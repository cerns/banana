#!/usr/bin/env node
import { config } from './config.js';
import { sessionStore } from './sessions/sessionStore.js';
import { machineStore } from './machines/machineStore.js';
import { hubStore } from './hub/hubStore.js';
import { taskStore } from './hub/taskStore.js';
import { docStore } from './hub/docStore.js';
import { createHttpServer } from './http/httpServer.js';
import { createWsServer } from './ws/wsServer.js';
import { pushManager } from './push/pushManager.js';
import { onAnyJobComplete } from './ssh/remoteSessionExecutor.js';
import { processQueue, drainGlobalQueue, extractTextFromChunks, postHubMessage } from './hub/hubRouter.js';
import { parseReplyToChannel, stripReplyToChannel, extractArtifactActions, parseReplyRouting, extractChannelReply } from './hub/channelArtifactExtractor.js';
import { broadcastToDashboards } from './ws/dashboardBroadcast.js';
import { jumpHostStore } from './ssh/jumpHostStore.js';
import { closeJumpTunnelCache } from './ssh/sshRunner.js';
import { closeTmuxConnections, reconcileSession } from './ssh/tmuxRunner.js';
import { updateClaudeSessionId } from './sessions/sessionManager.js';
import { abortRemoteJob, getActiveSessionIds } from './ssh/remoteSessionExecutor.js';

sessionStore.load();
machineStore.load();
hubStore.load();
taskStore.load();
docStore.load();
jumpHostStore.load();
pushManager.init();

