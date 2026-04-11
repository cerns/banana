import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { hubStore } from './hubStore.js';
import type { HubMessage, ChannelCompaction } from './hubStore.js';
import { taskStore } from './taskStore.js';
import type { ChannelTask } from './taskStore.js';
import { docStore } from './docStore.js';
import type { ChannelDoc } from './docStore.js';
import { extractArtifactActions } from './channelArtifactExtractor.js';
import { compressPrompt, compressionStats } from './promptCompressor.js';
import { sessionStore } from '../sessions/sessionStore.js';
import type { SessionRecord } from '../sessions/sessionStore.js';
import { createJob } from '../sessions/sessionManager.js';
import { broadcastToDashboards } from '../ws/dashboardBroadcast.js';
import { isSessionBusy, onJobComplete, executeRemoteJob } from '../ssh/remoteSessionExecutor.js';

/** Track last dispatch time per session for cooldown. */
const sessionCooldowns = new Map<string, number>();

/**
 * Apply heuristic compression to a prompt before sending to claude.
 * Logs the savings so operators can see token reduction in real time.
 * Bypassed when BANANA_PROMPT_COMPRESS=0.
 */
function compressForDispatch(prompt: string, label: string): string {
  if (!config.promptCompressEnabled) return prompt;
  const compressed = compressPrompt(prompt);
  const stats = compressionStats(prompt, compressed);
  if (stats.saved > 0) {
    const pct = ((1 - stats.ratio) * 100).toFixed(1);
    console.log(`[hub] compress(${label}) ${stats.beforeChars}→${stats.afterChars} chars (-${pct}%)`);
  }
  return compressed;
}

/** Count currently running hub-dispatched jobs. */
let runningHubJobs = 0;

export interface PostHubMessageOpts {
  from: string;
  fromName: string;
  content: string;
  channelIds: string[];
  tags?: string[];
  mentions?: string[];
  parentId?: string;
  depth?: number;
}

/**
 * Post a message to the hub. Creates channels on demand, resolves mentions,
 * finds matching sessions, and dispatches or queues work.
 */
export function postHubMessage(opts: PostHubMessageOpts): HubMessage {
  const {
    from, fromName, content, channelIds,
    tags = [], mentions = [], parentId, depth = 0,
  } = opts;

  // Ensure channels exist
  for (const chId of channelIds) {
    hubStore.ensureChannel(chId, from);
  }

  // Use first channel as primary
  const channelId = channelIds[0];

  const msg: HubMessage = {
    id: randomUUID(),
    channelId,
    from,
    fromName,
    content,
    tags,
    mentions,
    parentId,
    depth,
    timestamp: new Date().toISOString(),
    status: 'pending',
    dispatches: [],
  };

  hubStore.addMessage(msg);

  // Broadcast to dashboards
  broadcastToDashboards({
    type: 'DASHBOARD_EVENT',
    event: 'HUB_MESSAGE',
    message: msg,
  });

  // Resolve @mentions → find sessions by screenName
  const mentionedSessionIds = new Set<string>();
  for (const name of mentions) {
    const sid = resolveScreenName(name);
    if (sid) mentionedSessionIds.add(sid);
  }

  // Find matching sessions.
  //   - User-originated messages (depth=0) fan out to everyone subscribed (war-room).
  //   - Agent replies (depth>0) do NOT fan out — only sessions explicitly
  //     @mentioned in the reply get dispatched. This prevents chain explosions
  //     where every agent reply re-triggers every other agent.
  const allSessions = sessionStore.getAll();
  const matchingSessions: Array<{ session: SessionRecord; engagement: EngagementLevel }> = [];
  const replyFanOutSuppressed = depth > 0;

  console.log(`[hub] postHubMessage → channels=${JSON.stringify(channelIds)} depth=${depth} tags=${JSON.stringify(tags)} mentions=${JSON.stringify(mentions)} from=${from}`);
  console.log(`[hub] scanning ${allSessions.length} sessions for matches${replyFanOutSuppressed ? ' (reply — mentions only)' : ''}`);

  for (const session of allSessions) {
    const sid = session.sessionId.slice(0, 8);

    if (session.type !== 'remote' || !session.machineId) {
      console.log(`[hub]   ${sid} SKIP: type=${session.type} machineId=${session.machineId ?? 'none'}`);
      continue;
    }
    if (session.sessionId === from) {
      console.log(`[hub]   ${sid} SKIP: self-exclusion`);
      continue;
    }

    const isSubscribed = session.channels?.some(ch => channelIds.includes(ch)) ?? false;
    const isMentioned = mentionedSessionIds.has(session.sessionId);
    const hasInterestOverlap = session.interests?.some(i => tags.includes(i)) ?? false;

    // Replies only dispatch to explicit @mentions to prevent chain explosions.
    // Originals (depth=0) fan out to everyone subscribed.
    const matched = replyFanOutSuppressed
      ? isMentioned
      : (isSubscribed || isMentioned);

    let engagement: EngagementLevel = 'listen';
    if (isMentioned) engagement = 'mentioned';
    else if (hasInterestOverlap || tags.length === 0) engagement = 'expert';

    console.log(
      `[hub]   ${sid} name=${session.name ?? '-'} channels=${JSON.stringify(session.channels ?? [])} ` +
      `subscribed=${isSubscribed} mentioned=${isMentioned} interestOverlap=${hasInterestOverlap} ` +
      `→ ${matched ? `MATCH(${engagement})` : 'no-match'}`
    );

    if (matched) {
      matchingSessions.push({ session, engagement });
    }
  }

  console.log(`[hub] matched ${matchingSessions.length} sessions`);

  // Dispatch to matching sessions
  for (const entry of matchingSessions) {
    dispatchOrQueue(entry.session, msg, entry.engagement);
  }

  return msg;
}

type EngagementLevel = 'mentioned' | 'expert' | 'listen' | 'triggered';

