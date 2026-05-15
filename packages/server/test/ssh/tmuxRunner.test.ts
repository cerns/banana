import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { MachineRecord } from '../../src/machines/machineStore.js';

// ── Mock config ──────────────────────────────────────────────────────────────
const mockConfig = {
  machinesPersistPath: '',
  sshKeepaliveCountMax: 60,
  sshReadyTimeoutMs: 30_000,
  sshConnectRetries: 0,
  jumpHostPersistPath: '',
  tmuxStartupTimeoutMs: 5_000, // short for tests
  tmuxIdleCompletionMs: 2_000,
  tmuxAutoApprovePermissions: true,
};
vi.mock('../../src/config.js', () => ({
  config: mockConfig,
}));

// ── Mock ssh2 ────────────────────────────────────────────────────────────────
function createMockStream() {
  const stream = new EventEmitter() as any;
  stream.stderr = new EventEmitter();
  stream.close = vi.fn();
  return stream;
}

function createMockSftp() {
  return {
    end: vi.fn(),
    createWriteStream: vi.fn((_path: string, _opts?: any) => {
      const ws = new EventEmitter() as any;
      ws.end = vi.fn((_data?: any, cb?: Function) => { if (cb) cb(); });
      return ws;
    }),
  };
}

function createMockClient() {
  const client = new EventEmitter() as any;
  client.exec = vi.fn();
  client.end = vi.fn();
  client.connect = vi.fn();
  client.sftp = vi.fn((cb: Function) => { cb(null, createMockSftp()); });
  return client;
}

// ── Mock sshRunner ───────────────────────────────────────────────────────────
// Track all exec calls for command inspection
const execCalls: { cmd: string; stream: any }[] = [];

const mockConnectWithRetry = vi.fn();
const mockShellEscape = vi.fn((s: string) => `'${s.replace(/'/g, "'\"'\"'")}'`);

vi.mock('../../src/ssh/sshRunner.js', () => ({
  connectWithRetry: mockConnectWithRetry,
  shellEscape: mockShellEscape,
}));

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

/**
 * Set up mockConnectWithRetry to create a fresh mock client + auto-respond
 * to exec calls. Returns a helper to access the latest client and streams.
 */