// After ANY job completes (ad-hoc or hub-dispatched), drain hub queues
// AND check for channel reply markers in job output.
// This fires AFTER activeExecutions.delete so the session is free and
// processQueue/drainGlobalQueue can dispatch the next queued item.
onAnyJobComplete((sessionId, jobId) => {
  processQueue(sessionId);
  drainGlobalQueue();

  const session = sessionStore.get(sessionId);
  if (!session) return;
  const job = session.jobs.find(j => j.jobId === jobId);
  if (!job) return;

  // Hub/trigger/self-trigger/talking jobs are handled by onSessionJobComplete
  // in hubRouter.ts. However, if that flow somehow fails to post a channel
  // reply, we act as a safety net here. Ad-hoc jobs always go through this path.
  const isHubJob = job.source && job.source !== 'adhoc';

  const rawOutput = extractTextFromChunks(job.chunks ?? [], { skipToolOutput: true });

  // ── Strategy 1: Full [REPLY_TO_CHANNEL][#ch][%msg]...[/REPLY_TO_CHANNEL] in output
  // (agent explicitly provided both routing and content in the output)
  if (!isHubJob) {
    const replyTarget = parseReplyToChannel(rawOutput);
    if (replyTarget) {
      const channel = hubStore.getChannel(replyTarget.channelId);
      const parentMsg = hubStore.getMessage(replyTarget.messageId);
      if (!channel) {
        console.warn(`[banana] REPLY_TO_CHANNEL: channel "${replyTarget.channelId}" not found — skipped`);
      } else {
        const screenName = session.screenName ?? session.name ?? sessionId.slice(0, 8);
        console.log(`[banana] REPLY_TO_CHANNEL from ad-hoc job → #${replyTarget.channelId} msg ${replyTarget.messageId.slice(0, 8)}`);
        postHubMessage({
          from: sessionId,
          fromName: screenName,
          content: replyTarget.content,
          channelIds: [replyTarget.channelId],
          tags: parentMsg?.tags ?? [],
          mentions: [],
          parentId: parentMsg ? replyTarget.messageId : undefined,
          depth: parentMsg ? parentMsg.depth + 1 : 0,
        });
        return; // Done — don't also try strategy 2
      }
    }
  }

  // ── Strategy 2: [CHANNEL_REPLY] in output + routing from job prompt
  // The agent used [CHANNEL_REPLY]...[/CHANNEL_REPLY] (content-only) and the
  // routing metadata [REPLY_TO_CHANNEL][#ch][%msg] was in the job prompt.
  // For hub-dispatched jobs, onSessionJobComplete handles this already, but
  // this acts as a safety net. For ad-hoc jobs with prompt routing, this is
  // the primary path.
  const channelReply = extractChannelReply(rawOutput);
  if (!channelReply) return;

  // Extract routing from the job's prompt (where the system injected it)
  let routing = parseReplyRouting(job.prompt ?? '');

  // No routing in prompt — fall back to the session's channel subscriptions.
  // This handles adhoc jobs where the agent learned [CHANNEL_REPLY] from a
  // previous hub dispatch (via --resume conversation history) but the manual
  // prompt has no routing header.
  if (!routing && !isHubJob && session.channels?.length) {
    const fallbackChannel = session.channels[0];
    // Post as a new top-level message (no parent) — the adhoc job's output
    // isn't necessarily related to any specific thread in the channel.
    routing = {
      channelId: fallbackChannel,
      messageId: '',
    };
    console.log(`[banana] CHANNEL_REPLY: no routing in prompt — falling back to session channel #${fallbackChannel}`);
  }

  if (!routing) {
    if (!isHubJob) {
      console.warn(`[banana] [CHANNEL_REPLY] found in output but no routing and no session channels — cannot post`);
    }
    // For hub jobs, onSessionJobComplete should have already handled this
    return;
  }

  // For hub jobs, check if a reply was already posted (onSessionJobComplete ran first)
  // by looking for the job's dispatch status in the hub store. If already 'acted',
  // onSessionJobComplete already posted the reply — skip to avoid duplicates.
  if (isHubJob) {
    // Find the hub message this job was dispatched from
    const allMessages = hubStore.getByChannel(routing.channelId);
    const alreadyPosted = allMessages.some(m =>
      m.dispatches?.some(d => d.jobId === jobId && d.status === 'acted')
    );
    if (alreadyPosted) return; // onSessionJobComplete already handled it
  }

  const channel = hubStore.getChannel(routing.channelId);
  const parentMsg = hubStore.getMessage(routing.messageId);
  if (!channel) {
    console.warn(`[banana] CHANNEL_REPLY: channel "${routing.channelId}" not found — skipped`);
    return;
  }

  const screenName = session.screenName ?? session.name ?? sessionId.slice(0, 8);
  console.log(`[banana] CHANNEL_REPLY (${isHubJob ? 'fallback' : 'adhoc'}) → #${routing.channelId} msg ${routing.messageId.slice(0, 8)}`);

  // Run artifact extraction on the reply content (bJIRA/bCONF markers)
  const actions = extractArtifactActions(channelReply);
  // Apply any task/doc actions embedded in the reply
  for (const f of actions.taskCreates) taskStore.createTask(routing.channelId, f, screenName);
  for (const u of actions.taskUpdates) taskStore.updateTask(u.id, u, screenName);
  for (const c of actions.taskComments) taskStore.addComment(c.id, c.text, screenName);
  for (const w of actions.docWrites) docStore.createDoc(routing.channelId, w.title, w.body, screenName, w.tags ?? []);
  for (const u of actions.docUpdates) docStore.updateDoc(u.id, { title: u.title, body: u.body, tags: u.tags }, screenName);
  for (const a of actions.docAppends) docStore.appendDoc(a.id, a.text, screenName);

  postHubMessage({
    from: sessionId,
    fromName: screenName,
    content: actions.cleanedText || channelReply,
    channelIds: [routing.channelId],
    tags: parentMsg?.tags ?? [],
    mentions: [],
    parentId: parentMsg ? routing.messageId : undefined,
    depth: parentMsg ? parentMsg.depth + 1 : 0,
  });
});

const httpServer = createHttpServer();
const wss = createWsServer(httpServer);