function dispatchOrQueue(
  session: SessionRecord,
  hubMessage: HubMessage,
  engagement: EngagementLevel,
): void {
  const sid = session.sessionId.slice(0, 8);

  // Cooldown check
  const lastDispatch = sessionCooldowns.get(session.sessionId);
  const now = Date.now();
  if (lastDispatch && (now - lastDispatch) < config.hubCooldownMs) {
    const remaining = config.hubCooldownMs - (now - lastDispatch);
    console.log(`[hub]   ${sid} QUEUE: cooldown (${remaining}ms remaining)`);
    queueForSession(session.sessionId, hubMessage.id, engagement);
    return;
  }

  // Check if session is busy
  if (isSessionBusy(session.sessionId)) {
    console.log(`[hub]   ${sid} QUEUE: session is busy`);
    queueForSession(session.sessionId, hubMessage.id, engagement);
    return;
  }

  // Max concurrent check
  if (runningHubJobs >= config.hubMaxConcurrentJobs) {
    console.log(`[hub]   ${sid} QUEUE: max concurrent reached (${runningHubJobs}/${config.hubMaxConcurrentJobs})`);
    queueForSession(session.sessionId, hubMessage.id, engagement);
    return;
  }

  console.log(`[hub]   ${sid} DISPATCH (${engagement})`);
  dispatchToSession(session, hubMessage, engagement);
}

function queueForSession(
  sessionId: string,
  hubMessageId: string,
  engagement: EngagementLevel = 'expert',
): void {
  const session = sessionStore.get(sessionId);
  if (!session) return;
  const queue = session.hubQueue ?? [];
  queue.push({ hubMessageId, queuedAt: new Date().toISOString(), engagement });
  sessionStore.updateMeta(sessionId, { hubQueue: queue });

  // Add queued dispatch record
  hubStore.addDispatch(hubMessageId, {
    sessionId,
    jobId: '',
    status: 'queued',
  });
  broadcastDispatchUpdate(hubMessageId);
}

/**
 * Push a real-time dispatch state-change event to dashboards so the
 * "processing: <agent>" indicator next to a hub message updates as soon as
 * a session goes queued → running → acted/skipped/error, without waiting for
 * the next channel reload.
 */
function broadcastDispatchUpdate(messageId: string): void {
  const msg = hubStore.getMessage(messageId);
  if (!msg) return;
  broadcastToDashboards({
    type: 'DASHBOARD_EVENT',
    event: 'HUB_DISPATCH_UPDATE',
    messageId,
    channelId: msg.channelId,
    status: msg.status,
    dispatches: msg.dispatches,
  });
}

/** Maximum characters allowed in the formatted context block. */
const MAX_CONTEXT_CHARS = 4000;
/** Maximum characters kept per individual message in the context log. */
const MAX_PRIOR_CONTENT_CHARS = 600;

/**
 * Build a compact conversation log + tasks/docs snapshot covering:
 *   1. The full parentId ancestor chain (thread lineage, always included)
 *   2. Recent sibling messages in the same channel (war-room shared memory)
 *   3. Open bJira tickets for the channel (persistent task tracker)
 *   4. Recent bConfluence pages for the channel (persistent doc store)
 *
 * NOTE: This is intentionally NOT cached on `hubMessage` so queued/delayed
 * dispatches see fresh state at the moment they actually run (fixes the
 * standup-staleness problem where qa-bob kept repeating "Lighthouse 78"
 * because the cached context never updated).
 */
function buildChannelContext(hubMessage: HubMessage, session?: SessionRecord): string {
  // Collect ancestor chain (ordered root → direct parent)
  const ancestors = hubStore.getAncestorChain(hubMessage.id);
  const ancestorIds = new Set(ancestors.map(a => a.id));

  // Collect all prior messages in this channel
  const channelMsgs = hubStore.getByChannel(hubMessage.channelId);
  const priors = channelMsgs.filter(m =>
    m.id !== hubMessage.id &&
    m.timestamp < hubMessage.timestamp &&
    !ancestorIds.has(m.id),
  );

  const fmt = (m: HubMessage): string => {
    let content = m.content;
    if (content.length > MAX_PRIOR_CONTENT_CHARS) {
      content = content.slice(0, MAX_PRIOR_CONTENT_CHARS) + ' …[truncated]';
    }
    return `[${m.fromName}] (depth ${m.depth}): ${content}`;
  };

  const sections: string[] = [];

  if (priors.length > 0) {
    sections.push('## Channel history\n' + priors.map(fmt).join('\n\n'));
  }
  if (ancestors.length > 0) {
    sections.push('## Direct thread (replies leading to this message)\n' + ancestors.map(fmt).join('\n\n'));
  }

  let log = sections.join('\n\n');
  if (log.length > MAX_CONTEXT_CHARS) {
    log = '…[earlier messages trimmed]\n\n' + log.slice(log.length - MAX_CONTEXT_CHARS);
  }

  // ── Tasks & Docs snapshot ───────────────────────────────────────────────
  const channelName = hubStore.getChannel(hubMessage.channelId)?.name ?? hubMessage.channelId;
  const interests = session?.interests ?? [];

  const openTasks = taskStore
    .getByChannel(hubMessage.channelId, { status: ['open', 'in_progress', 'blocked'] })
    .slice(0, config.taskContextMax ?? 8);

  const recentDocs = docStore
    .getByChannel(hubMessage.channelId)
    .slice(0, config.docContextMax ?? 5);

  const taggedTasks = interests.length > 0
    ? openTasks.filter(t => t.tags.some(tag => interests.includes(tag)))
    : [];
  const taggedDocs = interests.length > 0
    ? recentDocs.filter(d => d.tags.some(tag => interests.includes(tag)))
    : [];

  const fmtTask = (t: ChannelTask): string => {
    const tagPart = t.tags.length > 0 ? ` (${t.tags.join(',')})` : '';
    const assigneePart = t.assignee ? ` @${t.assignee}` : '';
    return `${t.id} [${t.status}]${assigneePart}${tagPart} — ${t.title}`;
  };
  const fmtDoc = (d: ChannelDoc): string => {
    const preview = d.body.replace(/\s+/g, ' ').slice(0, 80);
    return `${d.id} v${d.version} "${d.title}" by ${d.author} — ${preview}${d.body.length > 80 ? '…' : ''}`;
  };

  const taskDocSections: string[] = [];

  if (taggedTasks.length > 0 || taggedDocs.length > 0) {
    const lines: string[] = [`## Tagged for you (${channelName})`];
    if (taggedTasks.length > 0) lines.push(taggedTasks.map(fmtTask).join('\n'));
    if (taggedDocs.length > 0) lines.push(taggedDocs.map(fmtDoc).join('\n'));
    taskDocSections.push(lines.join('\n'));
  }

  if (openTasks.length > 0) {
    taskDocSections.push(
      `## Open bJira tickets (${channelName})\n` + openTasks.map(fmtTask).join('\n'),
    );
  }
  if (recentDocs.length > 0) {
    taskDocSections.push(
      `## Recent bConfluence pages (${channelName})\n` + recentDocs.map(fmtDoc).join('\n'),
    );
  }

  // Always include the marker grammar so agents know how to write to bJira/bConfluence,
  // even when the channel is empty (otherwise nobody would ever create the first ticket).
  taskDocSections.push(BJIRA_BCONF_HINT);
  taskDocSections.push(TALKING_HINT);

  if (taskDocSections.length > 0) {
    log = log
      ? log + '\n\n' + taskDocSections.join('\n\n')
      : taskDocSections.join('\n\n');
  }

  return log;
}

