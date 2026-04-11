import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionRecord } from '../../src/sessions/sessionStore.js';
import type { MachineRecord } from '../../src/machines/machineStore.js';

// Mock config
vi.mock('../../src/config.js', () => ({
  config: { persistPath: '', historyMax: 1000, machinesPersistPath: '' },
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
vi.mock('../../src/ssh/sshRunner.js', () => ({
  runClaudeOverSsh: mockRunClaudeOverSsh,
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

    it('should abort prior execution when new one starts on same session', async () => {
      setupRemoteSession();

      let firstSignal: AbortSignal | undefined;
      let callCount = 0;

      mockRunClaudeOverSsh.mockImplementation(
        async (_m: any, _p: any, _w: any, _onChunk: Function, _resumeId?: string, signal?: AbortSignal) => {
          callCount++;
          if (callCount === 1) {
            firstSignal = signal;
            return new Promise((resolve, reject) => {
              signal?.addEventListener('abort', () => reject(new Error('Aborted')));
            });
          }
          return { exitCode: 0, durationMs: 100 };
        },
      );

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      executor.executeRemoteJob('sess-r1', 'job-1', 'first');

      await vi.waitFor(() => expect(callCount).toBe(1));

      // Add second job
      const session = sessionStore.sessionStore.get('sess-r1')!;
      session.jobs.push({ jobId: 'job-2', prompt: 'second', startedAt: new Date().toISOString(), chunks: [] });
      sessionStore.sessionStore.upsert(session);

      executor.executeRemoteJob('sess-r1', 'job-2', 'second');

      await vi.waitFor(() => expect(callCount).toBe(2));

      // First execution should have been aborted
      expect(firstSignal?.aborted).toBe(true);
      consoleSpy.mockRestore();
    });
  });
});
