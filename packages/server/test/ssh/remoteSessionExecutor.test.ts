import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionRecord } from '../../src/sessions/sessionStore.js';
import type { MachineRecord } from '../../src/machines/machineStore.js';

// Mock config
const mockConfig = { persistPath: '', historyMax: 1000, machinesPersistPath: '', compactTokenThreshold: 80000 };
vi.mock('../../src/config.js', () => ({
  config: mockConfig,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: { ...actual, readFileSync: vi.fn(), writeFileSync: vi.fn(), mkdirSync: vi.fn() },
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// Track mock calls
const mockRunClaudeOverSsh = vi.fn();
const mockGetRemoteContextTokens = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/ssh/sshRunner.js', () => ({
  runClaudeOverSsh: mockRunClaudeOverSsh,
  getRemoteContextTokens: mockGetRemoteContextTokens,
}));

const mockRunClaudeViaTmuxForSession = vi.fn();
const mockAbortTmuxJob = vi.fn().mockResolvedValue(true);
vi.mock('../../src/ssh/tmuxRunner.js', () => ({
  runClaudeViaTmuxForSession: mockRunClaudeViaTmuxForSession,
  abortTmuxJob: mockAbortTmuxJob,
}));

const mockBroadcast = vi.fn();
vi.mock('../../src/ws/dashboardBroadcast.js', () => ({
  broadcastToDashboards: mockBroadcast,
}));

const mockSendPush = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/push/pushManager.js', () => ({
  pushManager: { sendPush: mockSendPush },
}));

