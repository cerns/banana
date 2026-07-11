import { sessionStore } from '../sessions/sessionStore.js';
import { machineStore } from '../machines/machineStore.js';
import { updateClaudeSessionId } from '../sessions/sessionManager.js';
import { broadcastToDashboards } from '../ws/dashboardBroadcast.js';
import { pushManager } from '../push/pushManager.js';
import { runClaudeOverSsh, getRemoteContextTokens, type SshRunOptions } from './sshRunner.js';
import { runClaudeViaTmuxForSession, abortTmuxJob, clearTmuxSession } from './tmuxRunner.js';
import { config } from '../config.js';

/**
 * Execution channel:
 *   'work'                    — direct sends (dashboard chat, CLI banana send)
 *   'hub'                     — hub chat dispatches (listen/chat/engage engagement)
 *   `hub-channel:${channelId}` — triggered work from a specific hub channel
 *                               Each channel gets its own tmux session so one agent
 *                               can handle triggered work from multiple channels in parallel.
 */
export type ExecChannel = 'work' | 'hub' | `hub-channel:${string}`;

/** Extract the channel ID slug from a hub-channel ExecChannel string. */
function hubChSlug(channel: ExecChannel): string {
  return channel.slice('hub-channel:'.length);
}

/**
 * Build the execution key for activeExecutions/pendingQueue Maps.
 * Persistent tmux sessions get separate channels; non-persistent share one process.
 */
function execKey(sessionId: string, channel: ExecChannel, persistentMode?: boolean): string {
  if (persistentMode) {
    if (channel === 'hub') return `${sessionId}:hub`;
    if (channel.startsWith('hub-channel:')) return `${sessionId}:hub-ch-${hubChSlug(channel)}`;
  }
  return sessionId;
}

/** Map ExecChannel to tmux suffix. Matches the name used by tmuxRunner. */
function tmuxSuffix(channel: ExecChannel): string | undefined {
  if (channel === 'hub') return '-hub';
  if (channel.startsWith('hub-channel:')) return `-hub-ch-${hubChSlug(channel)}`;
  return undefined;
}

/** Active SSH executions — keyed by execKey for abort support. */
const activeExecutions = new Map<string, AbortController>();

/** Per-session job queue — jobs waiting to run when the session is busy. */
interface PendingJob {
  jobId: string;
  prompt: string;
  modelOverride?: string;
  channel: ExecChannel;
  /** Extended SSH options (bare, systemPrompt, maxTurns). */
  sshOpts?: SshRunOptions;
}
const pendingQueue = new Map<string, PendingJob[]>();

/** Job completion callbacks — keyed by jobId. */
const completionCallbacks = new Map<string, Array<(sessionId: string, jobId: string) => void>>();

/** Global callbacks — fire after EVERY job completes (regardless of hub routing). */
const globalCallbacks: Array<(sessionId: string, jobId: string) => void> = [];

/** Register a callback to fire when a specific job completes. */
export function onJobComplete(jobId: string, callback: (sessionId: string, jobId: string) => void): void {
  const cbs = completionCallbacks.get(jobId) ?? [];
  cbs.push(callback);
  completionCallbacks.set(jobId, cbs);
}

/**
 * Register a callback that fires after ANY job completes — ad-hoc or hub-dispatched.
 * Used to drain hub queues after ad-hoc jobs free up a session.
 */
export function onAnyJobComplete(callback: (sessionId: string, jobId: string) => void): void {
  globalCallbacks.push(callback);
}

function fireCompletionCallbacks(sessionId: string, jobId: string): void {
  const cbs = completionCallbacks.get(jobId);
  if (!cbs) return;
  completionCallbacks.delete(jobId);
  for (const cb of cbs) {
    try { cb(sessionId, jobId); } catch (e) {
      console.error('[remote-executor] completion callback error:', e);
    }
  }
}

function fireGlobalCallbacks(sessionId: string, jobId: string): void {
  for (const cb of globalCallbacks) {
    try { cb(sessionId, jobId); } catch (e) {
      console.error('[remote-executor] global callback error:', e);
    }
  }
}

/**
 * Check if a session has an active SSH execution.
 * With no channel: returns true if ANY channel is busy.
 * With channel: checks only that specific channel (requires knowing persistentMode).
 */
