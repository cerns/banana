import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { MachineRecord } from '../../src/machines/machineStore.js';

// Mock config
const mockConfig = {
  machinesPersistPath: '',
  sshKeepaliveCountMax: 60,
  sshReadyTimeoutMs: 30_000,
  sshConnectRetries: 0,
  sshIdleTimeoutMs: 0, // disabled by default in tests
  jumpHostPersistPath: '',
};
vi.mock('../../src/config.js', () => ({
  config: mockConfig,
}));

// Mock fs for key file reading + local temp file writes
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-key-data')),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      promises: {
        ...(actual.promises || {}),
        writeFile: mockWriteFile,
      },
    },
    readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-key-data')),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// ── Mock child_process for local execution tests ──────────────────────
function createMockChildProcess() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 12345;
  return child;
}

let mockChildProcess: any;
const mockSpawn = vi.fn().mockImplementation(() => {
  mockChildProcess = createMockChildProcess();
  return mockChildProcess;
});
const mockExecCb = vi.fn();
vi.mock('child_process', () => ({
  spawn: mockSpawn,
  exec: mockExecCb,
}));

// Create mock stream and client
function createMockStream() {
  const stream = new EventEmitter() as any;
  stream.stderr = new EventEmitter();
  stream.signal = vi.fn();
  stream.close = vi.fn();
  // Writable stdin half — used by the large-prompt path. Tracks every write
  // so tests can assert what was piped over the channel.
  const stdin = new EventEmitter() as any;
  stdin.writes = [] as string[];
  stdin.ended = false;
  stdin.write = vi.fn((data: string | Buffer, cb?: (err?: Error | null) => void) => {
    stdin.writes.push(typeof data === 'string' ? data : data.toString());
    if (cb) cb();
    return true;
  });
  stdin.end = vi.fn(() => { stdin.ended = true; });
  stream.stdin = stdin;
  return stream;
}

function createMockSftp() {
  const sftp = {
    end: vi.fn(),
    createWriteStream: vi.fn((_path: string, _opts?: any) => {
      const ws = new EventEmitter() as any;
      ws.end = vi.fn((_data?: any, cb?: Function) => { if (cb) cb(); });
      return ws;
    }),
  };
  return sftp;
}

function createMockClient() {
  const client = new EventEmitter() as any;
  client.exec = vi.fn();
  client.end = vi.fn();
  client.connect = vi.fn();
  client.sftp = vi.fn((cb: Function) => { cb(null, createMockSftp()); });
  return client;
}

// Mock ssh2
let mockClientInstance: any;
vi.mock('ssh2', () => ({
  Client: vi.fn().mockImplementation(() => {
    mockClientInstance = createMockClient();
    return mockClientInstance;
  }),
}));