function makeMachine(): MachineRecord {
  return {
    id: 'machine-1', name: 'test-machine', alias: 'tm1', ip: '192.168.1.1',
    port: 22, username: 'root', defaultWorkdir: '/default/work',
    createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

describe('remoteSessionExecutor', () => {
  let executor: typeof import('../../src/ssh/remoteSessionExecutor.js');
  let sessionStore: typeof import('../../src/sessions/sessionStore.js');
  let machineStore: typeof import('../../src/machines/machineStore.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Re-apply mocks
    vi.doMock('../../src/ssh/sshRunner.js', () => ({
      runClaudeOverSsh: mockRunClaudeOverSsh,
      getRemoteContextTokens: mockGetRemoteContextTokens,
    }));
    vi.doMock('../../src/ssh/tmuxRunner.js', () => ({
      runClaudeViaTmuxForSession: mockRunClaudeViaTmuxForSession,
      abortTmuxJob: mockAbortTmuxJob,
    }));
    vi.doMock('../../src/ws/dashboardBroadcast.js', () => ({
      broadcastToDashboards: mockBroadcast,
    }));
    vi.doMock('../../src/push/pushManager.js', () => ({
      pushManager: { sendPush: mockSendPush },
    }));

    sessionStore = await import('../../src/sessions/sessionStore.js');
    machineStore = await import('../../src/machines/machineStore.js');
    executor = await import('../../src/ssh/remoteSessionExecutor.js');
  });

  function setupRemoteSession(): { session: SessionRecord; machine: MachineRecord } {
    const machine = makeMachine();
    machineStore.machineStore.upsert(machine);

    const session: SessionRecord = {
      sessionId: 'sess-r1', clientId: '', hostname: 'test', workdir: '',
      connectedAt: new Date().toISOString(), status: 'connected', jobs: [],
      type: 'remote', name: 'my-remote', machineId: 'machine-1', remoteWorkdir: '/remote/path',
    };
    sessionStore.sessionStore.upsert(session);

    // Add a job
    const job = { jobId: 'job-1', prompt: 'do stuff', startedAt: new Date().toISOString(), chunks: [] as unknown[] };
    session.jobs.push(job);
    sessionStore.sessionStore.upsert(session);

    return { session, machine };
  }

  describe('executeRemoteJob', () => {
    it('should run SSH job and broadcast OUTPUT_DONE on success', async () => {
      setupRemoteSession();

      mockRunClaudeOverSsh.mockImplementation(async (_m: any, _p: any, _w: any, onChunk: Function) => {
        onChunk({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } });
        return { exitCode: 0, durationMs: 1500, claudeSessionId: 'claude-abc' };
      });

      executor.executeRemoteJob('sess-r1', 'job-1', 'do stuff');

      // Wait for async job to complete
      await vi.waitFor(() => {
        expect(mockBroadcast).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'OUTPUT_DONE', exitCode: 0 }),
        );
      });

      // Check chunk was broadcast
      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'OUTPUT_CHUNK', sessionId: 'sess-r1' }),
      );

      // Check claudeSessionId was persisted
      const session = sessionStore.sessionStore.get('sess-r1');
      expect(session!.claudeSessionId).toBe('claude-abc');

      // Check push notification
      expect(mockSendPush).toHaveBeenCalled();
    });

    it('should broadcast stream_event chunks (Claude streaming API format)', async () => {
      setupRemoteSession();

      mockRunClaudeOverSsh.mockImplementation(async (_m: any, _p: any, _w: any, onChunk: Function) => {
        // Simulate Claude CLI stream-json output with stream_event envelope
        onChunk({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello world' } },
          session_id: 'claude-stream-1',
        });
        onChunk({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file":' } },
          session_id: 'claude-stream-1',
        });
        onChunk({
          type: 'stream_event',
          event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'Read' } },
          session_id: 'claude-stream-1',
        });
        return { exitCode: 0, durationMs: 800, claudeSessionId: 'claude-stream-1' };
      });

      executor.executeRemoteJob('sess-r1', 'job-1', 'do stuff');

      await vi.waitFor(() => {
        expect(mockBroadcast).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'OUTPUT_DONE', exitCode: 0 }),
        );
      });

      // All 3 stream_event chunks should have been broadcast
      const chunkCalls = mockBroadcast.mock.calls.filter(
        (call: any[]) => call[0]?.event === 'OUTPUT_CHUNK',
      );
      expect(chunkCalls).toHaveLength(3);

      // Verify chunk data is forwarded as-is
      expect(chunkCalls[0][0].chunk).toEqual(
        expect.objectContaining({ type: 'stream_event', event: expect.objectContaining({ type: 'content_block_delta' }) }),
      );
      expect(chunkCalls[2][0].chunk).toEqual(
        expect.objectContaining({ type: 'stream_event', event: expect.objectContaining({ type: 'content_block_start' }) }),
      );

      // Chunks stored in session job
      const session = sessionStore.sessionStore.get('sess-r1');
      const job = session!.jobs.find(j => j.jobId === 'job-1');
      expect(job!.chunks).toHaveLength(3);
      expect((job!.chunks[0] as any).type).toBe('stream_event');
    });

    it('should broadcast OUTPUT_ERROR when session is invalid', async () => {
      // No session setup — session doesn't exist
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      executor.executeRemoteJob('nonexistent', 'job-1', 'prompt');

      await vi.waitFor(() => {
        expect(mockBroadcast).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'OUTPUT_ERROR', error: 'Invalid remote session configuration' }),
        );
      });
      consoleSpy.mockRestore();
    });

    it('should broadcast OUTPUT_ERROR when machine not found', async () => {
      // Create session but no machine
      const session: SessionRecord = {
        sessionId: 'sess-no-machine', clientId: '', hostname: 'test', workdir: '',
        connectedAt: new Date().toISOString(), status: 'connected',
        jobs: [{ jobId: 'job-1', prompt: 'test', startedAt: new Date().toISOString(), chunks: [] }],
        type: 'remote', machineId: 'does-not-exist',
      };
      sessionStore.sessionStore.upsert(session);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      executor.executeRemoteJob('sess-no-machine', 'job-1', 'prompt');

      await vi.waitFor(() => {
        expect(mockBroadcast).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'OUTPUT_ERROR', error: expect.stringContaining('not found') }),
        );
      });
      consoleSpy.mockRestore();
    });

    it('should handle SSH error and broadcast OUTPUT_ERROR', async () => {
      setupRemoteSession();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockRunClaudeOverSsh.mockRejectedValue(new Error('SSH connection refused'));

      executor.executeRemoteJob('sess-r1', 'job-1', 'do stuff');

      await vi.waitFor(() => {
        expect(mockBroadcast).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'OUTPUT_ERROR', error: 'SSH connection refused' }),
        );
      });

      // Check job error was recorded
      const session = sessionStore.sessionStore.get('sess-r1');
      const job = session!.jobs.find(j => j.jobId === 'job-1');
      expect(job!.error).toBe('SSH connection refused');

      // Push notification for error
      expect(mockSendPush).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should send push notification with failure info on non-zero exit', async () => {
      setupRemoteSession();

      mockRunClaudeOverSsh.mockResolvedValue({ exitCode: 1, durationMs: 500 });

      executor.executeRemoteJob('sess-r1', 'job-1', 'do stuff');

      await vi.waitFor(() => {
        expect(mockSendPush).toHaveBeenCalledWith(
          expect.stringContaining('failed'),
          expect.any(String),
        );
      });
    });

    it('should use machine defaultWorkdir when remoteWorkdir not set', async () => {
      const machine = makeMachine();
      machineStore.machineStore.upsert(machine);

      const session: SessionRecord = {
        sessionId: 'sess-no-wd', clientId: '', hostname: 'test', workdir: '',
        connectedAt: new Date().toISOString(), status: 'connected',
        jobs: [{ jobId: 'job-1', prompt: 'test', startedAt: new Date().toISOString(), chunks: [] }],
        type: 'remote', machineId: 'machine-1',
        // no remoteWorkdir
      };
      sessionStore.sessionStore.upsert(session);

      mockRunClaudeOverSsh.mockResolvedValue({ exitCode: 0, durationMs: 100 });

      executor.executeRemoteJob('sess-no-wd', 'job-1', 'test');

      await vi.waitFor(() => {
        expect(mockRunClaudeOverSsh).toHaveBeenCalledWith(
          expect.anything(),
          'test',
          '/default/work',  // machine defaultWorkdir
          expect.any(Function),
          undefined,  // no claudeSessionId
          expect.anything(),
          undefined,  // no model
          undefined,  // no sshOpts
        );
      });
    });

    it('should pass claudeSessionId as resumeId', async () => {
      const { session } = setupRemoteSession();
      sessionStore.sessionStore.updateMeta('sess-r1', { claudeSessionId: 'prev-session' });

      mockRunClaudeOverSsh.mockResolvedValue({ exitCode: 0, durationMs: 100 });

      executor.executeRemoteJob('sess-r1', 'job-1', 'continue');

      await vi.waitFor(() => {
        expect(mockRunClaudeOverSsh).toHaveBeenCalledWith(
          expect.anything(),
          'continue',
          '/remote/path',
          expect.any(Function),
          'prev-session',  // resumeId
          expect.anything(),
          undefined,  // no model
          undefined,  // no sshOpts
        );
      });
    });

    it('should pass session.model when set', async () => {
      const { session } = setupRemoteSession();
      sessionStore.sessionStore.updateMeta('sess-r1', { model: 'sonnet' });

      mockRunClaudeOverSsh.mockResolvedValue({ exitCode: 0, durationMs: 100 });

      executor.executeRemoteJob('sess-r1', 'job-1', 'go');

      await vi.waitFor(() => {
        expect(mockRunClaudeOverSsh).toHaveBeenCalledWith(
          expect.anything(),
          'go',
          '/remote/path',
          expect.any(Function),
          undefined,
          expect.anything(),
          'sonnet',
          undefined,  // no sshOpts
        );
      });
    });
  });

  describe('abortRemoteJob', () => {
    it('should return false when no active execution', () => {
      expect(executor.abortRemoteJob('nonexistent')).toBe(false);
    });

    it('should abort active execution and return true', async () => {
      setupRemoteSession();

      // Make SSH run hang until aborted
      let capturedSignal: AbortSignal | undefined;
      mockRunClaudeOverSsh.mockImplementation(
        async (_m: any, _p: any, _w: any, _onChunk: Function, _resumeId?: string, signal?: AbortSignal) => {
          capturedSignal = signal;
          return new Promise((resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('Aborted')));
          });
        },
      );

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      executor.executeRemoteJob('sess-r1', 'job-1', 'long task');

      // Wait for execution to start
      await vi.waitFor(() => {
        expect(mockRunClaudeOverSsh).toHaveBeenCalled();
      });

      const aborted = executor.abortRemoteJob('sess-r1');
      expect(aborted).toBe(true);
      expect(capturedSignal?.aborted).toBe(true);
      consoleSpy.mockRestore();
    });

    it('should queue second job when session is busy instead of aborting', async () => {
      setupRemoteSession();

      let firstSignal: AbortSignal | undefined;
      let callCount = 0;
      const deferreds: Array<{ resolve: (v: any) => void; reject: (e: Error) => void }> = [];

      mockRunClaudeOverSsh.mockImplementation(
        async (_m: any, _p: any, _w: any, _onChunk: Function, _resumeId?: string, signal?: AbortSignal) => {
          callCount++;
          if (callCount === 1) firstSignal = signal;
          return new Promise((resolve, reject) => {
            deferreds.push({ resolve, reject });
            signal?.addEventListener('abort', () => reject(new Error('Aborted')));
          });
        },
      );

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      executor.executeRemoteJob('sess-r1', 'job-1', 'first');
      await vi.waitFor(() => expect(callCount).toBe(1));

      // Add second job
      const session = sessionStore.sessionStore.get('sess-r1')!;
      session.jobs.push({ jobId: 'job-2', prompt: 'second', startedAt: new Date().toISOString(), chunks: [] });
      sessionStore.sessionStore.upsert(session);

      // Second call should be queued, NOT start immediately
      executor.executeRemoteJob('sess-r1', 'job-2', 'second');
      expect(callCount).toBe(1); // still only 1 SSH call
      expect(executor.getPendingJobCount('sess-r1')).toBe(1);

      // First execution should NOT be aborted
      expect(firstSignal?.aborted).toBe(false);

      // JOB_QUEUED event should have been broadcast
      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'JOB_QUEUED', sessionId: 'sess-r1', jobId: 'job-2', queueLength: 1 }),
      );

      // Complete first job — second should auto-start
      deferreds[0].resolve({ exitCode: 0, durationMs: 100 });
      await vi.waitFor(() => expect(callCount).toBe(2));

      // Queue is now empty
      expect(executor.getPendingJobCount('sess-r1')).toBe(0);

      // Complete second job
      deferreds[1].resolve({ exitCode: 0, durationMs: 50 });
      await vi.waitFor(() => expect(executor.isSessionBusy('sess-r1')).toBe(false));

      consoleSpy.mockRestore();
    });
  });

  describe('per-session job queue', () => {
    /** Deferred helper */
    function deferred<T>() {
      let resolve!: (v: T) => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    }

    it('should execute three queued jobs in FIFO order', async () => {
      setupRemoteSession();
      const session = sessionStore.sessionStore.get('sess-r1')!;
      session.jobs.push(
        { jobId: 'job-2', prompt: 'second', startedAt: new Date().toISOString(), chunks: [] },
        { jobId: 'job-3', prompt: 'third', startedAt: new Date().toISOString(), chunks: [] },
      );
      sessionStore.sessionStore.upsert(session);

      const executedPrompts: string[] = [];
      const defs: Array<{ resolve: (v: any) => void }> = [];

      mockRunClaudeOverSsh.mockImplementation(async (_m: any, prompt: string) => {
        executedPrompts.push(prompt);
        return new Promise(resolve => { defs.push({ resolve }); });
      });

      // Fire all three
      executor.executeRemoteJob('sess-r1', 'job-1', 'first');
      executor.executeRemoteJob('sess-r1', 'job-2', 'second');
      executor.executeRemoteJob('sess-r1', 'job-3', 'third');

      await vi.waitFor(() => expect(executedPrompts).toHaveLength(1));
      expect(executedPrompts[0]).toBe('first');
      expect(executor.getPendingJobCount('sess-r1')).toBe(2);

      // Complete first → second starts
      defs[0].resolve({ exitCode: 0, durationMs: 50 });
      await vi.waitFor(() => expect(executedPrompts).toHaveLength(2));
      expect(executedPrompts[1]).toBe('second');
      expect(executor.getPendingJobCount('sess-r1')).toBe(1);

      // Complete second → third starts
      defs[1].resolve({ exitCode: 0, durationMs: 50 });
      await vi.waitFor(() => expect(executedPrompts).toHaveLength(3));
      expect(executedPrompts[2]).toBe('third');
      expect(executor.getPendingJobCount('sess-r1')).toBe(0);

      // Complete third
      defs[2].resolve({ exitCode: 0, durationMs: 50 });
      await vi.waitFor(() => expect(executor.isSessionBusy('sess-r1')).toBe(false));
    });

    it('should clear queue on abort', async () => {
      setupRemoteSession();
      const session = sessionStore.sessionStore.get('sess-r1')!;
      session.jobs.push(
        { jobId: 'job-2', prompt: 'second', startedAt: new Date().toISOString(), chunks: [] },
      );
      sessionStore.sessionStore.upsert(session);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      mockRunClaudeOverSsh.mockImplementation(async (_m: any, _p: any, _w: any, _on: Function, _r?: string, signal?: AbortSignal) => {
        return new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('Aborted')));
        });
      });

      executor.executeRemoteJob('sess-r1', 'job-1', 'first');
      await vi.waitFor(() => expect(mockRunClaudeOverSsh).toHaveBeenCalledTimes(1));
      executor.executeRemoteJob('sess-r1', 'job-2', 'second');
      expect(executor.getPendingJobCount('sess-r1')).toBe(1);

      // Abort clears queue + stops active job
      const aborted = executor.abortRemoteJob('sess-r1');
      expect(aborted).toBe(true);
      expect(executor.getPendingJobCount('sess-r1')).toBe(0);

      consoleSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('should drain queued job even after SSH error on current job', async () => {
      setupRemoteSession();
      const session = sessionStore.sessionStore.get('sess-r1')!;
      session.jobs.push(
        { jobId: 'job-2', prompt: 'second', startedAt: new Date().toISOString(), chunks: [] },
      );
      sessionStore.sessionStore.upsert(session);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let callCount = 0;

      mockRunClaudeOverSsh.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('SSH connection refused');
        return { exitCode: 0, durationMs: 50 };
      });

      executor.executeRemoteJob('sess-r1', 'job-1', 'first');
      executor.executeRemoteJob('sess-r1', 'job-2', 'second');

      // First fails, second should still run
      await vi.waitFor(() => expect(callCount).toBe(2));
      await vi.waitFor(() => expect(executor.isSessionBusy('sess-r1')).toBe(false));

      // Both jobs should have broadcast events
      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'OUTPUT_ERROR', jobId: 'job-1' }),
      );
      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'OUTPUT_DONE', jobId: 'job-2', exitCode: 0 }),
      );

      consoleSpy.mockRestore();
    });

    it('should not interfere with parallel execution on different sessions', async () => {
      // Setup two sessions
      const machine = makeMachine();
      machineStore.machineStore.upsert(machine);

      const s1: SessionRecord = {
        sessionId: 'sess-a', clientId: '', hostname: 'a', workdir: '',
        connectedAt: new Date().toISOString(), status: 'connected',
        jobs: [
          { jobId: 'job-a1', prompt: 'a1', startedAt: new Date().toISOString(), chunks: [] },
          { jobId: 'job-a2', prompt: 'a2', startedAt: new Date().toISOString(), chunks: [] },
        ],
        type: 'remote', machineId: 'machine-1', remoteWorkdir: '/a',
      };
      const s2: SessionRecord = {
        sessionId: 'sess-b', clientId: '', hostname: 'b', workdir: '',
        connectedAt: new Date().toISOString(), status: 'connected',
        jobs: [{ jobId: 'job-b1', prompt: 'b1', startedAt: new Date().toISOString(), chunks: [] }],
        type: 'remote', machineId: 'machine-1', remoteWorkdir: '/b',
      };
      sessionStore.sessionStore.upsert(s1);
      sessionStore.sessionStore.upsert(s2);

      const executedPrompts: string[] = [];
      const defs: Array<{ resolve: (v: any) => void }> = [];

      mockRunClaudeOverSsh.mockImplementation(async (_m: any, prompt: string) => {
        executedPrompts.push(prompt);
        return new Promise(resolve => { defs.push({ resolve }); });
      });

      // sess-a: two jobs (queued), sess-b: one job (runs immediately)
      executor.executeRemoteJob('sess-a', 'job-a1', 'alpha-1');
      executor.executeRemoteJob('sess-a', 'job-a2', 'alpha-2'); // queued
      executor.executeRemoteJob('sess-b', 'job-b1', 'beta-1');  // parallel

      await vi.waitFor(() => expect(executedPrompts).toHaveLength(2));
      expect(executedPrompts).toContain('alpha-1');
      expect(executedPrompts).toContain('beta-1');
      expect(executor.getPendingJobCount('sess-a')).toBe(1);
      expect(executor.getPendingJobCount('sess-b')).toBe(0);

      // Complete sess-a first job → alpha-2 starts
      defs[0].resolve({ exitCode: 0, durationMs: 50 });
      await vi.waitFor(() => expect(executedPrompts).toHaveLength(3));
      expect(executedPrompts[2]).toBe('alpha-2');

      // Complete both remaining
      defs[1].resolve({ exitCode: 0, durationMs: 50 });
      defs[2].resolve({ exitCode: 0, durationMs: 50 });
      await vi.waitFor(() => expect(executor.getActiveSessionIds()).toEqual([]));
    });
  });

  describe('onAnyJobComplete', () => {
    it('should fire global callback after successful job (session freed first)', async () => {
      setupRemoteSession();
      mockRunClaudeOverSsh.mockResolvedValue({ exitCode: 0, durationMs: 100 });

      const calls: Array<{ sessionId: string; jobId: string; wasBusy: boolean }> = [];
      executor.onAnyJobComplete((sid, jid) => {
        calls.push({ sessionId: sid, jobId: jid, wasBusy: executor.isSessionBusy(sid) });
      });

      executor.executeRemoteJob('sess-r1', 'job-1', 'test');

      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toEqual({ sessionId: 'sess-r1', jobId: 'job-1', wasBusy: false });
    });

    it('should fire global callback after SSH error', async () => {
      setupRemoteSession();
      mockRunClaudeOverSsh.mockRejectedValue(new Error('SSH refused'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const calls: string[] = [];
      executor.onAnyJobComplete((sid) => { calls.push(sid); });

      executor.executeRemoteJob('sess-r1', 'job-1', 'test');

      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toBe('sess-r1');
      // Session should be freed
      expect(executor.isSessionBusy('sess-r1')).toBe(false);
      consoleSpy.mockRestore();
    });

    it('should fire global callback on validation failure (missing machine)', async () => {
      // Session with non-existent machine
      const session: SessionRecord = {
        sessionId: 'sess-no-m', clientId: '', hostname: 'test', workdir: '',
        connectedAt: new Date().toISOString(), status: 'connected',
        jobs: [{ jobId: 'job-1', prompt: 'test', startedAt: new Date().toISOString(), chunks: [] }],
        type: 'remote', machineId: 'gone',
      };
      sessionStore.sessionStore.upsert(session);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const calls: string[] = [];
      executor.onAnyJobComplete((sid) => { calls.push(sid); });

      executor.executeRemoteJob('sess-no-m', 'job-1', 'test');

      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toBe('sess-no-m');
      consoleSpy.mockRestore();
    });

    it('should fire per-job callback before global callback (both after session freed)', async () => {
      setupRemoteSession();
      mockRunClaudeOverSsh.mockResolvedValue({ exitCode: 0, durationMs: 50 });

      const order: string[] = [];
      executor.onJobComplete('job-1', (sid) => {
        order.push(`per-job:busy=${executor.isSessionBusy(sid)}`);
      });
      executor.onAnyJobComplete((sid) => {
        order.push(`global:busy=${executor.isSessionBusy(sid)}`);
      });

      executor.executeRemoteJob('sess-r1', 'job-1', 'test');

      await vi.waitFor(() => expect(order).toHaveLength(2));
      // Both should see session as FREE (not busy)
      expect(order).toEqual([
        'per-job:busy=false',
        'global:busy=false',
      ]);
    });
  });

  // ── Parallel execution tests ─────────────────────────────────────────────
  // Multiple sessions (different agents/folders/machines) run concurrently.
  // Each session gets its own SSH connection; the executor must keep them
  // fully isolated: chunks, callbacks, busy state, and abort signals.
  describe('parallel execution', () => {
    /** Deferred helper — lets the test control exactly when each SSH mock resolves. */
    function deferred<T>() {
      let resolve!: (v: T) => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    }

    function makeMachine2(): MachineRecord {
      return {
        id: 'machine-2', name: 'nuc-box', alias: 'nuc', ip: '192.168.1.200',
        port: 22, username: 'nuc', defaultWorkdir: '/home/nuc/work',
        createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
      };
    }

    /** Create N sessions on potentially different machines, each with one job. */
    function setupParallelSessions(count: number): Array<{ sessionId: string; jobId: string; machineId: string }> {
      const m1 = makeMachine();
      const m2 = makeMachine2();
      machineStore.machineStore.upsert(m1);
      machineStore.machineStore.upsert(m2);

      const sessions: Array<{ sessionId: string; jobId: string; machineId: string }> = [];
      for (let i = 0; i < count; i++) {
        const sid = `sess-${i}`;
        const jid = `job-${i}`;
        const mid = i % 2 === 0 ? 'machine-1' : 'machine-2';
        const session: SessionRecord = {
          sessionId: sid, clientId: '', hostname: `host-${i}`, workdir: '',
          connectedAt: new Date().toISOString(), status: 'connected',
          jobs: [{ jobId: jid, prompt: `prompt-${i}`, startedAt: new Date().toISOString(), chunks: [] }],
          type: 'remote', name: `agent-${i}`, machineId: mid,
          remoteWorkdir: `/project-${i}`,
        };
        sessionStore.sessionStore.upsert(session);
        sessions.push({ sessionId: sid, jobId: jid, machineId: mid });
      }
      return sessions;
    }

    it('should run multiple sessions on different machines truly in parallel', async () => {
      const sessions = setupParallelSessions(4);

      // Each session gets its own deferred — SSH "hangs" until we resolve it
      const deferreds = sessions.map(() => deferred<{ exitCode: number; durationMs: number }>());
      let callIdx = 0;
      mockRunClaudeOverSsh.mockImplementation(async () => {
        const d = deferreds[callIdx++];
        return d.promise;
      });

      // Fire all 4 jobs
      for (const s of sessions) {
        executor.executeRemoteJob(s.sessionId, s.jobId, `do ${s.sessionId}`);
      }

      // Wait for all 4 SSH calls to be in-flight
      await vi.waitFor(() => expect(mockRunClaudeOverSsh).toHaveBeenCalledTimes(4));

      // All 4 should be active simultaneously
      const active = executor.getActiveSessionIds();
      expect(active).toHaveLength(4);
      for (const s of sessions) {
        expect(executor.isSessionBusy(s.sessionId)).toBe(true);
      }

      // Resolve all at once
      for (const d of deferreds) {
        d.resolve({ exitCode: 0, durationMs: 100 });
      }

      // All should complete
      await vi.waitFor(() => {
        for (const s of sessions) {
          expect(executor.isSessionBusy(s.sessionId)).toBe(false);
        }
      });

      // Each session got its own OUTPUT_DONE
      const doneCalls = mockBroadcast.mock.calls.filter((c: any[]) => c[0]?.event === 'OUTPUT_DONE');
      expect(doneCalls).toHaveLength(4);
      const doneSessionIds = doneCalls.map((c: any[]) => c[0].sessionId).sort();
      expect(doneSessionIds).toEqual(['sess-0', 'sess-1', 'sess-2', 'sess-3']);
    });

    it('should keep chunks isolated between parallel sessions', async () => {
      const sessions = setupParallelSessions(3);

      // Each session's SSH mock emits session-specific chunks then resolves
      mockRunClaudeOverSsh.mockImplementation(async (_m: any, prompt: string, _w: any, onChunk: Function) => {
        // Emit 2 chunks unique to this session
        onChunk({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `chunk-A-${prompt}` } } });
        onChunk({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `chunk-B-${prompt}` } } });
        return { exitCode: 0, durationMs: 50 };
      });

      // Launch all 3
      for (const s of sessions) {
        executor.executeRemoteJob(s.sessionId, s.jobId, s.sessionId);
      }

      // Wait for all to complete
      await vi.waitFor(() => {
        for (const s of sessions) {
          expect(executor.isSessionBusy(s.sessionId)).toBe(false);
        }
      });

      // Verify each session's job has exactly its own 2 chunks (no cross-contamination)
      for (const s of sessions) {
        const stored = sessionStore.sessionStore.get(s.sessionId);
        const job = stored!.jobs.find(j => j.jobId === s.jobId);
        expect(job!.chunks).toHaveLength(2);
        const texts = job!.chunks.map((c: any) => c.event.delta.text);
        expect(texts).toEqual([`chunk-A-${s.sessionId}`, `chunk-B-${s.sessionId}`]);
      }
    });

    it('should fire global callback once per completed session', async () => {
      const sessions = setupParallelSessions(3);

      const deferreds = sessions.map(() => deferred<{ exitCode: number; durationMs: number }>());
      let callIdx = 0;
      mockRunClaudeOverSsh.mockImplementation(async () => deferreds[callIdx++].promise);

      const globalCalls: Array<{ sid: string; activeCount: number }> = [];
      executor.onAnyJobComplete((sid) => {
        globalCalls.push({ sid, activeCount: executor.getActiveSessionIds().length });
      });

      for (const s of sessions) {
        executor.executeRemoteJob(s.sessionId, s.jobId, `prompt`);
      }
      await vi.waitFor(() => expect(mockRunClaudeOverSsh).toHaveBeenCalledTimes(3));

      // Resolve all
      for (const d of deferreds) d.resolve({ exitCode: 0, durationMs: 50 });

      await vi.waitFor(() => expect(globalCalls).toHaveLength(3));

      // Each session got exactly 1 global callback
      const callbackSessionIds = globalCalls.map(c => c.sid).sort();
      expect(callbackSessionIds).toEqual(['sess-0', 'sess-1', 'sess-2']);
    });

    it('should track active sessions correctly as jobs finish at different times', async () => {
      const sessions = setupParallelSessions(3);

      const deferreds = sessions.map(() => deferred<{ exitCode: number; durationMs: number }>());
      let callIdx = 0;
      mockRunClaudeOverSsh.mockImplementation(async () => deferreds[callIdx++].promise);

      for (const s of sessions) {
        executor.executeRemoteJob(s.sessionId, s.jobId, `prompt`);
      }
      await vi.waitFor(() => expect(mockRunClaudeOverSsh).toHaveBeenCalledTimes(3));
      expect(executor.getActiveSessionIds().sort()).toEqual(['sess-0', 'sess-1', 'sess-2']);

      // Finish session-1 first
      deferreds[1].resolve({ exitCode: 0, durationMs: 100 });
      await vi.waitFor(() => expect(executor.isSessionBusy('sess-1')).toBe(false));
      expect(executor.isSessionBusy('sess-0')).toBe(true);
      expect(executor.isSessionBusy('sess-2')).toBe(true);
      expect(executor.getActiveSessionIds().sort()).toEqual(['sess-0', 'sess-2']);

      // Finish session-0
      deferreds[0].resolve({ exitCode: 0, durationMs: 200 });
      await vi.waitFor(() => expect(executor.isSessionBusy('sess-0')).toBe(false));
      expect(executor.getActiveSessionIds()).toEqual(['sess-2']);

      // Finish session-2 last
      deferreds[2].resolve({ exitCode: 0, durationMs: 300 });
      await vi.waitFor(() => expect(executor.isSessionBusy('sess-2')).toBe(false));
      expect(executor.getActiveSessionIds()).toEqual([]);
    });

    it('should isolate errors — one SSH failure does not affect other sessions', async () => {
      const sessions = setupParallelSessions(3);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const deferreds = sessions.map(() => deferred<{ exitCode: number; durationMs: number }>());
      let callIdx = 0;
      mockRunClaudeOverSsh.mockImplementation(async () => deferreds[callIdx++].promise);

      for (const s of sessions) {
        executor.executeRemoteJob(s.sessionId, s.jobId, `prompt`);
      }
      await vi.waitFor(() => expect(mockRunClaudeOverSsh).toHaveBeenCalledTimes(3));

      // Session-1 errors out
      deferreds[1].reject(new Error('SSH timeout on nuc'));
      await vi.waitFor(() => expect(executor.isSessionBusy('sess-1')).toBe(false));

      // Other two still running
      expect(executor.isSessionBusy('sess-0')).toBe(true);
      expect(executor.isSessionBusy('sess-2')).toBe(true);

      // Error was recorded only for session-1
      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'OUTPUT_ERROR', sessionId: 'sess-1', error: 'SSH timeout on nuc' }),
      );

      // Resolve the other two successfully
      deferreds[0].resolve({ exitCode: 0, durationMs: 100 });
      deferreds[2].resolve({ exitCode: 0, durationMs: 100 });
      await vi.waitFor(() => expect(executor.getActiveSessionIds()).toEqual([]));

      // Both should have OUTPUT_DONE
      const doneCalls = mockBroadcast.mock.calls.filter((c: any[]) => c[0]?.event === 'OUTPUT_DONE');
      expect(doneCalls).toHaveLength(2);
      const doneIds = doneCalls.map((c: any[]) => c[0].sessionId).sort();
      expect(doneIds).toEqual(['sess-0', 'sess-2']);

      consoleSpy.mockRestore();
    });

    it('should abort only the targeted session — others continue unaffected', async () => {
      const sessions = setupParallelSessions(3);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const signals: Map<string, AbortSignal> = new Map();
      const deferreds = sessions.map(() => deferred<{ exitCode: number; durationMs: number }>());
      let callIdx = 0;
      mockRunClaudeOverSsh.mockImplementation(async (_m: any, prompt: string, _w: any, _onChunk: Function, _r?: string, signal?: AbortSignal) => {
        const idx = callIdx++;
        const sid = sessions[idx].sessionId;
        signals.set(sid, signal!);
        return new Promise<{ exitCode: number; durationMs: number }>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('Aborted')));
          deferreds[idx].promise.then(resolve, reject);
        });
      });

      for (const s of sessions) {
        executor.executeRemoteJob(s.sessionId, s.jobId, `prompt`);
      }
      await vi.waitFor(() => expect(mockRunClaudeOverSsh).toHaveBeenCalledTimes(3));

      // Abort session-1 only
      expect(executor.abortRemoteJob('sess-1')).toBe(true);
      await vi.waitFor(() => expect(executor.isSessionBusy('sess-1')).toBe(false));

      // Other sessions still running, their signals NOT aborted
      expect(executor.isSessionBusy('sess-0')).toBe(true);
      expect(executor.isSessionBusy('sess-2')).toBe(true);
      expect(signals.get('sess-0')?.aborted).toBe(false);
      expect(signals.get('sess-2')?.aborted).toBe(false);

      // Finish the rest
      deferreds[0].resolve({ exitCode: 0, durationMs: 100 });
      deferreds[2].resolve({ exitCode: 0, durationMs: 100 });
      await vi.waitFor(() => expect(executor.getActiveSessionIds()).toEqual([]));
      consoleSpy.mockRestore();
    });

    it('should broadcast chunks to correct sessions when streaming in parallel', async () => {
      const sessions = setupParallelSessions(2);

      // Use fine-grained interleaving: both sessions stream chunks alternately
      const deferreds = sessions.map(() => deferred<{ exitCode: number; durationMs: number }>());
      const chunkFns: Function[] = [];
      let callIdx = 0;
      mockRunClaudeOverSsh.mockImplementation(async (_m: any, _p: any, _w: any, onChunk: Function) => {
        chunkFns[callIdx] = onChunk;
        return deferreds[callIdx++].promise;
      });

      for (const s of sessions) {
        executor.executeRemoteJob(s.sessionId, s.jobId, `prompt`);
      }
      await vi.waitFor(() => expect(chunkFns).toHaveLength(2));

      // Interleave chunks: sess-0 chunk, sess-1 chunk, sess-0 chunk, sess-1 chunk
      chunkFns[0]({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A0' } } });
      chunkFns[1]({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'B0' } } });
      chunkFns[0]({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A1' } } });
      chunkFns[1]({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'B1' } } });

      // Resolve both
      for (const d of deferreds) d.resolve({ exitCode: 0, durationMs: 50 });
      await vi.waitFor(() => expect(executor.getActiveSessionIds()).toEqual([]));

      // Broadcast calls should carry the correct sessionId for each chunk
      const chunkBroadcasts = mockBroadcast.mock.calls
        .filter((c: any[]) => c[0]?.event === 'OUTPUT_CHUNK')
        .map((c: any[]) => ({ sid: c[0].sessionId, text: c[0].chunk.event.delta.text }));

      expect(chunkBroadcasts).toEqual([
        { sid: 'sess-0', text: 'A0' },
        { sid: 'sess-1', text: 'B0' },
        { sid: 'sess-0', text: 'A1' },
        { sid: 'sess-1', text: 'B1' },
      ]);

      // Session store should have correct chunks per session
      const s0 = sessionStore.sessionStore.get('sess-0');
      const s1 = sessionStore.sessionStore.get('sess-1');
      expect(s0!.jobs[0].chunks).toHaveLength(2);
      expect(s1!.jobs[0].chunks).toHaveLength(2);
      expect((s0!.jobs[0].chunks[0] as any).event.delta.text).toBe('A0');
      expect((s1!.jobs[0].chunks[0] as any).event.delta.text).toBe('B0');
    });

    it('should pass correct machine, workdir, model per session', async () => {
      const m1 = makeMachine();
      const m2 = makeMachine2();
      machineStore.machineStore.upsert(m1);
      machineStore.machineStore.upsert(m2);

      // Session A: machine-1, workdir /proj-a, model opus
      const sA: SessionRecord = {
        sessionId: 'sess-a', clientId: '', hostname: 'a', workdir: '',
        connectedAt: new Date().toISOString(), status: 'connected',
        jobs: [{ jobId: 'job-a', prompt: 'x', startedAt: new Date().toISOString(), chunks: [] }],
        type: 'remote', name: 'ceo-alice', machineId: 'machine-1',
        remoteWorkdir: '/proj-a', model: 'opus',
      };
      // Session B: machine-2, workdir /proj-b, model sonnet
      const sB: SessionRecord = {
        sessionId: 'sess-b', clientId: '', hostname: 'b', workdir: '',
        connectedAt: new Date().toISOString(), status: 'connected',
        jobs: [{ jobId: 'job-b', prompt: 'y', startedAt: new Date().toISOString(), chunks: [] }],
        type: 'remote', name: 'dev-bob', machineId: 'machine-2',
        remoteWorkdir: '/proj-b', model: 'sonnet',
      };
      sessionStore.sessionStore.upsert(sA);
      sessionStore.sessionStore.upsert(sB);

      mockRunClaudeOverSsh.mockResolvedValue({ exitCode: 0, durationMs: 50 });

      executor.executeRemoteJob('sess-a', 'job-a', 'prompt-a');
      executor.executeRemoteJob('sess-b', 'job-b', 'prompt-b');

      await vi.waitFor(() => expect(mockRunClaudeOverSsh).toHaveBeenCalledTimes(2));

      // First call = session A → machine-1, /proj-a, opus
      expect(mockRunClaudeOverSsh).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'machine-1', ip: '192.168.1.1' }),
        'prompt-a',
        '/proj-a',
        expect.any(Function),
        undefined,
        expect.anything(),
        'opus',
        undefined,  // no sshOpts
      );
      // Second call = session B → machine-2, /proj-b, sonnet
      expect(mockRunClaudeOverSsh).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'machine-2', ip: '192.168.1.200' }),
        'prompt-b',
        '/proj-b',
        expect.any(Function),
        undefined,
        expect.anything(),
        'sonnet',
        undefined,  // no sshOpts
      );
    });

    it('should handle mixed outcomes — success, error, non-zero exit in parallel', async () => {
      const sessions = setupParallelSessions(3);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const deferreds = sessions.map(() => deferred<{ exitCode: number; durationMs: number }>());
      let callIdx = 0;
      mockRunClaudeOverSsh.mockImplementation(async () => deferreds[callIdx++].promise);

      const completedSessions: string[] = [];
      executor.onAnyJobComplete((sid) => { completedSessions.push(sid); });

      for (const s of sessions) {
        executor.executeRemoteJob(s.sessionId, s.jobId, `prompt`);
      }
      await vi.waitFor(() => expect(mockRunClaudeOverSsh).toHaveBeenCalledTimes(3));

      // sess-0: success, sess-1: SSH error, sess-2: non-zero exit
      deferreds[0].resolve({ exitCode: 0, durationMs: 100 });
      deferreds[1].reject(new Error('connection reset'));
      deferreds[2].resolve({ exitCode: 1, durationMs: 200 });

      await vi.waitFor(() => expect(completedSessions).toHaveLength(3));

      // All 3 sessions freed
      expect(executor.getActiveSessionIds()).toEqual([]);

      // Verify each outcome
      const s0 = sessionStore.sessionStore.get('sess-0');
      const s1 = sessionStore.sessionStore.get('sess-1');
      const s2 = sessionStore.sessionStore.get('sess-2');
      expect(s0!.jobs[0].exitCode).toBe(0);
      expect(s1!.jobs[0].error).toBe('connection reset');
      expect(s2!.jobs[0].exitCode).toBe(1);

      consoleSpy.mockRestore();
    });

    it('should support same machine with multiple sessions (different folders/agents)', async () => {
      // Both sessions on machine-1 but different workdirs — simulates
      // two agents (CEO + QA) on the same server, different project folders
      const m1 = makeMachine();
      machineStore.machineStore.upsert(m1);

      const sA: SessionRecord = {
        sessionId: 'sess-ceo', clientId: '', hostname: 'ceo', workdir: '',
        connectedAt: new Date().toISOString(), status: 'connected',
        jobs: [{ jobId: 'job-ceo', prompt: 'x', startedAt: new Date().toISOString(), chunks: [] }],
        type: 'remote', name: 'ceo-alice', machineId: 'machine-1',
        remoteWorkdir: '/home/root/cernsio',
      };
      const sB: SessionRecord = {
        sessionId: 'sess-qa', clientId: '', hostname: 'qa', workdir: '',
        connectedAt: new Date().toISOString(), status: 'connected',
        jobs: [{ jobId: 'job-qa', prompt: 'y', startedAt: new Date().toISOString(), chunks: [] }],
        type: 'remote', name: 'qa-bob', machineId: 'machine-1',
        remoteWorkdir: '/home/root/cernsio-qa',
      };
      sessionStore.sessionStore.upsert(sA);
      sessionStore.sessionStore.upsert(sB);

      const deferreds = [deferred<{ exitCode: number; durationMs: number }>(), deferred<{ exitCode: number; durationMs: number }>()];
      let callIdx = 0;
      mockRunClaudeOverSsh.mockImplementation(async () => deferreds[callIdx++].promise);

      executor.executeRemoteJob('sess-ceo', 'job-ceo', 'review the roadmap');
      executor.executeRemoteJob('sess-qa', 'job-qa', 'run lighthouse');

      await vi.waitFor(() => expect(mockRunClaudeOverSsh).toHaveBeenCalledTimes(2));

      // Both should be active simultaneously on the same machine
      expect(executor.isSessionBusy('sess-ceo')).toBe(true);
      expect(executor.isSessionBusy('sess-qa')).toBe(true);
      expect(executor.getActiveSessionIds().sort()).toEqual(['sess-ceo', 'sess-qa']);

      // Each got the correct workdir
      expect(mockRunClaudeOverSsh).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'machine-1' }),
        'review the roadmap',
        '/home/root/cernsio',
        expect.any(Function), undefined, expect.anything(), undefined, undefined,
      );
      expect(mockRunClaudeOverSsh).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'machine-1' }),
        'run lighthouse',
        '/home/root/cernsio-qa',
        expect.any(Function), undefined, expect.anything(), undefined, undefined,
      );

      deferreds[0].resolve({ exitCode: 0, durationMs: 100 });
      deferreds[1].resolve({ exitCode: 0, durationMs: 200 });
      await vi.waitFor(() => expect(executor.getActiveSessionIds()).toEqual([]));
    });

    it('should handle rapid sequential launches across many sessions', async () => {
      const count = 8;
      const sessions = setupParallelSessions(count);

      // All resolve immediately — tests that rapid fire doesn't corrupt state
      mockRunClaudeOverSsh.mockImplementation(async (_m: any, _p: any, _w: any, onChunk: Function) => {
        onChunk({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
        return { exitCode: 0, durationMs: 10 };
      });

      const completedSessions: string[] = [];
      executor.onAnyJobComplete((sid) => { completedSessions.push(sid); });

      // Launch all 8 synchronously (no await between)
      for (const s of sessions) {
        executor.executeRemoteJob(s.sessionId, s.jobId, `prompt-${s.sessionId}`);
      }

      // All 8 should complete
      await vi.waitFor(() => expect(completedSessions).toHaveLength(count));
      expect(executor.getActiveSessionIds()).toEqual([]);

      // Each session has exactly 1 chunk and a successful job
      for (const s of sessions) {
        const stored = sessionStore.sessionStore.get(s.sessionId);
        expect(stored!.jobs[0].chunks).toHaveLength(1);
        expect(stored!.jobs[0].exitCode).toBe(0);
      }
    });

    it('should allow a completed session to start a new job while others still run', async () => {
      const sessions = setupParallelSessions(2);

      const deferreds = [
        deferred<{ exitCode: number; durationMs: number }>(),
        deferred<{ exitCode: number; durationMs: number }>(),
        deferred<{ exitCode: number; durationMs: number }>(), // for sess-0 second job
      ];
      let callIdx = 0;
      mockRunClaudeOverSsh.mockImplementation(async () => deferreds[callIdx++].promise);

      executor.executeRemoteJob('sess-0', 'job-0', 'first');
      executor.executeRemoteJob('sess-1', 'job-1', 'parallel');
      await vi.waitFor(() => expect(mockRunClaudeOverSsh).toHaveBeenCalledTimes(2));

      // Finish sess-0 first
      deferreds[0].resolve({ exitCode: 0, durationMs: 50 });
      await vi.waitFor(() => expect(executor.isSessionBusy('sess-0')).toBe(false));

      // sess-1 still running
      expect(executor.isSessionBusy('sess-1')).toBe(true);

      // Start a new job on sess-0 while sess-1 is still busy
      const s0 = sessionStore.sessionStore.get('sess-0')!;
      s0.jobs.push({ jobId: 'job-0b', prompt: 'second', startedAt: new Date().toISOString(), chunks: [] });
      sessionStore.sessionStore.upsert(s0);

      executor.executeRemoteJob('sess-0', 'job-0b', 'second task');
      await vi.waitFor(() => expect(mockRunClaudeOverSsh).toHaveBeenCalledTimes(3));

      // Both sessions active again
      expect(executor.isSessionBusy('sess-0')).toBe(true);
      expect(executor.isSessionBusy('sess-1')).toBe(true);

      // Finish both
      deferreds[1].resolve({ exitCode: 0, durationMs: 100 });
      deferreds[2].resolve({ exitCode: 0, durationMs: 100 });
      await vi.waitFor(() => expect(executor.getActiveSessionIds()).toEqual([]));
    });
  });

  // ── Auto-compact tests ──────────────────────────────────────────────────
  describe('auto-compact', () => {
    it('should run /compact when remote context tokens >= threshold', async () => {
      setupRemoteSession();
      sessionStore.sessionStore.updateMeta('sess-r1', {
        claudeSessionId: 'prev-session',
      });

      // Remote session file reports 85000 tokens
      mockGetRemoteContextTokens.mockResolvedValue(85000);

      const calls: Array<{ prompt: string; resumeId?: string }> = [];
      mockRunClaudeOverSsh.mockImplementation(async (_m: any, prompt: string, _w: any, _onChunk: Function, resumeId?: string) => {
        calls.push({ prompt, resumeId });
        return { exitCode: 0, durationMs: 100, claudeSessionId: 'new-session' };
      });

      executor.executeRemoteJob('sess-r1', 'job-1', 'do stuff');

      await vi.waitFor(() => {
        expect(mockBroadcast).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'OUTPUT_DONE', exitCode: 0 }),
        );
      });

      // First call should be /compact, second the actual prompt
      expect(calls).toHaveLength(2);
      expect(calls[0].prompt).toBe('/compact');
      expect(calls[0].resumeId).toBe('prev-session');
      expect(calls[1].prompt).toBe('do stuff');

      // SESSION_COMPACTING event broadcast with token count
      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'SESSION_COMPACTING', sessionId: 'sess-r1', inputTokens: 85000 }),
      );

      // lastInputTokens stored from the context check
      const updated = sessionStore.sessionStore.get('sess-r1');
      expect(updated!.lastInputTokens).toBe(85000);
    });

    it('should NOT run /compact when remote context tokens < threshold', async () => {
      setupRemoteSession();
      sessionStore.sessionStore.updateMeta('sess-r1', {
        claudeSessionId: 'prev-session',
      });

      mockGetRemoteContextTokens.mockResolvedValue(50000);

      const calls: string[] = [];
      mockRunClaudeOverSsh.mockImplementation(async (_m: any, prompt: string) => {
        calls.push(prompt);
        return { exitCode: 0, durationMs: 100, claudeSessionId: 'sess-abc' };
      });

      executor.executeRemoteJob('sess-r1', 'job-1', 'do stuff');

      await vi.waitFor(() => {
        expect(mockBroadcast).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'OUTPUT_DONE' }),
        );
      });

      // Only the actual prompt, no /compact
      expect(calls).toEqual(['do stuff']);

      // lastInputTokens stored from context check
      const updated = sessionStore.sessionStore.get('sess-r1');
      expect(updated!.lastInputTokens).toBe(50000);
    });

    it('should NOT run /compact on first run (no resumeId)', async () => {
      setupRemoteSession();
      // No claudeSessionId — first run

      mockRunClaudeOverSsh.mockResolvedValue({ exitCode: 0, durationMs: 50 });

      executor.executeRemoteJob('sess-r1', 'job-1', 'first prompt');

      await vi.waitFor(() => {
        expect(mockBroadcast).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'OUTPUT_DONE' }),
        );
      });

      expect(mockRunClaudeOverSsh).toHaveBeenCalledTimes(1);
      // getRemoteContextTokens not called (no resumeId)
      expect(mockGetRemoteContextTokens).not.toHaveBeenCalled();
    });

    it('should skip compact check when getRemoteContextTokens returns undefined', async () => {
      setupRemoteSession();
      sessionStore.sessionStore.updateMeta('sess-r1', {
        claudeSessionId: 'prev-session',
      });

      mockGetRemoteContextTokens.mockResolvedValue(undefined);
      mockRunClaudeOverSsh.mockResolvedValue({ exitCode: 0, durationMs: 50, claudeSessionId: 'new-id' });

      executor.executeRemoteJob('sess-r1', 'job-1', 'go');

      await vi.waitFor(() => {
        expect(mockBroadcast).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'OUTPUT_DONE' }),
        );
      });

      // Only one SSH call — no /compact (couldn't read tokens)
      expect(mockRunClaudeOverSsh).toHaveBeenCalledTimes(1);
    });

    it('should continue with prompt if /compact fails', async () => {
      setupRemoteSession();
      sessionStore.sessionStore.updateMeta('sess-r1', {
        claudeSessionId: 'prev-session',
      });

      mockGetRemoteContextTokens.mockResolvedValue(100000);
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let callCount = 0;

      mockRunClaudeOverSsh.mockImplementation(async (_m: any, prompt: string) => {
        callCount++;
        if (prompt === '/compact') throw new Error('SSH timeout during compact');
        return { exitCode: 0, durationMs: 100, claudeSessionId: 'new-session' };
      });

      executor.executeRemoteJob('sess-r1', 'job-1', 'do stuff');

      await vi.waitFor(() => {
        expect(mockBroadcast).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'OUTPUT_DONE', exitCode: 0 }),
        );
      });

      expect(callCount).toBe(2);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('/compact failed'),
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });

    it('should NOT run /compact when compactTokenThreshold is 0 (disabled)', async () => {
      const original = mockConfig.compactTokenThreshold;
      mockConfig.compactTokenThreshold = 0;

      try {
        setupRemoteSession();
        sessionStore.sessionStore.updateMeta('sess-r1', {
          claudeSessionId: 'prev-session',
        });

        mockRunClaudeOverSsh.mockResolvedValue({ exitCode: 0, durationMs: 50, claudeSessionId: 'abc' });

        executor.executeRemoteJob('sess-r1', 'job-1', 'go');

        await vi.waitFor(() => {
          expect(mockBroadcast).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'OUTPUT_DONE' }),
          );
        });

        // Only one SSH call — no /compact
        expect(mockRunClaudeOverSsh).toHaveBeenCalledTimes(1);
        // getRemoteContextTokens still called post-job for context logging
        // but NOT called pre-job (compact check skipped when threshold is 0)
      } finally {
        mockConfig.compactTokenThreshold = original;
      }
    });

    it('should use updated claudeSessionId from /compact for the actual prompt', async () => {
      setupRemoteSession();
      sessionStore.sessionStore.updateMeta('sess-r1', {
        claudeSessionId: 'old-session',
      });

      mockGetRemoteContextTokens.mockResolvedValue(90000);

      const calls: Array<{ prompt: string; resumeId?: string }> = [];
      mockRunClaudeOverSsh.mockImplementation(async (_m: any, prompt: string, _w: any, _onChunk: Function, resumeId?: string) => {
        calls.push({ prompt, resumeId });
        if (prompt === '/compact') {
          return { exitCode: 0, durationMs: 200, claudeSessionId: 'compacted-session' };
        }
        return { exitCode: 0, durationMs: 100, claudeSessionId: 'final-session' };
      });

      executor.executeRemoteJob('sess-r1', 'job-1', 'work');

      await vi.waitFor(() => {
        expect(mockBroadcast).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'OUTPUT_DONE' }),
        );
      });

      // /compact used old-session, actual prompt used compacted-session
      expect(calls[0]).toEqual({ prompt: '/compact', resumeId: 'old-session' });
      expect(calls[1]).toEqual({ prompt: 'work', resumeId: 'compacted-session' });

      const updated = sessionStore.sessionStore.get('sess-r1');
      expect(updated!.claudeSessionId).toBe('final-session');
    });
  });

  describe('dual-channel execution (persistent tmux)', () => {
    function setupPersistentSession(): { session: SessionRecord; machine: MachineRecord } {
      const machine: MachineRecord = {
        ...makeMachine(),
        persistentMode: true,
      };
      machineStore.machineStore.upsert(machine);

      const session: SessionRecord = {
        sessionId: 'sess-p1', clientId: '', hostname: 'test', workdir: '',
        connectedAt: new Date().toISOString(), status: 'connected', jobs: [],
        type: 'remote', name: 'persistent-remote', machineId: 'machine-1', remoteWorkdir: '/remote/path',
      };
      sessionStore.sessionStore.upsert(session);

      // Add jobs
      session.jobs.push(
        { jobId: 'job-w1', prompt: 'work prompt', startedAt: new Date().toISOString(), chunks: [] },
        { jobId: 'job-h1', prompt: 'hub prompt', startedAt: new Date().toISOString(), chunks: [] },
      );
      sessionStore.sessionStore.upsert(session);

      return { session, machine };
    }

    it('should run work and hub jobs in parallel on persistent machines', async () => {
      setupPersistentSession();

      const defs: Array<{ resolve: (v: any) => void }> = [];
      const calledSuffixes: Array<string | undefined> = [];

      mockRunClaudeViaTmuxForSession.mockImplementation(
        async (_m: any, _sid: any, _p: any, _w: any, _on: Function, _sig: any, _model: any, suffix?: string) => {
          calledSuffixes.push(suffix);
          return new Promise(resolve => { defs.push({ resolve }); });
        },
      );

      // Execute work job and hub job
      executor.executeRemoteJob('sess-p1', 'job-w1', 'work prompt', undefined, 'work');
      executor.executeRemoteJob('sess-p1', 'job-h1', 'hub prompt', undefined, 'hub');

      // Both should run in parallel (different execution keys)
      await vi.waitFor(() => expect(mockRunClaudeViaTmuxForSession).toHaveBeenCalledTimes(2));

      // Verify suffixes: work=undefined, hub='-hub'
      expect(calledSuffixes).toContain(undefined);
      expect(calledSuffixes).toContain('-hub');

      // Complete both
      defs[0].resolve({ exitCode: 0, durationMs: 100 });
      defs[1].resolve({ exitCode: 0, durationMs: 100 });

      await vi.waitFor(() => expect(executor.isSessionBusy('sess-p1')).toBe(false));
    });

    it('should queue hub jobs independently from work jobs on persistent machines', async () => {
      setupPersistentSession();
      const session = sessionStore.sessionStore.get('sess-p1')!;
      session.jobs.push(
        { jobId: 'job-h2', prompt: 'hub 2', startedAt: new Date().toISOString(), chunks: [] },
      );
      sessionStore.sessionStore.upsert(session);

      const defs: Array<{ resolve: (v: any) => void }> = [];
      mockRunClaudeViaTmuxForSession.mockImplementation(async () => {
        return new Promise(resolve => { defs.push({ resolve }); });
      });

      // Start one hub job
      executor.executeRemoteJob('sess-p1', 'job-h1', 'hub prompt', undefined, 'hub');
      await vi.waitFor(() => expect(mockRunClaudeViaTmuxForSession).toHaveBeenCalledTimes(1));

      // Second hub job should queue (same channel)
      executor.executeRemoteJob('sess-p1', 'job-h2', 'hub 2', undefined, 'hub');
      expect(mockRunClaudeViaTmuxForSession).toHaveBeenCalledTimes(1); // still only 1

      // But work job should run immediately (different channel)
      executor.executeRemoteJob('sess-p1', 'job-w1', 'work prompt', undefined, 'work');
      await vi.waitFor(() => expect(mockRunClaudeViaTmuxForSession).toHaveBeenCalledTimes(2));

      // Complete hub-1, hub-2 should start
      defs[0].resolve({ exitCode: 0, durationMs: 50 });
      await vi.waitFor(() => expect(mockRunClaudeViaTmuxForSession).toHaveBeenCalledTimes(3));

      // Complete all
      defs[1].resolve({ exitCode: 0, durationMs: 50 });
      defs[2].resolve({ exitCode: 0, durationMs: 50 });
      await vi.waitFor(() => expect(executor.isSessionBusy('sess-p1')).toBe(false));
    });

    it('isSessionBusy with channel should check only that channel', async () => {
      setupPersistentSession();

      mockRunClaudeViaTmuxForSession.mockImplementation(async () => {
        return new Promise(() => {}); // never resolves
      });

      executor.executeRemoteJob('sess-p1', 'job-w1', 'work', undefined, 'work');
      await vi.waitFor(() => expect(mockRunClaudeViaTmuxForSession).toHaveBeenCalledTimes(1));

      // Work channel is busy, hub is not
      expect(executor.isSessionBusy('sess-p1', 'work')).toBe(true);
      expect(executor.isSessionBusy('sess-p1', 'hub')).toBe(false);
      // No channel = any busy
      expect(executor.isSessionBusy('sess-p1')).toBe(true);
    });

    it('abortRemoteJob should abort both channels on persistent machines', async () => {
      setupPersistentSession();

      const defs: Array<{ resolve: (v: any) => void; reject: (e: Error) => void }> = [];
      mockRunClaudeViaTmuxForSession.mockImplementation(
        async (_m: any, _sid: any, _p: any, _w: any, _on: Function, signal: AbortSignal) => {
          return new Promise((resolve, reject) => {
            defs.push({ resolve, reject });
            signal?.addEventListener('abort', () => reject(new Error('Aborted')));
          });
        },
      );

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      executor.executeRemoteJob('sess-p1', 'job-w1', 'work', undefined, 'work');
      executor.executeRemoteJob('sess-p1', 'job-h1', 'hub', undefined, 'hub');

      await vi.waitFor(() => expect(mockRunClaudeViaTmuxForSession).toHaveBeenCalledTimes(2));

      const aborted = executor.abortRemoteJob('sess-p1');
      expect(aborted).toBe(true);

      // Both tmux sessions should get C-c
      expect(mockAbortTmuxJob).toHaveBeenCalledTimes(2);
      expect(mockAbortTmuxJob).toHaveBeenCalledWith(expect.anything(), 'sess-p1');
      expect(mockAbortTmuxJob).toHaveBeenCalledWith(expect.anything(), 'sess-p1', '-hub');

      consoleSpy.mockRestore();
    });

    it('non-persistent machines should share one execution slot for both channels', async () => {
      // Non-persistent: same key regardless of channel
      const machine = makeMachine(); // no persistentMode
      machineStore.machineStore.upsert(machine);

      const session: SessionRecord = {
        sessionId: 'sess-np', clientId: '', hostname: 'test', workdir: '',
        connectedAt: new Date().toISOString(), status: 'connected',
        jobs: [
          { jobId: 'job-1', prompt: 'work', startedAt: new Date().toISOString(), chunks: [] },
          { jobId: 'job-2', prompt: 'hub', startedAt: new Date().toISOString(), chunks: [] },
        ],
        type: 'remote', machineId: 'machine-1', remoteWorkdir: '/work',
      };
      sessionStore.sessionStore.upsert(session);

      mockRunClaudeOverSsh.mockImplementation(async () => {
        return new Promise(() => {}); // never resolves
      });

      executor.executeRemoteJob('sess-np', 'job-1', 'work', undefined, 'work');
      await vi.waitFor(() => expect(mockRunClaudeOverSsh).toHaveBeenCalledTimes(1));

      // Hub job on non-persistent should queue (same key)
      executor.executeRemoteJob('sess-np', 'job-2', 'hub', undefined, 'hub');
      expect(mockRunClaudeOverSsh).toHaveBeenCalledTimes(1); // still only 1
    });
  });
});
