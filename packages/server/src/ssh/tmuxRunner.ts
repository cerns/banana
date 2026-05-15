import { spawn } from 'child_process';
import * as fs from 'fs';
import type { MachineRecord } from '../machines/machineStore.js';
import type { SshRunResult, SshChunkCallback, TunneledConnection } from './sshRunner.js';
import { connectWithRetry, shellEscape, isLocalMachine, execLocal, getLocalShell } from './sshRunner.js';
import { config } from '../config.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface TmuxSession {
  /** tmux session name — `banana-{sessionId}` */
  tmuxName: string;
  /** Remote log file path fed by `tmux pipe-pane` */
  logPath: string;
  /** Whether claude has started and shown its initial prompt */
  ready: boolean;
  /** Long-lived SSH connection for `tail -f` streaming (null when not tailing) */
  tailConn: TunneledConnection | null;
}

/** Active tmux sessions keyed by banana sessionId. */
const tmuxSessions = new Map<string, TmuxSession>();

// ── ANSI / TUI cleanup ────────────────────────────────────────────────────

/** Remove ANSI escape sequences, cursor movement codes, and common TUI artifacts. */
export function stripAnsi(text: string): string {
  return text
    // Standard ANSI escapes (colors, cursor, erase, etc.)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    // OSC sequences (title bar, hyperlinks, etc.)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // Other escape sequences (single-char after ESC)
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[>=<]/g, '')
    // Carriage returns (TUI redraws)
    .replace(/\r/g, '')
    // Bell
    .replace(/\x07/g, '');
}

// ── Permission pattern registry ──────────────────────────────────────────────

interface PermissionPattern {
  label: string;
  test: (line: string) => boolean;
  keys: string;
}

const PERMISSION_PATTERNS: PermissionPattern[] = [
  // y/n/a — prefer "always" to reduce future prompts
  {
    label: 'allow-always',
    test: (line) => /\bAllow\b.*\?\s*\(?\s*y(?:es)?\/n(?:o)?\/a(?:lways)?\s*\)?/i.test(line),
    keys: 'a Enter',
  },
  // Standard y/n Allow prompts
  {
    label: 'allow-yn',
    test: (line) => /\bAllow\b.*\?\s*\(?\s*y(?:es)?\/n(?:o)?\s*\)?/i.test(line),
    keys: 'y Enter',
  },
  // General confirmations: Proceed? Continue? Do you want to...?
  {
    label: 'confirm-yn',
    test: (line) => /(?:Proceed|Continue|Do you (?:want|wish) to)\b.*\?\s*\(?\s*y(?:es)?\/n(?:o)?\s*\)?/i.test(line),
    keys: 'y Enter',
  },
  // Menu: cursor on Allow/Yes option → press Enter
  {
    label: 'menu-allow',
    test: (line) => /^[❯>►]\s+(?:Allow|Yes)\b/i.test(line),
    keys: 'Enter',
  },
  // Menu: cursor on Deny/No → navigate up (to Allow) and press Enter
  {
    label: 'menu-deny',
    test: (line) => /^[❯>►]\s+(?:Deny|No)\b/i.test(line),
    keys: 'Up Enter',
  },
];

// ── TmuxOutputParser ───────────────────────────────────────────────────────

type ParserState = 'waiting' | 'text' | 'tool_use' | 'tool_result';

/**
 * State machine that parses Claude TUI text output into synthetic stream-json
 * chunks matching the format produced by `claude --print --output-format stream-json`.
 */
export class TmuxOutputParser {
  private state: ParserState = 'waiting';
  private buffer = '';
  private onChunk: SshChunkCallback;
  private autoApprove: boolean;
  /** Callback to send keystrokes to the tmux session (for auto-approve). */
  private sendKeys: ((keys: string) => void) | null;
  /** Lines accumulated since last prompt — used for completion detection. */
  private responseLines: string[] = [];

  constructor(
    onChunk: SshChunkCallback,
    sendKeys?: (keys: string) => void,
    autoApprove = config.tmuxAutoApprovePermissions,
  ) {
    this.onChunk = onChunk;
    this.sendKeys = sendKeys ?? null;
    this.autoApprove = autoApprove;
  }

