import type { IncomingMessage, ServerResponse } from 'http';
import { config } from '../config.js';
import { sessionStore } from '../sessions/sessionStore.js';
import { machineStore } from '../machines/machineStore.js';
import { createJob, resolveSessionId, createRemoteSession, updateSessionName, updateClaudeSessionId } from '../sessions/sessionManager.js';
import { reconcileSession } from '../ssh/tmuxRunner.js';
import { hubStore } from '../hub/hubStore.js';
import { taskStore } from '../hub/taskStore.js';
import type { TaskStatus, TaskPriority, UpdateTaskFields } from '../hub/taskStore.js';
import { docStore } from '../hub/docStore.js';
import type { UpdateDocFields } from '../hub/docStore.js';
import { postHubMessage, resolveScreenName, triggerSessionOnMessage, compactChannel, redoCompaction } from '../hub/hubRouter.js';
import { broadcastToDashboards } from '../ws/dashboardBroadcast.js';
import { pushManager } from '../push/pushManager.js';
import type webpush from 'web-push';
import { randomUUID } from 'crypto';

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  });
  res.end(body);
}

function auth(req: IncomingMessage): boolean {
  const header = req.headers['authorization'] ?? '';
  return header === `Bearer ${config.token}`;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export async function handleApiRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    });
    res.end();
    return true;
  }

  if (!pathname.startsWith('/api/')) return false;

  if (!auth(req)) {
    json(res, 401, { error: 'Unauthorized' });
    return true;
  }

  // GET /api/health
  if (method === 'GET' && pathname === '/api/health') {
    const sessions = sessionStore.getAll();
    const { getRunningHubJobs } = await import('../hub/hubRouter.js');
    const { getActiveSessionIds } = await import('../ssh/remoteSessionExecutor.js');
    json(res, 200, {
      status: 'ok',
      totalSessions: sessions.length,
      runningHubJobs: getRunningHubJobs(),
      activeExecutions: getActiveSessionIds().length,
      hubMaxConcurrentJobs: config.hubMaxConcurrentJobs,
      uptime: process.uptime(),
    });
    return true;
  }

  // POST /api/hub/reset-counter — emergency reset for stuck runningHubJobs counter
  if (method === 'POST' && pathname === '/api/hub/reset-counter') {
    const { resetRunningHubJobs, drainGlobalQueue } = await import('../hub/hubRouter.js');
    resetRunningHubJobs();
    drainGlobalQueue();
    json(res, 200, { ok: true });
    return true;
  }

  // GET /api/jobs/active — list currently running SSH jobs
  if (method === 'GET' && pathname === '/api/jobs/active') {
    const { getActiveSessionIds } = await import('../ssh/remoteSessionExecutor.js');
    const activeIds = getActiveSessionIds();
    const jobs = activeIds.map(sessionId => {
      const session = sessionStore.get(sessionId);
      if (!session) return null;
      // Find the most recent running job (no finishedAt)
      const runningJob = [...(session.jobs || [])].reverse().find(j => !j.finishedAt);
      if (!runningJob) return null;
      const elapsedMs = Date.now() - new Date(runningJob.startedAt).getTime();
      const chunkCount = runningJob.chunks?.length ?? 0;
      // Last few text chunks for preview
      const lastChunks = (runningJob.chunks || []).slice(-5);
      const lastText = lastChunks
        .filter((c: any) => c?.type === 'stream_event' && c?.event?.type === 'content_block_delta')
        .map((c: any) => c?.event?.delta?.text ?? '')
        .join('');
      return {
        sessionId,
        sessionName: session.name || session.hostname,
        machineId: session.machineId,
        model: session.model,
        jobId: runningJob.jobId,
        prompt: runningJob.prompt?.slice(0, 200),
        startedAt: runningJob.startedAt,
        elapsedMs,
        chunkCount,
        lastText: lastText.slice(-200),
        status: 'running' as const,
        source: runningJob.source || 'adhoc',
      };
    }).filter(Boolean);
    json(res, 200, jobs);
    return true;
  }

  // GET /api/jobs/recent — recently completed jobs (last N across all sessions)
  if (method === 'GET' && pathname === '/api/jobs/recent') {
    const limitParam = url.searchParams.get('limit');
    const limit = Math.min(Math.max(parseInt(limitParam ?? '20', 10) || 20, 1), 100);
    const allSessions = sessionStore.getAll();
    const recentJobs: Array<Record<string, unknown>> = [];

    for (const session of allSessions) {
      for (const job of session.jobs) {
        if (!job.finishedAt) continue;
        const lastChunks = (job.chunks || []).slice(-3);
        const lastText = lastChunks
          .filter((c: any) => c?.type === 'stream_event' && c?.event?.type === 'content_block_delta')
          .map((c: any) => c?.event?.delta?.text ?? '')
          .join('');
        recentJobs.push({
          sessionId: session.sessionId,
          sessionName: session.name || session.hostname,
          machineId: session.machineId,
          model: session.model,
          jobId: job.jobId,
          prompt: job.prompt?.slice(0, 200),
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          durationMs: job.durationMs,
          exitCode: job.exitCode,
          error: job.error,
          chunkCount: job.chunks?.length ?? 0,
          lastText: lastText.slice(-200),
          status: job.error ? 'error' : (job.exitCode === 0 ? 'done' : 'failed'),
          source: job.source || 'adhoc',
        });
      }
    }

    // Sort by finishedAt desc, take top N
    recentJobs.sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
    json(res, 200, recentJobs.slice(0, limit));
    return true;
  }

  // ── Machine CRUD ───────────────────────────────────────────────────────────

  // GET /api/machines
  if (method === 'GET' && pathname === '/api/machines') {
    json(res, 200, machineStore.getAllRedacted());
    return true;
  }

  // Machine routes: /api/machines/:id[/test|/detect|/setup]
  const machineMatch = pathname.match(/^\/api\/machines\/([^/]+)(\/test|\/detect|\/setup)?$/);
  if (machineMatch) {
    const machineId = machineMatch[1];
    const subRoute = machineMatch[2];

    if (subRoute === '/test' && method === 'POST') {
      const machine = machineStore.get(machineId);
      if (!machine) { json(res, 404, { error: 'Machine not found' }); return true; }
      // Lazy-import to avoid loading ssh2 until needed
      const { testSshConnection } = await import('../ssh/sshRunner.js');
      try {
        const output = await testSshConnection(machine);
        // Also run runtime detection after successful test
        let runtimes: import('../machines/machineStore.js').RuntimeInfo[] = [];
        let claudePath = '';
        let systemInfo: import('../machines/machineStore.js').SystemInfo = {};
        let runtimeDetectedAt = '';
        try {
          const { detectRuntimes } = await import('../ssh/runtimeDetector.js');
          const detection = await detectRuntimes(machine);
          runtimes = detection.runtimes;
          claudePath = detection.claudePath;
          systemInfo = detection.systemInfo;
          runtimeDetectedAt = new Date().toISOString();
          machine.runtimes = runtimes;
          machine.claudePath = claudePath;
          machine.systemInfo = systemInfo;
          machine.runtimeDetectedAt = runtimeDetectedAt;
          machineStore.upsert(machine);
        } catch {
          // detection failure is non-fatal during test
        }
        json(res, 200, { ok: true, output, runtimes, claudePath, systemInfo, runtimeDetectedAt });
      } catch (err) {
        json(res, 422, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (subRoute === '/detect' && method === 'POST') {
      const machine = machineStore.get(machineId);
      if (!machine) { json(res, 404, { error: 'Machine not found' }); return true; }
      const { detectRuntimes } = await import('../ssh/runtimeDetector.js');
      try {
        const detection = await detectRuntimes(machine);
        const runtimeDetectedAt = new Date().toISOString();
        machine.runtimes = detection.runtimes;
        machine.claudePath = detection.claudePath;
        machine.systemInfo = detection.systemInfo;
        machine.runtimeDetectedAt = runtimeDetectedAt;
        machineStore.upsert(machine);
        json(res, 200, { runtimes: detection.runtimes, claudePath: detection.claudePath, systemInfo: detection.systemInfo, runtimeDetectedAt });
      } catch (err) {
        json(res, 422, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (subRoute === '/setup' && method === 'POST') {
      const machine = machineStore.get(machineId);
      if (!machine) { json(res, 404, { error: 'Machine not found' }); return true; }
      const { setupMachine } = await import('../ssh/machineSetup.js');
      const steps: import('../ssh/machineSetup.js').SetupStep[] = [];
      try {
        const detection = await setupMachine(machine, (step) => { steps.push(step); });
        const runtimeDetectedAt = new Date().toISOString();
        machine.runtimes = detection.runtimes;
        machine.claudePath = detection.claudePath;
        machine.systemInfo = detection.systemInfo;
        machine.runtimeDetectedAt = runtimeDetectedAt;
        machineStore.upsert(machine);
        json(res, 200, { steps, runtimes: detection.runtimes, claudePath: detection.claudePath, systemInfo: detection.systemInfo, runtimeDetectedAt });
      } catch (err) {
        json(res, 422, { steps, error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (method === 'GET') {
      const machine = machineStore.getRedacted(machineId);
      if (!machine) { json(res, 404, { error: 'Machine not found' }); return true; }
      json(res, 200, machine);
      return true;
    }

    if (method === 'PUT') {
      const body = await readBody(req) as Partial<import('../machines/machineStore.js').MachineRecord>;
      const existing = machineStore.get(machineId);
      if (!existing) { json(res, 404, { error: 'Machine not found' }); return true; }
      const updated = { ...existing, ...body, id: machineId, updatedAt: new Date().toISOString() };
      machineStore.upsert(updated);
      json(res, 200, machineStore.getRedacted(machineId));
      return true;
    }

    if (method === 'DELETE') {
      if (!machineStore.remove(machineId)) { json(res, 404, { error: 'Machine not found' }); return true; }
      json(res, 200, { ok: true });
      return true;
    }
  }

  // POST /api/machines — create new machine
  if (method === 'POST' && pathname === '/api/machines') {
    const body = await readBody(req) as Partial<import('../machines/machineStore.js').MachineRecord>;
    if (!body.name) {
      json(res, 400, { error: 'name is required' });
      return true;
    }
    const port = body.port ?? 22;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      json(res, 400, { error: 'port must be an integer between 1 and 65535' });
      return true;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: import('../machines/machineStore.js').MachineRecord = {
      id,
      name: body.name,
      alias: body.alias ?? body.name,
      ip: body.ip ?? '',
      port,
      username: body.username ?? '',
      password: body.password,
      sshKeyPath: body.sshKeyPath,
      passphrase: body.passphrase,
      defaultWorkdir: body.defaultWorkdir,
      macAddress: body.macAddress,
      os: body.os,
      notes: body.notes,
      localShell: body.localShell,
      skipPermissions: body.skipPermissions,
      permissionSettings: body.permissionSettings,
      persistentMode: body.persistentMode,
      createdAt: now,
      updatedAt: now,
    };
    machineStore.upsert(record);
    json(res, 201, machineStore.getRedacted(id));
    return true;
  }

  // ── Session endpoints ─────────────────────────────────────────────────────

  // POST /api/sessions — create a remote session
  if (method === 'POST' && pathname === '/api/sessions') {
    const body = await readBody(req) as {
      machineId?: string; name?: string; workdir?: string;
      role?: string; screenName?: string; interests?: string[];
      rolePrompt?: string; channels?: string[]; model?: string;
    };
    if (!body.machineId) { json(res, 400, { error: 'machineId required' }); return true; }
    const machine = machineStore.get(body.machineId);
    if (!machine) { json(res, 404, { error: 'Machine not found' }); return true; }
    const session = createRemoteSession(
      body.machineId,
      body.name ?? `${machine.alias}-session`,
      body.workdir ?? machine.defaultWorkdir,
      {
        role: body.role,
        screenName: body.screenName,
        interests: body.interests,
        rolePrompt: body.rolePrompt,
        channels: body.channels,
        model: body.model,
      },
    );
    json(res, 201, session);

    // Fire-and-forget: reconcile tmux + claudeSessionId for persistent machines
    if (machine.persistentMode) {
      const workdir = body.workdir ?? machine.defaultWorkdir ?? '';
      reconcileSession(machine, session.sessionId, workdir, body.model, session.claudeSessionId)
        .then(detected => { if (detected) updateClaudeSessionId(session.sessionId, detected); })
        .catch(e => console.warn(`[api] Reconcile failed for new session: ${(e as Error).message}`));
    }
    return true;
  }

  // GET /api/sessions
  if (method === 'GET' && pathname === '/api/sessions') {
    const sessions = sessionStore.getAll().map(s => ({
      sessionId: s.sessionId,
      clientId: s.clientId,
      hostname: s.hostname,
      workdir: s.workdir,
      status: s.status,
      connectedAt: s.connectedAt,
      disconnectedAt: s.disconnectedAt,
      jobCount: s.jobs.length,
      type: s.type ?? 'remote',
      name: s.name,
      machineId: s.machineId,
      claudeSessionId: s.claudeSessionId,
      remoteWorkdir: s.remoteWorkdir,
      role: s.role,
      screenName: s.screenName,
      interests: s.interests,
      rolePrompt: s.rolePrompt,
      channels: s.channels,
      model: s.model,
    }));
    json(res, 200, sessions);
    return true;
  }

  // Routes on /api/sessions/:id
  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const prefix = sessionMatch[1];

    if (method === 'GET') {
      const sessionId = resolveSessionId(prefix);
      if (!sessionId) { json(res, 404, { error: 'Session not found' }); return true; }
      const session = sessionStore.get(sessionId);
      json(res, 200, session);
      return true;
    }

    if (method === 'PATCH') {
      const sessionId = resolveSessionId(prefix);
      if (!sessionId) { json(res, 404, { error: 'Session not found' }); return true; }
      const body = await readBody(req) as {
        name?: string; role?: string; screenName?: string;
        interests?: string[]; rolePrompt?: string; channels?: string[];
        remoteWorkdir?: string; model?: string; claudeSessionId?: string;
      };
      if (body.name !== undefined) {
        updateSessionName(sessionId, body.name);
      }
      const metaFields: Record<string, unknown> = {};
      if (body.role !== undefined) metaFields.role = body.role;
      if (body.screenName !== undefined) metaFields.screenName = body.screenName;
      if (body.interests !== undefined) metaFields.interests = body.interests;
      if (body.rolePrompt !== undefined) metaFields.rolePrompt = body.rolePrompt;
      if (body.channels !== undefined) metaFields.channels = body.channels;
      if (body.remoteWorkdir !== undefined) metaFields.remoteWorkdir = body.remoteWorkdir;
      if (body.model !== undefined) metaFields.model = body.model;
      if (body.claudeSessionId !== undefined) metaFields.claudeSessionId = body.claudeSessionId;
      if (Object.keys(metaFields).length > 0) {
        sessionStore.updateMeta(sessionId, metaFields as any);
      }
      json(res, 200, sessionStore.get(sessionId));
      return true;
    }

    if (method === 'DELETE') {
      const sessionId = resolveSessionId(prefix);
      if (!sessionId) { json(res, 404, { error: 'Session not found' }); return true; }
      const session = sessionStore.get(sessionId);

      // Abort any active SSH execution
      if (session?.type === 'remote') {
        const { abortRemoteJob } = await import('../ssh/remoteSessionExecutor.js');
        abortRemoteJob(sessionId);
        // Clean up persistent tmux session if applicable
        if (session.machineId) {
          const machine = machineStore.get(session.machineId);
          if (machine?.persistentMode) {
            import('../ssh/tmuxRunner.js').then(m => m.killAllTmuxSessions(machine, sessionId)).catch(() => {});
          }
        }
      }

      json(res, 200, { ok: true });
      return true;
    }
  }

  // POST /api/sessions/:id/keys — send raw tmux keys while Claude awaits interactive input
  const keysMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/keys$/);
  if (keysMatch && method === 'POST') {
    const prefix = keysMatch[1];
    const sessionId = resolveSessionId(prefix);
    if (!sessionId) { json(res, 404, { error: 'Session not found' }); return true; }
    const body = await readBody(req) as { keys?: string };
    if (!body.keys || typeof body.keys !== 'string') { json(res, 400, { error: 'keys required' }); return true; }
    const session = sessionStore.get(sessionId);
    if (!session) { json(res, 404, { error: 'Session not found' }); return true; }
    const machine = machineStore.get(session.machineId ?? '');
    if (!machine) { json(res, 400, { error: 'No machine for session' }); return true; }
    const { sendKeysToTmuxSession } = await import('../ssh/tmuxRunner.js');
    try {
      await sendKeysToTmuxSession(machine, sessionId, body.keys);
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
    return true;
  }

  // POST /api/sessions/:id/abort
  const abortMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
  if (abortMatch && method === 'POST') {
    const prefix = abortMatch[1];
    const sessionId = resolveSessionId(prefix);
    if (!sessionId) { json(res, 404, { error: 'Session not found' }); return true; }

    const { abortRemoteJob } = await import('../ssh/remoteSessionExecutor.js');
    const aborted = abortRemoteJob(sessionId);
    json(res, 200, { ok: true, aborted });
    return true;
  }

  // POST /api/sessions/:id/clear-queue — clear hub message queue without aborting active job
  const clearQueueMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/clear-queue$/);
  if (clearQueueMatch && method === 'POST') {
    const prefix = clearQueueMatch[1];
    const sessionId = resolveSessionId(prefix);
    if (!sessionId) { json(res, 404, { error: 'Session not found' }); return true; }

    const { clearSessionQueue } = await import('../hub/hubRouter.js');
    const cleared = clearSessionQueue(sessionId);
    json(res, 200, { ok: true, cleared });
    return true;
  }

  // POST /api/sessions/:id/send
  const sendMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/send$/);
  if (sendMatch && method === 'POST') {
    const prefix = sendMatch[1];
    const sessionId = resolveSessionId(prefix);
    if (!sessionId) { json(res, 404, { error: 'Session not found' }); return true; }

    const body = await readBody(req) as { prompt?: string; model?: string; options?: unknown };
    if (!body.prompt) { json(res, 400, { error: 'prompt required' }); return true; }

    const session = sessionStore.get(sessionId);
    if (!session?.machineId) {
      json(res, 422, { error: 'Session has no associated machine' });
      return true;
    }

    const job = createJob(sessionId, body.prompt, 'adhoc');

    const { executeRemoteJob } = await import('../ssh/remoteSessionExecutor.js');
    executeRemoteJob(sessionId, job.jobId, body.prompt, body.model);
    json(res, 200, { jobId: job.jobId });
    return true;
  }

  // ── Hub endpoints ─────────────────────────────────────────────────────────

  // GET /api/hub/channels
  if (method === 'GET' && pathname === '/api/hub/channels') {
    json(res, 200, hubStore.getAllChannels());
    return true;
  }

  // POST /api/hub/channels
  if (method === 'POST' && pathname === '/api/hub/channels') {
    const body = await readBody(req) as { id?: string; name?: string; description?: string };
    if (!body.id || !body.name) {
      json(res, 400, { error: 'id and name are required' });
      return true;
    }
    const existing = hubStore.getChannel(body.id);
    if (existing) {
      json(res, 409, { error: existing.archived ? 'Channel exists but is archived — restore it instead' : 'Channel already exists' });
      return true;
    }
    const channel = hubStore.createChannel(body.id, body.name, 'api', body.description);
    json(res, 201, channel);
    return true;
  }

  // POST /api/hub/channels/:id/restore
  const hubRestoreMatch = pathname.match(/^\/api\/hub\/channels\/([^/]+)\/restore$/);
  if (hubRestoreMatch && method === 'POST') {
    const channelId = hubRestoreMatch[1];
    const channel = hubStore.restoreChannel(channelId);
    if (!channel) { json(res, 404, { error: 'Channel not found or not archived' }); return true; }
    json(res, 200, channel);
    return true;
  }

  // PATCH/DELETE /api/hub/channels/:id — must come after all sub-route matches
  const hubChannelMatch = pathname.match(/^\/api\/hub\/channels\/([^/]+)$/);
  if (hubChannelMatch) {
    const channelId = hubChannelMatch[1];

    if (method === 'PATCH') {
      const body = await readBody(req) as { name?: string; description?: string };
      const channel = hubStore.updateChannel(channelId, body);
      if (!channel) { json(res, 404, { error: 'Channel not found' }); return true; }
      json(res, 200, channel);
      return true;
    }

    if (method === 'DELETE') {
      const body = await readBody(req).catch(() => ({})) as { by?: string };
      const channel = hubStore.archiveChannel(channelId, (body as any)?.by ?? 'dashboard');
      if (!channel) { json(res, 404, { error: 'Channel not found or already archived' }); return true; }
      json(res, 200, { ok: true, archived: true });
      return true;
    }
  }

  // GET /api/hub/channels/:id/messages
  const hubChannelMsgMatch = pathname.match(/^\/api\/hub\/channels\/([^/]+)\/messages$/);
  if (hubChannelMsgMatch && method === 'GET') {
    const channelId = hubChannelMsgMatch[1];
    const since = url.searchParams.get('since') ?? undefined;
    json(res, 200, hubStore.getByChannel(channelId, since));
    return true;
  }

  // POST /api/hub/channels/:id/compact — LLM-summarize the channel and reset
  const hubCompactMatch = pathname.match(/^\/api\/hub\/channels\/([^/]+)\/compact$/);
  if (hubCompactMatch && method === 'POST') {
    const channelId = hubCompactMatch[1];
    const body = await readBody(req) as { by?: string; machineId?: string };
    try {
      const result = await compactChannel(channelId, body.by ?? 'user', body.machineId);
      json(res, 200, result);
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
    return true;
  }

  // GET /api/hub/channels/:id/compactions — list past compactions for the channel
  const hubCompactionsMatch = pathname.match(/^\/api\/hub\/channels\/([^/]+)\/compactions$/);
  if (hubCompactionsMatch && method === 'GET') {
    const channelId = hubCompactionsMatch[1];
    json(res, 200, hubStore.getCompactions(channelId));
    return true;
  }

  // POST /api/hub/channels/:id/compactions/:cid/redo — re-run summarizer on an existing compaction
  const hubRedoMatch = pathname.match(/^\/api\/hub\/channels\/([^/]+)\/compactions\/([^/]+)\/redo$/);
  if (hubRedoMatch && method === 'POST') {
    const channelId = hubRedoMatch[1];
    const compactionId = hubRedoMatch[2];
    const body = await readBody(req) as { machineId?: string };
    try {
      const result = await redoCompaction(channelId, compactionId, body.machineId);
      json(res, 200, result);
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
    return true;
  }

  // POST /api/hub/messages
  if (method === 'POST' && pathname === '/api/hub/messages') {
    const body = await readBody(req) as {
      channelIds?: string[]; content?: string; tags?: string[];
      mentions?: string[]; from?: string; fromName?: string;
      parentId?: string;
    };
    if (!body.channelIds?.length || !body.content) {
      json(res, 400, { error: 'channelIds and content are required' });
      return true;
    }
    const msg = postHubMessage({
      from: body.from ?? 'user',
      fromName: body.fromName ?? 'User',
      content: body.content,
      channelIds: body.channelIds,
      tags: body.tags,
      mentions: body.mentions,
      parentId: body.parentId,
    });
    json(res, 201, msg);
    return true;
  }

  // POST /api/hub/messages/:id/trigger — manually trigger a session against a message
  const hubTriggerMatch = pathname.match(/^\/api\/hub\/messages\/([^/]+)\/trigger$/);
  if (hubTriggerMatch && method === 'POST') {
    const msgId = hubTriggerMatch[1];
    const body = await readBody(req) as { sessionId?: string };
    if (!body.sessionId) { json(res, 400, { error: 'sessionId required' }); return true; }
    const result = triggerSessionOnMessage(body.sessionId, msgId);
    if (!result.ok) { json(res, 404, { error: result.error }); return true; }
    json(res, 200, result);
    return true;
  }

  // Hub message routes: /api/hub/messages/:id[/thread]
  const hubMsgMatch = pathname.match(/^\/api\/hub\/messages\/([^/]+)(\/thread)?$/);
  if (hubMsgMatch && method === 'GET') {
    const msgId = hubMsgMatch[1];
    const subRoute = hubMsgMatch[2];

    if (subRoute === '/thread') {
      json(res, 200, hubStore.getThread(msgId));
      return true;
    }

    const msg = hubStore.getMessage(msgId);
    if (!msg) { json(res, 404, { error: 'Message not found' }); return true; }
    json(res, 200, msg);
    return true;
  }

  // ── Task endpoints ────────────────────────────────────────────────────────

  // GET /api/hub/channels/:id/tasks
  const channelTasksMatch = pathname.match(/^\/api\/hub\/channels\/([^/]+)\/tasks$/);
  if (channelTasksMatch) {
    const channelId = channelTasksMatch[1];
    if (method === 'GET') {
      const statusParam = url.searchParams.get('status');
      const q = url.searchParams.get('q') ?? undefined;
      const tagsParam = url.searchParams.get('tags');
      const assignee = url.searchParams.get('assignee') ?? undefined;
      const tags = tagsParam ? tagsParam.split(',').map(s => s.trim()).filter(Boolean) : undefined;

      let results;
      if (q || (tags && tags.length > 0)) {
        results = taskStore.search(channelId, q, tags);
      } else {
        const status = statusParam
          ? statusParam.split(',').map(s => s.trim()).filter(Boolean) as TaskStatus[]
          : undefined;
        results = taskStore.getByChannel(channelId, { status, assignee });
      }
      json(res, 200, results);
      return true;
    }
    if (method === 'POST') {
      const body = await readBody(req) as {
        title?: string; description?: string; assignee?: string;
        tags?: string[]; priority?: TaskPriority; status?: TaskStatus;
        reporter?: string; parentId?: string;
      };
      if (!body.title) { json(res, 400, { error: 'title required' }); return true; }
      const task = taskStore.createTask(channelId, {
        title: body.title,
        description: body.description,
        status: body.status,
        assignee: body.assignee,
        tags: body.tags,
        priority: body.priority,
        parentId: body.parentId,
      }, body.reporter ?? 'user');
      broadcastToDashboards({ type: 'DASHBOARD_EVENT', event: 'TASKS_CHANGED', channelId });
      json(res, 201, task);
      return true;
    }
  }

  // /api/hub/tasks/:id and /api/hub/tasks/:id/comments
  const taskMatch = pathname.match(/^\/api\/hub\/tasks\/([^/]+)(\/comments)?$/);
  if (taskMatch) {
    const taskId = taskMatch[1];
    const sub = taskMatch[2];

    if (sub === '/comments' && method === 'POST') {
      const body = await readBody(req) as { text?: string; by?: string };
      if (!body.text) { json(res, 400, { error: 'text required' }); return true; }
      const updated = taskStore.addComment(taskId, body.text, body.by ?? 'user');
      if (!updated) { json(res, 404, { error: 'Task not found' }); return true; }
      broadcastToDashboards({ type: 'DASHBOARD_EVENT', event: 'TASKS_CHANGED', channelId: updated.channelId });
      json(res, 200, updated);
      return true;
    }

    if (!sub && method === 'GET') {
      const task = taskStore.getTask(taskId);
      if (!task) { json(res, 404, { error: 'Task not found' }); return true; }
      json(res, 200, task);
      return true;
    }

    if (!sub && method === 'PATCH') {
      const body = await readBody(req) as UpdateTaskFields & { by?: string };
      const updated = taskStore.updateTask(taskId, body, body.by ?? 'user');
      if (!updated) { json(res, 404, { error: 'Task not found' }); return true; }
      broadcastToDashboards({ type: 'DASHBOARD_EVENT', event: 'TASKS_CHANGED', channelId: updated.channelId });
      json(res, 200, updated);
      return true;
    }

    if (!sub && method === 'DELETE') {
      const task = taskStore.getTask(taskId);
      if (!task) { json(res, 404, { error: 'Task not found' }); return true; }
      taskStore.removeTask(taskId);
      broadcastToDashboards({ type: 'DASHBOARD_EVENT', event: 'TASKS_CHANGED', channelId: task.channelId });
      json(res, 200, { ok: true });
      return true;
    }
  }

  // ── Doc endpoints ─────────────────────────────────────────────────────────

  // GET/POST /api/hub/channels/:id/docs
  const channelDocsMatch = pathname.match(/^\/api\/hub\/channels\/([^/]+)\/docs$/);
  if (channelDocsMatch) {
    const channelId = channelDocsMatch[1];
    if (method === 'GET') {
      const q = url.searchParams.get('q') ?? undefined;
      const tagsParam = url.searchParams.get('tags');
      const tags = tagsParam ? tagsParam.split(',').map(s => s.trim()).filter(Boolean) : undefined;
      const includeArchived = url.searchParams.get('archived') === 'true';
      const results = (q || (tags && tags.length > 0))
        ? docStore.search(channelId, q, tags)
        : docStore.getByChannel(channelId, includeArchived);
      json(res, 200, results);
      return true;
    }
    if (method === 'POST') {
      const body = await readBody(req) as {
        title?: string; body?: string; tags?: string[]; author?: string;
      };
      if (!body.title || body.body === undefined) {
        json(res, 400, { error: 'title and body required' });
        return true;
      }
      const doc = docStore.createDoc(channelId, body.title, body.body, body.author ?? 'user', body.tags ?? []);
      broadcastToDashboards({ type: 'DASHBOARD_EVENT', event: 'DOCS_CHANGED', channelId });
      json(res, 201, doc);
      return true;
    }
  }

  // /api/hub/docs/:id, /append, /history, /restore
  const docMatch = pathname.match(/^\/api\/hub\/docs\/([^/]+)(\/append|\/history|\/restore)?$/);
  if (docMatch) {
    const docId = docMatch[1];
    const sub = docMatch[2];
    const chId = url.searchParams.get('channelId') ?? undefined;

    if (sub === '/append' && method === 'POST') {
      const body = await readBody(req) as { text?: string; by?: string };
      if (!body.text) { json(res, 400, { error: 'text required' }); return true; }
      const updated = docStore.appendDoc(docId, body.text, body.by ?? 'user', chId);
      if (!updated) { json(res, 404, { error: 'Doc not found' }); return true; }
      broadcastToDashboards({ type: 'DASHBOARD_EVENT', event: 'DOCS_CHANGED', channelId: updated.channelId });
      json(res, 200, updated);
      return true;
    }

    if (sub === '/history' && method === 'GET') {
      const doc = docStore.getDoc(docId, chId);
      if (!doc) { json(res, 404, { error: 'Doc not found' }); return true; }
      json(res, 200, doc.history);
      return true;
    }

    if (sub === '/restore' && method === 'POST') {
      const restored = docStore.restoreDoc(docId, chId);
      if (!restored) { json(res, 404, { error: 'Doc not found or not archived' }); return true; }
      broadcastToDashboards({ type: 'DASHBOARD_EVENT', event: 'DOCS_CHANGED', channelId: restored.channelId });
      json(res, 200, restored);
      return true;
    }

    if (!sub && method === 'GET') {
      const doc = docStore.getDoc(docId, chId);
      if (!doc) { json(res, 404, { error: 'Doc not found' }); return true; }
      json(res, 200, doc);
      return true;
    }

    if (!sub && method === 'PATCH') {
      const body = await readBody(req) as UpdateDocFields & { by?: string };
      const updated = docStore.updateDoc(docId, body, body.by ?? 'user', chId);
      if (!updated) { json(res, 404, { error: 'Doc not found' }); return true; }
      broadcastToDashboards({ type: 'DASHBOARD_EVENT', event: 'DOCS_CHANGED', channelId: updated.channelId });
      json(res, 200, updated);
      return true;
    }

    // DELETE now does soft delete (archive). Use removeDoc only for permanent cleanup.
    if (!sub && method === 'DELETE') {
      const body = await readBody(req).catch(() => ({})) as { by?: string };
      const doc = docStore.archiveDoc(docId, (body as any)?.by ?? 'user', chId);
      if (!doc) { json(res, 404, { error: 'Doc not found or already archived' }); return true; }
      broadcastToDashboards({ type: 'DASHBOARD_EVENT', event: 'DOCS_CHANGED', channelId: doc.channelId });
      json(res, 200, { ok: true, archived: true });
      return true;
    }
  }

  // ── Jump host endpoints ──────────────────────────────────────────────────

  // GET /api/jumphosts
  if (method === 'GET' && pathname === '/api/jumphosts') {
    const { jumpHostStore } = await import('../ssh/jumpHostStore.js');
    json(res, 200, jumpHostStore.getRedactedConfig());
    return true;
  }

  // PUT /api/jumphosts — replace entire config
  if (method === 'PUT' && pathname === '/api/jumphosts') {
    const { jumpHostStore } = await import('../ssh/jumpHostStore.js');
    const body = await readBody(req) as any;
    jumpHostStore.setConfig({ enabled: !!body.enabled, hosts: Array.isArray(body.hosts) ? body.hosts : [] });
    json(res, 200, jumpHostStore.getRedactedConfig());
    return true;
  }

  // PATCH /api/jumphosts/enabled — quick toggle
  if (method === 'PATCH' && pathname === '/api/jumphosts/enabled') {
    const { jumpHostStore } = await import('../ssh/jumpHostStore.js');
    const body = await readBody(req) as { enabled?: boolean };
    if (body.enabled !== undefined) jumpHostStore.setEnabled(!!body.enabled);
    json(res, 200, { enabled: jumpHostStore.getConfig().enabled });
    return true;
  }

  // POST /api/jumphosts/hosts — add a host
  if (method === 'POST' && pathname === '/api/jumphosts/hosts') {
    const { jumpHostStore } = await import('../ssh/jumpHostStore.js');
    const body = await readBody(req) as any;
    if (!body.host || !body.username) { json(res, 400, { error: 'host and username required' }); return true; }
    const id = randomUUID();
    const host = {
      id, host: body.host, port: body.port ?? 22, username: body.username,
      sshKeyPath: body.sshKeyPath, password: body.password, passphrase: body.passphrase,
      label: body.label,
    };
    jumpHostStore.addHost(host);
    json(res, 201, jumpHostStore.getRedactedConfig());
    return true;
  }

  // PUT /api/jumphosts/hosts/:id — update a host
  const jhHostMatch = pathname.match(/^\/api\/jumphosts\/hosts\/([^/]+)$/);
  if (jhHostMatch && method === 'PUT') {
    const { jumpHostStore } = await import('../ssh/jumpHostStore.js');
    const hostId = jhHostMatch[1];
    const body = await readBody(req) as any;
    if (!jumpHostStore.updateHost(hostId, body)) { json(res, 404, { error: 'Jump host not found' }); return true; }
    json(res, 200, jumpHostStore.getRedactedConfig());
    return true;
  }

  // DELETE /api/jumphosts/hosts/:id
  if (jhHostMatch && method === 'DELETE') {
    const { jumpHostStore } = await import('../ssh/jumpHostStore.js');
    const hostId = jhHostMatch[1];
    if (!jumpHostStore.removeHost(hostId)) { json(res, 404, { error: 'Jump host not found' }); return true; }
    json(res, 200, jumpHostStore.getRedactedConfig());
    return true;
  }

  // PUT /api/jumphosts/reorder
  if (method === 'PUT' && pathname === '/api/jumphosts/reorder') {
    const { jumpHostStore } = await import('../ssh/jumpHostStore.js');
    const body = await readBody(req) as { ids?: string[] };
    if (!Array.isArray(body.ids)) { json(res, 400, { error: 'ids array required' }); return true; }
    jumpHostStore.reorderHosts(body.ids);
    json(res, 200, jumpHostStore.getRedactedConfig());
    return true;
  }

  // POST /api/jumphosts/test — test the chain
  if (method === 'POST' && pathname === '/api/jumphosts/test') {
    const { jumpHostStore } = await import('../ssh/jumpHostStore.js');
    const { testJumpHostChain } = await import('../ssh/sshRunner.js');
    const cfg = jumpHostStore.getConfig();
    if (cfg.hosts.length === 0) { json(res, 400, { error: 'No jump hosts configured' }); return true; }
    try {
      const output = await testJumpHostChain(cfg.hosts);
      json(res, 200, { ok: true, output });
    } catch (err) {
      json(res, 422, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // ── Settings endpoints ──────────────────────────────────────────────────

  // GET /api/settings — read mutable runtime settings
  if (method === 'GET' && pathname === '/api/settings') {
    json(res, 200, {
      compactTokenThreshold: config.compactTokenThreshold,
      hubMaxConcurrentJobs: config.hubMaxConcurrentJobs,
      hubCooldownMs: config.hubCooldownMs,
      hubMaxTalkRounds: config.hubMaxTalkRounds,
      hubMaxChainDepth: config.hubMaxChainDepth,
      sshIdleTimeoutMs: config.sshIdleTimeoutMs,
    });
    return true;
  }

  // PATCH /api/settings — update mutable runtime settings
  if (method === 'PATCH' && pathname === '/api/settings') {
    const body = await readBody(req) as Record<string, unknown>;
    const allowed = ['compactTokenThreshold', 'hubMaxConcurrentJobs', 'hubCooldownMs', 'hubMaxTalkRounds', 'hubMaxChainDepth', 'sshIdleTimeoutMs'] as const;
    for (const key of allowed) {
      if (body[key] !== undefined) {
        const val = Number(body[key]);
        if (!Number.isFinite(val) || val < 0) continue;
        (config as any)[key] = Math.round(val);
      }
    }
    json(res, 200, {
      compactTokenThreshold: config.compactTokenThreshold,
      hubMaxConcurrentJobs: config.hubMaxConcurrentJobs,
      hubCooldownMs: config.hubCooldownMs,
      hubMaxTalkRounds: config.hubMaxTalkRounds,
      hubMaxChainDepth: config.hubMaxChainDepth,
      sshIdleTimeoutMs: config.sshIdleTimeoutMs,
    });
    return true;
  }

  // ── Push endpoints ────────────────────────────────────────────────────────

  // GET /api/push/vapid-key
  if (method === 'GET' && pathname === '/api/push/vapid-key') {
    json(res, 200, { publicKey: pushManager.getPublicKey() });
    return true;
  }

  // POST /api/push/subscribe
  if (method === 'POST' && pathname === '/api/push/subscribe') {
    const sub = await readBody(req) as webpush.PushSubscription;
    if (!sub?.endpoint) { json(res, 400, { error: 'invalid subscription' }); return true; }
    pushManager.addSubscription(sub);
    json(res, 200, { ok: true });
    return true;
  }

  json(res, 404, { error: 'Not found' });
  return true;
}