// Marker grammar shown to every dispatched session so agents know they can
// read AND write the persistent task/doc stores. Distinct bJIRA_ / bCONF_
// prefixes (rather than generic TASK_ / DOC_) prevent the LLM from accidentally
// triggering the parser when discussing real Jira / Confluence in normal prose.
const BJIRA_BCONF_HINT = `## bJira & bConfluence — persistent shared state
Use these markers ANYWHERE in your reply to read/write durable state for this
channel. Markers are stripped from the chat post before others see it. They are
the ONLY way to mutate the task tracker / doc store from inside an agent reply.

bJira (task tracker — bJIRA-N IDs):
  [bJIRA_CREATE title="Fix LCP > 4s" status=open assignee=qa-bob tags=perf,frontend priority=high]
  Optional longer description / acceptance criteria here.
  [/bJIRA_CREATE]

  [bJIRA_UPDATE id=bJIRA-12 status=in_progress assignee=cas-pop]

  [bJIRA_UPDATE id=bJIRA-12 status=done]
  Verified by running \`npm test\` — all green.
  [/bJIRA_UPDATE]

  [bJIRA_COMMENT id=bJIRA-12]
  Lighthouse rerun: 78 → 92. Still flaky on slow-3G though.
  [/bJIRA_COMMENT]

bConfluence (doc store — bCONF-N IDs, versioned):
  [bCONF_WRITE title="Auth Spec" tags=auth,api]
  # Auth Spec
  Decision matrix for JWT vs session...
  [/bCONF_WRITE]

  [bCONF_UPDATE id=bCONF-3 title="Auth Spec v2"]
  Replacement body — bumps version, prior is kept in history.
  [/bCONF_UPDATE]

  [bCONF_APPEND id=bCONF-3]
  ## Update 2026-04-10
  Added refresh-token rotation rule.
  [/bCONF_APPEND]

WHEN to use these vs plain chat:
  - Decisions / specs / threshold values others will need later → bConfluence.
  - Concrete actionable work that needs status tracking → bJira.
  - Casual discussion, questions, replies → just write normal chat (no markers).

Status values:  open · in_progress · blocked · done · wontfix
Priority values: low · medium · high
`;

// Hint shown to every dispatched session so agents know they can hold the
// floor across multiple turns by emitting [IM_TALKING] or [IM_THINKING]. The
// continuation reply is posted as a SIBLING of the previous one (same parent,
// same depth) so the conversation reads as sequential beats from one speaker.
const TALKING_HINT = `## Holding the floor — [IM_TALKING] / [IM_THINKING]
If you want to continue your own train of thought without waiting for anyone
else to reply, include [IM_TALKING] or [IM_THINKING] anywhere in your message.
After that reply is posted, the system will automatically re-invoke YOU and
your follow-up will appear as a sibling message right after this one (same
thread level, no nesting).

Stop the loop by simply NOT including the marker in your next reply, or by
replying with SKIP. There is a hard cap on continuation rounds — once it is
reached, the loop is force-stopped and other agents may take over.

Use this for: deep analysis, walking through edge cases out loud, narrating
debugging, breaking a complex task into a sequence of monologue beats.
Do NOT use it for: short acknowledgements, simple Q&A, or anything where you
should hear from another agent before continuing.
`;

/** Hint added to non-triggered prompts so agents know they can self-trigger. */
const SELF_TRIGGER_HINT = `

────────────────────────────────────────
SELF-EXECUTION OPTION: [BEGIN_WORK]
────────────────────────────────────────
If after replying you decide YOU should be the one to actually do this work,
include the marker [BEGIN_WORK] at the END of your reply. The system will then
automatically re-invoke you in "action" mode to execute the task with full tool
access (file edits, bash, etc.).

⚠️ MANDATORY BEFORE USING [BEGIN_WORK] ⚠️
You MUST first comply with the Plan–Do–Check–Act (PDCA) policy in your reply.
Your reply must contain ALL of the following sections, in this exact order,
BEFORE the [BEGIN_WORK] marker:

  ## Background
  Brief context: what is this task, why does it matter, what's the current state.

  ## Plan
  A numbered TODO task list of the concrete steps you will take.
  For EACH step include:
    - Action: what you will actually do (file/command/etc.)
    - Acceptance Criteria: how you (and others) will verify the step is done correctly

  ## Do
  (Will be performed in action mode after [BEGIN_WORK].)

  ## Check
  Note what tests / validations you will run after the work to confirm success.

  ## Act
  Note what follow-up adjustments may be needed and how you will report results back.

  [BEGIN_WORK]

If you cannot produce a real Plan with concrete steps and acceptance criteria,
DO NOT include [BEGIN_WORK]. Just discuss in chat instead. The marker is a
commitment to do real, verifiable work — not vibes.
`;