export function isSessionBusy(sessionId: string, channel?: ExecChannel): boolean {
  if (!channel) {
    if (activeExecutions.has(sessionId)) return true;
    for (const key of activeExecutions.keys()) {
      if (key.startsWith(`${sessionId}:`)) return true;
    }
    return false;
  }
  // Channel-specific check — need machine info
  const session = sessionStore.get(sessionId);
  const machine = session?.machineId ? machineStore.get(session.machineId) : undefined;
  const key = execKey(sessionId, channel, machine?.persistentMode);
  return activeExecutions.has(key);
}

/** Return the set of session IDs that currently have active SSH executions. */
export function getActiveSessionIds(): string[] {
  const ids = new Set<string>();
  for (const key of activeExecutions.keys()) {
    const colonIdx = key.indexOf(':');
    ids.add(colonIdx >= 0 ? key.slice(0, colonIdx) : key);
  }
  return Array.from(ids);
}

/** Return the number of jobs waiting in the per-session queue. */
export function getPendingJobCount(sessionId: string): number {
  let total = 0;
  for (const [key, jobs] of pendingQueue.entries()) {
    if (key === sessionId || key.startsWith(`${sessionId}:`)) total += jobs.length;
  }
  return total;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`;
}

function fmtBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}kB`;
  return `${n}B`;
}

/**
 * Execute a Claude prompt on a remote machine via SSH.
 * Fire-and-forget — the caller does not await this. Output is streamed
 * to the session store and broadcast to connected dashboards.
 *
 * If the session is already busy (running another job), the job is queued
 * and will execute automatically when the current job finishes. This
 * ensures correct ordering when multiple prompts target the same session.
 */
export function executeRemoteJob(sessionId: string, jobId: string, prompt: string, modelOverride?: string, channel: ExecChannel = 'work', sshOpts?: SshRunOptions): void {
  // Determine execution key based on channel and machine mode
  const session = sessionStore.get(sessionId);
  const machine = session?.machineId ? machineStore.get(session.machineId) : undefined;
  const key = execKey(sessionId, channel, machine?.persistentMode);

  if (activeExecutions.has(key)) {
    // Channel is busy — queue for sequential execution
    const queue = pendingQueue.get(key) ?? [];
    queue.push({ jobId, prompt, modelOverride, channel, sshOpts });
    pendingQueue.set(key, queue);
    console.log(`[remote-executor] Session ${sessionId.slice(0, 8)} [${channel}] busy — queued job ${jobId.slice(0, 8)} (${queue.length} pending)`);
    broadcastToDashboards({
      type: 'DASHBOARD_EVENT',
      event: 'JOB_QUEUED',
      sessionId,
      jobId,
      queueLength: queue.length,
    });
    return;
  }

  // Intentionally not awaited — runs in background
  runJob(sessionId, jobId, prompt, modelOverride, channel, sshOpts).catch((err) => {
    console.error(`[remote-executor] Unexpected error for session=${sessionId} job=${jobId}:`, err);
  });
}

