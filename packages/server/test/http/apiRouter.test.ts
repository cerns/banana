import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockConfig = {
  token: 'test-token', persistPath: '', historyMax: 1000, machinesPersistPath: '',
  hubPersistPath: '', hubMaxChainDepth: 5, hubMaxConcurrentJobs: 3, hubCooldownMs: 0,
  tasksPersistPath: '', docsPersistPath: '',
  taskContextMax: 8, docContextMax: 5, docRevisionMax: 20,
  compactTokenThreshold: 80000, hubMaxTalkRounds: 10, sshIdleTimeoutMs: 1800000,
};
vi.mock('../../src/config.js', () => ({
  config: mockConfig,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn().mockReturnValue(Buffer.from('mock-bundle')),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
    readFileSync: vi.fn().mockReturnValue(Buffer.from('mock-bundle')),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('../../src/push/pushManager.js', () => ({
  pushManager: {
    getPublicKey: vi.fn().mockReturnValue('mock-vapid-key'),
    addSubscription: vi.fn(),
    sendPush: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockExecuteRemoteJob = vi.fn();
const mockAbortRemoteJob = vi.fn().mockReturnValue(true);
const mockGetActiveSessionIds = vi.fn().mockReturnValue([]);
vi.mock('../../src/ssh/remoteSessionExecutor.js', () => ({
  executeRemoteJob: mockExecuteRemoteJob,
  abortRemoteJob: mockAbortRemoteJob,
  getActiveSessionIds: mockGetActiveSessionIds,
}));

const mockTestSshConnection = vi.fn();
const mockTestJumpHostChain = vi.fn();
vi.mock('../../src/ssh/sshRunner.js', () => ({
  testSshConnection: mockTestSshConnection,
  testJumpHostChain: mockTestJumpHostChain,
}));

const mockKillTmuxSession = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/ssh/tmuxRunner.js', () => ({
  killTmuxSession: mockKillTmuxSession,
}));

const mockJumpHostStore = {
  getConfig: vi.fn().mockReturnValue({ enabled: false, hosts: [] }),
  getRedactedConfig: vi.fn().mockReturnValue({ enabled: false, hosts: [] }),
  setConfig: vi.fn(),
  setEnabled: vi.fn(),
  addHost: vi.fn(),
  updateHost: vi.fn().mockReturnValue(true),
  removeHost: vi.fn().mockReturnValue(true),
  reorderHosts: vi.fn(),
};
vi.mock('../../src/ssh/jumpHostStore.js', () => ({
  jumpHostStore: mockJumpHostStore,
}));

const mockDetectRuntimes = vi.fn();
vi.mock('../../src/ssh/runtimeDetector.js', () => ({
  detectRuntimes: mockDetectRuntimes,
}));

const mockSetupMachine = vi.fn();
vi.mock('../../src/ssh/machineSetup.js', () => ({
  setupMachine: mockSetupMachine,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function createReq(method: string, url: string, body?: unknown, auth = true): IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = url;
  req.headers = {};
  if (auth) req.headers.authorization = 'Bearer test-token';

  // Simulate body stream
  if (body !== undefined) {
    setTimeout(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    }, 0);
  } else {
    setTimeout(() => req.emit('end'), 0);
  }

  return req;
}

function createRes(): ServerResponse & { _status: number; _body: any; _headers: Record<string, string> } {
  const res = {
    _status: 0,
    _body: null,
    _headers: {},
    writeHead(status: number, headers?: Record<string, string>) {
      this._status = status;
      if (headers) Object.assign(this._headers, headers);
    },
    end(body?: string | Buffer) {
      if (body) {
        try {
          this._body = JSON.parse(body.toString());
        } catch {
          this._body = body.toString();
        }
      }
    },
  } as any;
  return res;
}

describe('apiRouter', () => {
  let handleApiRequest: typeof import('../../src/http/apiRouter.js').handleApiRequest;
  let sessionStore: typeof import('../../src/sessions/sessionStore.js');
  let machineStore: typeof import('../../src/machines/machineStore.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Re-apply dynamic mocks
    vi.doMock('../../src/ssh/remoteSessionExecutor.js', () => ({
      executeRemoteJob: mockExecuteRemoteJob,
      abortRemoteJob: mockAbortRemoteJob,
      getActiveSessionIds: mockGetActiveSessionIds,
    }));
    vi.doMock('../../src/ssh/sshRunner.js', () => ({
      testSshConnection: mockTestSshConnection,
      testJumpHostChain: mockTestJumpHostChain,
    }));
    vi.doMock('../../src/ssh/jumpHostStore.js', () => ({
      jumpHostStore: mockJumpHostStore,
    }));
    vi.doMock('../../src/ssh/runtimeDetector.js', () => ({
      detectRuntimes: mockDetectRuntimes,
    }));
    vi.doMock('../../src/ssh/machineSetup.js', () => ({
      setupMachine: mockSetupMachine,
    }));

    const apiModule = await import('../../src/http/apiRouter.js');
    handleApiRequest = apiModule.handleApiRequest;
    sessionStore = await import('../../src/sessions/sessionStore.js');
    machineStore = await import('../../src/machines/machineStore.js');
  });

  // ── CORS ─────────────────────────────────────────────────────────────────

  describe('CORS', () => {
    it('should handle OPTIONS preflight', async () => {
      const req = createReq('OPTIONS', '/api/health', undefined, false);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(204);
      expect(res._headers['Access-Control-Allow-Methods']).toContain('PATCH');
    });
  });

  // ── Auth ─────────────────────────────────────────────────────────────────

  describe('Auth', () => {
    it('should reject unauthenticated API requests', async () => {
      const req = createReq('GET', '/api/health', undefined, false);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(401);
      expect(res._body.error).toBe('Unauthorized');
    });

    it('should accept valid bearer token', async () => {
      const req = createReq('GET', '/api/health');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
    });
  });

  // ── Non-API routes ───────────────────────────────────────────────────────

  describe('Non-API routes', () => {
    it('should return false for non-API paths', async () => {
      const req = createReq('GET', '/not-an-api');
      const res = createRes();
      const handled = await handleApiRequest(req, res);
      expect(handled).toBe(false);
    });

    it('should return 404 for unknown API route', async () => {
      const req = createReq('GET', '/api/nonexistent');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });
  });

  // ── Health ───────────────────────────────────────────────────────────────

  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const req = createReq('GET', '/api/health');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.status).toBe('ok');
      expect(typeof res._body.uptime).toBe('number');
    });
  });

  // ── Machines CRUD ────────────────────────────────────────────────────────

  describe('Machine endpoints', () => {
    it('GET /api/machines should return empty list', async () => {
      const req = createReq('GET', '/api/machines');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body).toEqual([]);
    });

    it('POST /api/machines should create a machine', async () => {
      const req = createReq('POST', '/api/machines', {
        name: 'prod-web', alias: 'pw1', ip: '10.0.0.1', port: 22, username: 'deploy',
      });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(201);
      expect(res._body.name).toBe('prod-web');
      expect(res._body.hasPassword).toBe(false);
      expect(res._body.id).toBeDefined();
    });

    it('POST /api/machines should reject missing name', async () => {
      const req = createReq('POST', '/api/machines', { ip: '1.2.3.4' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(400);
    });

    it('POST /api/machines should allow empty ip/username (local machine)', async () => {
      const req = createReq('POST', '/api/machines', { name: 'local' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(201);
      expect(res._body.ip).toBe('');
      expect(res._body.username).toBe('');
    });

    it('POST /api/machines should validate port range', async () => {
      const req = createReq('POST', '/api/machines', {
        name: 'test', ip: '1.2.3.4', username: 'root', port: 99999,
      });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(400);
      expect(res._body.error).toContain('port');
    });

    it('POST /api/machines should default alias to name', async () => {
      const req = createReq('POST', '/api/machines', {
        name: 'my-server', ip: '1.2.3.4', username: 'root',
      });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(201);
      expect(res._body.alias).toBe('my-server');
    });

    it('GET /api/machines/:id should return a machine', async () => {
      // Create first
      const createReqObj = createReq('POST', '/api/machines', {
        name: 'test', ip: '1.1.1.1', username: 'u', password: 'secret',
      });
      const createRes1 = createRes();
      await handleApiRequest(createReqObj, createRes1);
      const id = createRes1._body.id;

      // Get it
      const req = createReq('GET', `/api/machines/${id}`);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.hasPassword).toBe(true);
      expect((res._body as any).password).toBeUndefined();
    });

    it('GET /api/machines/:id should 404 for unknown', async () => {
      const req = createReq('GET', '/api/machines/nonexistent');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });

    it('PUT /api/machines/:id should update a machine', async () => {
      // Create
      const cr = createReq('POST', '/api/machines', { name: 'old', ip: '1.1.1.1', username: 'u' });
      const cres = createRes();
      await handleApiRequest(cr, cres);
      const id = cres._body.id;

      // Update
      const req = createReq('PUT', `/api/machines/${id}`, { name: 'new-name' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.name).toBe('new-name');
    });

    it('PUT /api/machines/:id should 404 for unknown', async () => {
      const req = createReq('PUT', '/api/machines/nonexistent', { name: 'x' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });

    it('DELETE /api/machines/:id should remove a machine', async () => {
      // Create
      const cr = createReq('POST', '/api/machines', { name: 'del', ip: '1.1.1.1', username: 'u' });
      const cres = createRes();
      await handleApiRequest(cr, cres);
      const id = cres._body.id;

      // Delete
      const req = createReq('DELETE', `/api/machines/${id}`);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.ok).toBe(true);
    });

    it('DELETE /api/machines/:id should 404 for unknown', async () => {
      const req = createReq('DELETE', '/api/machines/nonexistent');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });

    it('POST /api/machines/:id/test should test SSH connection', async () => {
      // Create machine
      const cr = createReq('POST', '/api/machines', { name: 'test', ip: '1.1.1.1', username: 'u' });
      const cres = createRes();
      await handleApiRequest(cr, cres);
      const id = cres._body.id;

      mockTestSshConnection.mockResolvedValue('ok\nmy-hostname');

      const req = createReq('POST', `/api/machines/${id}/test`);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.ok).toBe(true);
      expect(res._body.output).toBe('ok\nmy-hostname');
    });

    it('POST /api/machines/:id/test should return 422 on SSH failure', async () => {
      const cr = createReq('POST', '/api/machines', { name: 'test', ip: '1.1.1.1', username: 'u' });
      const cres = createRes();
      await handleApiRequest(cr, cres);
      const id = cres._body.id;

      mockTestSshConnection.mockRejectedValue(new Error('Connection refused'));

      const req = createReq('POST', `/api/machines/${id}/test`);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(422);
      expect(res._body.ok).toBe(false);
      expect(res._body.error).toBe('Connection refused');
    });

    it('POST /api/machines/:id/test should 404 for unknown machine', async () => {
      const req = createReq('POST', '/api/machines/nonexistent/test');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });

    it('POST /api/machines/:id/test should return runtimes after detection', async () => {
      const cr = createReq('POST', '/api/machines', { name: 'rt', ip: '1.1.1.1', username: 'u' });
      const cres = createRes();
      await handleApiRequest(cr, cres);
      const id = cres._body.id;

      mockTestSshConnection.mockResolvedValue('ok\nhost');
      mockDetectRuntimes.mockResolvedValue({
        runtimes: [{ runtime: 'node', version: 'v20.11.1', path: '/usr/bin/node' }],
        claudePath: '/usr/bin/claude',
        systemInfo: { os: 'Ubuntu 22.04', cpuCores: 8, memoryTotal: '16Gi' },
      });

      const req = createReq('POST', `/api/machines/${id}/test`);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.ok).toBe(true);
      expect(res._body.runtimes).toHaveLength(1);
      expect(res._body.runtimes[0].runtime).toBe('node');
      expect(res._body.claudePath).toBe('/usr/bin/claude');
      expect(res._body.systemInfo.os).toBe('Ubuntu 22.04');
      expect(res._body.runtimeDetectedAt).toBeTruthy();
    });

    it('POST /api/machines/:id/test should still succeed when detection fails', async () => {
      const cr = createReq('POST', '/api/machines', { name: 'rt2', ip: '1.1.1.1', username: 'u' });
      const cres = createRes();
      await handleApiRequest(cr, cres);
      const id = cres._body.id;

      mockTestSshConnection.mockResolvedValue('ok\nhost');
      mockDetectRuntimes.mockRejectedValue(new Error('detection failed'));

      const req = createReq('POST', `/api/machines/${id}/test`);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.ok).toBe(true);
      expect(res._body.runtimes).toEqual([]);
    });

    it('POST /api/machines/:id/detect should detect runtimes', async () => {
      const cr = createReq('POST', '/api/machines', { name: 'det', ip: '1.1.1.1', username: 'u' });
      const cres = createRes();
      await handleApiRequest(cr, cres);
      const id = cres._body.id;

      mockDetectRuntimes.mockResolvedValue({
        runtimes: [{ runtime: 'bun', version: '1.0.25', path: '/usr/bin/bun' }],
        claudePath: '',
        systemInfo: { os: 'Debian 12', kernel: 'Linux 6.1.0', cpuCores: 4 },
      });

      const req = createReq('POST', `/api/machines/${id}/detect`);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.runtimes).toHaveLength(1);
      expect(res._body.runtimes[0].runtime).toBe('bun');
      expect(res._body.claudePath).toBe('');
      expect(res._body.systemInfo.os).toBe('Debian 12');
      expect(res._body.systemInfo.cpuCores).toBe(4);
      expect(res._body.runtimeDetectedAt).toBeTruthy();
    });

    it('POST /api/machines/:id/detect should 404 for unknown machine', async () => {
      const req = createReq('POST', '/api/machines/nonexistent/detect');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });

    it('POST /api/machines/:id/detect should 422 on detection failure', async () => {
      const cr = createReq('POST', '/api/machines', { name: 'fail', ip: '1.1.1.1', username: 'u' });
      const cres = createRes();
      await handleApiRequest(cr, cres);
      const id = cres._body.id;

      mockDetectRuntimes.mockRejectedValue(new Error('SSH failed'));

      const req = createReq('POST', `/api/machines/${id}/detect`);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(422);
      expect(res._body.error).toBe('SSH failed');
    });

    it('POST /api/machines/:id/setup should setup machine', async () => {
      const cr = createReq('POST', '/api/machines', { name: 'setup-test', ip: '1.1.1.1', username: 'u' });
      const cres = createRes();
      await handleApiRequest(cr, cres);
      const id = cres._body.id;

      mockSetupMachine.mockImplementation((_machine: any, onStep: Function) => {
        onStep({ phase: 'bun', status: 'skipped', message: 'bun already installed (1.0.25)' });
        onStep({ phase: 'claude', status: 'done', message: 'claude installed' });
        onStep({ phase: 'detect', status: 'done', message: 'Found 1 runtime(s)' });
        return Promise.resolve({
          runtimes: [{ runtime: 'bun', version: '1.0.25', path: '/usr/bin/bun' }],
          claudePath: '/usr/bin/claude',
          systemInfo: { os: 'Ubuntu 22.04', cpuCores: 16 },
        });
      });

      const req = createReq('POST', `/api/machines/${id}/setup`);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.steps).toHaveLength(3);
      expect(res._body.runtimes).toHaveLength(1);
      expect(res._body.claudePath).toBe('/usr/bin/claude');
      expect(res._body.systemInfo.os).toBe('Ubuntu 22.04');
      expect(res._body.runtimeDetectedAt).toBeTruthy();
    });

    it('POST /api/machines/:id/setup should 404 for unknown machine', async () => {
      const req = createReq('POST', '/api/machines/nonexistent/setup');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });

    it('POST /api/machines/:id/setup should 422 on failure', async () => {
      const cr = createReq('POST', '/api/machines', { name: 'setup-fail', ip: '1.1.1.1', username: 'u' });
      const cres = createRes();
      await handleApiRequest(cr, cres);
      const id = cres._body.id;

      mockSetupMachine.mockImplementation((_machine: any, onStep: Function) => {
        onStep({ phase: 'bun', status: 'running', message: 'Installing bun...' });
        onStep({ phase: 'bun', status: 'error', message: 'bun install failed' });
        return Promise.reject(new Error('bun install failed'));
      });

      const req = createReq('POST', `/api/machines/${id}/setup`);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(422);
      expect(res._body.error).toBe('bun install failed');
      expect(res._body.steps).toHaveLength(2);
    });

    it('GET /api/machines should include runtime fields', async () => {
      machineStore.machineStore.upsert({
        id: 'rt-machine', name: 'rt-test', alias: 'rt', ip: '1.1.1.1', port: 22,
        username: 'root', createdAt: '', updatedAt: '',
        runtimes: [{ runtime: 'node', version: 'v20.0.0', path: '/usr/bin/node' }],
        claudePath: '/usr/bin/claude',
        runtimeDetectedAt: '2024-01-01T00:00:00.000Z',
      });

      const req = createReq('GET', '/api/machines');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      const m = res._body.find((x: any) => x.id === 'rt-machine');
      expect(m).toBeDefined();
      expect(m.runtimes).toHaveLength(1);
      expect(m.claudePath).toBe('/usr/bin/claude');
      expect(m.runtimeDetectedAt).toBe('2024-01-01T00:00:00.000Z');
    });
  });

  // ── Session endpoints ────────────────────────────────────────────────────

  describe('Session endpoints', () => {
    it('GET /api/sessions should list sessions with new fields', async () => {
      const { sessionStore: store } = sessionStore;
      store.upsert({
        sessionId: 'sess-1', clientId: 'c1', hostname: 'h1', workdir: '/w',
        connectedAt: new Date().toISOString(), status: 'connected',
        jobs: [], type: 'remote', name: 'my-session', machineId: 'm1',
      });

      const req = createReq('GET', '/api/sessions');
      const res = createRes();
      await handleApiRequest(req, res);

      expect(res._status).toBe(200);
      expect(res._body).toHaveLength(1);
      expect(res._body[0].type).toBe('remote');
      expect(res._body[0].name).toBe('my-session');
      expect(res._body[0].machineId).toBe('m1');
    });

    it('POST /api/sessions should create a remote session', async () => {
      // Create machine first
      machineStore.machineStore.upsert({
        id: 'm1', name: 'machine', alias: 'mc', ip: '1.1.1.1', port: 22,
        username: 'root', defaultWorkdir: '/opt', createdAt: '', updatedAt: '',
      });

      const req = createReq('POST', '/api/sessions', {
        machineId: 'm1', name: 'my-remote', workdir: '/custom',
      });
      const res = createRes();
      await handleApiRequest(req, res);

      expect(res._status).toBe(201);
      expect(res._body.type).toBe('remote');
      expect(res._body.name).toBe('my-remote');
      expect(res._body.machineId).toBe('m1');
    });

    it('POST /api/sessions should require machineId', async () => {
      const req = createReq('POST', '/api/sessions', {});
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(400);
    });

    it('POST /api/sessions should 404 for unknown machine', async () => {
      const req = createReq('POST', '/api/sessions', { machineId: 'unknown' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });

    it('GET /api/sessions/:id should return session', async () => {
      sessionStore.sessionStore.upsert({
        sessionId: 'sess-full', clientId: '', hostname: 'h', workdir: '/w',
        connectedAt: '', status: 'connected', jobs: [], type: 'remote', machineId: 'm1',
      });

      const req = createReq('GET', '/api/sessions/sess-full');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.sessionId).toBe('sess-full');
    });

    it('GET /api/sessions/:id should 404 for unknown', async () => {
      const req = createReq('GET', '/api/sessions/nonexistent');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });

    it('PATCH /api/sessions/:id should rename session', async () => {
      sessionStore.sessionStore.upsert({
        sessionId: 'sess-rename', clientId: '', hostname: 'h', workdir: '/w',
        connectedAt: '', status: 'connected', jobs: [], type: 'remote', machineId: 'm1',
      });

      const req = createReq('PATCH', '/api/sessions/sess-rename', { name: 'new-name' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.name).toBe('new-name');
    });

    it('PATCH /api/sessions/:id should 404 for unknown', async () => {
      const req = createReq('PATCH', '/api/sessions/nonexistent', { name: 'x' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });

    it('DELETE /api/sessions/:id should abort remote session', async () => {
      sessionStore.sessionStore.upsert({
        sessionId: 'sess-del-remote', clientId: '', hostname: 'h', workdir: '/w',
        connectedAt: '', status: 'connected', jobs: [], type: 'remote', machineId: 'm1',
      });

      const req = createReq('DELETE', '/api/sessions/sess-del-remote');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(mockAbortRemoteJob).toHaveBeenCalledWith('sess-del-remote');
    });

    it('DELETE /api/sessions/:id should 404 for unknown', async () => {
      const req = createReq('DELETE', '/api/sessions/nonexistent');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });
  });

  // ── Abort ────────────────────────────────────────────────────────────────

  describe('POST /api/sessions/:id/abort', () => {
    it('should abort running job and return aborted=true', async () => {
      sessionStore.sessionStore.upsert({
        sessionId: 'sess-abort', clientId: '', hostname: 'h', workdir: '/w',
        connectedAt: '', status: 'connected', jobs: [], type: 'remote', machineId: 'm1',
      });
      mockAbortRemoteJob.mockReturnValue(true);

      const req = createReq('POST', '/api/sessions/sess-abort/abort');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body).toEqual({ ok: true, aborted: true });
      expect(mockAbortRemoteJob).toHaveBeenCalledWith('sess-abort');
    });

    it('should return aborted=false when no active job', async () => {
      sessionStore.sessionStore.upsert({
        sessionId: 'sess-idle', clientId: '', hostname: 'h', workdir: '/w',
        connectedAt: '', status: 'connected', jobs: [], type: 'remote', machineId: 'm1',
      });
      mockAbortRemoteJob.mockReturnValue(false);

      const req = createReq('POST', '/api/sessions/sess-idle/abort');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body).toEqual({ ok: true, aborted: false });
    });

    it('should 404 for unknown session', async () => {
      const req = createReq('POST', '/api/sessions/unknown/abort');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });
  });

  // ── Send ─────────────────────────────────────────────────────────────────

  describe('POST /api/sessions/:id/send', () => {
    it('should route to remote executor for remote session', async () => {
      sessionStore.sessionStore.upsert({
        sessionId: 'sess-remote', clientId: '', hostname: 'h', workdir: '/w',
        connectedAt: '', status: 'connected', jobs: [], type: 'remote', machineId: 'm1',
      });

      const req = createReq('POST', '/api/sessions/sess-remote/send', { prompt: 'do it' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.jobId).toBeDefined();
      expect(mockExecuteRemoteJob).toHaveBeenCalledWith('sess-remote', expect.any(String), 'do it', undefined);
    });

    it('should 404 for unknown session', async () => {
      const req = createReq('POST', '/api/sessions/unknown/send', { prompt: 'hello' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });

    it('should 400 when prompt missing', async () => {
      sessionStore.sessionStore.upsert({
        sessionId: 'sess-np', clientId: '', hostname: 'h', workdir: '/w',
        connectedAt: '', status: 'connected', jobs: [], type: 'remote', machineId: 'm1',
      });

      const req = createReq('POST', '/api/sessions/sess-np/send', {});
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(400);
    });

    it('should 422 for session without machineId', async () => {
      sessionStore.sessionStore.upsert({
        sessionId: 'sess-no-machine', clientId: '', hostname: 'h', workdir: '/w',
        connectedAt: '', status: 'connected', jobs: [], type: 'remote',
      });

      const req = createReq('POST', '/api/sessions/sess-no-machine/send', { prompt: 'hello' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(422);
      expect(res._body.error).toContain('no associated machine');
    });
  });

  // ── Jobs endpoints ─────────────────────────────────────────────────────

  describe('Jobs endpoints', () => {
    it('GET /api/jobs/active should return empty when no active sessions', async () => {
      mockGetActiveSessionIds.mockReturnValue([]);
      const req = createReq('GET', '/api/jobs/active');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body).toEqual([]);
    });

    it('GET /api/jobs/active should return running jobs with session info', async () => {
      // Setup a session with a running job
      const session = sessionStore.sessionStore.get(
        sessionStore.sessionStore.getAll().find(s => s.type === 'remote')?.sessionId ?? '',
      );
      if (!session) {
        // Create a remote session for this test
        const { machineStore: ms } = await import('../../src/machines/machineStore.js');
        ms.upsert({
          id: 'jm-1', name: 'job-machine', alias: 'jm', ip: '10.0.0.1',
          port: 22, username: 'user', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        const s: import('../../src/sessions/sessionStore.js').SessionRecord = {
          sessionId: 'job-sess-1', clientId: '', hostname: 'test', workdir: '',
          connectedAt: new Date().toISOString(), status: 'connected',
          jobs: [{
            jobId: 'running-job-1', prompt: 'analyze codebase',
            startedAt: new Date().toISOString(), chunks: [
              { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'analyzing...' } } },
            ],
          }],
          type: 'remote', name: 'dev-agent', machineId: 'jm-1', model: 'opus',
        };
        sessionStore.sessionStore.upsert(s);
        mockGetActiveSessionIds.mockReturnValue(['job-sess-1']);
      }

      const req = createReq('GET', '/api/jobs/active');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body).toHaveLength(1);
      expect(res._body[0]).toMatchObject({
        sessionId: 'job-sess-1',
        sessionName: 'dev-agent',
        model: 'opus',
        jobId: 'running-job-1',
        status: 'running',
        source: 'adhoc',
        chunkCount: 1,
      });
      expect(res._body[0].prompt).toContain('analyze');
    });

    it('GET /api/jobs/recent should return empty when no finished jobs', async () => {
      const req = createReq('GET', '/api/jobs/recent');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body).toEqual([]);
    });

    it('GET /api/jobs/recent should return completed jobs sorted by finishedAt desc', async () => {
      // Create session with 3 finished jobs
      const s: import('../../src/sessions/sessionStore.js').SessionRecord = {
        sessionId: 'recent-sess', clientId: '', hostname: 'test', workdir: '',
        connectedAt: new Date().toISOString(), status: 'connected',
        jobs: [
          {
            jobId: 'old-job', prompt: 'first task', startedAt: '2026-04-13T10:00:00Z',
            finishedAt: '2026-04-13T10:01:00Z', exitCode: 0, durationMs: 60000, chunks: [],
          },
          {
            jobId: 'mid-job', prompt: 'second task', startedAt: '2026-04-13T10:05:00Z',
            finishedAt: '2026-04-13T10:06:00Z', exitCode: 1, durationMs: 60000, chunks: [],
          },
          {
            jobId: 'new-job', prompt: 'third task', startedAt: '2026-04-13T10:10:00Z',
            finishedAt: '2026-04-13T10:11:00Z', exitCode: 0, durationMs: 60000, chunks: [],
          },
          {
            jobId: 'still-running', prompt: 'current', startedAt: '2026-04-13T10:15:00Z',
            chunks: [],
          },
        ],
        type: 'remote', name: 'qa-bob', machineId: 'jm-1',
      };
      sessionStore.sessionStore.upsert(s);

      const req = createReq('GET', '/api/jobs/recent');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      // Only 3 finished jobs (not the still-running one)
      expect(res._body).toHaveLength(3);
      // Sorted newest first
      expect(res._body[0].jobId).toBe('new-job');
      expect(res._body[1].jobId).toBe('mid-job');
      expect(res._body[2].jobId).toBe('old-job');
      // Status derived correctly
      expect(res._body[0].status).toBe('done');
      expect(res._body[1].status).toBe('failed');
    });

    it('GET /api/jobs/recent should respect limit param', async () => {
      const req = createReq('GET', '/api/jobs/recent?limit=1');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.length).toBeLessThanOrEqual(1);
    });

    it('GET /api/jobs/recent should show error status for errored jobs', async () => {
      const s: import('../../src/sessions/sessionStore.js').SessionRecord = {
        sessionId: 'err-sess', clientId: '', hostname: 'test', workdir: '',
        connectedAt: new Date().toISOString(), status: 'connected',
        jobs: [{
          jobId: 'err-job', prompt: 'will fail', startedAt: '2026-04-13T10:00:00Z',
          finishedAt: '2026-04-13T10:00:05Z', error: 'SSH connection refused', chunks: [],
        }],
        type: 'remote', name: 'broken-agent', machineId: 'jm-1',
      };
      sessionStore.sessionStore.upsert(s);

      const req = createReq('GET', '/api/jobs/recent');
      const res = createRes();
      await handleApiRequest(req, res);
      const errJob = res._body.find((j: any) => j.jobId === 'err-job');
      expect(errJob).toBeDefined();
      expect(errJob.status).toBe('error');
      expect(errJob.error).toBe('SSH connection refused');
    });

    it('GET /api/jobs/recent should include source field', async () => {
      const s: import('../../src/sessions/sessionStore.js').SessionRecord = {
        sessionId: 'source-sess', clientId: '', hostname: 'test', workdir: '',
        connectedAt: new Date().toISOString(), status: 'connected',
        jobs: [
          {
            jobId: 'hub-job', prompt: '[HUB #proj]', startedAt: '2026-04-13T11:00:00Z',
            finishedAt: '2026-04-13T11:01:00Z', exitCode: 0, durationMs: 60000, chunks: [],
            source: 'hub' as const,
          },
          {
            jobId: 'trigger-job', prompt: 'triggered', startedAt: '2026-04-13T11:02:00Z',
            finishedAt: '2026-04-13T11:03:00Z', exitCode: 0, durationMs: 60000, chunks: [],
            source: 'trigger' as const,
          },
          {
            jobId: 'adhoc-job', prompt: 'hello', startedAt: '2026-04-13T11:04:00Z',
            finishedAt: '2026-04-13T11:05:00Z', exitCode: 0, durationMs: 60000, chunks: [],
          },
        ],
        type: 'remote', name: 'source-test', machineId: 'jm-1',
      };
      sessionStore.sessionStore.upsert(s);

      const req = createReq('GET', '/api/jobs/recent');
      const res = createRes();
      await handleApiRequest(req, res);
      const hubJob = res._body.find((j: any) => j.jobId === 'hub-job');
      const triggerJob = res._body.find((j: any) => j.jobId === 'trigger-job');
      const adhocJob = res._body.find((j: any) => j.jobId === 'adhoc-job');
      expect(hubJob.source).toBe('hub');
      expect(triggerJob.source).toBe('trigger');
      expect(adhocJob.source).toBe('adhoc'); // defaults to adhoc when undefined
    });
  });

  // ── Hub endpoints ──────────────────────────────────────────────────────

  describe('Hub endpoints', () => {
    it('GET /api/hub/channels should return empty list initially', async () => {
      const req = createReq('GET', '/api/hub/channels');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body).toEqual([]);
    });

    it('POST /api/hub/channels should create a channel', async () => {
      const req = createReq('POST', '/api/hub/channels', {
        id: 'general', name: '#general', description: 'Main channel',
      });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(201);
      expect(res._body.id).toBe('general');
      expect(res._body.name).toBe('#general');
    });

    it('POST /api/hub/channels should 400 for missing fields', async () => {
      const req = createReq('POST', '/api/hub/channels', { id: 'test' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(400);
    });

    it('POST /api/hub/channels should 409 for duplicate', async () => {
      // Create first
      const hubStore = (await import('../../src/hub/hubStore.js')).hubStore;
      hubStore.createChannel('dup', '#dup', 'api');

      const req = createReq('POST', '/api/hub/channels', { id: 'dup', name: '#dup' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(409);
    });

    it('GET /api/hub/channels/:id/messages should return messages', async () => {
      const req = createReq('GET', '/api/hub/channels/general/messages');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(Array.isArray(res._body)).toBe(true);
    });

    it('POST /api/hub/messages should create a message', async () => {
      const req = createReq('POST', '/api/hub/messages', {
        channelIds: ['test-ch'],
        content: 'Hello hub',
        tags: ['test'],
      });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(201);
      expect(res._body.content).toBe('Hello hub');
      expect(res._body.channelId).toBe('test-ch');
    });

    it('POST /api/hub/messages should 400 for missing content', async () => {
      const req = createReq('POST', '/api/hub/messages', { channelIds: ['ch'] });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(400);
    });

    it('POST /api/hub/messages should 400 for missing channelIds', async () => {
      const req = createReq('POST', '/api/hub/messages', { content: 'test' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(400);
    });

    it('GET /api/hub/messages/:id should return a message', async () => {
      const hubStore = (await import('../../src/hub/hubStore.js')).hubStore;
      hubStore.addMessage({
        id: 'test-msg', channelId: 'ch', from: 'user', fromName: 'User',
        content: 'test', tags: [], mentions: [], depth: 0,
        timestamp: new Date().toISOString(), status: 'pending', dispatches: [],
      });

      const req = createReq('GET', '/api/hub/messages/test-msg');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.id).toBe('test-msg');
    });

    it('GET /api/hub/messages/:id should 404 for unknown', async () => {
      const req = createReq('GET', '/api/hub/messages/unknown');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });

    it('GET /api/hub/messages/:id/thread should return thread', async () => {
      const hubStore = (await import('../../src/hub/hubStore.js')).hubStore;
      hubStore.addMessage({
        id: 'thread-parent', channelId: 'ch', from: 'user', fromName: 'User',
        content: 'parent', tags: [], mentions: [], depth: 0,
        timestamp: new Date().toISOString(), status: 'pending', dispatches: [],
      });
      hubStore.addMessage({
        id: 'thread-child', channelId: 'ch', from: 'bot', fromName: 'Bot',
        content: 'reply', tags: [], mentions: [], parentId: 'thread-parent', depth: 1,
        timestamp: new Date().toISOString(), status: 'pending', dispatches: [],
      });

      const req = createReq('GET', '/api/hub/messages/thread-parent/thread');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body).toHaveLength(2);
    });
  });

  // ── Task endpoints ──────────────────────────────────────────────────────

  describe('Task endpoints', () => {
    it('GET /api/hub/channels/:id/tasks should reject unauth', async () => {
      const req = createReq('GET', '/api/hub/channels/c1/tasks', undefined, false);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(401);
    });

    it('POST /api/hub/channels/:id/tasks should create a task', async () => {
      const req = createReq('POST', '/api/hub/channels/c1/tasks', {
        title: 'Fix LCP', tags: ['perf'], assignee: 'qa-bob', priority: 'high',
      });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(201);
      expect(res._body.id).toMatch(/^bJIRA-\d+$/);
      expect(res._body.title).toBe('Fix LCP');
      expect(res._body.assignee).toBe('qa-bob');
    });

    it('POST /api/hub/channels/:id/tasks should 400 for missing title', async () => {
      const req = createReq('POST', '/api/hub/channels/c1/tasks', { tags: ['x'] });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(400);
    });

    it('GET /api/hub/channels/:id/tasks should list tasks', async () => {
      const { taskStore } = await import('../../src/hub/taskStore.js');
      taskStore.createTask('c-list', { title: 'a' }, 'u');
      taskStore.createTask('c-list', { title: 'b' }, 'u');

      const req = createReq('GET', '/api/hub/channels/c-list/tasks');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body).toHaveLength(2);
    });

    it('GET /api/hub/channels/:id/tasks?status=open filters by status', async () => {
      const { taskStore } = await import('../../src/hub/taskStore.js');
      taskStore.createTask('c-filt', { title: 'open one' }, 'u');
      taskStore.createTask('c-filt', { title: 'done one', status: 'done' }, 'u');

      const req = createReq('GET', '/api/hub/channels/c-filt/tasks?status=open');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body).toHaveLength(1);
      expect(res._body[0].title).toBe('open one');
    });

    it('GET /api/hub/channels/:id/tasks?q=foo searches', async () => {
      const { taskStore } = await import('../../src/hub/taskStore.js');
      taskStore.createTask('c-search', { title: 'Fix LCP', description: 'lighthouse' }, 'u');
      taskStore.createTask('c-search', { title: 'JWT refresh' }, 'u');

      const req = createReq('GET', '/api/hub/channels/c-search/tasks?q=lcp');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body).toHaveLength(1);
    });

    it('GET /api/hub/tasks/:id should return task', async () => {
      const { taskStore } = await import('../../src/hub/taskStore.js');
      const t = taskStore.createTask('c-get', { title: 'X' }, 'u');

      const req = createReq('GET', `/api/hub/tasks/${t.id}`);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.title).toBe('X');
    });

    it('GET /api/hub/tasks/:id should 404 for unknown', async () => {
      const req = createReq('GET', '/api/hub/tasks/bJIRA-9999');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });

    it('PATCH /api/hub/tasks/:id should update task', async () => {
      const { taskStore } = await import('../../src/hub/taskStore.js');
      const t = taskStore.createTask('c-patch', { title: 'X' }, 'u');

      const req = createReq('PATCH', `/api/hub/tasks/${t.id}`, { status: 'done' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.status).toBe('done');
    });

    it('PATCH /api/hub/tasks/:id should 404 for unknown', async () => {
      const req = createReq('PATCH', '/api/hub/tasks/bJIRA-9999', { status: 'done' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });

    it('POST /api/hub/tasks/:id/comments should add comment', async () => {
      const { taskStore } = await import('../../src/hub/taskStore.js');
      const t = taskStore.createTask('c-cmt', { title: 'X' }, 'u');

      const req = createReq('POST', `/api/hub/tasks/${t.id}/comments`, { text: 'looks good' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.activity.some((a: any) => a.kind === 'comment' && a.text === 'looks good')).toBe(true);
    });

    it('POST /api/hub/tasks/:id/comments should 400 for missing text', async () => {
      const { taskStore } = await import('../../src/hub/taskStore.js');
      const t = taskStore.createTask('c-cmt2', { title: 'X' }, 'u');

      const req = createReq('POST', `/api/hub/tasks/${t.id}/comments`, {});
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(400);
    });

    it('DELETE /api/hub/tasks/:id should remove task', async () => {
      const { taskStore } = await import('../../src/hub/taskStore.js');
      const t = taskStore.createTask('c-del', { title: 'X' }, 'u');

      const req = createReq('DELETE', `/api/hub/tasks/${t.id}`);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(taskStore.getTask(t.id)).toBeUndefined();
    });

    it('DELETE /api/hub/tasks/:id should 404 for unknown', async () => {
      const req = createReq('DELETE', '/api/hub/tasks/bJIRA-9999');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });
  });

  // ── Doc endpoints ───────────────────────────────────────────────────────

  describe('Doc endpoints', () => {
    it('GET /api/hub/channels/:id/docs should reject unauth', async () => {
      const req = createReq('GET', '/api/hub/channels/c1/docs', undefined, false);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(401);
    });

    it('POST /api/hub/channels/:id/docs should create a doc', async () => {
      const req = createReq('POST', '/api/hub/channels/d1/docs', {
        title: 'Auth Spec', body: '# Auth\nJWT', tags: ['auth'],
      });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(201);
      expect(res._body.id).toMatch(/^bCONF-\d+$/);
      expect(res._body.title).toBe('Auth Spec');
      expect(res._body.version).toBe(1);
    });

    it('POST /api/hub/channels/:id/docs should 400 for missing title', async () => {
      const req = createReq('POST', '/api/hub/channels/d1/docs', { body: 'b' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(400);
    });

    it('GET /api/hub/channels/:id/docs?q=foo searches', async () => {
      const { docStore } = await import('../../src/hub/docStore.js');
      docStore.createDoc('d-search', 'Auth Spec', '# Auth\nJWT', 'u', ['auth']);
      docStore.createDoc('d-search', 'Perf Plan', '# Perf', 'u', ['perf']);

      const req = createReq('GET', '/api/hub/channels/d-search/docs?q=jwt');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body).toHaveLength(1);
    });

    it('GET /api/hub/docs/:id should return doc', async () => {
      const { docStore } = await import('../../src/hub/docStore.js');
      const d = docStore.createDoc('d-get', 'X', 'body', 'u');

      const req = createReq('GET', `/api/hub/docs/${d.id}`);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.title).toBe('X');
    });

    it('GET /api/hub/docs/:id should 404 for unknown', async () => {
      const req = createReq('GET', '/api/hub/docs/bCONF-9999');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });

    it('PATCH /api/hub/docs/:id should bump version', async () => {
      const { docStore } = await import('../../src/hub/docStore.js');
      const d = docStore.createDoc('d-patch', 'X', 'v1 body', 'u');

      const req = createReq('PATCH', `/api/hub/docs/${d.id}`, { body: 'v2 body' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.version).toBe(2);
      expect(res._body.body).toBe('v2 body');
    });

    it('POST /api/hub/docs/:id/append should append', async () => {
      const { docStore } = await import('../../src/hub/docStore.js');
      const d = docStore.createDoc('d-app', 'X', 'orig', 'u');

      const req = createReq('POST', `/api/hub/docs/${d.id}/append`, { text: 'extra' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.body).toContain('orig');
      expect(res._body.body).toContain('extra');
      expect(res._body.version).toBe(2);
    });

    it('GET /api/hub/docs/:id/history should return history', async () => {
      const { docStore } = await import('../../src/hub/docStore.js');
      const d = docStore.createDoc('d-hist', 'X', 'v1', 'u');
      docStore.updateDoc(d.id, { body: 'v2' }, 'u');
      docStore.updateDoc(d.id, { body: 'v3' }, 'u');

      const req = createReq('GET', `/api/hub/docs/${d.id}/history`);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body).toHaveLength(2);
    });

    it('DELETE /api/hub/docs/:id should soft-delete (archive) doc', async () => {
      const { docStore } = await import('../../src/hub/docStore.js');
      const d = docStore.createDoc('d-del', 'X', 'b', 'u');

      const req = createReq('DELETE', `/api/hub/docs/${d.id}`);
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.archived).toBe(true);
      // Doc still exists but is archived
      const doc = docStore.getDoc(d.id);
      expect(doc).toBeDefined();
      expect(doc!.archived).toBe(true);
      // Archived docs are excluded from channel listing
      expect(docStore.getByChannel('d-del').find(x => x.id === d.id)).toBeUndefined();
      // But included with flag
      expect(docStore.getByChannel('d-del', true).find(x => x.id === d.id)).toBeDefined();
    });

    it('DELETE /api/hub/docs/:id should 404 for unknown', async () => {
      const req = createReq('DELETE', '/api/hub/docs/bCONF-9999');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });
  });

  // ── Session hub fields ──────────────────────────────────────────────────

  describe('Session hub fields', () => {
    it('POST /api/sessions should accept role and screenName', async () => {
      machineStore.machineStore.upsert({
        id: 'm-hub', name: 'hub-machine', alias: 'hm', ip: '1.1.1.1', port: 22,
        username: 'root', createdAt: '', updatedAt: '',
      });

      const req = createReq('POST', '/api/sessions', {
        machineId: 'm-hub', name: 'ceo-session',
        role: 'CEO', screenName: 'ceo-1',
        interests: ['strategy', 'vision'],
        channels: ['general', 'executive'],
        rolePrompt: 'You are the CEO.',
      });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(201);
      expect(res._body.role).toBe('CEO');
      expect(res._body.screenName).toBe('ceo-1');
      expect(res._body.interests).toEqual(['strategy', 'vision']);
      expect(res._body.channels).toEqual(['general', 'executive']);
      expect(res._body.rolePrompt).toBe('You are the CEO.');
    });

    it('PATCH /api/sessions/:id should update role fields', async () => {
      sessionStore.sessionStore.upsert({
        sessionId: 'sess-hub-patch', clientId: '', hostname: 'h', workdir: '/w',
        connectedAt: '', status: 'connected', jobs: [], type: 'remote', machineId: 'm1',
      });

      const req = createReq('PATCH', '/api/sessions/sess-hub-patch', {
        role: 'QA', screenName: 'qa-bob',
        interests: ['testing'], channels: ['qa'],
      });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.role).toBe('QA');
      expect(res._body.screenName).toBe('qa-bob');
      expect(res._body.interests).toEqual(['testing']);
      expect(res._body.channels).toEqual(['qa']);
    });

    it('GET /api/sessions should include role and screenName', async () => {
      sessionStore.sessionStore.upsert({
        sessionId: 'sess-list-hub', clientId: '', hostname: 'h', workdir: '/w',
        connectedAt: '', status: 'connected', jobs: [], type: 'remote', machineId: 'm1',
        role: 'Dev', screenName: 'dev-1', interests: ['code'], channels: ['dev'],
      });

      const req = createReq('GET', '/api/sessions');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      const s = res._body.find((x: any) => x.sessionId === 'sess-list-hub');
      expect(s).toBeDefined();
      expect(s.role).toBe('Dev');
      expect(s.screenName).toBe('dev-1');
      expect(s.interests).toEqual(['code']);
      expect(s.channels).toEqual(['dev']);
    });
  });

  // ── Push ─────────────────────────────────────────────────────────────────

  describe('Push endpoints', () => {
    it('GET /api/push/vapid-key should return public key', async () => {
      const req = createReq('GET', '/api/push/vapid-key');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.publicKey).toBe('mock-vapid-key');
    });

    it('POST /api/push/subscribe should accept subscription', async () => {
      const req = createReq('POST', '/api/push/subscribe', {
        endpoint: 'https://push.example.com/sub',
        keys: { p256dh: 'k1', auth: 'k2' },
      });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
    });

    it('POST /api/push/subscribe should 400 for missing endpoint', async () => {
      const req = createReq('POST', '/api/push/subscribe', {});
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(400);
    });
  });

  describe('settings', () => {
    it('GET /api/settings should return current settings', async () => {
      const req = createReq('GET', '/api/settings');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.compactTokenThreshold).toBe(80000);
      expect(res._body.hubMaxConcurrentJobs).toBe(3);
      expect(res._body.hubCooldownMs).toBe(0);
      expect(res._body.hubMaxTalkRounds).toBe(10);
      expect(res._body.hubMaxChainDepth).toBe(5);
      expect(res._body.sshIdleTimeoutMs).toBe(1800000);
    });

    it('PATCH /api/settings should update settings', async () => {
      const req = createReq('PATCH', '/api/settings', { compactTokenThreshold: 50000 });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.compactTokenThreshold).toBe(50000);
      expect(mockConfig.compactTokenThreshold).toBe(50000);
      // restore
      mockConfig.compactTokenThreshold = 80000;
    });

    it('PATCH /api/settings should ignore invalid values', async () => {
      const original = mockConfig.compactTokenThreshold;
      const req = createReq('PATCH', '/api/settings', { compactTokenThreshold: -5 });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(mockConfig.compactTokenThreshold).toBe(original);
    });

    it('PATCH /api/settings should ignore unknown keys', async () => {
      const req = createReq('PATCH', '/api/settings', { unknownKey: 999 });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
    });
  });

  // ── Jump hosts ────────────────────────────────────────────────────────
  describe('Jump hosts', () => {
    it('GET /api/jumphosts should return redacted config', async () => {
      mockJumpHostStore.getRedactedConfig.mockReturnValue({ enabled: true, hosts: [{ id: 'h1', host: '10.0.0.1', port: 22, username: 'root', hasPassword: true, hasPassphrase: false }] });
      const req = createReq('GET', '/api/jumphosts');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.enabled).toBe(true);
      expect(res._body.hosts).toHaveLength(1);
    });

    it('PUT /api/jumphosts should replace config', async () => {
      mockJumpHostStore.getRedactedConfig.mockReturnValue({ enabled: true, hosts: [] });
      const req = createReq('PUT', '/api/jumphosts', { enabled: true, hosts: [] });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(mockJumpHostStore.setConfig).toHaveBeenCalled();
    });

    it('PATCH /api/jumphosts/enabled should toggle', async () => {
      mockJumpHostStore.getConfig.mockReturnValue({ enabled: true, hosts: [] });
      const req = createReq('PATCH', '/api/jumphosts/enabled', { enabled: true });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(mockJumpHostStore.setEnabled).toHaveBeenCalledWith(true);
    });

    it('POST /api/jumphosts/hosts should add host', async () => {
      mockJumpHostStore.getRedactedConfig.mockReturnValue({ enabled: false, hosts: [{ id: 'new', host: '1.2.3.4', port: 22, username: 'root' }] });
      const req = createReq('POST', '/api/jumphosts/hosts', { host: '1.2.3.4', username: 'root' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(201);
      expect(mockJumpHostStore.addHost).toHaveBeenCalled();
    });

    it('POST /api/jumphosts/hosts should 400 without required fields', async () => {
      const req = createReq('POST', '/api/jumphosts/hosts', { host: '1.2.3.4' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(400);
    });

    it('PUT /api/jumphosts/hosts/:id should update host', async () => {
      mockJumpHostStore.getRedactedConfig.mockReturnValue({ enabled: false, hosts: [] });
      const req = createReq('PUT', '/api/jumphosts/hosts/h1', { username: 'admin' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(mockJumpHostStore.updateHost).toHaveBeenCalledWith('h1', expect.objectContaining({ username: 'admin' }));
    });

    it('PUT /api/jumphosts/hosts/:id should 404 for unknown host', async () => {
      mockJumpHostStore.updateHost.mockReturnValueOnce(false);
      const req = createReq('PUT', '/api/jumphosts/hosts/nope', { username: 'admin' });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });

    it('DELETE /api/jumphosts/hosts/:id should remove host', async () => {
      mockJumpHostStore.getRedactedConfig.mockReturnValue({ enabled: false, hosts: [] });
      const req = createReq('DELETE', '/api/jumphosts/hosts/h1');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(mockJumpHostStore.removeHost).toHaveBeenCalledWith('h1');
    });

    it('DELETE /api/jumphosts/hosts/:id should 404 for unknown', async () => {
      mockJumpHostStore.removeHost.mockReturnValueOnce(false);
      const req = createReq('DELETE', '/api/jumphosts/hosts/nope');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(404);
    });

    it('PUT /api/jumphosts/reorder should reorder hosts', async () => {
      mockJumpHostStore.getRedactedConfig.mockReturnValue({ enabled: false, hosts: [] });
      const req = createReq('PUT', '/api/jumphosts/reorder', { ids: ['b', 'a'] });
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(mockJumpHostStore.reorderHosts).toHaveBeenCalledWith(['b', 'a']);
    });

    it('PUT /api/jumphosts/reorder should 400 without ids', async () => {
      const req = createReq('PUT', '/api/jumphosts/reorder', {});
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(400);
    });

    it('POST /api/jumphosts/test should test chain', async () => {
      mockJumpHostStore.getConfig.mockReturnValue({ enabled: true, hosts: [{ id: 'h1', host: '10.0.0.1', port: 22, username: 'root' }] });
      mockTestJumpHostChain.mockResolvedValue('ok\nbastion-1');
      const req = createReq('POST', '/api/jumphosts/test');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(200);
      expect(res._body.ok).toBe(true);
      expect(res._body.output).toContain('ok');
    });

    it('POST /api/jumphosts/test should 400 when no hosts', async () => {
      mockJumpHostStore.getConfig.mockReturnValue({ enabled: false, hosts: [] });
      const req = createReq('POST', '/api/jumphosts/test');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(400);
    });

    it('POST /api/jumphosts/test should 422 on failure', async () => {
      mockJumpHostStore.getConfig.mockReturnValue({ enabled: true, hosts: [{ id: 'h1', host: '10.0.0.1', port: 22, username: 'root' }] });
      mockTestJumpHostChain.mockRejectedValue(new Error('Connection refused'));
      const req = createReq('POST', '/api/jumphosts/test');
      const res = createRes();
      await handleApiRequest(req, res);
      expect(res._status).toBe(422);
      expect(res._body.ok).toBe(false);
    });
  });
});