function buildGuidance(engagement: EngagementLevel): string {
  const fallback = 'If the message is not actionable for you or you have nothing to add, respond with exactly "SKIP".';
  switch (engagement) {
    case 'triggered':
      return [
        '## ACTION REQUIRED — you have been EXPLICITLY TRIGGERED to start working on this task NOW.',
        '',
        'This is NOT a chat ping. Do not just discuss, plan, or summarize.',
        'You are expected to actually DO the work in your environment using your tools:',
        '  - Use Read / Edit / Write to inspect and modify files in your working directory.',
        '  - Use Bash to run commands, install dependencies, run tests, start servers, etc.',
        '  - Use Grep / Glob to navigate the codebase.',
        '  - If something needs research, do it; if something needs code, write it.',
        '',
        'Work autonomously from your role\'s perspective. Make real changes. Take real actions.',
        'When you have made meaningful progress (or finished), report back ONE concrete summary:',
        '  - What files you changed (paths)',
        '  - What commands you ran and their results',
        '  - What\'s done, what remains, and any blockers',
        '',
        'If the task is genuinely outside your role or impossible, briefly explain why instead of pretending to act.',
        'Do NOT respond with "SKIP". Do NOT ask the user clarifying questions — make reasonable assumptions and proceed.',
      ].join('\n');
    case 'mentioned':
      return `You were @mentioned directly. Respond to the question or request. ${fallback}${SELF_TRIGGER_HINT}`;
    case 'expert':
      return `This message is in your area of expertise. Engage fully and provide substantive input from your role's perspective. ${fallback}${SELF_TRIGGER_HINT}`;
    case 'listen':
      return [
        'You are in the war-room listening to a discussion outside your core specialty.',
        'Only respond if you have a brief, concrete observation, concern, or suggestion from your role that others might miss (1-2 sentences max).',
        fallback,
      ].join(' ') + SELF_TRIGGER_HINT;
  }
}

/** Detect [BEGIN_WORK] / [SELF_TRIGGER] / [ACT_NOW] markers in agent reply. */
function detectSelfTrigger(text: string): boolean {
  return /\[(BEGIN_WORK|SELF_TRIGGER|ACT_NOW)\]/i.test(text);
}