async function runJob(sessionId: string, jobId: string, prompt: string, modelOverride?: string, channel: ExecChannel = 'work', sshOpts?: SshRunOptions): Promise<void> {
  const session = sessionStore.get(sessionId);
  if (!session || session.type !== 'remote' || !session.machineId) {
    sessionStore.errorJob(sessionId, jobId, 'Invalid remote session configuration');
    broadcastError(sessionId, jobId, 'Invalid remote session configuration');
    // Still fire callbacks so hub can decrement counters and drain queues
    fireCompletionCallbacks(sessionId, jobId);
    drainSessionQueue(sessionId, channel);
    fireGlobalCallbacks(sessionId, jobId);
    return;
  }

  const machine = machineStore.get(session.machineId);
  if (!machine) {
    sessionStore.errorJob(sessionId, jobId, `Machine ${session.machineId} not found`);
    broadcastError(sessionId, jobId, `Machine ${session.machineId} not found`);
    fireCompletionCallbacks(sessionId, jobId);
    drainSessionQueue(sessionId, channel);
    fireGlobalCallbacks(sessionId, jobId);
    return;
  }

  const workdir = session.remoteWorkdir ?? machine.defaultWorkdir ?? '';
  let resumeId = session.claudeSessionId;

  const key = execKey(sessionId, channel, machine.persistentMode);
  const controller = new AbortController();
  activeExecutions.set(key, controller);

  try {
    const sid8 = sessionId.slice(0, 8);
    const jid8 = jobId.slice(0, 8);

    // ── Persistent tmux mode ──────────────────────────────────────────
    if (machine.persistentMode) {
      console.log(`[remote-executor] Session ${sid8} job ${jid8} [tmux/${channel}] — prompt ${prompt.length} chars`);

      // Clear tmux before hub-originated dispatches to avoid context pollution.
      // - Hub channel: always clear (chat responses should be stateless)
      // - Work channel: clear when job has hub metadata (triggered from hub),
      //   but NOT for direct API sends (user wants context continuity)
      const jobRecord = session.jobs.find(j => j.jobId === jobId);
      const isHubOriginated = channel === 'hub' || !!jobRecord?.hubChannelId;
      if (isHubOriginated) {
        try {
          await clearTmuxSession(machine, sessionId, controller.signal, tmuxSuffix(channel));
        } catch (e) {
          console.warn(`[remote-executor] /clear failed for ${sid8} ${channel}, continuing:`, e);
        }
      }

      let outputBytes = 0;
      const result = await runClaudeViaTmuxForSession(
        machine,
        sessionId,
        prompt,
        workdir,
        (chunk) => {
          outputBytes += JSON.stringify(chunk).length;
          sessionStore.addChunk(sessionId, jobId, chunk);
          broadcastToDashboards({
            type: 'DASHBOARD_EVENT',
            event: 'OUTPUT_CHUNK',
            sessionId,
            jobId,
            chunk,
          });
        },
        controller.signal,
        modelOverride || session.model,
        tmuxSuffix(channel),
        resumeId,
      );

      sessionStore.finishJob(sessionId, jobId, result.exitCode, result.durationMs);

      // Persist claudeSessionId from tmux detection so --resume works too
      if (result.claudeSessionId) {
        updateClaudeSessionId(sessionId, result.claudeSessionId);
      }

      console.log(`[remote-executor] Session ${sid8} job ${jid8} [tmux] done — ${fmtDuration(result.durationMs)}, output ${fmtBytes(outputBytes)}${result.claudeSessionId ? ` session=${result.claudeSessionId.slice(0, 8)}` : ''}`);

      broadcastToDashboards({
        type: 'DASHBOARD_EVENT',
        event: 'OUTPUT_DONE',
        sessionId,
        jobId,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });

      const host = session.name ?? machine.alias;
      const folder = workdir.split('/').pop() ?? '';
      const dur = fmtDuration(result.durationMs);
      pushManager.sendPush(`✅ ${host} finished in ${dur}`, `${folder} · "${prompt.slice(0, 80)}"`).catch(() => {});

      return;
    }

    // ── Standard --print mode ──────────────────────────────────────────

    // ── Pre-job context check ──────────────────────────────────────────
    let preContextTokens: number | undefined;
    if (resumeId) {
      try {
        preContextTokens = await getRemoteContextTokens(machine, workdir, resumeId, controller.signal);
      } catch { /* non-critical */ }
      if (preContextTokens !== undefined) {
        sessionStore.updateMeta(sessionId, { lastInputTokens: preContextTokens });
      }
    }

    console.log(`[remote-executor] Session ${sid8} job ${jid8} start — prompt ${prompt.length} chars${preContextTokens ? `, context ${fmtTokens(preContextTokens)}` : resumeId ? ', context unknown' : ', new session'}`);

    // ── Auto-compact: keep context window lean on long-running sessions ──
    if (resumeId && config.compactTokenThreshold > 0 && preContextTokens !== undefined && preContextTokens >= config.compactTokenThreshold) {
      console.log(`[remote-executor] Session ${sid8} context ${fmtTokens(preContextTokens)} >= ${fmtTokens(config.compactTokenThreshold)} — running /compact`);
      broadcastToDashboards({
        type: 'DASHBOARD_EVENT',
        event: 'SESSION_COMPACTING',
        sessionId,
        inputTokens: preContextTokens,
      });
      try {
        const compactResult = await runClaudeOverSsh(
          machine,
          '/compact',
          workdir,
          () => {}, // discard compact output
          resumeId,
          controller.signal,
          modelOverride || session.model,
        );
        if (compactResult.claudeSessionId) {
          updateClaudeSessionId(sessionId, compactResult.claudeSessionId);
          resumeId = compactResult.claudeSessionId;
        }
        console.log(`[remote-executor] /compact done for ${sid8} in ${fmtDuration(compactResult.durationMs)}`);
      } catch (compactErr) {
        // Don't fail the actual job — just log and continue
        console.warn(`[remote-executor] /compact failed for ${sid8}, continuing:`, compactErr);
      }
    }

    let outputBytes = 0;
    const result = await runClaudeOverSsh(
      machine,
      prompt,
      workdir,
      (chunk) => {
        outputBytes += JSON.stringify(chunk).length;
        sessionStore.addChunk(sessionId, jobId, chunk);
        broadcastToDashboards({
          type: 'DASHBOARD_EVENT',
          event: 'OUTPUT_CHUNK',
          sessionId,
          jobId,
          chunk,
        });
      },
      resumeId,
      controller.signal,
      modelOverride || session.model,
      sshOpts,
    );

    sessionStore.finishJob(sessionId, jobId, result.exitCode, result.durationMs);

    // Persist the claude session ID for future --resume
    if (result.claudeSessionId) {
      updateClaudeSessionId(sessionId, result.claudeSessionId);
    }

    // Read actual context size from remote JSONL (sums input + cache tokens)
    const finalSessionId = result.claudeSessionId ?? resumeId;
    let postContextTokens: number | undefined;
    if (finalSessionId) {
      try {
        postContextTokens = await getRemoteContextTokens(machine, workdir, finalSessionId);
      } catch { /* non-critical */ }
      if (postContextTokens !== undefined) {
        sessionStore.updateMeta(sessionId, { lastInputTokens: postContextTokens });
      }
    }

    console.log(`[remote-executor] Session ${sid8} job ${jid8} done — exit ${result.exitCode}, ${fmtDuration(result.durationMs)}, output ${fmtBytes(outputBytes)}${postContextTokens ? `, context ${fmtTokens(postContextTokens)}` : ''}`);

    broadcastToDashboards({
      type: 'DASHBOARD_EVENT',
      event: 'OUTPUT_DONE',
      sessionId,
      jobId,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    });

    // Push notification
    const host = session.name ?? machine.alias;
    const folder = workdir.split('/').pop() ?? '';
    const dur = fmtDuration(result.durationMs);
    const title = result.exitCode === 0
      ? `✅ ${host} finished in ${dur}`
      : `⚠️ ${host} failed · exit ${result.exitCode} · ${dur}`;
    pushManager.sendPush(title, `${folder} · "${prompt.slice(0, 80)}"`).catch(() => {});

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    sessionStore.errorJob(sessionId, jobId, errorMsg);
    broadcastError(sessionId, jobId, errorMsg);

    const host = session.name ?? machine.alias;
    const folder = workdir.split('/').pop() ?? '';
    pushManager.sendPush(`❌ ${host} couldn't start`, `${folder} · ${errorMsg.slice(0, 100)}`).catch(() => {});

  } finally {
    // Free the execution slot FIRST so callbacks see it as available for queue drain.
    if (activeExecutions.get(key) === controller) {
      activeExecutions.delete(key);
    }

    // Per-job callbacks (hub dispatch completion handlers — update hub state, don't start new jobs)
    fireCompletionCallbacks(sessionId, jobId);

    // Drain per-channel queue — start the next queued job before hub queue
    // drain so that already-submitted jobs execute in order. Hub queue items
    // will wait until the per-session queue is empty.
    drainSessionQueue(sessionId, channel);

    // Global callbacks (hub queue drain for ALL job types including ad-hoc)
    fireGlobalCallbacks(sessionId, jobId);
  }
}