  /** Feed raw text from `tail -f`. May contain partial lines. */
  feed(raw: string): void {
    this.buffer += stripAnsi(raw);
    const lines = this.buffer.split('\n');
    // Keep the last (possibly incomplete) line in the buffer
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      this.processLine(line);
    }
  }

  /** Flush any remaining buffer (e.g. on completion). */
  flush(): void {
    if (this.buffer.trim()) {
      this.processLine(this.buffer);
      this.buffer = '';
    }
  }

  /** Whether we've seen response content (not just the initial prompt). */
  hasContent(): boolean {
    return this.responseLines.length > 0;
  }

  /** Reset for next prompt. */
  reset(): void {
    this.state = 'waiting';
    this.buffer = '';
    this.responseLines = [];
  }

  private processLine(line: string): void {
    const trimmed = line.trim();

    // ── Permission prompt detection ────────────────────────────────────
    if (this.autoApprove) {
      for (const pattern of PERMISSION_PATTERNS) {
        if (pattern.test(trimmed)) {
          this.onChunk({
            type: 'stderr',
            text: `[banana-tmux] Auto-approved (${pattern.label}): ${trimmed}\n`,
          });
          if (this.sendKeys) this.sendKeys(pattern.keys);
          return;
        }
      }
    }

    // ── Prompt detection (response complete) ───────────────────────────
    // Claude TUI shows ">" at start of line when waiting for input.
    // Only counts if we've already seen response content.
    if (/^>\s*$/.test(trimmed) && this.hasContent()) {
      // Signal completion — handled by the caller via isPrompt flag
      return;
    }

    // ── Tool use start: "⏺ ToolName(...)" ─────────────────────────────
    if (/^[⏺●]\s+\w+/.test(trimmed)) {
      const match = trimmed.match(/^[⏺●]\s+(\w+)/);
      if (match) {
        this.state = 'tool_use';
        this.responseLines.push(trimmed);
        this.onChunk({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', name: match[1] },
          },
        });
        return;
      }
    }

    // ── Tool result: "⎿ output" ────────────────────────────────────────
    if (/^[⎿└]/.test(trimmed)) {
      this.state = 'tool_result';
      this.responseLines.push(trimmed);
      const resultText = trimmed.replace(/^[⎿└]\s*/, '');
      this.onChunk({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: `[tool result] ${resultText}\n` },
        },
      });
      return;
    }

    // ── Regular text output ────────────────────────────────────────────
    if (trimmed || this.state === 'text') {
      this.state = 'text';
      this.responseLines.push(line);
      this.onChunk({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: line + '\n' },
        },
      });
    }
  }
}

// ── Exec helpers ────────────────────────────────────────────────────────────

const PATH_PREFIX = 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.nvm/current/bin:$PATH"';

/** Execute a command — locally or over SSH depending on machine type. */
async function tmuxExec(
  machine: MachineRecord,
  command: string,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<string> {
  if (signal?.aborted) throw new Error('Aborted');

  if (isLocalMachine(machine)) {
    const { stdout } = await execLocal(`${PATH_PREFIX} && ${command}`, { timeout: timeoutMs });
    return stdout;
  }

  const { client: conn, cleanup } = await connectWithRetry(machine, signal);
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`SSH exec timed out (${timeoutMs}ms)`)); }, timeoutMs);
    const shell = machine.localShell || '/bin/bash';
    conn.exec(`${shell} -ic ${shellEscape(PATH_PREFIX + ' && ' + command)}`, (err, stream) => {
      if (err) { clearTimeout(timer); cleanup(); reject(err); return; }
      let out = '';
      let stderr = '';
      stream.on('data', (d: Buffer) => { out += d.toString(); });
      stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      stream.on('close', (code: number | null) => {
        clearTimeout(timer);
        cleanup();
        if (code !== 0 && code !== null) {
          reject(new Error(`Command exited ${code}: ${stderr.trim() || out.trim()}`));
        } else {
          resolve(out);
        }
      });
    });
  });
}

/** Send tmux keys via exec (local or SSH). */
async function tmuxSendKeys(
  machine: MachineRecord,
  tmuxName: string,
  keys: string,
  signal?: AbortSignal,
): Promise<void> {
  await tmuxExec(machine, `tmux send-keys -t ${shellEscape(tmuxName)} ${keys}`, signal, 10_000);
}

