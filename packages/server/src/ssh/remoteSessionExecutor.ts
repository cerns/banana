import { sessionStore } from '../sessions/sessionStore.js';
import { machineStore } from '../machines/machineStore.js';
import { updateClaudeSessionId } from '../sessions/sessionManager.js';
import { broadcastToDashboards } from '../ws/dashboardBroadcast.js';
import { pushManager } from '../push/pushManager.js';
import { runClaudeOverSsh, getRemoteContextTokens } from './sshRunner.js';
import { config } from '../config.js';

/** Active SSH executions — keyed by sessionId for abort support. */
const activeExecutions = new Map<string, AbortController>();

/** Per-session job queue — jobs waiting to run when the session is busy. */
interface PendingJob {
  jobId: string;
  prompt: string;
  modelOverride?: string;
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

/** Check if a session has an active SSH execution. */
export function isSessionBusy(sessionId: string): boolean {
  return activeExecutions.has(sessionId);
}

/** Return the set of session IDs that currently have active SSH executions. */
export function getActiveSessionIds(): string[] {
  return Array.from(activeExecutions.keys());
}

/** Return the number of jobs waiting in the per-session queue. */
export function getPendingJobCount(sessionId: string): number {
  return pendingQueue.get(sessionId)?.length ?? 0;
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
export function executeRemoteJob(sessionId: string, jobId: string, prompt: string, modelOverride?: string): void {
  if (activeExecutions.has(sessionId)) {
    // Session is busy — queue for sequential execution instead of aborting
    const queue = pendingQueue.get(sessionId) ?? [];
    queue.push({ jobId, prompt, modelOverride });
    pendingQueue.set(sessionId, queue);
    console.log(`[remote-executor] Session ${sessionId.slice(0, 8)} busy — queued job ${jobId.slice(0, 8)} (${queue.length} pending)`);
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
  runJob(sessionId, jobId, prompt, modelOverride).catch((err) => {
    console.error(`[remote-executor] Unexpected error for session=${sessionId} job=${jobId}:`, err);
  });
}

async function runJob(sessionId: string, jobId: string, prompt: string, modelOverride?: string): Promise<void> {
  const session = sessionStore.get(sessionId);
  if (!session || session.type !== 'remote' || !session.machineId) {
    sessionStore.errorJob(sessionId, jobId, 'Invalid remote session configuration');
    broadcastError(sessionId, jobId, 'Invalid remote session configuration');
    // Still fire callbacks so hub can decrement counters and drain queues
    fireCompletionCallbacks(sessionId, jobId);
    drainSessionQueue(sessionId);
    fireGlobalCallbacks(sessionId, jobId);
    return;
  }

  const machine = machineStore.get(session.machineId);
  if (!machine) {
    sessionStore.errorJob(sessionId, jobId, `Machine ${session.machineId} not found`);
    broadcastError(sessionId, jobId, `Machine ${session.machineId} not found`);
    fireCompletionCallbacks(sessionId, jobId);
    drainSessionQueue(sessionId);
    fireGlobalCallbacks(sessionId, jobId);
    return;
  }

  const workdir = session.remoteWorkdir ?? machine.defaultWorkdir ?? '';
  let resumeId = session.claudeSessionId;

  const controller = new AbortController();
  activeExecutions.set(sessionId, controller);

  try {
    const sid8 = sessionId.slice(0, 8);
    const jid8 = jobId.slice(0, 8);

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
    // Free the session FIRST so callbacks see it as available for queue drain.
    if (activeExecutions.get(sessionId) === controller) {
      activeExecutions.delete(sessionId);
    }

    // Per-job callbacks (hub dispatch completion handlers — update hub state, don't start new jobs)
    fireCompletionCallbacks(sessionId, jobId);

    // Drain per-session queue — start the next queued job before hub queue
    // drain so that already-submitted jobs execute in order. Hub queue items
    // will wait until the per-session queue is empty.
    drainSessionQueue(sessionId);

    // Global callbacks (hub queue drain for ALL job types including ad-hoc)
    fireGlobalCallbacks(sessionId, jobId);
  }
}

/**
 * Drain the per-session job queue — start the next queued job if the session
 * is free. Called in the finally block after each job completes.
 */
function drainSessionQueue(sessionId: string): void {
  if (activeExecutions.has(sessionId)) return; // safety check
  const queue = pendingQueue.get(sessionId);
  if (!queue || queue.length === 0) {
    pendingQueue.delete(sessionId);
    return;
  }
  const next = queue.shift()!;
  if (queue.length === 0) pendingQueue.delete(sessionId);

  console.log(`[remote-executor] Draining queue for ${sessionId.slice(0, 8)} → job ${next.jobId.slice(0, 8)} (${queue.length} remaining)`);

  runJob(sessionId, next.jobId, next.prompt, next.modelOverride).catch((err) => {
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

/** Abort an active SSH execution for a session and clear any pending queue. */
export function abortRemoteJob(sessionId: string): boolean {
  // Clear pending queue — abort means "stop everything for this session"
  const queuedCount = pendingQueue.get(sessionId)?.length ?? 0;
  pendingQueue.delete(sessionId);
  if (queuedCount > 0) {
    console.log(`[remote-executor] Cleared ${queuedCount} queued job(s) for ${sessionId.slice(0, 8)}`);
  }

  const controller = activeExecutions.get(sessionId);
  if (!controller) return queuedCount > 0;
  controller.abort();
  return true;
}