/**
 * Drain the per-channel job queue — start the next queued job if the
 * execution slot is free. Called in the finally block after each job completes.
 */
function drainSessionQueue(sessionId: string, channel: ExecChannel = 'work'): void {
  const session = sessionStore.get(sessionId);
  const machine = session?.machineId ? machineStore.get(session.machineId) : undefined;
  const key = execKey(sessionId, channel, machine?.persistentMode);

  if (activeExecutions.has(key)) return; // safety check
  const queue = pendingQueue.get(key);
  if (!queue || queue.length === 0) {
    pendingQueue.delete(key);
    return;
  }
  const next = queue.shift()!;
  if (queue.length === 0) pendingQueue.delete(key);

  console.log(`[remote-executor] Draining queue for ${sessionId.slice(0, 8)} [${channel}] → job ${next.jobId.slice(0, 8)} (${queue.length} remaining)`);

  runJob(sessionId, next.jobId, next.prompt, next.modelOverride, next.channel, next.sshOpts).catch((err) => {
    console.error(`[remote-executor] Unexpected error for session=${sessionId} job=${next.jobId}:`, err);
  });
}

function broadcastError(sessionId: string, jobId: string, error: string): void {
  broadcastToDashboards({
    type: 'DASHBOARD_EVENT',
    event: 'OUTPUT_ERROR',
    sessionId,
    jobId,
    error,
  });
}