/** Write content to a temp file, return the path. Uses local fs or SFTP depending on machine. */
async function writeTempFile(
  machine: MachineRecord,
  content: string,
  signal?: AbortSignal,
): Promise<{ path: string; cleanup: () => void }> {
  if (signal?.aborted) throw new Error('Aborted');
  const tmpPath = `/tmp/banana-tmux-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (isLocalMachine(machine)) {
    fs.writeFileSync(tmpPath, content, { mode: 0o600 });
    return { path: tmpPath, cleanup: () => {} };
  }

  const tunneled = await connectWithRetry(machine, signal);
  await new Promise<void>((resolve, reject) => {
    tunneled.client.sftp((err, sftp) => {
      if (err) { reject(err); return; }
      const ws = sftp.createWriteStream(tmpPath, { mode: 0o600 });
      ws.on('error', (e: Error) => { sftp.end(); reject(e); });
      ws.end(Buffer.from(content, 'utf8'), () => { sftp.end(); resolve(); });
    });
  });
  return {
    path: tmpPath,
    cleanup: () => { tunneled.cleanup(); },
  };
}

// ── Core functions ─────────────────────────────────────────────────────────

/**
 * Ensure a tmux session exists on the remote machine with claude running inside.
 * Creates the session + starts claude if it doesn't exist.
 */
export async function ensureTmuxSession(
  machine: MachineRecord,
  sessionId: string,
  workdir: string,
  model?: string,
  signal?: AbortSignal,
): Promise<TmuxSession> {
  const existing = tmuxSessions.get(sessionId);
  if (existing) {
    // Verify tmux session still exists on remote
    try {
      await tmuxExec(machine, `tmux has-session -t ${shellEscape(existing.tmuxName)} 2>/dev/null`, signal, 10_000);
      return existing;
    } catch {
      // Session died — clean up and recreate
      console.warn(`[tmux-runner] Session ${existing.tmuxName} died on remote, recreating`);
      tmuxSessions.delete(sessionId);
      if (existing.tailConn) existing.tailConn.cleanup();
    }
  }

  const tmuxName = `banana-${sessionId}`;
  const logPath = `/tmp/banana-tmux-log-${sessionId}`;

  // Verify tmux is installed
  try {
    await tmuxExec(machine, 'command -v tmux', signal, 10_000);
  } catch {
    const hint = isLocalMachine(machine)
      ? 'Install it with: brew install tmux (macOS) or apt install tmux (Linux)'
      : 'Install it on the remote machine: apt install tmux / yum install tmux';
    throw new Error(`tmux is not installed or not in PATH. ${hint}`);
  }

  // Kill any stale session with the same name
  try {
    await tmuxExec(machine, `tmux kill-session -t ${shellEscape(tmuxName)} 2>/dev/null || true`, signal, 10_000);
  } catch { /* ignore */ }

  // Remove stale log file
  try {
    await tmuxExec(machine, `rm -f ${shellEscape(logPath)}`, signal, 10_000);
  } catch { /* ignore */ }

  // Create tmux session in detached mode
  const cdPart = workdir ? `cd ${shellEscape(workdir)} && ` : '';
  await tmuxExec(
    machine,
    `tmux new-session -d -s ${shellEscape(tmuxName)} -x 200 -y 50`,
    signal,
    15_000,
  );

  // Set up pipe-pane to log all output
  await tmuxExec(
    machine,
    `tmux pipe-pane -t ${shellEscape(tmuxName)} -o 'cat >> ${shellEscape(logPath)}'`,
    signal,
    10_000,
  );

  // Determine claude command
  const hasBun = machine.runtimes?.some(r => r.runtime === 'bun');
  const hasNode = machine.runtimes?.some(r => r.runtime === 'node');
  let claudeBin = 'claude';
  if (hasBun) claudeBin = 'bunx --bun claude';
  else if (hasNode && machine.claudePath) claudeBin = machine.claudePath;
  else if (hasNode) claudeBin = 'npx -y claude';

  // Build the claude command — interactive mode (no --print)
  const claudeArgs = ['--verbose'];
  if (model) claudeArgs.push('--model', shellEscape(model));

  const fullCmd = `${cdPart}${PATH_PREFIX} && ${claudeBin} ${claudeArgs.join(' ')}`;

  // Send the command to tmux
  await tmuxSendKeys(machine, tmuxName, `${shellEscape(fullCmd)} Enter`, signal);

  // Wait for claude to start (look for the initial prompt '>')
  const startedAt = Date.now();
  const timeoutMs = config.tmuxStartupTimeoutMs;
  let ready = false;

  let lastScreen = '';
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw new Error('Aborted');
    await new Promise(r => setTimeout(r, 2000));
    try {
      // capture-pane -p returns the rendered screen content as plain text
      // (much more reliable than pipe-pane log for TUI apps like Claude)
      const screen = await tmuxExec(
        machine,
        `tmux capture-pane -t ${shellEscape(tmuxName)} -p`,
        signal,
        10_000,
      );
      const cleaned = stripAnsi(screen);
      lastScreen = cleaned;
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const summary = cleaned.trim().split('\n').filter(l => l.trim()).slice(-3).join(' | ');
      if (summary) {
        console.log(`[tmux-runner] Startup screen (${elapsed}s): ${summary.slice(-200)}`);
      }
      // Claude TUI shows ">" at start of line when ready for input
      if (/^>\s*$/m.test(cleaned)) {
        ready = true;
        break;
      }
      // Also check if claude printed an error and exited
      if (/error|Error|fatal|FATAL/i.test(cleaned) && /\$\s*$/m.test(cleaned)) {
        throw new Error(`Claude failed to start: ${cleaned.slice(-500)}`);
      }
    } catch (e) {
      if ((e as Error).message.includes('Claude failed')) throw e;
      // transient error — keep trying
    }
  }

  if (!ready) {
    // Clean up
    try { await tmuxExec(machine, `tmux kill-session -t ${shellEscape(tmuxName)} 2>/dev/null || true`); } catch { /* ignore */ }
    throw new Error(`Claude did not start within ${timeoutMs}ms. Last screen:\n${lastScreen.slice(-1000)}`);
  }

  // Truncate the startup log so we start clean for the first prompt
  try {
    await tmuxExec(machine, `truncate -s 0 ${shellEscape(logPath)}`, signal, 10_000);
  } catch { /* ignore */ }

  const session: TmuxSession = {
    tmuxName,
    logPath,
    ready: true,
    tailConn: null,
  };
  tmuxSessions.set(sessionId, session);
  console.log(`[tmux-runner] Session ${tmuxName} ready on ${machine.alias || machine.ip}`);
  return session;
}

/**
 * Send a prompt to a tmux session using load-buffer + paste-buffer.
 * Binary-safe — handles any special characters.
 */
export async function sendPromptViaTmux(
  machine: MachineRecord,
  session: TmuxSession,
  prompt: string,
  signal?: AbortSignal,
): Promise<void> {
  // Truncate the log file so we only capture output from this prompt
  try {
    await tmuxExec(machine, `truncate -s 0 ${shellEscape(session.logPath)}`, signal, 10_000);
  } catch { /* ignore */ }

  // Write prompt to temp file via SFTP
  const tmp = await writeTempFile(machine, prompt + '\n', signal);
  try {
    // Load into tmux buffer and paste it (binary-safe prompt delivery)
    await tmuxExec(
      machine,
      `tmux load-buffer -t ${shellEscape(session.tmuxName)} ${shellEscape(tmp.path)} && tmux paste-buffer -t ${shellEscape(session.tmuxName)} -d`,
      signal,
      15_000,
    );
    // Send Enter to submit the prompt
    await tmuxSendKeys(machine, session.tmuxName, 'Enter', signal);
  } finally {
    // Clean up temp file
    try { await tmuxExec(machine, `rm -f ${shellEscape(tmp.path)}`, signal, 5_000); } catch { /* ignore */ }
    tmp.cleanup();
  }
}

/**
 * Stream output from a tmux session's log file.
 * Opens a persistent SSH connection with `tail -f` and feeds through TmuxOutputParser.
 * Resolves when the response is complete (prompt reappears or idle timeout).
 */
export async function streamTmuxOutput(
  machine: MachineRecord,
  session: TmuxSession,
  onChunk: SshChunkCallback,
  signal?: AbortSignal,
): Promise<{ completed: boolean }> {
  if (signal?.aborted) throw new Error('Aborted');

  // Shared stream processing — same logic for local and SSH tail -f
  const processStream = (
    stdout: NodeJS.ReadableStream,
    stderr: NodeJS.ReadableStream | null,
    kill: () => void,
    cleanupFn: () => void,
  ): Promise<{ completed: boolean }> => {
    return new Promise<{ completed: boolean }>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          console.log(`[tmux-runner] Idle timeout (${config.tmuxIdleCompletionMs}ms) — response complete`);
          onChunk({ type: 'stderr', text: `[banana-tmux] Idle timeout — response complete\n` });
          parser.flush();
          cleanupAndResolve(true);
        }, config.tmuxIdleCompletionMs);
      };

      const cleanupAndResolve = (completed: boolean) => {
        if (idleTimer) clearTimeout(idleTimer);
        session.tailConn = null;
        cleanupFn();
        settle(() => resolve({ completed }));
      };

      const sendKeysForApprove = (keys: string) => {
        tmuxSendKeys(machine, session.tmuxName, keys, signal).catch((e) => {
          console.warn(`[tmux-runner] Failed to send auto-approve keys: ${e.message}`);
        });
      };

      const parser = new TmuxOutputParser(onChunk, sendKeysForApprove);

      resetIdle();

      stdout.on('data', (data: Buffer) => {
        resetIdle();
        const text = data.toString();
        const cleaned = stripAnsi(text);

        parser.feed(text);

        if (parser.hasContent() && /^>\s*$/m.test(cleaned)) {
          console.log('[tmux-runner] Prompt detected — response complete');
          parser.flush();
          kill();
          cleanupAndResolve(true);
          return;
        }

        if (parser.hasContent() && /\$\s*$/m.test(cleaned) && !/\\\$/m.test(cleaned)) {
          console.warn('[tmux-runner] Shell prompt detected — claude may have exited');
          parser.flush();
          onChunk({ type: 'stderr', text: '[banana-tmux] Claude process exited\n' });
          kill();
          cleanupAndResolve(true);
          return;
        }
      });

      if (stderr) {
        stderr.on('data', (data: Buffer) => {
          resetIdle();
          console.error(`[tmux-runner] tail stderr: ${data.toString().trim()}`);
        });
      }

      stdout.on('close', () => {
        if (idleTimer) clearTimeout(idleTimer);
        parser.flush();
        session.tailConn = null;
        settle(() => resolve({ completed: true }));
      });

      stdout.on('error', (e: Error) => {
        if (idleTimer) clearTimeout(idleTimer);
        console.error(`[tmux-runner] tail stream error: ${e.message}`);
        session.tailConn = null;
        settle(() => reject(e));
      });

      const onAbort = () => {
        if (idleTimer) clearTimeout(idleTimer);
        kill();
        session.tailConn = null;
        settle(() => reject(new Error('Aborted')));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      stdout.on('close', () => signal?.removeEventListener('abort', onAbort));
    });
  };

  // ── Local: spawn `tail -f` directly ──
  if (isLocalMachine(machine)) {
    const proc = spawn('tail', ['-f', session.logPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    return processStream(
      proc.stdout,
      proc.stderr,
      () => proc.kill(),
      () => { try { proc.kill(); } catch { /* noop */ } },
    );
  }

  // ── Remote: SSH tail -f ──
  const { client: conn, cleanup } = await connectWithRetry(machine, signal);
  session.tailConn = { client: conn, cleanup };

  conn.on('error', (err) => {
    session.tailConn = null;
    // Error will propagate through stream events
    console.error(`[tmux-runner] SSH connection error: ${err.message}`);
  });

  return new Promise<{ completed: boolean }>((resolve, reject) => {
    const shell = machine.localShell || '/bin/bash';
    conn.exec(`${shell} -ic ${shellEscape('tail -f ' + shellEscape(session.logPath))}`, (err, stream) => {
      if (err) { cleanup(); reject(err); return; }
      processStream(
        stream,
        stream.stderr,
        () => stream.close(),
        () => cleanup(),
      ).then(resolve, reject);
    });
  });
}

/**
 * Main entry point — run a claude prompt via persistent tmux session.
 * Same signature as `runClaudeOverSsh` for drop-in use in remoteSessionExecutor.
 */
export async function runClaudeViaTmux(
  machine: MachineRecord,
  prompt: string,
  workdir: string,
  onChunk: SshChunkCallback,
  signal?: AbortSignal,
  model?: string,
): Promise<SshRunResult> {
  if (signal?.aborted) throw new Error('Aborted');

  // Use the session ID derived from the workdir + machine to get a stable key,
  // but the caller passes the actual banana sessionId through the executor.
  // We rely on the caller to manage the sessionId → tmux mapping.
  // For now, throw — this function is only called from the executor wrapper.
  throw new Error('Use runClaudeViaTmuxForSession instead');
}

/**
 * Execute a prompt in a persistent tmux session, keyed by banana sessionId.
 * Ensures tmux session exists, sends prompt, streams output, returns result.
 */
export async function runClaudeViaTmuxForSession(
  machine: MachineRecord,
  sessionId: string,
  prompt: string,
  workdir: string,
  onChunk: SshChunkCallback,
  signal?: AbortSignal,
  model?: string,
): Promise<SshRunResult> {
  if (signal?.aborted) throw new Error('Aborted');
  const startedAt = Date.now();

  const sid8 = sessionId.slice(0, 8);
  console.log(`[tmux-runner] Session ${sid8} — prompt ${prompt.length} chars`);

  // Ensure tmux session is running
  const session = await ensureTmuxSession(machine, sessionId, workdir, model, signal);

  // Send the prompt
  await sendPromptViaTmux(machine, session, prompt, signal);

  // Stream output until response complete
  const { completed } = await streamTmuxOutput(machine, session, onChunk, signal);

  const durationMs = Date.now() - startedAt;
  console.log(`[tmux-runner] Session ${sid8} — done in ${durationMs}ms (completed=${completed})`);

  // Truncate log if too large (keep last 1MB)
  try {
    const sizeOutput = await tmuxExec(machine, `stat -c%s ${shellEscape(session.logPath)} 2>/dev/null || echo 0`, signal, 5_000);
    const size = parseInt(sizeOutput.trim(), 10);
    if (size > 1_048_576) {
      await tmuxExec(machine, `tail -c 1048576 ${shellEscape(session.logPath)} > ${shellEscape(session.logPath)}.tmp && mv ${shellEscape(session.logPath)}.tmp ${shellEscape(session.logPath)}`, signal, 10_000);
      console.log(`[tmux-runner] Truncated log to 1MB (was ${(size / 1_048_576).toFixed(1)}MB)`);
    }
  } catch { /* non-critical */ }

  return {
    exitCode: 0,
    durationMs,
    // No claudeSessionId — tmux session IS the persistent session
    // No inputTokens — can't extract from TUI output
  };
}

/**
 * Abort the current job in a tmux session by sending Ctrl-C.
 * Claude stays alive — only the current tool/response is interrupted.
 */
export async function abortTmuxJob(machine: MachineRecord, sessionId: string): Promise<boolean> {
  const session = tmuxSessions.get(sessionId);
  if (!session) return false;

  console.log(`[tmux-runner] Aborting job in ${session.tmuxName}`);

  // Close any active tail connection
  if (session.tailConn) {
    session.tailConn.cleanup();
    session.tailConn = null;
  }

  // Send Ctrl-C to interrupt current operation
  try {
    await tmuxSendKeys(machine, session.tmuxName, 'C-c');
  } catch (e) {
    console.warn(`[tmux-runner] Failed to send C-c: ${(e as Error).message}`);
    return false;
  }

  return true;
}

/**
 * Kill a tmux session and clean up resources.
 * Called when a banana session is deleted.
 */
export async function killTmuxSession(machine: MachineRecord, sessionId: string): Promise<void> {
  const session = tmuxSessions.get(sessionId);
  if (!session) return;

  console.log(`[tmux-runner] Killing session ${session.tmuxName}`);

  // Close any active tail connection
  if (session.tailConn) {
    session.tailConn.cleanup();
    session.tailConn = null;
  }

  // Kill tmux session
  try {
    await tmuxExec(machine, `tmux kill-session -t ${shellEscape(session.tmuxName)} 2>/dev/null || true`);
  } catch { /* ignore */ }

  // Clean up log file
  try {
    await tmuxExec(machine, `rm -f ${shellEscape(session.logPath)}`);
  } catch { /* ignore */ }

  tmuxSessions.delete(sessionId);
}

/** Check if a tmux session exists for the given banana sessionId. */
export function hasTmuxSession(sessionId: string): boolean {
  return tmuxSessions.has(sessionId);
}