/** Strip self-trigger markers from displayed text so they don't clutter the channel. */
function stripSelfTriggerMarkers(text: string): string {
  return text.replace(/\[(BEGIN_WORK|SELF_TRIGGER|ACT_NOW)\]/gi, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Detect [IM_TALKING] / [IM_THINKING] markers — agent wants to keep the floor. */
function detectTalkingMarker(text: string): boolean {
  return /\[(IM_TALKING|IM_THINKING)\]/i.test(text);
}

/** Strip talking markers from displayed text. */
function stripTalkingMarkers(text: string): string {
  return text.replace(/\[(IM_TALKING|IM_THINKING)\]/gi, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Detect whether an agent's reply is a "SKIP" — meaning it should be silently
 * dropped rather than posted as a real message. Catches:
 *   - empty responses
 *   - "SKIP", "SKIP.", "SKIP!", "skip"
 *   - "SKIPSKIP", "SKIP SKIP" (LLM stuttering)
 *   - "SKIP - not relevant", "skip: nothing to add"
 * Does NOT match: "skipping the build", "skip ahead to ..." (real content).
 */
function isSkipResponse(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return true;
  // Strip everything except letters, then check for repeated "skip"
  const lettersOnly = trimmed.replace(/[^a-z]/gi, '').toLowerCase();
  if (/^(skip)+$/.test(lettersOnly)) return true;
  // "SKIP <punctuation/space> ..." → still a skip
  if (/^skip\b/i.test(trimmed)) return true;
  return false;
}

function dispatchToSession(
  session: SessionRecord,
  hubMessage: HubMessage,
  engagement: EngagementLevel,
): void {
  // Build prompt with role context
  const roleLine = session.role ? `[ROLE: ${session.role}]` : '';
  const rolePromptLine = session.rolePrompt ? `${session.rolePrompt}\n\n` : '';
  const channelName = hubStore.getChannel(hubMessage.channelId)?.name ?? hubMessage.channelId;

  const channelContext = buildChannelContext(hubMessage, session);
  const contextBlock = channelContext
    ? `[CHAT CONTEXT in ${channelName}]\n${channelContext}\n\n`
    : '';

  const guidance = buildGuidance(engagement);

  // Frame the "trigger source" message differently depending on origin:
  //   - Self-trigger (agent included [BEGIN_WORK] in their own reply):
  //       The hubMessage IS their own reply. Show it as "you said earlier".
  //   - Manual trigger / mention / dispatch from another source:
  //       Standard "[HUB #ch from <person>]" framing.
  const isSelfTrigger = engagement === 'triggered' && hubMessage.from === session.sessionId;
  const sourceHeader = isSelfTrigger
    ? `[YOU SAID THIS EARLIER IN ${channelName} — and you marked it for self-execution by including [BEGIN_WORK]. Now actually do the work you described.]`
    : engagement === 'triggered'
      ? `[YOU WERE TRIGGERED TO ACT ON THIS MESSAGE in ${channelName} from ${hubMessage.fromName}]`
      : `[HUB ${channelName} from ${hubMessage.fromName}]`;

  const rawPrompt = [
    roleLine,
    rolePromptLine,
    contextBlock,
    sourceHeader,
    hubMessage.content,
    '',
    '---',
    guidance,
  ].filter(Boolean).join('\n');

  const prompt = compressForDispatch(rawPrompt, `dispatch ${session.sessionId.slice(0, 8)}`);

  // Create job
  const job = createJob(session.sessionId, prompt);

  // Update dispatch
  hubStore.addDispatch(hubMessage.id, {
    sessionId: session.sessionId,
    jobId: job.jobId,
    status: 'running',
    startedAt: new Date().toISOString(),
  });
  broadcastDispatchUpdate(hubMessage.id);

  runningHubJobs++;
  sessionCooldowns.set(session.sessionId, Date.now());

  // Register completion callback and execute
  onJobComplete(job.jobId, () => {
    onSessionJobComplete(session.sessionId, job.jobId, hubMessage, engagement);
  });

  executeRemoteJob(session.sessionId, job.jobId, prompt);
}

function onSessionJobComplete(
  sessionId: string,
  jobId: string,
  hubMessage: HubMessage,
  engagement: EngagementLevel,
): void {
  runningHubJobs = Math.max(0, runningHubJobs - 1);

  const session = sessionStore.get(sessionId);
  if (!session) return;

  // Extract text from job chunks
  const storedSession = sessionStore.get(sessionId);
  const job = storedSession?.jobs.find(j => j.jobId === jobId);
  const rawOutput = extractTextFromChunks(job?.chunks ?? []);

  // SKIP detection — catches "SKIP", "SKIP.", "SKIPSKIP", "skip - not relevant", etc.
  // Skipped responses are NEVER posted to the channel; they're just recorded
  // on the dispatch row so the dashboard can show "X skipped".
  if (isSkipResponse(rawOutput)) {
    hubStore.updateDispatch(hubMessage.id, sessionId, {
      status: 'skipped',
      finishedAt: new Date().toISOString(),
    });
    broadcastDispatchUpdate(hubMessage.id);
  } else {
    hubStore.updateDispatch(hubMessage.id, sessionId, {
      status: 'acted',
      finishedAt: new Date().toISOString(),
    });
    broadcastDispatchUpdate(hubMessage.id);

    // Chain depth check before posting result back
    if (hubMessage.depth < config.hubMaxChainDepth) {
      // Detect markers BEFORE stripping them
      const wantsSelfTrigger = detectSelfTrigger(rawOutput) && engagement !== 'triggered';
      // Talking continuation is only valid in chat mode (not while triggered)
      // and never together with [BEGIN_WORK] — self-trigger takes precedence.
      const wantsTalking = !wantsSelfTrigger
        && engagement !== 'triggered'
        && detectTalkingMarker(rawOutput);

      // Strip self-trigger AND talking markers from displayed content
      const stripped = stripTalkingMarkers(stripSelfTriggerMarkers(rawOutput));

      // Extract task/doc artifact actions from the reply (and strip those markers too)
      const screenName = session.screenName ?? session.name ?? sessionId.slice(0, 8);
      const actions = extractArtifactActions(stripped);
      applyArtifactActions(actions, hubMessage.channelId, screenName);

      const compactedContent = actions.cleanedText;

      // Inherit parent tags only — don't auto-inject the session's interests
      // (that floods the conversation with internal routing metadata).
      const newTags = hubMessage.tags;

      // Extract @mentions from the agent's reply so humans can be pulled in.
      const replyMentions = extractMentions(compactedContent);

      const postedReply = postHubMessage({
        from: sessionId,
        fromName: screenName,
        content: compactedContent,
        channelIds: [hubMessage.channelId],
        tags: newTags,
        mentions: replyMentions,
        parentId: hubMessage.id,
        depth: hubMessage.depth + 1,
      });

      // Self-trigger: agent included [BEGIN_WORK] in their reply, so re-invoke
      // them in 'triggered' (action) mode against their own reply. The work
      // result becomes a child of the chat reply, preserving the source chain.
      // Loop guard: only chat-mode (not already triggered) can self-trigger.
      if (wantsSelfTrigger) {
        console.log(`[hub]   ${sessionId.slice(0, 8)} SELF-TRIGGER detected in reply`);
        // Defer one tick so the reply gets persisted/broadcast first
        setImmediate(() => {
          triggerSessionOnMessage(sessionId, postedReply.id);
        });
      } else if (wantsTalking) {
        // Talking continuation: re-invoke the same agent. Their next reply will
        // be posted as a SIBLING of postedReply (same parent = hubMessage.id,
        // same depth = hubMessage.depth + 1) so the conversation reads as a
        // sequence of monologue beats rather than a deeply nested thread.
        console.log(`[hub]   ${sessionId.slice(0, 8)} TALKING marker detected → round 1`);
        setImmediate(() => {
          continueTalking(sessionId, hubMessage, postedReply, 1);
        });
      }
    }
  }

  // Check if all dispatches are done
  const msg = hubStore.getMessage(hubMessage.id);
  if (msg) {
    const allDone = msg.dispatches.every(d => ['acted', 'skipped', 'error'].includes(d.status));
    if (allDone) {
      hubStore.updateStatus(hubMessage.id, 'complete');
    }
  }

  // Process this session's queue first, then drain any other sessions that
  // were blocked by the concurrency limit or cooldown.
  processQueue(sessionId);
  drainGlobalQueue();
}

/**
 * Continuation dispatch for [IM_TALKING] / [IM_THINKING] threads.
 *
 * Re-invokes the same `sessionId` that just emitted the talking marker. The
 * follow-up reply is posted as a SIBLING of `lastReply` (same parentId, same
 * depth as the FIRST reply in the thread, which is `originalMessage.depth + 1`).
 *
 * Stops when:
 *   - the agent's next reply has no marker (loop terminates naturally)
 *   - the agent SKIPs (silently dropped)
 *   - `round` exceeds `config.hubMaxTalkRounds` (hard cap)
 */
function continueTalking(
  sessionId: string,
  originalMessage: HubMessage,
  lastReply: HubMessage,
  round: number,
): void {
  const session = sessionStore.get(sessionId);
  if (!session) return;

  const cap = config.hubMaxTalkRounds ?? 10;
  if (round > cap) {
    console.log(`[hub]   ${sessionId.slice(0, 8)} TALKING cap reached (${round}/${cap})`);
    return;
  }
  if (isSessionBusy(sessionId)) {
    console.log(`[hub]   ${sessionId.slice(0, 8)} TALKING → busy, dropping continuation`);
    return;
  }
  if (runningHubJobs >= config.hubMaxConcurrentJobs) {
    console.log(`[hub]   ${sessionId.slice(0, 8)} TALKING → concurrency cap, dropping continuation`);
    return;
  }

  const roleLine = session.role ? `[ROLE: ${session.role}]` : '';
  const rolePromptLine = session.rolePrompt ? `${session.rolePrompt}\n\n` : '';
  const channelName = hubStore.getChannel(originalMessage.channelId)?.name ?? originalMessage.channelId;

  // Use lastReply as the anchor for context-building so the channel history
  // naturally includes their prior beats in this monologue.
  const channelContext = buildChannelContext(lastReply, session);
  const contextBlock = channelContext
    ? `[CHAT CONTEXT in ${channelName}]\n${channelContext}\n\n`
    : '';

  const sourceHeader = `[CONTINUING YOUR TRAIN OF THOUGHT in ${channelName} — round ${round}/${cap}]`;
  const guidance = [
    'You marked your previous message with [IM_TALKING] / [IM_THINKING] to keep the floor.',
    'Continue your train of thought from where you left off. Build on what you',
    'just said — do not repeat it. Make ONE more substantive contribution.',
    '',
    'You may continue holding the floor by including [IM_TALKING] or',
    '[IM_THINKING] again in this reply, or release it by writing your final',
    'beat without the marker. Reply with SKIP to drop out entirely.',
  ].join('\n');

  const rawPrompt = [
    roleLine,
    rolePromptLine,
    contextBlock,
    sourceHeader,
    '',
    '---',
    guidance,
  ].filter(Boolean).join('\n');

  const prompt = compressForDispatch(rawPrompt, `talking ${sessionId.slice(0, 8)}`);

  const job = createJob(sessionId, prompt);

  // Record the dispatch on the ORIGINAL message so the dashboard sees the
  // talking thread as part of that conversation.
  hubStore.addDispatch(originalMessage.id, {
    sessionId,
    jobId: job.jobId,
    status: 'running',
    startedAt: new Date().toISOString(),
  });
  broadcastDispatchUpdate(originalMessage.id);

  runningHubJobs++;
  sessionCooldowns.set(sessionId, Date.now());

  onJobComplete(job.jobId, () => {
    onTalkingJobComplete(sessionId, job.jobId, originalMessage, round);
  });

  executeRemoteJob(sessionId, job.jobId, prompt);
}

function onTalkingJobComplete(
  sessionId: string,
  jobId: string,
  originalMessage: HubMessage,
  round: number,
): void {
  runningHubJobs = Math.max(0, runningHubJobs - 1);

  const session = sessionStore.get(sessionId);
  if (!session) {
    drainGlobalQueue();
    return;
  }

  const job = session.jobs.find(j => j.jobId === jobId);
  const rawOutput = extractTextFromChunks(job?.chunks ?? []);

  if (isSkipResponse(rawOutput)) {
    hubStore.updateDispatch(originalMessage.id, sessionId, {
      status: 'skipped',
      finishedAt: new Date().toISOString(),
    });
    broadcastDispatchUpdate(originalMessage.id);
    processQueue(sessionId);
    drainGlobalQueue();
    return;
  }

  hubStore.updateDispatch(originalMessage.id, sessionId, {
    status: 'acted',
    finishedAt: new Date().toISOString(),
  });
  broadcastDispatchUpdate(originalMessage.id);

  const wantsContinue = detectTalkingMarker(rawOutput);
  // Strip BOTH self-trigger and talking markers from displayed content. We do
  // not honour [BEGIN_WORK] inside a talking continuation — keep that flow
  // strictly chat-only to avoid muddling the two state machines.
  const stripped = stripTalkingMarkers(stripSelfTriggerMarkers(rawOutput));
  const screenName = session.screenName ?? session.name ?? sessionId.slice(0, 8);
  const actions = extractArtifactActions(stripped);
  applyArtifactActions(actions, originalMessage.channelId, screenName);

  const compactedContent = actions.cleanedText;
  const replyMentions = extractMentions(compactedContent);

  // CRITICAL: post as SIBLING of the previous reply — same parentId
  // (originalMessage.id) and same depth (originalMessage.depth + 1) as the
  // first reply in the talking thread.
  const postedReply = postHubMessage({
    from: sessionId,
    fromName: screenName,
    content: compactedContent,
    channelIds: [originalMessage.channelId],
    tags: originalMessage.tags,
    mentions: replyMentions,
    parentId: originalMessage.id,
    depth: originalMessage.depth + 1,
  });

  if (wantsContinue) {
    const cap = config.hubMaxTalkRounds ?? 10;
    if (round + 1 <= cap) {
      console.log(`[hub]   ${sessionId.slice(0, 8)} TALKING → round ${round + 1}`);
      setImmediate(() => {
        continueTalking(sessionId, originalMessage, postedReply, round + 1);
      });
    } else {
      console.log(`[hub]   ${sessionId.slice(0, 8)} TALKING cap reached (${round + 1}/${cap})`);
    }
  }

  processQueue(sessionId);
  drainGlobalQueue();
}

export function processQueue(sessionId: string): void {
  const session = sessionStore.get(sessionId);
  if (!session) return;

  const queue = session.hubQueue ?? [];
  if (queue.length === 0) return;

  // Respect concurrency limit even while draining
  if (runningHubJobs >= config.hubMaxConcurrentJobs) return;
  // Respect busy state
  if (isSessionBusy(sessionId)) return;

  // Take next message from queue
  const next = queue.shift()!;
  sessionStore.updateMeta(sessionId, { hubQueue: queue });

  const msg = hubStore.getMessage(next.hubMessageId);
  if (!msg) return;

  // In war-room mode every subscriber responds; we no longer skip just
  // because another role acted. Still skip obviously stale entries.
  const existingDispatch = msg.dispatches.find(d => d.sessionId === sessionId);
  if (existingDispatch && ['acted', 'skipped', 'error'].includes(existingDispatch.status)) {
    // Already handled by this very session — don't double-dispatch
    processQueue(sessionId);
    return;
  }

  const freshSession = sessionStore.get(sessionId);
  if (freshSession) {
    const engagement: EngagementLevel = next.engagement ?? 'expert';
    console.log(`[hub]   ${sessionId.slice(0, 8)} DRAIN → ${engagement}`);
    dispatchToSession(freshSession, msg, engagement);
  }
}

/**
 * Global queue drain — called after any hub job completes so sessions that
 * were blocked on concurrency/cooldown get a chance to run.
 */
function drainGlobalQueue(): void {
  const allSessions = sessionStore.getAll();
  for (const session of allSessions) {
    if (runningHubJobs >= config.hubMaxConcurrentJobs) break;
    const queue = session.hubQueue ?? [];
    if (queue.length === 0) continue;
    if (isSessionBusy(session.sessionId)) continue;
    const last = sessionCooldowns.get(session.sessionId);
    if (last && (Date.now() - last) < config.hubCooldownMs) continue;
    processQueue(session.sessionId);
  }
}

/**
 * Manually trigger a session to act on a specific channel message. The
 * session's response will be posted back to the channel as a reply with
 * `parentId = hubMessageId`, so the source of the trigger is preserved
 * automatically through the parent chain.
 *
 * Bypasses the cooldown gate (this is a deliberate user action), but still
 * queues if the session is busy or the global concurrency limit is hit.
 */
export function triggerSessionOnMessage(
  sessionId: string,
  hubMessageId: string,
): { ok: boolean; status: 'dispatched' | 'queued'; error?: string } {
  const session = sessionStore.get(sessionId);
  if (!session) return { ok: false, status: 'dispatched', error: 'session not found' };
  if (session.type !== 'remote' || !session.machineId) {
    return { ok: false, status: 'dispatched', error: 'session is not remote or has no machine' };
  }

  const msg = hubStore.getMessage(hubMessageId);
  if (!msg) return { ok: false, status: 'dispatched', error: 'message not found' };

  const sid = sessionId.slice(0, 8);

  if (isSessionBusy(sessionId)) {
    console.log(`[hub]   ${sid} TRIGGER → queue (busy)`);
    queueForSession(sessionId, hubMessageId, 'triggered');
    return { ok: true, status: 'queued' };
  }
  if (runningHubJobs >= config.hubMaxConcurrentJobs) {
    console.log(`[hub]   ${sid} TRIGGER → queue (max concurrent)`);
    queueForSession(sessionId, hubMessageId, 'triggered');
    return { ok: true, status: 'queued' };
  }

  console.log(`[hub]   ${sid} TRIGGER → dispatch on msg ${hubMessageId.slice(0, 8)}`);
  dispatchToSession(session, msg, 'triggered');
  return { ok: true, status: 'dispatched' };
}

/**
 * Apply parsed task/doc actions from an agent reply, then broadcast the
 * relevant change events to dashboards. Unknown task/doc IDs are silently
 * skipped (the marker is still stripped from the chat post).
 */
function applyArtifactActions(
  actions: ReturnType<typeof extractArtifactActions>,
  channelId: string,
  by: string,
): void {
  let tasksChanged = false;
  let docsChanged = false;

  for (const fields of actions.taskCreates) {
    taskStore.createTask(channelId, fields, by);
    tasksChanged = true;
  }
  for (const upd of actions.taskUpdates) {
    if (taskStore.updateTask(upd.id, upd, by)) tasksChanged = true;
  }
  for (const cmt of actions.taskComments) {
    if (taskStore.addComment(cmt.id, cmt.text, by)) tasksChanged = true;
  }
  for (const w of actions.docWrites) {
    docStore.createDoc(channelId, w.title, w.body, by, w.tags ?? []);
    docsChanged = true;
  }
  for (const u of actions.docUpdates) {
    if (docStore.updateDoc(u.id, { title: u.title, body: u.body, tags: u.tags }, by)) {
      docsChanged = true;
    }
  }
  for (const a of actions.docAppends) {
    if (docStore.appendDoc(a.id, a.text, by)) docsChanged = true;
  }

  if (tasksChanged) {
    broadcastToDashboards({
      type: 'DASHBOARD_EVENT',
      event: 'TASKS_CHANGED',
      channelId,
    });
  }
  if (docsChanged) {
    broadcastToDashboards({
      type: 'DASHBOARD_EVENT',
      event: 'DOCS_CHANGED',
      channelId,
    });
  }
}

/**
 * Parse @screenName references out of free-form text. Matches alnum, dash and
 * underscore after an `@`. Returns unique names in the order they first appear.
 */
function extractMentions(text: string): string[] {
  const re = /@([a-zA-Z0-9_-]+)/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

export function resolveScreenName(name: string): string | undefined {
  const all = sessionStore.getAll();
  const match = all.find(s => s.screenName === name);
  return match?.sessionId;
}

function extractTextFromChunks(chunks: unknown[]): string {
  const parts: string[] = [];
  // Capture the final `result` chunk's text as a fallback in case no
  // assistant/stream_event chunks were emitted (e.g. rate-limited very early).
  let resultFallback: string | null = null;

  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue;
    const c = chunk as Record<string, unknown>;

    if (c.type === 'assistant') {
      const content = (c.message as Record<string, unknown>)?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
            parts.push((block as Record<string, unknown>).text as string);
          }
        }
      }
    }

    // Handle stream_event text deltas
    if (c.type === 'stream_event') {
      const evt = c.event as Record<string, unknown> | undefined;
      if (evt?.type === 'content_block_delta') {
        const delta = evt.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          parts.push(delta.text);
        }
      }
    }

    // Claude CLI's terminal `result` chunk holds the aggregated final text.
    // We use it only as a fallback when no streaming content was captured.
    if (c.type === 'result' && typeof c.result === 'string') {
      resultFallback = c.result;
    }
  }

  const joined = parts.join('');
  return joined || resultFallback || '';
}