/** All exec keys (activeExecutions/pendingQueue) belonging to a session: bare, :hub, :hub-ch-*. */
function execKeysForSession(sessionId: string): string[] {
  const keys = new Set<string>([sessionId, `${sessionId}:hub`]);
  for (const key of activeExecutions.keys()) {
    if (key === sessionId || key.startsWith(`${sessionId}:`)) keys.add(key);
  }
  for (const key of pendingQueue.keys()) {
    if (key === sessionId || key.startsWith(`${sessionId}:`)) keys.add(key);
  }
  return [...keys];
}

/** Map an exec key back to its tmux suffix ('' for work, '-hub', '-hub-ch-…'). */
function tmuxSuffixForKey(sessionId: string, key: string): string {
  return key === sessionId ? '' : `-${key.slice(sessionId.length + 1)}`;
}

/** Abort all active SSH executions for a session and clear pending queues on every channel. */
export function abortRemoteJob(sessionId: string): boolean {
  // Abort means "stop everything for this session" — work, hub, and every hub-channel key.
  // IMPORTANT: Fire completion callbacks for cleared jobs so hub counters (runningHubJobs)
  // decrement properly. Without this, dispatchToSession's runningHubJobs++ is never
  // matched by onSessionJobComplete's runningHubJobs-- and the counter grows without bound.
  const keys = execKeysForSession(sessionId);
  const clearedJobs: PendingJob[] = [];
  for (const key of keys) {
    clearedJobs.push(...(pendingQueue.get(key) ?? []));
    pendingQueue.delete(key);
  }
  const queuedCount = clearedJobs.length;
  if (queuedCount > 0) {
    console.log(`[remote-executor] Cleared ${queuedCount} queued job(s) for ${sessionId.slice(0, 8)}`);
    // Fire completion callbacks for each cleared job — this lets hub's
    // onSessionJobComplete decrement runningHubJobs and mark dispatches as error/aborted.
    for (const job of clearedJobs) {
      sessionStore.errorJob(sessionId, job.jobId, 'Aborted (queue cleared)');
      fireCompletionCallbacks(sessionId, job.jobId);
      fireGlobalCallbacks(sessionId, job.jobId);
    }
  }

  // Clear hub message queue (persisted on SessionRecord) and mark dispatches as aborted
  try {
    const { clearSessionQueue } = require('../hub/hubRouter.js');
    clearSessionQueue(sessionId);
  } catch { /* hub module may not be loaded yet */ }

  // Abort every active controller for this session (work, hub, hub-ch-*)
  let aborted = queuedCount > 0;
  for (const key of keys) {
    const controller = activeExecutions.get(key);
    if (controller) { controller.abort(); aborted = true; }
  }

  // For tmux sessions, send C-c to every tmux session belonging to this sessionId
  const session = sessionStore.get(sessionId);
  if (session?.machineId) {
    const machine = machineStore.get(session.machineId);
    if (machine?.persistentMode) {
      for (const key of keys) {
        const sfx = tmuxSuffixForKey(sessionId, key);
        const p = sfx ? abortTmuxJob(machine, sessionId, sfx) : abortTmuxJob(machine, sessionId);
        p.catch((e) => {
          console.warn(`[remote-executor] tmux abort (${sfx || 'work'}) failed: ${(e as Error).message}`);
        });
      }
    }
  }

  return aborted;
}