function setupMockConnection() {
  let latestClient: any;
  const streams: any[] = [];

  mockConnectWithRetry.mockImplementation(async () => {
    latestClient = createMockClient();
    // Default exec: create a stream, call callback, record it
    latestClient.exec.mockImplementation((cmd: string, cb: Function) => {
      const stream = createMockStream();
      execCalls.push({ cmd, stream });
      streams.push(stream);
      cb(null, stream);
      // Auto-close with success for sshExec calls
      process.nextTick(() => stream.emit('close', 0));
    });
    return { client: latestClient, cleanup: vi.fn() };
  });

  return {
    getClient: () => latestClient,
    getStreams: () => streams,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('tmuxRunner', () => {
  let tmuxRunner: typeof import('../../src/ssh/tmuxRunner.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    execCalls.length = 0;
    vi.resetModules();
    // Re-apply mocks after resetModules
    vi.doMock('../../src/config.js', () => ({ config: mockConfig }));
    vi.doMock('../../src/ssh/sshRunner.js', () => ({
      connectWithRetry: mockConnectWithRetry,
      shellEscape: mockShellEscape,
    }));
    tmuxRunner = await import('../../src/ssh/tmuxRunner.js');
    // Reset config to defaults
    mockConfig.tmuxAutoApprovePermissions = true;
    mockConfig.tmuxStartupTimeoutMs = 5_000;
    mockConfig.tmuxIdleCompletionMs = 2_000;
  });

  // ── stripAnsi ────────────────────────────────────────────────────────────
  describe('stripAnsi', () => {
    it('should strip ANSI color codes', () => {
      expect(tmuxRunner.stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    });

    it('should strip cursor movement codes', () => {
      expect(tmuxRunner.stripAnsi('\x1b[2Aup\x1b[3Bdown')).toBe('updown');
    });

    it('should strip OSC sequences', () => {
      expect(tmuxRunner.stripAnsi('\x1b]0;title\x07text')).toBe('text');
      // Hyperlink OSC: \x1b]8;;url\x07link\x1b]8;;\x07
      expect(tmuxRunner.stripAnsi('\x1b]8;;https://example.com\x07link\x1b]8;;\x07')).toBe('link');
    });

    it('should strip carriage returns', () => {
      expect(tmuxRunner.stripAnsi('hello\rworld')).toBe('helloworld');
    });

    it('should strip bell characters', () => {
      expect(tmuxRunner.stripAnsi('alert\x07!')).toBe('alert!');
    });

    it('should strip charset escape sequences', () => {
      expect(tmuxRunner.stripAnsi('\x1b(Btext\x1b)0more')).toBe('textmore');
    });

    it('should preserve normal text', () => {
      const normal = 'Hello, world! This is a test. 123 @#$';
      expect(tmuxRunner.stripAnsi(normal)).toBe(normal);
    });

    it('should handle mixed ANSI and normal text', () => {
      expect(tmuxRunner.stripAnsi('\x1b[1;32m✓\x1b[0m Test passed')).toBe('✓ Test passed');
    });

    it('should handle empty string', () => {
      expect(tmuxRunner.stripAnsi('')).toBe('');
    });
  });

  // ── TmuxOutputParser ──────────────────────────────────────────────────────
  describe('TmuxOutputParser', () => {
    it('should emit text_delta for regular text lines', () => {
      const chunks: any[] = [];
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c));

      parser.feed('Hello world\n');

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello world\n' },
        },
      });
    });

    it('should emit content_block_start for tool use (⏺ Bash(...))', () => {
      const chunks: any[] = [];
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c));

      parser.feed('⏺ Bash(ls -la)\n');

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', name: 'Bash' },
        },
      });
    });

    it('should emit content_block_start for tool use with ● bullet', () => {
      const chunks: any[] = [];
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c));

      parser.feed('● Read(file.txt)\n');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].event.content_block.name).toBe('Read');
    });

    it('should emit tool result for ⎿ output', () => {
      const chunks: any[] = [];
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c));

      parser.feed('⎿ file contents here\n');

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: '[tool result] file contents here\n' },
        },
      });
    });

    it('should emit tool result for └ output', () => {
      const chunks: any[] = [];
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c));

      parser.feed('└ result line\n');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].event.delta.text).toContain('[tool result] result line');
    });

    it('should auto-approve permission prompts when enabled', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, true);

      parser.feed('Allow Bash? (y/n)\n');

      expect(sendKeys).toHaveBeenCalledWith('y Enter');
      expect(chunks).toHaveLength(1);
      expect(chunks[0].type).toBe('stderr');
      expect(chunks[0].text).toContain('Auto-approved');
    });

    it('should auto-approve "Allow all tools?" prompts', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, true);

      parser.feed('Allow all tools? (y/n)\n');

      expect(sendKeys).toHaveBeenCalledWith('y Enter');
    });

    it('should NOT auto-approve when disabled', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, false);

      parser.feed('Allow Bash? (y/n)\n');

      expect(sendKeys).not.toHaveBeenCalled();
      // Line is still emitted as text
      expect(chunks.some((c: any) => c.type === 'stream_event')).toBe(true);
    });

    // ── Expanded permission pattern tests ──────────────────────────────

    it('should send "a Enter" for y/n/a prompts (allow-always)', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, true);

      parser.feed('Allow Bash? (y/n/a)\n');

      expect(sendKeys).toHaveBeenCalledWith('a Enter');
      expect(chunks[0].text).toContain('allow-always');
    });

    it('should send "a Enter" for yes/no/always prompts', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, true);

      parser.feed('Allow Read? (yes/no/always)\n');

      expect(sendKeys).toHaveBeenCalledWith('a Enter');
      expect(chunks[0].text).toContain('allow-always');
    });

    it('should still send "y Enter" for plain y/n prompts (allow-yn)', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, true);

      parser.feed('Allow Write? (y/n)\n');

      expect(sendKeys).toHaveBeenCalledWith('y Enter');
      expect(chunks[0].text).toContain('allow-yn');
    });

    it('should send "y Enter" for "Proceed? (y/n)" prompts (confirm-yn)', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, true);

      parser.feed('Proceed? (y/n)\n');

      expect(sendKeys).toHaveBeenCalledWith('y Enter');
      expect(chunks[0].text).toContain('confirm-yn');
    });

    it('should send "y Enter" for "Continue? (y/n)" prompts', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, true);

      parser.feed('Continue? (y/n)\n');

      expect(sendKeys).toHaveBeenCalledWith('y Enter');
      expect(chunks[0].text).toContain('confirm-yn');
    });

    it('should send "y Enter" for "Do you want to overwrite? (y/n)" prompts', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, true);

      parser.feed('Do you want to overwrite? (y/n)\n');

      expect(sendKeys).toHaveBeenCalledWith('y Enter');
      expect(chunks[0].text).toContain('confirm-yn');
    });

    it('should send "Enter" for "❯ Allow once" menu item (menu-allow)', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, true);

      parser.feed('❯ Allow once\n');

      expect(sendKeys).toHaveBeenCalledWith('Enter');
      expect(chunks[0].text).toContain('menu-allow');
    });

    it('should send "Enter" for "❯ Allow always" menu item', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, true);

      parser.feed('❯ Allow always\n');

      expect(sendKeys).toHaveBeenCalledWith('Enter');
      expect(chunks[0].text).toContain('menu-allow');
    });

    it('should send "Enter" for "❯ Yes" menu item', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, true);

      parser.feed('❯ Yes\n');

      expect(sendKeys).toHaveBeenCalledWith('Enter');
      expect(chunks[0].text).toContain('menu-allow');
    });

    it('should send "Up Enter" for "❯ Deny" menu item (menu-deny)', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, true);

      parser.feed('❯ Deny\n');

      expect(sendKeys).toHaveBeenCalledWith('Up Enter');
      expect(chunks[0].text).toContain('menu-deny');
    });

    it('should send "Up Enter" for "❯ No" menu item', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, true);

      parser.feed('❯ No\n');

      expect(sendKeys).toHaveBeenCalledWith('Up Enter');
      expect(chunks[0].text).toContain('menu-deny');
    });

    it('should handle ">" as menu cursor (post-ANSI fallback)', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, true);

      parser.feed('> Allow once\n');

      expect(sendKeys).toHaveBeenCalledWith('Enter');
      expect(chunks[0].text).toContain('menu-allow');
    });

    it('should NOT auto-approve y/n/a prompts when disabled', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, false);

      parser.feed('Allow Bash? (y/n/a)\n');

      expect(sendKeys).not.toHaveBeenCalled();
      expect(chunks.some((c: any) => c.type === 'stream_event')).toBe(true);
    });

    it('should NOT match normal text containing "Allow" without prompt format', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, true);

      parser.feed('We allow users to configure settings\n');

      expect(sendKeys).not.toHaveBeenCalled();
      expect(chunks[0].type).toBe('stream_event');
    });

    it('should NOT match menu items with unrecognized options', () => {
      const chunks: any[] = [];
      const sendKeys = vi.fn();
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), sendKeys, true);

      parser.feed('❯ Some other option\n');

      expect(sendKeys).not.toHaveBeenCalled();
      expect(chunks[0].type).toBe('stream_event');
    });

    it('should not emit prompt ">" after content (completion signal)', () => {
      const chunks: any[] = [];
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c));

      parser.feed('Some response text\n');
      const countBefore = chunks.length;
      parser.feed('>\n');

      // The ">" line should not be emitted as a chunk
      expect(chunks.length).toBe(countBefore);
    });

    it('should treat ">" as regular text before any content (no completion)', () => {
      const chunks: any[] = [];
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c));

      parser.feed('>\n');

      // Before hasContent() is true, ">" falls through to text processing
      // (only suppressed as completion signal when hasContent() is true)
      expect(chunks).toHaveLength(1);
      expect(chunks[0].event.delta.text).toBe('>\n');
    });

    it('should handle partial line buffering', () => {
      const chunks: any[] = [];
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c));

      parser.feed('Hello ');
      expect(chunks).toHaveLength(0); // No complete line yet

      parser.feed('world\n');
      expect(chunks).toHaveLength(1);
      expect(chunks[0].event.delta.text).toBe('Hello world\n');
    });

    it('should flush remaining buffer', () => {
      const chunks: any[] = [];
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c));

      parser.feed('partial line');
      expect(chunks).toHaveLength(0);

      parser.flush();
      expect(chunks).toHaveLength(1);
      expect(chunks[0].event.delta.text).toBe('partial line\n');
    });

    it('should not flush empty buffer', () => {
      const chunks: any[] = [];
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c));

      parser.flush();
      expect(chunks).toHaveLength(0);
    });

    it('should track hasContent correctly', () => {
      const parser = new tmuxRunner.TmuxOutputParser(() => {});

      expect(parser.hasContent()).toBe(false);
      parser.feed('some text\n');
      expect(parser.hasContent()).toBe(true);
    });

    it('should reset state', () => {
      const parser = new tmuxRunner.TmuxOutputParser(() => {});

      parser.feed('some text\n');
      expect(parser.hasContent()).toBe(true);

      parser.reset();
      expect(parser.hasContent()).toBe(false);
    });

    it('should handle multiple lines in one feed', () => {
      const chunks: any[] = [];
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c));

      parser.feed('Line 1\nLine 2\nLine 3\n');

      expect(chunks).toHaveLength(3);
      expect(chunks[0].event.delta.text).toBe('Line 1\n');
      expect(chunks[1].event.delta.text).toBe('Line 2\n');
      expect(chunks[2].event.delta.text).toBe('Line 3\n');
    });

    it('should strip ANSI from fed text', () => {
      const chunks: any[] = [];
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c));

      parser.feed('\x1b[32mGreen text\x1b[0m\n');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].event.delta.text).toBe('Green text\n');
    });

    it('should not call sendKeys when sendKeys is not provided', () => {
      const chunks: any[] = [];
      // No sendKeys callback
      const parser = new tmuxRunner.TmuxOutputParser((c: any) => chunks.push(c), undefined, true);

      // Should not throw
      parser.feed('Allow Bash? (y/n)\n');
      expect(chunks).toHaveLength(1);
      expect(chunks[0].type).toBe('stderr');
    });
  });

  // ── ensureTmuxSession ──────────────────────────────────────────────────────
  describe('ensureTmuxSession', () => {
    it('should create a new tmux session and wait for prompt', async () => {
      const machine = makeMachine();
      let callCount = 0;

      mockConnectWithRetry.mockImplementation(async () => {
        const client = createMockClient();
        client.exec.mockImplementation((cmd: string, cb: Function) => {
          const stream = createMockStream();
          cb(null, stream);
          callCount++;

          // For the "cat logPath" command, return the prompt to indicate ready
          if (cmd.includes('cat ')) {
            process.nextTick(() => {
              stream.emit('data', Buffer.from('>\n'));
              stream.emit('close', 0);
            });
          } else {
            process.nextTick(() => stream.emit('close', 0));
          }
        });
        return { client, cleanup: vi.fn() };
      });

      const session = await tmuxRunner.ensureTmuxSession(machine, 'test-session-id', '/work');

      expect(session.tmuxName).toBe('banana-test-session-id');
      expect(session.logPath).toBe('/tmp/banana-tmux-log-test-session-id');
      expect(session.ready).toBe(true);
      expect(tmuxRunner.hasTmuxSession('test-session-id')).toBe(true);
    });

    it('should return cached session if alive', async () => {
      const machine = makeMachine();

      mockConnectWithRetry.mockImplementation(async () => {
        const client = createMockClient();
        client.exec.mockImplementation((cmd: string, cb: Function) => {
          const stream = createMockStream();
          cb(null, stream);
          if (cmd.includes('cat ')) {
            process.nextTick(() => {
              stream.emit('data', Buffer.from('>\n'));
              stream.emit('close', 0);
            });
          } else {
            process.nextTick(() => stream.emit('close', 0));
          }
        });
        return { client, cleanup: vi.fn() };
      });

      const session1 = await tmuxRunner.ensureTmuxSession(machine, 'cached-id', '/work');
      const connectCallsBefore = mockConnectWithRetry.mock.calls.length;

      const session2 = await tmuxRunner.ensureTmuxSession(machine, 'cached-id', '/work');

      // Should have made exactly one more call (to verify session is alive via tmux has-session)
      // Not a full recreation
      expect(session2.tmuxName).toBe(session1.tmuxName);
    });

    it('should recreate session when remote tmux session is dead', async () => {
      const machine = makeMachine();
      let callIdx = 0;

      mockConnectWithRetry.mockImplementation(async () => {
        const client = createMockClient();
        client.exec.mockImplementation((cmd: string, cb: Function) => {
          callIdx++;
          const stream = createMockStream();
          cb(null, stream);

          if (cmd.includes('has-session')) {
            // First has-session → success (for initial creation verify it won't be called)
            // Later has-session → fail (session died)
            process.nextTick(() => stream.emit('close', 1)); // exit 1 = not found
          } else if (cmd.includes('cat ')) {
            process.nextTick(() => {
              stream.emit('data', Buffer.from('>\n'));
              stream.emit('close', 0);
            });
          } else {
            process.nextTick(() => stream.emit('close', 0));
          }
        });
        return { client, cleanup: vi.fn() };
      });

      // Create initial session
      const session1 = await tmuxRunner.ensureTmuxSession(machine, 'dead-id', '/work');
      expect(session1.tmuxName).toBe('banana-dead-id');

      // Now the session is "dead" on remote (has-session returns exit code 1)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const session2 = await tmuxRunner.ensureTmuxSession(machine, 'dead-id', '/work');

      expect(session2.tmuxName).toBe('banana-dead-id');
      expect(session2.ready).toBe(true);
      warnSpy.mockRestore();
    });

    it('should throw on startup timeout', async () => {
      const machine = makeMachine();
      mockConfig.tmuxStartupTimeoutMs = 100; // Very short for test

      mockConnectWithRetry.mockImplementation(async () => {
        const client = createMockClient();
        client.exec.mockImplementation((cmd: string, cb: Function) => {
          const stream = createMockStream();
          cb(null, stream);
          // Never return the ">" prompt for cat commands — simulate timeout
          if (cmd.includes('cat ')) {
            process.nextTick(() => {
              stream.emit('data', Buffer.from('loading...\n'));
              stream.emit('close', 0);
            });
          } else {
            process.nextTick(() => stream.emit('close', 0));
          }
        });
        return { client, cleanup: vi.fn() };
      });

      await expect(
        tmuxRunner.ensureTmuxSession(machine, 'timeout-id', '/work'),
      ).rejects.toThrow(/did not start within/);
    });

    it('should use interactive shell in exec commands', async () => {
      const machine = makeMachine({ localShell: '/bin/zsh' });
      const executedCmds: string[] = [];

      mockConnectWithRetry.mockImplementation(async () => {
        const client = createMockClient();
        client.exec.mockImplementation((cmd: string, cb: Function) => {
          executedCmds.push(cmd);
          const stream = createMockStream();
          cb(null, stream);
          if (cmd.includes('cat ')) {
            process.nextTick(() => {
              stream.emit('data', Buffer.from('>\n'));
              stream.emit('close', 0);
            });
          } else {
            process.nextTick(() => stream.emit('close', 0));
          }
        });
        return { client, cleanup: vi.fn() };
      });

      await tmuxRunner.ensureTmuxSession(machine, 'shell-test-id', '/work');

      // All exec commands should be wrapped in the interactive shell
      for (const cmd of executedCmds) {
        expect(cmd).toMatch(/^\/bin\/zsh -ic /);
      }
    });

    it('should default to /bin/bash when no localShell', async () => {
      const machine = makeMachine(); // no localShell
      const executedCmds: string[] = [];

      mockConnectWithRetry.mockImplementation(async () => {
        const client = createMockClient();
        client.exec.mockImplementation((cmd: string, cb: Function) => {
          executedCmds.push(cmd);
          const stream = createMockStream();
          cb(null, stream);
          if (cmd.includes('cat ')) {
            process.nextTick(() => {
              stream.emit('data', Buffer.from('>\n'));
              stream.emit('close', 0);
            });
          } else {
            process.nextTick(() => stream.emit('close', 0));
          }
        });
        return { client, cleanup: vi.fn() };
      });

      await tmuxRunner.ensureTmuxSession(machine, 'bash-default-id', '/work');

      for (const cmd of executedCmds) {
        expect(cmd).toMatch(/^\/bin\/bash -ic /);
      }
    });
  });

  // ── sendPromptViaTmux ──────────────────────────────────────────────────────
  describe('sendPromptViaTmux', () => {
    it('should SFTP write + load-buffer + paste-buffer + Enter', async () => {
      const machine = makeMachine();
      const executedCmds: string[] = [];

      mockConnectWithRetry.mockImplementation(async () => {
        const client = createMockClient();
        client.exec.mockImplementation((cmd: string, cb: Function) => {
          executedCmds.push(cmd);
          const stream = createMockStream();
          cb(null, stream);
          process.nextTick(() => stream.emit('close', 0));
        });
        client.sftp.mockImplementation((cb: Function) => {
          cb(null, createMockSftp());
        });
        return { client, cleanup: vi.fn() };
      });

      const session = {
        tmuxName: 'banana-test',
        logPath: '/tmp/banana-tmux-log-test',
        ready: true,
        tailConn: null,
      };

      await tmuxRunner.sendPromptViaTmux(machine, session as any, 'Hello Claude');

      // Should have: truncate log, load-buffer + paste-buffer, send Enter, rm temp
      const loadBufferCmd = executedCmds.find(c => c.includes('load-buffer'));
      expect(loadBufferCmd).toBeDefined();
      expect(loadBufferCmd).toContain('paste-buffer');

      const enterCmd = executedCmds.find(c => c.includes('send-keys') && c.includes('Enter'));
      expect(enterCmd).toBeDefined();
    });
  });

  // ── abortTmuxJob ──────────────────────────────────────────────────────────
  describe('abortTmuxJob', () => {
    it('should send C-c and return true for known session', async () => {
      const machine = makeMachine();
      const executedCmds: string[] = [];

      // First create a session
      mockConnectWithRetry.mockImplementation(async () => {
        const client = createMockClient();
        client.exec.mockImplementation((cmd: string, cb: Function) => {
          executedCmds.push(cmd);
          const stream = createMockStream();
          cb(null, stream);
          if (cmd.includes('cat ')) {
            process.nextTick(() => {
              stream.emit('data', Buffer.from('>\n'));
              stream.emit('close', 0);
            });
          } else {
            process.nextTick(() => stream.emit('close', 0));
          }
        });
        return { client, cleanup: vi.fn() };
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await tmuxRunner.ensureTmuxSession(machine, 'abort-test', '/work');

      executedCmds.length = 0; // Clear creation commands
      const result = await tmuxRunner.abortTmuxJob(machine, 'abort-test');

      expect(result).toBe(true);
      const ccCmd = executedCmds.find(c => c.includes('send-keys') && c.includes('C-c'));
      expect(ccCmd).toBeDefined();
      logSpy.mockRestore();
    });

    it('should return false for unknown session', async () => {
      const machine = makeMachine();
      const result = await tmuxRunner.abortTmuxJob(machine, 'nonexistent');
      expect(result).toBe(false);
    });
  });

  // ── killTmuxSession ────────────────────────────────────────────────────────
  describe('killTmuxSession', () => {
    it('should send kill-session + rm log and remove from map', async () => {
      const machine = makeMachine();
      const executedCmds: string[] = [];

      mockConnectWithRetry.mockImplementation(async () => {
        const client = createMockClient();
        client.exec.mockImplementation((cmd: string, cb: Function) => {
          executedCmds.push(cmd);
          const stream = createMockStream();
          cb(null, stream);
          if (cmd.includes('cat ')) {
            process.nextTick(() => {
              stream.emit('data', Buffer.from('>\n'));
              stream.emit('close', 0);
            });
          } else {
            process.nextTick(() => stream.emit('close', 0));
          }
        });
        return { client, cleanup: vi.fn() };
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await tmuxRunner.ensureTmuxSession(machine, 'kill-test', '/work');
      expect(tmuxRunner.hasTmuxSession('kill-test')).toBe(true);

      executedCmds.length = 0;
      await tmuxRunner.killTmuxSession(machine, 'kill-test');

      expect(tmuxRunner.hasTmuxSession('kill-test')).toBe(false);
      const killCmd = executedCmds.find(c => c.includes('kill-session'));
      expect(killCmd).toBeDefined();
      const rmCmd = executedCmds.find(c => c.includes('rm -f'));
      expect(rmCmd).toBeDefined();
      logSpy.mockRestore();
    });

    it('should be a no-op for unknown session', async () => {
      const machine = makeMachine();
      // Should not throw
      await tmuxRunner.killTmuxSession(machine, 'nonexistent');
    });
  });

  // ── hasTmuxSession ────────────────────────────────────────────────────────
  describe('hasTmuxSession', () => {
    it('should return false for unknown sessionId', () => {
      expect(tmuxRunner.hasTmuxSession('unknown')).toBe(false);
    });

    it('should return true after session is created', async () => {
      const machine = makeMachine();

      mockConnectWithRetry.mockImplementation(async () => {
        const client = createMockClient();
        client.exec.mockImplementation((cmd: string, cb: Function) => {
          const stream = createMockStream();
          cb(null, stream);
          if (cmd.includes('cat ')) {
            process.nextTick(() => {
              stream.emit('data', Buffer.from('>\n'));
              stream.emit('close', 0);
            });
          } else {
            process.nextTick(() => stream.emit('close', 0));
          }
        });
        return { client, cleanup: vi.fn() };
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await tmuxRunner.ensureTmuxSession(machine, 'has-test', '/work');
      expect(tmuxRunner.hasTmuxSession('has-test')).toBe(true);
      logSpy.mockRestore();
    });
  });

  // ── streamTmuxOutput ──────────────────────────────────────────────────────
  describe('streamTmuxOutput', () => {
    it('should use interactive shell for tail -f', async () => {
      const machine = makeMachine({ localShell: '/bin/zsh' });
      let tailCmd = '';

      mockConnectWithRetry.mockImplementation(async () => {
        const client = createMockClient();
        client.exec.mockImplementation((cmd: string, cb: Function) => {
          tailCmd = cmd;
          const stream = createMockStream();
          cb(null, stream);
          // Emit some content then prompt to trigger completion
          process.nextTick(() => {
            stream.emit('data', Buffer.from('Response text\n'));
            process.nextTick(() => {
              stream.emit('data', Buffer.from('>\n'));
            });
          });
        });
        return { client, cleanup: vi.fn() };
      });

      const session = {
        tmuxName: 'banana-stream-test',
        logPath: '/tmp/banana-tmux-log-stream-test',
        ready: true,
        tailConn: null,
      };

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const chunks: any[] = [];
      await tmuxRunner.streamTmuxOutput(machine, session as any, (c: any) => chunks.push(c));

      expect(tailCmd).toMatch(/^\/bin\/zsh -ic /);
      expect(tailCmd).toContain('tail -f');
      logSpy.mockRestore();
    });

    it('should complete when prompt is detected after content', async () => {
      const machine = makeMachine();

      mockConnectWithRetry.mockImplementation(async () => {
        const client = createMockClient();
        client.exec.mockImplementation((cmd: string, cb: Function) => {
          const stream = createMockStream();
          cb(null, stream);
          process.nextTick(() => {
            stream.emit('data', Buffer.from('Hello from Claude\n'));
            process.nextTick(() => {
              stream.emit('data', Buffer.from('>\n'));
            });
          });
        });
        return { client, cleanup: vi.fn() };
      });

      const session = {
        tmuxName: 'banana-prompt-test',
        logPath: '/tmp/banana-tmux-log-prompt-test',
        ready: true,
        tailConn: null,
      };

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const chunks: any[] = [];
      const result = await tmuxRunner.streamTmuxOutput(machine, session as any, (c: any) => chunks.push(c));

      expect(result.completed).toBe(true);
      expect(chunks.length).toBeGreaterThan(0);
      logSpy.mockRestore();
    });

    it('should reject if signal already aborted', async () => {
      const machine = makeMachine();
      const controller = new AbortController();
      controller.abort();

      const session = {
        tmuxName: 'banana-abort-test',
        logPath: '/tmp/banana-tmux-log-abort-test',
        ready: true,
        tailConn: null,
      };

      await expect(
        tmuxRunner.streamTmuxOutput(machine, session as any, () => {}, controller.signal),
      ).rejects.toThrow('Aborted');
    });

    it('should reject on connection error', async () => {
      const machine = makeMachine();

      mockConnectWithRetry.mockImplementation(async () => {
        const client = createMockClient();
        client.exec.mockImplementation((cmd: string, cb: Function) => {
          cb(new Error('exec failed'));
        });
        return { client, cleanup: vi.fn() };
      });

      const session = {
        tmuxName: 'banana-err-test',
        logPath: '/tmp/banana-tmux-log-err-test',
        ready: true,
        tailConn: null,
      };

      await expect(
        tmuxRunner.streamTmuxOutput(machine, session as any, () => {}),
      ).rejects.toThrow('exec failed');
    });
  });
});
