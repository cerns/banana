import { sessionStore } from '../sessions/sessionStore.js';
import { machineStore } from '../machines/machineStore.js';
import { updateClaudeSessionId } from '../sessions/sessionManager.js';
import { broadcastToDashboards } from '../ws/dashboardBroadcast.js';
import { pushManager } from '../push/pushManager.js';
import { runClaudeOverSsh } from './sshRunner.js';

/** Active SSH executions — keyed by sessionId for abort support. */
const activeExecutions = new Map<string, AbortController>();

/** Job completion callbacks — keyed by jobId. */
const completionCallbacks = new Map<string, Array<(sessionId: string, jobId: string) => void>>();

/** Register a callback to fire when a specific job completes. */
export function onJobComplete(jobId: string, callback: (sessionId: string, jobId: string) => void): void {
  const cbs = completionCallbacks.get(jobId) ?? [];
  cbs.push(callback);
  completionCallbacks.set(jobId, cbs);
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

/** Check if a session has an active SSH execution. */
export function isSessionBusy(sessionId: string): boolean {
  return activeExecutions.has(sessionId);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Execute a Claude prompt on a remote machine via SSH.
 * Fire-and-forget — the caller does not await this. Output is streamed
 * to the session store and broadcast to connected dashboards.
 */
export function executeRemoteJob(sessionId: string, jobId: string, prompt: string): void {
  // Intentionally not awaited — runs in background
  runJob(sessionId, jobId, prompt).catch((err) => {
    console.error(`[remote-executor] Unexpected error for session=${sessionId} job=${jobId}:`, err);
  });
}

async function runJob(sessionId: string, jobId: string, prompt: string): Promise<void> {
  const session = sessionStore.get(sessionId);
  if (!session || session.type !== 'remote' || !session.machineId) {
    sessionStore.errorJob(sessionId, jobId, 'Invalid remote session configuration');
    broadcastError(sessionId, jobId, 'Invalid remote session configuration');
    return;
  }

  const machine = machineStore.get(session.machineId);
  if (!machine) {
    sessionStore.errorJob(sessionId, jobId, `Machine ${session.machineId} not found`);
    broadcastError(sessionId, jobId, `Machine ${session.machineId} not found`);
    return;
  }

  const workdir = session.remoteWorkdir ?? machine.defaultWorkdir ?? '';
  const resumeId = session.claudeSessionId;

  // Abort any prior execution for this session (only one active per session)
  const existing = activeExecutions.get(sessionId);
  if (existing) existing.abort();

  const controller = new AbortController();
  activeExecutions.set(sessionId, controller);

  try {
    const result = await runClaudeOverSsh(
      machine,
      prompt,
      workdir,
      (chunk) => {
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
      session.model,
    );

    sessionStore.finishJob(sessionId, jobId, result.exitCode, result.durationMs);

    // Persist the claude session ID for future --resume
    if (result.claudeSessionId) {
      updateClaudeSessionId(sessionId, result.claudeSessionId);
    }

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

    fireCompletionCallbacks(sessionId, jobId);

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    sessionStore.errorJob(sessionId, jobId, errorMsg);
    broadcastError(sessionId, jobId, errorMsg);

    const host = session.name ?? machine.alias;
    const folder = workdir.split('/').pop() ?? '';
    pushManager.sendPush(`❌ ${host} couldn't start`, `${folder} · ${errorMsg.slice(0, 100)}`).catch(() => {});

    fireCompletionCallbacks(sessionId, jobId);

  } finally {
    // Only remove if this is still the current execution (not replaced by a newer one)
    if (activeExecutions.get(sessionId) === controller) {
      activeExecutions.delete(sessionId);
    }
  }
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

/** Abort an active SSH execution for a session. */
export function abortRemoteJob(sessionId: string): boolean {
  const controller = activeExecutions.get(sessionId);
  if (!controller) return false;
  controller.abort();
  return true;
}