/**
 * Compact (LLM-summarize) every live message in a channel into a single seed
 * message. Originals are NOT deleted — they are snapshotted into a
 * `ChannelCompaction` record on the channel so the full history is preserved
 * and can always be replayed/audited.
 *
 * Flow:
 *   1. Snapshot all live messages in the channel (in chronological order)
 *   2. Build a transcript and ask Claude to produce a faithful summary that
 *      preserves: open decisions, unresolved questions, action items, and
 *      every bJira/bConfluence reference
 *   3. Archive the originals via `hubStore.compactChannel`
 *   4. Post a NEW seed message containing the summary so the channel reads
 *      "like new" with one starter message that captures everything that
 *      came before
 *
 * Returns the new seed message + the compaction record. Throws if no machine
 * is available to run the summarizer.
 */
export async function compactChannel(
  channelId: string,
  by: string,
  machineId?: string,
): Promise<{ seedMessage: HubMessage; compaction: ChannelCompaction }> {
  const channel = hubStore.getChannel(channelId);
  if (!channel) throw new Error('channel not found');

  const messages = hubStore.getByChannel(channelId);
  if (messages.length === 0) throw new Error('channel has no messages to compact');

  // Pick a machine: caller-supplied first, then any available remote session's
  // machine, then any registered machine.
  const { machineStore } = await import('../machines/machineStore.js');
  let mid = machineId;
  if (!mid) {
    const remote = sessionStore.getAll().find(s => s.type === 'remote' && s.machineId);
    mid = remote?.machineId;
  }
  if (!mid) {
    const machines = machineStore.getAll();
    mid = machines[0]?.id;
  }
  if (!mid) throw new Error('no machine available to run summarizer');

  // Build transcript
  const transcript = messages.map(m => {
    const tagPart = m.tags.length > 0 ? ` [${m.tags.join(',')}]` : '';
    return `[${m.fromName} @ ${m.timestamp}] (depth ${m.depth})${tagPart}\n${m.content}`;
  }).join('\n\n---\n\n');

  // Include prior compaction summaries so the new compaction is cumulative.
  const priorSummaries = (channel.compactions ?? [])
    .map((c, i) => `### Prior compaction ${i + 1} (${c.createdAt})\n${c.summary}`)
    .join('\n\n');

  const rawPrompt = [
    `You are compacting the conversation history of channel "${channel.name}".`,
    'Produce a faithful, dense summary that preserves EVERYTHING the agents will',
    'need to keep working — open decisions, unresolved questions, action items,',
    'next steps, blockers, and every reference to bJira-* tickets and bCONF-*',
    'docs by ID. Use plain markdown with the following sections:',
    '',
    '  ## Context — what the channel is about',
    '  ## Decisions reached',
    '  ## Open questions',
    '  ## Action items / next steps',
    '  ## Active bJira tickets and bCONF docs (by ID)',
    '',
    'Be dense, not verbose. Skip pleasantries. Quote concrete numbers, paths,',
    'commands, file names, and IDs verbatim. Length: aim for 1/4 to 1/8 of the',
    'original transcript.',
    '',
    priorSummaries ? `## Earlier compaction summaries (already folded in)\n${priorSummaries}\n` : '',
    '## Transcript to compact',
    transcript,
  ].filter(Boolean).join('\n');

  const prompt = compressForDispatch(rawPrompt, `compact ${channelId}`);

  const machine = machineStore.get(mid);
  if (!machine) throw new Error('machine not found');

  const { runClaudeOverSsh } = await import('../ssh/sshRunner.js');
  let summary = '';
  await runClaudeOverSsh(machine, prompt, '', (chunk) => {
    const c = chunk as Record<string, unknown>;
    if (c.type === 'stream_event') {
      const evt = c.event as Record<string, unknown> | undefined;
      if (evt?.type === 'content_block_delta') {
        const delta = evt.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          summary += delta.text;
        }
      }
    }
    if (c.type === 'assistant') {
      const content = (c.message as Record<string, unknown>)?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
            summary += (block as Record<string, unknown>).text as string;
          }
        }
      }
    }
    if (c.type === 'result' && typeof c.result === 'string' && !summary) {
      summary = c.result;
    }
  });

  if (!summary.trim()) throw new Error('summarizer produced empty output');

  // Archive originals + drop them from live store
  const compaction = hubStore.compactChannel(channelId, summary, by);
  if (!compaction) throw new Error('compaction failed');

  // Post the new seed message — depth=0 (root), no parent.
  // Mark the message so the dashboard can render a "📜 compacted from N
  // messages" badge instead of treating it as a normal user post.
  const seedContent = `📜 **Channel compacted** — ${compaction.messageIds.length} messages folded into ${compaction.id}\n\n${summary}`;
  const seedMessage = postHubMessage({
    from: by,
    fromName: by,
    content: seedContent,
    channelIds: [channelId],
    tags: ['compaction'],
  });

  // Broadcast a channel-changed event so dashboards reload the message list
  broadcastToDashboards({
    type: 'DASHBOARD_EVENT',
    event: 'CHANNEL_COMPACTED',
    channelId,
    compactionId: compaction.id,
    seedMessageId: seedMessage.id,
  });

  return { seedMessage, compaction };
}

/** Compact output using a utility Claude CLI on the same machine. */
export async function compactOutput(machineId: string, rawOutput: string): Promise<string> {
  try {
    const { machineStore } = await import('../machines/machineStore.js');
    const { runClaudeOverSsh } = await import('../ssh/sshRunner.js');

    const machine = machineStore.get(machineId);
    if (!machine) return rawOutput;

    const prompt = `Summarize this work output in 2-3 concise paragraphs. Focus on what was done, what changed, and any issues found:\n\n${rawOutput}`;
    let result = '';

    await runClaudeOverSsh(
      machine,
      prompt,
      '',
      (chunk) => {
        const c = chunk as Record<string, unknown>;
        if (c.type === 'stream_event') {
          const evt = c.event as Record<string, unknown> | undefined;
          if (evt?.type === 'content_block_delta') {
            const delta = evt.delta as Record<string, unknown> | undefined;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              result += delta.text;
            }
          }
        }
      },
    );

    return result || rawOutput;
  } catch {
    return rawOutput;
  }
}