// Drain microtask queue so awaited promises in connectWithRetry → conn.exec
// settle before the test continues firing stream events.
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function makeMachine(overrides: Partial<MachineRecord> = {}): MachineRecord {
  return {
    id: 'machine-1',
    name: 'test-machine',
    alias: 'tm1',
    ip: '192.168.1.1',
    port: 22,
    username: 'root',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('sshRunner', () => {
  let sshRunner: typeof import('../../src/ssh/sshRunner.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    // Re-mock ssh2 for fresh instance
    vi.doMock('ssh2', () => ({
      Client: vi.fn().mockImplementation(() => {
        mockClientInstance = createMockClient();
        return mockClientInstance;
      }),
    }));
    sshRunner = await import('../../src/ssh/sshRunner.js');
  });

  describe('exports', () => {
    it('should export buildConnectConfig', () => {
      expect(typeof sshRunner.buildConnectConfig).toBe('function');
    });

    it('should export shellEscape', () => {
      expect(typeof sshRunner.shellEscape).toBe('function');
    });
  });

  describe('isRetryableConnectError', () => {
    it('should retry handshake timeout', () => {
      expect(sshRunner.isRetryableConnectError(new Error('Timed out while waiting for handshake'))).toBe(true);
    });

    it('should retry ECONNRESET / ETIMEDOUT / ECONNREFUSED', () => {
      expect(sshRunner.isRetryableConnectError(new Error('connect ECONNREFUSED 1.2.3.4:22'))).toBe(true);
      expect(sshRunner.isRetryableConnectError(new Error('read ECONNRESET'))).toBe(true);
      expect(sshRunner.isRetryableConnectError(new Error('connect ETIMEDOUT'))).toBe(true);
    });

    it('should NOT retry auth failures', () => {
      expect(sshRunner.isRetryableConnectError(new Error('All configured authentication methods failed'))).toBe(false);
      expect(sshRunner.isRetryableConnectError(new Error('Permission denied (publickey)'))).toBe(false);
    });

    it('should NOT retry unrelated errors', () => {
      expect(sshRunner.isRetryableConnectError(new Error('exec failed'))).toBe(false);
      expect(sshRunner.isRetryableConnectError(new Error(''))).toBe(false);
    });
  });

  describe('testSshConnection', () => {
    it('should resolve with output on success', async () => {
      const machine = makeMachine();
      const promise = sshRunner.testSshConnection(machine);

      // Simulate connection ready
      const stream = createMockStream();
      // testSshConnection calls exec(cmd, cb) — 2-arg, no options
      mockClientInstance.exec.mockImplementation((_cmd: string, cb: Function) => {
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();

      // Simulate output
      stream.emit('data', Buffer.from('ok\ntest-host'));
      stream.emit('close');

      const result = await promise;
      expect(result).toBe('ok\ntest-host');
      expect(mockClientInstance.end).toHaveBeenCalled();
    });

    it('should reject on connection error', async () => {
      const machine = makeMachine();
      const promise = sshRunner.testSshConnection(machine);

      mockClientInstance.emit('error', new Error('Connection refused'));

      await expect(promise).rejects.toThrow('Connection refused');
    });

    it('should reject on exec error', async () => {
      const machine = makeMachine();
      const promise = sshRunner.testSshConnection(machine);

      mockClientInstance.exec.mockImplementation((_cmd: string, cb: Function) => {
        cb(new Error('exec failed'));
      });
      mockClientInstance.emit('ready');
      await flush();

      await expect(promise).rejects.toThrow('exec failed');
    });

    it('should include stderr in output', async () => {
      const machine = makeMachine();
      const promise = sshRunner.testSshConnection(machine);

      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((_cmd: string, cb: Function) => {
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();

      stream.stderr.emit('data', Buffer.from('warning'));
      stream.emit('close');

      const result = await promise;
      expect(result).toBe('warning');
    });
  });

  describe('getRemoteContextTokens', () => {
    it('should sum input_tokens + cache_creation + cache_read from last usage line', async () => {
      const machine = makeMachine();
      const promise = sshRunner.getRemoteContextTokens(machine, '/home/user/project', 'sess-abc');

      const stream = createMockStream();
      // getRemoteContextTokens calls exec(cmd, cb) — 2-arg, no options
      mockClientInstance.exec.mockImplementation((_cmd: string, cb: Function) => {
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();

      // The grep+awk pipeline outputs the sum of all three token fields
      stream.emit('data', Buffer.from('59068\n'));
      stream.emit('close');

      const result = await promise;
      expect(result).toBe(59068);
    });

    it('should build correct command: find by session ID, grep + sum tokens', async () => {
      const machine = makeMachine();
      const promise = sshRunner.getRemoteContextTokens(machine, '/home/user/project', 'sess-abc');

      const stream = createMockStream();
      let executedCmd = '';
      mockClientInstance.exec.mockImplementation((cmd: string, cb: Function) => {
        executedCmd = cmd;
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();

      stream.emit('data', Buffer.from('100\n'));
      stream.emit('close');

      await promise;
      // Must find session file by ID under ~/.claude/projects
      expect(executedCmd).toContain('find ~/.claude/projects');
      expect(executedCmd).toContain('sess-abc.jsonl');
      // Must grep for cache_read_input_tokens lines (present on usage entries)
      expect(executedCmd).toContain('cache_read_input_tokens');
      // Must extract all three token fields
      expect(executedCmd).toContain('input_tokens|cache_creation_input_tokens|cache_read_input_tokens');
      // Must sum with awk
      expect(executedCmd).toContain('awk');
    });

    it('should return undefined when no output', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const machine = makeMachine();
      const promise = sshRunner.getRemoteContextTokens(machine, '/home/user/project', 'sess-abc');

      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((_cmd: string, cb: Function) => {
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();

      stream.emit('data', Buffer.from('\n'));
      stream.emit('close');

      const result = await promise;
      expect(result).toBeUndefined();
      warnSpy.mockRestore();
    });

    it('should return undefined for empty claudeSessionId', async () => {
      const machine = makeMachine();
      const result = await sshRunner.getRemoteContextTokens(machine, '/work', '');
      expect(result).toBeUndefined();
    });

    it('should return undefined on connection error', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const machine = makeMachine();
      const promise = sshRunner.getRemoteContextTokens(machine, '/work', 'sess-1');

      mockClientInstance.emit('error', new Error('Connection refused'));

      const result = await promise;
      expect(result).toBeUndefined();
      warnSpy.mockRestore();
    });
  });

  describe('runClaudeOverSsh', () => {
    it('should resolve with exitCode and durationMs', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine();
      const chunks: unknown[] = [];
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '/work', c => chunks.push(c));

      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();

      // Emit JSON output
      stream.emit('data', Buffer.from('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n'));
      stream.emit('close', 0);

      const result = await promise;
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(chunks).toHaveLength(1);
      consoleSpy.mockRestore();
    });

    it('should extract claudeSessionId from output', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine();
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '', c => {});

      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();

      stream.emit('data', Buffer.from('{"session_id":"abc-123","type":"system"}\n'));
      stream.emit('close', 0);

      const result = await promise;
      expect(result.claudeSessionId).toBe('abc-123');
      consoleSpy.mockRestore();
    });

    it('should handle stderr output', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const machine = makeMachine();
      const chunks: any[] = [];
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '/work', c => chunks.push(c));

      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();

      stream.stderr.emit('data', Buffer.from('some error'));
      stream.emit('close', 1);

      const result = await promise;
      expect(result.exitCode).toBe(1);
      expect(chunks.some((c: any) => c.type === 'stderr')).toBe(true);
      consoleSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    it('should reject immediately if signal already aborted', async () => {
      const machine = makeMachine();
      const controller = new AbortController();
      controller.abort();

      await expect(
        sshRunner.runClaudeOverSsh(machine, 'hello', '/work', () => {}, undefined, controller.signal),
      ).rejects.toThrow('Aborted');
    });

    it('should use --resume when resumeId provided', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine();
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '/work', () => {}, 'resume-id-123');

      const stream = createMockStream();
      let executedCommand = '';
      mockClientInstance.exec.mockImplementation((cmd: string, _opts: any, cb: Function) => {
        executedCommand = cmd;
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();
      stream.emit('close', 0);

      await promise;
      expect(executedCommand).toContain('--resume');
      expect(executedCommand).toContain('resume-id-123');
      consoleSpy.mockRestore();
    });

    it('should handle connection error', async () => {
      const machine = makeMachine();
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '/work', () => {});

      mockClientInstance.emit('error', new Error('SSH connection failed'));

      await expect(promise).rejects.toThrow('SSH connection failed');
      expect(mockClientInstance.end).toHaveBeenCalled();
    });

    it('should handle exec error', async () => {
      const machine = makeMachine();
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '/work', () => {});

      mockClientInstance.exec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
        cb(new Error('Command failed'));
      });
      mockClientInstance.emit('ready');
      await flush();

      await expect(promise).rejects.toThrow('Command failed');
    });

    it('should flush buffer on close', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine();
      const chunks: any[] = [];
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '', c => chunks.push(c));

      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();

      // Send data without trailing newline
      stream.emit('data', Buffer.from('{"type":"result","session_id":"flush-id"}'));
      stream.emit('close', 0);

      const result = await promise;
      expect(chunks).toHaveLength(1);
      expect(result.claudeSessionId).toBe('flush-id');
      consoleSpy.mockRestore();
    });

    it('should skip invalid JSON lines', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine();
      const chunks: unknown[] = [];
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '', c => chunks.push(c));

      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();

      stream.emit('data', Buffer.from('not-json\n{"valid":true}\n\n'));
      stream.emit('close', 0);

      await promise;
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ valid: true });
      consoleSpy.mockRestore();
    });

    it('should use password auth when no sshKeyPath', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine({ password: 'secret' });
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '', () => {});

      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();
      stream.emit('close', 0);

      await promise;
      expect(mockClientInstance.connect).toHaveBeenCalledWith(
        expect.objectContaining({ password: 'secret' }),
      );
      consoleSpy.mockRestore();
    });

    it('should use key auth with passphrase', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine({ sshKeyPath: '/path/to/key', passphrase: 'pp' });
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '', () => {});

      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();
      stream.emit('close', 0);

      await promise;
      expect(mockClientInstance.connect).toHaveBeenCalledWith(
        expect.objectContaining({ privateKey: expect.anything(), passphrase: 'pp' }),
      );
      consoleSpy.mockRestore();
    });

    it('should construct command without workdir when empty', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine();
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '', () => {});

      let cmd = '';
      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((c: string, _opts: any, cb: Function) => {
        cmd = c;
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();
      stream.emit('close', 0);

      await promise;
      expect(cmd).not.toContain('cd ');
      expect(cmd).toContain('claude --print');
      consoleSpy.mockRestore();
    });

    it('should handle null exit code', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine();
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '', () => {});

      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();
      stream.emit('close', null);

      const result = await promise;
      expect(result.exitCode).toBe(0);
      consoleSpy.mockRestore();
    });

    it('should write prompt via SFTP temp file instead of embedding in command', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine();
      const bigPrompt = 'x'.repeat(32 * 1024);
      const promise = sshRunner.runClaudeOverSsh(machine, bigPrompt, '/work', () => {});

      let cmd = '';
      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((c: string, _opts: any, cb: Function) => {
        cmd = c;
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();
      stream.emit('close', 0);

      const result = await promise;
      expect(result.exitCode).toBe(0);
      // The raw prompt is NOT embedded in the command
      expect(cmd).not.toContain('xxxxxxxxxxxxxxxx');
      // Command uses stdin redirect from SFTP temp file
      expect(cmd).toContain('/tmp/banana-prompt-');
      expect(cmd).toMatch(/< '\/tmp\/banana-prompt-/);
      // Cleanup rm -f at the end
      expect(cmd).toContain('rm -f');
      // SFTP was used to write the prompt
      expect(mockClientInstance.sftp).toHaveBeenCalled();
      // Always uses PTY (no stdin piping)
      expect(stream.stdin.writes.length).toBe(0);
      consoleSpy.mockRestore();
    });

    it('should deliver prompt via SFTP — no shell injection possible', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine();
      const prompt = "it's a test; rm -rf /";
      const promise = sshRunner.runClaudeOverSsh(machine, prompt, '/work', () => {});

      let cmd = '';
      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((c: string, _opts: any, cb: Function) => {
        cmd = c;
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();
      stream.emit('close', 0);

      await promise;
      // The dangerous raw characters must NOT appear in the command
      expect(cmd).not.toContain("it's a test; rm -rf /");
      // Prompt was written via SFTP, not embedded in the command
      expect(mockClientInstance.sftp).toHaveBeenCalled();
      expect(cmd).toMatch(/< '\/tmp\/banana-prompt-/);
      consoleSpy.mockRestore();
    });

    it('should SIGTERM after idle timeout when no output arrives', async () => {
      vi.useFakeTimers();
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Enable idle timeout at 5000ms for this test
      mockConfig.sshIdleTimeoutMs = 5000;

      // Need fresh module so config is picked up
      vi.resetModules();
      vi.doMock('ssh2', () => ({
        Client: vi.fn().mockImplementation(() => {
          mockClientInstance = createMockClient();
          return mockClientInstance;
        }),
      }));
      const freshRunner = await import('../../src/ssh/sshRunner.js');

      const machine = makeMachine();
      const chunks: unknown[] = [];
      const promise = freshRunner.runClaudeOverSsh(machine, 'hello', '/work', c => chunks.push(c));

      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();

      // Some initial output
      stream.emit('data', Buffer.from('{"type":"init"}\n'));
      // Advance time past idle timeout — no more output
      vi.advanceTimersByTime(5001);
      // stream.signal should have been called
      expect(stream.signal).toHaveBeenCalledWith('TERM');
      // A synthetic stderr chunk should have been pushed
      const idleChunk = chunks.find((c: any) => typeof c.text === 'string' && c.text.includes('idle timeout'));
      expect(idleChunk).toBeDefined();

      // Clean up — simulate close after TERM
      stream.emit('close', 137);
      await promise;

      mockConfig.sshIdleTimeoutMs = 0; // restore
      vi.useRealTimers();
      consoleSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('should reset idle timeout on every data event', async () => {
      vi.useFakeTimers();
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      mockConfig.sshIdleTimeoutMs = 5000;

      vi.resetModules();
      vi.doMock('ssh2', () => ({
        Client: vi.fn().mockImplementation(() => {
          mockClientInstance = createMockClient();
          return mockClientInstance;
        }),
      }));
      const freshRunner = await import('../../src/ssh/sshRunner.js');

      const machine = makeMachine();
      const promise = freshRunner.runClaudeOverSsh(machine, 'hello', '/work', () => {});

      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();

      // Emit output every 3s — each resets the 5s idle timer
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(3000);
        stream.emit('data', Buffer.from(`{"type":"chunk","i":${i}}\n`));
      }
      // 15s total elapsed but timer never exceeded 5s without output
      expect(stream.signal).not.toHaveBeenCalled();

      stream.emit('close', 0);
      await promise;

      mockConfig.sshIdleTimeoutMs = 0;
      vi.useRealTimers();
      consoleSpy.mockRestore();
    });

    it('should handle prompts with quotes, backticks, and dollar signs via SFTP', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine();
      const prompt = `He said "hello" and it's $HOME \`cmd\` done`;
      const promise = sshRunner.runClaudeOverSsh(machine, prompt, '/work', () => {});

      let cmd = '';
      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((c: string, _opts: any, cb: Function) => {
        cmd = c;
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();
      stream.emit('close', 0);

      await promise;
      // Raw dangerous characters from the PROMPT must not appear in the command
      expect(cmd).not.toContain('`cmd`');
      expect(cmd).not.toContain(`He said "hello"`);
      expect(cmd).not.toContain("it's");
      // Prompt was delivered via SFTP, command just redirects from temp file
      expect(mockClientInstance.sftp).toHaveBeenCalled();
      expect(cmd).toMatch(/< '\/tmp\/banana-prompt-/);
      expect(cmd).toContain('rm -f');
      consoleSpy.mockRestore();
    });

    it('should reject on stream error during execution', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const machine = makeMachine();
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '/work', () => {});

      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();

      // Simulate a transient SSH channel error mid-execution
      stream.emit('error', new Error('channel read ECONNRESET'));

      await expect(promise).rejects.toThrow('channel read ECONNRESET');
      consoleSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('should allocate PTY and trap SIGHUP for streaming output', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine();
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '/work', () => {});

      const stream = createMockStream();
      let execArgs: unknown[] = [];
      mockClientInstance.exec.mockImplementation((...args: unknown[]) => {
        execArgs = args;
        const cb = args[args.length - 1] as Function;
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();
      stream.emit('close', 0);
      await promise;

      // exec should be called with 3 args: (command, opts, callback)
      // PTY is enabled for line-buffered streaming output.
      expect(execArgs).toHaveLength(3);
      expect(typeof execArgs[0]).toBe('string');
      expect(execArgs[1]).toEqual({ pty: true });
      expect(typeof execArgs[2]).toBe('function');
      // Command prefix traps SIGHUP so claude survives PTY disconnections
      expect(execArgs[0]).toContain("trap '' HUP");
      consoleSpy.mockRestore();
    });
  });

  describe('isLocalMachine', () => {
    it('should return true for empty ip', () => {
      expect(sshRunner.isLocalMachine(makeMachine({ ip: '' }))).toBe(true);
    });

    it('should return true for undefined ip', () => {
      expect(sshRunner.isLocalMachine(makeMachine({ ip: undefined as any }))).toBe(true);
    });

    it('should return true for whitespace-only ip', () => {
      expect(sshRunner.isLocalMachine(makeMachine({ ip: '   ' }))).toBe(true);
    });

    it('should return true for localhost', () => {
      expect(sshRunner.isLocalMachine(makeMachine({ ip: 'localhost' }))).toBe(true);
    });

    it('should return true for LOCALHOST (case-insensitive)', () => {
      expect(sshRunner.isLocalMachine(makeMachine({ ip: 'LOCALHOST' }))).toBe(true);
    });

    it('should return true for 127.0.0.1', () => {
      expect(sshRunner.isLocalMachine(makeMachine({ ip: '127.0.0.1' }))).toBe(true);
    });

    it('should return true for padded localhost', () => {
      expect(sshRunner.isLocalMachine(makeMachine({ ip: ' localhost ' }))).toBe(true);
    });

    it('should return false for a real IP', () => {
      expect(sshRunner.isLocalMachine(makeMachine({ ip: '192.168.1.1' }))).toBe(false);
    });

    it('should return false for a hostname', () => {
      expect(sshRunner.isLocalMachine(makeMachine({ ip: 'myserver.example.com' }))).toBe(false);
    });
  });

  describe('runClaudeOverSsh (local execution)', () => {
    it('should spawn locally when machine IP is empty', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine({ ip: '' });
      const chunks: unknown[] = [];
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '/work', c => chunks.push(c));

      await flush();

      // spawn should have been called with the local shell (auto-detected)
      expect(mockSpawn).toHaveBeenCalledWith(expect.any(String), ['-ic', expect.any(String)], expect.objectContaining({
        cwd: '/work',
        stdio: ['ignore', 'pipe', 'pipe'],
      }));

      // Emit JSON output via child stdout
      mockChildProcess.stdout.emit('data', Buffer.from('{"type":"assistant","message":"hi"}\n'));
      mockChildProcess.emit('close', 0);

      const result = await promise;
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(chunks).toHaveLength(1);
      // SSH mock should NOT have been called (no connect)
      expect(mockClientInstance.connect).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should spawn locally when machine IP is localhost', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine({ ip: 'localhost' });
      const promise = sshRunner.runClaudeOverSsh(machine, 'test', '/work', () => {});

      await flush();
      expect(mockSpawn).toHaveBeenCalled();
      mockChildProcess.emit('close', 0);
      await promise;
      consoleSpy.mockRestore();
    });

    it('should spawn locally when machine IP is 127.0.0.1', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine({ ip: '127.0.0.1' });
      const promise = sshRunner.runClaudeOverSsh(machine, 'test', '/work', () => {});

      await flush();
      expect(mockSpawn).toHaveBeenCalled();
      mockChildProcess.emit('close', 0);
      await promise;
      consoleSpy.mockRestore();
    });

    it('should extract claudeSessionId from local output', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine({ ip: '' });
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '', () => {});

      await flush();
      mockChildProcess.stdout.emit('data', Buffer.from('{"session_id":"local-sess-1","type":"system"}\n'));
      mockChildProcess.emit('close', 0);

      const result = await promise;
      expect(result.claudeSessionId).toBe('local-sess-1');
      consoleSpy.mockRestore();
    });

    it('should extract inputTokens from local stream_event', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine({ ip: '' });
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '', () => {});

      await flush();
      const evt = JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { usage: { input_tokens: 42000 } } },
      });
      mockChildProcess.stdout.emit('data', Buffer.from(evt + '\n'));
      mockChildProcess.emit('close', 0);

      const result = await promise;
      expect(result.inputTokens).toBe(42000);
      consoleSpy.mockRestore();
    });

    it('should handle stderr from local process', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const machine = makeMachine({ ip: '' });
      const chunks: any[] = [];
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '/work', c => chunks.push(c));

      await flush();
      mockChildProcess.stderr.emit('data', Buffer.from('some error'));
      mockChildProcess.emit('close', 1);

      const result = await promise;
      expect(result.exitCode).toBe(1);
      expect(chunks.some((c: any) => c.type === 'stderr' && c.text.includes('some error'))).toBe(true);
      consoleSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    it('should abort local process via SIGTERM', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine({ ip: '' });
      const controller = new AbortController();
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '/work', () => {}, undefined, controller.signal);

      await flush();
      controller.abort();
      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');

      mockChildProcess.emit('close', 137);
      const result = await promise;
      expect(result.exitCode).toBe(137);
      consoleSpy.mockRestore();
    });

    it('should reject immediately if signal already aborted (local)', async () => {
      const machine = makeMachine({ ip: '' });
      const controller = new AbortController();
      controller.abort();

      await expect(
        sshRunner.runClaudeOverSsh(machine, 'hello', '/work', () => {}, undefined, controller.signal),
      ).rejects.toThrow('Aborted');
    });

    it('should write prompt to local temp file', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine({ ip: '' });
      const promise = sshRunner.runClaudeOverSsh(machine, 'my prompt', '/work', () => {});

      await flush();
      // fs.promises.writeFile should have been called with the prompt
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('/tmp/banana-prompt-'),
        'my prompt',
        { mode: 0o600 },
      );

      mockChildProcess.emit('close', 0);
      await promise;
      consoleSpy.mockRestore();
    });

    it('should include --resume in local command when resumeId provided', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine({ ip: '' });
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '/work', () => {}, 'resume-abc');

      await flush();
      const cmd = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][1][1];
      expect(cmd).toContain('--resume');
      expect(cmd).toContain('resume-abc');

      mockChildProcess.emit('close', 0);
      await promise;
      consoleSpy.mockRestore();
    });

    it('should include --model in local command when model provided', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine({ ip: '' });
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '/work', () => {}, undefined, undefined, 'sonnet');

      await flush();
      const cmd = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][1][1];
      expect(cmd).toContain('--model');
      expect(cmd).toContain('sonnet');

      mockChildProcess.emit('close', 0);
      await promise;
      consoleSpy.mockRestore();
    });

    it('should flush buffer on close for local process', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine({ ip: '' });
      const chunks: any[] = [];
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '', c => chunks.push(c));

      await flush();
      // Send data without trailing newline
      mockChildProcess.stdout.emit('data', Buffer.from('{"type":"result","session_id":"local-flush"}'));
      mockChildProcess.emit('close', 0);

      const result = await promise;
      expect(chunks).toHaveLength(1);
      expect(result.claudeSessionId).toBe('local-flush');
      consoleSpy.mockRestore();
    });

    it('should handle null exit code from local process', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine({ ip: '' });
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '', () => {});

      await flush();
      mockChildProcess.emit('close', null);

      const result = await promise;
      expect(result.exitCode).toBe(0);
      consoleSpy.mockRestore();
    });

    it('should reject on spawn error', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine({ ip: '' });
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '/work', () => {});

      await flush();
      mockChildProcess.emit('error', new Error('spawn ENOENT'));

      await expect(promise).rejects.toThrow('spawn ENOENT');
      consoleSpy.mockRestore();
    });

    it('should skip invalid JSON lines in local output', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine({ ip: '' });
      const chunks: unknown[] = [];
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '', c => chunks.push(c));

      await flush();
      mockChildProcess.stdout.emit('data', Buffer.from('not-json\n{"valid":true}\n\n'));
      mockChildProcess.emit('close', 0);

      await promise;
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ valid: true });
      consoleSpy.mockRestore();
    });

    it('should omit cd when workdir is empty', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const machine = makeMachine({ ip: '' });
      const promise = sshRunner.runClaudeOverSsh(machine, 'hello', '', () => {});

      await flush();
      const cmd = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][1][1];
      expect(cmd).not.toContain('cd ');

      mockChildProcess.emit('close', 0);
      await promise;
      consoleSpy.mockRestore();
    });
  });

  describe('testSshConnection (local)', () => {
    it('should run locally when machine IP is empty', async () => {
      // Mock child_process.exec for the promisified execAsync call
      mockExecCb.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
        cb(null, 'ok\nlocal-host', '');
      });

      const machine = makeMachine({ ip: '' });
      const result = await sshRunner.testSshConnection(machine);
      expect(result).toBe('ok\nlocal-host');
      expect(mockExecCb).toHaveBeenCalledWith(
        'echo ok && hostname',
        expect.objectContaining({ timeout: 120_000 }),
        expect.any(Function),
      );
    });

    it('should run locally when machine IP is localhost', async () => {
      mockExecCb.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
        cb(null, 'ok\nmy-laptop', '');
      });

      const machine = makeMachine({ ip: 'localhost' });
      const result = await sshRunner.testSshConnection(machine);
      expect(result).toBe('ok\nmy-laptop');
    });

    it('should run locally when machine IP is 127.0.0.1', async () => {
      mockExecCb.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
        cb(null, 'ok\nmy-machine', '');
      });

      const machine = makeMachine({ ip: '127.0.0.1' });
      const result = await sshRunner.testSshConnection(machine);
      expect(result).toBe('ok\nmy-machine');
    });
  });
});
