import type { IncomingMessage, ServerResponse } from 'http';
import { config } from '../config.js';
import { sessionStore } from '../sessions/sessionStore.js';
import { machineStore } from '../machines/machineStore.js';
import { createJob, resolveSessionId, createRemoteSession, updateSessionName } from '../sessions/sessionManager.js';
import { hubStore } from '../hub/hubStore.js';
import { taskStore } from '../hub/taskStore.js';
import type { TaskStatus, TaskPriority, UpdateTaskFields } from '../hub/taskStore.js';
import { docStore } from '../hub/docStore.js';
import type { UpdateDocFields } from '../hub/docStore.js';
import { postHubMessage, resolveScreenName, triggerSessionOnMessage } from '../hub/hubRouter.js';
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
    json(res, 200, {
      status: 'ok',
      totalSessions: sessions.length,
      uptime: process.uptime(),
    });
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
    if (!body.name || !body.ip || !body.username) {
      json(res, 400, { error: 'name, ip, and username are required' });
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
      ip: body.ip,
      port,
      username: body.username,
      password: body.password,
      sshKeyPath: body.sshKeyPath,
      passphrase: body.passphrase,
      defaultWorkdir: body.defaultWorkdir,
      macAddress: body.macAddress,
      os: body.os,
      notes: body.notes,
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
        remoteWorkdir?: string; model?: string;
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
      }

      json(res, 200, { ok: true });
      return true;
    }
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

  // POST /api/sessions/:id/send
  const sendMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/send$/);
  if (sendMatch && method === 'POST') {
    const prefix = sendMatch[1];
    const sessionId = resolveSessionId(prefix);
    if (!sessionId) { json(res, 404, { error: 'Session not found' }); return true; }

    const body = await readBody(req) as { prompt?: string; options?: unknown };
    if (!body.prompt) { json(res, 400, { error: 'prompt required' }); return true; }

    const session = sessionStore.get(sessionId);
    if (!session?.machineId) {
      json(res, 422, { error: 'Session has no associated machine' });
      return true;
    }

    const job = createJob(sessionId, body.prompt);

    const { executeRemoteJob } = await import('../ssh/remoteSessionExecutor.js');
    executeRemoteJob(sessionId, job.jobId, body.prompt);
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
      json(res, 409, { error: 'Channel already exists' });
      return true;
    }
    const channel = hubStore.createChannel(body.id, body.name, 'api', body.description);
    json(res, 201, channel);
    return true;
  }

  // GET /api/hub/channels/:id/messages
  const hubChannelMsgMatch = pathname.match(/^\/api\/hub\/channels\/([^/]+)\/messages$/);
  if (hubChannelMsgMatch && method === 'GET') {
    const channelId = hubChannelMsgMatch[1];
    const since = url.searchParams.get('since') ?? undefined;
    json(res, 200, hubStore.getByChannel(channelId, since));
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
      const results = (q || (tags && tags.length > 0))
        ? docStore.search(channelId, q, tags)
        : docStore.getByChannel(channelId);
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

  // /api/hub/docs/:id, /append, /history
  const docMatch = pathname.match(/^\/api\/hub\/docs\/([^/]+)(\/append|\/history)?$/);
  if (docMatch) {
    const docId = docMatch[1];
    const sub = docMatch[2];

    if (sub === '/append' && method === 'POST') {
      const body = await readBody(req) as { text?: string; by?: string };
      if (!body.text) { json(res, 400, { error: 'text required' }); return true; }
      const updated = docStore.appendDoc(docId, body.text, body.by ?? 'user');
      if (!updated) { json(res, 404, { error: 'Doc not found' }); return true; }
      broadcastToDashboards({ type: 'DASHBOARD_EVENT', event: 'DOCS_CHANGED', channelId: updated.channelId });
      json(res, 200, updated);
      return true;
    }

    if (sub === '/history' && method === 'GET') {
      const doc = docStore.getDoc(docId);
      if (!doc) { json(res, 404, { error: 'Doc not found' }); return true; }
      json(res, 200, doc.history);
      return true;
    }

    if (!sub && method === 'GET') {
      const doc = docStore.getDoc(docId);
      if (!doc) { json(res, 404, { error: 'Doc not found' }); return true; }
      json(res, 200, doc);
      return true;
    }

    if (!sub && method === 'PATCH') {
      const body = await readBody(req) as UpdateDocFields & { by?: string };
      const updated = docStore.updateDoc(docId, body, body.by ?? 'user');
      if (!updated) { json(res, 404, { error: 'Doc not found' }); return true; }
      broadcastToDashboards({ type: 'DASHBOARD_EVENT', event: 'DOCS_CHANGED', channelId: updated.channelId });
      json(res, 200, updated);
      return true;
    }

    if (!sub && method === 'DELETE') {
      const doc = docStore.getDoc(docId);
      if (!doc) { json(res, 404, { error: 'Doc not found' }); return true; }
      docStore.removeDoc(docId);
      broadcastToDashboards({ type: 'DASHBOARD_EVENT', event: 'DOCS_CHANGED', channelId: doc.channelId });
      json(res, 200, { ok: true });
      return true;
    }
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