httpServer.listen(config.port, () => {
  console.log(`[banana] Server running on http://localhost:${config.port}`);
  console.log(`[banana] Dashboard: http://localhost:${config.port}`);
  console.log(`[banana] Token configured: ${config.token ? 'yes' : 'NO (set BANANA_TOKEN)'}`);

  // Recover queued hub dispatches from previous session. Runs after the
  // HTTP server is ready so SSH connections can be established.
  const pending = sessionStore.getAll().filter(s => s.hubQueue?.length).length;
  if (pending > 0) {
    console.log(`[banana] Recovering queued hub dispatches for ${pending} session(s)`);
    drainGlobalQueue();
  }

  // Reconcile tmux sessions — ensure every persistent-mode session has both
  // a running tmux session and a claudeSessionId. Runs in background.
  reconcileAllSessions().catch(e => console.warn('[banana] Session reconciliation error:', e));
});

httpServer.on('error', (err) => {
  console.error('[banana] Server error:', err);
  process.exit(1);
});

/**
 * Reconcile all persistent-mode sessions on startup.
 * Ensures each has a running tmux session + claudeSessionId.
 */
async function reconcileAllSessions(): Promise<void> {
  const allSessions = sessionStore.getAll();
  const toReconcile = allSessions.filter(s => {
    if (!s.machineId) return false;
    const m = machineStore.get(s.machineId);
    return m?.persistentMode;
  });
  if (toReconcile.length === 0) return;
  console.log(`[banana] Reconciling ${toReconcile.length} persistent session(s)...`);

  // Group by machine to avoid hammering the same host in parallel
  const byMachine = new Map<string, typeof toReconcile>();
  for (const s of toReconcile) {
    const list = byMachine.get(s.machineId!) ?? [];
    list.push(s);
    byMachine.set(s.machineId!, list);
  }

  for (const [machineId, sessions] of byMachine) {
    const machine = machineStore.get(machineId);
    if (!machine) continue;
    let machineReachable = true;
    for (const s of sessions) {
      if (!machineReachable) break; // skip remaining sessions on unreachable machine
      try {
        const workdir = s.remoteWorkdir ?? machine.defaultWorkdir ?? '';
        const detected = await reconcileSession(machine, s.sessionId, workdir, s.model, s.claudeSessionId);
        if (detected) {
          updateClaudeSessionId(s.sessionId, detected);
        }
      } catch (e) {
        const msg = (e as Error).message;
        console.warn(`[banana] Reconcile failed for ${s.sessionId.slice(0, 8)}: ${msg}`);
        // If SSH connection failed, skip remaining sessions on this machine
        if (/timed out|ECONNREFUSED|ETIMEDOUT|handshake/i.test(msg)) {
          console.warn(`[banana] Machine ${machine.alias || machineId.slice(0, 8)} unreachable — skipping remaining sessions`);
          machineReachable = false;
        }
      }
    }
  }
  console.log(`[banana] Reconciliation complete`);
}

// ── Graceful shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[banana] ${signal} received — shutting down...`);

  // Force exit after 5s if cleanup hangs
  const forceTimer = setTimeout(() => {
    console.error('[banana] Shutdown timed out — forcing exit');
    process.exit(1);
  }, 5000);
  forceTimer.unref();

  try {
    // 1. Stop accepting new connections
    httpServer.close();
    wss.close();

    // 2. Abort all active SSH jobs
    for (const id of getActiveSessionIds()) {
      try { abortRemoteJob(id); } catch { /* ignore */ }
    }

    // 3. Close SSH connections
    closeTmuxConnections();
    closeJumpTunnelCache();

    // 4. Flush all pending writes
    await Promise.all([
      sessionStore.persistNow(),
      hubStore.persistNow(),
      taskStore.persistNow(),
      docStore.persistNow(),
    ]);

    console.log('[banana] Shutdown complete');
  } catch (err) {
    console.error('[banana] Shutdown error:', err);
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
