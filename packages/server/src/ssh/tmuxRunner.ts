import * as fs from 'fs';
import { execFile } from 'child_process';
import type { MachineRecord } from '../machines/machineStore.js';
import type { SshRunResult, SshChunkCallback, TunneledConnection } from './sshRunner.js';
import { connectWithRetry, shellEscape, isLocalMachine, execLocal, getLocalShell } from './sshRunner.js';
import { config } from '../config.js';

/**
 * Run tmux directly via execFile (no shell) for local machines.
 * Avoids spawning bash every 250ms which causes terminal title flicker.
 */
function execTmuxLocal(args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

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

/** Active tmux sessions keyed by `${sessionId}${suffix}` (suffix is '' for work, '-hub' for hub). */
const tmuxSessions = new Map<string, TmuxSession>();

/** Build the Map key for a tmux session. */
function tmuxKey(sessionId: string, suffix?: string): string {
  return `${sessionId}${suffix ?? ''}`;
}

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
    .replace(/\x07/g, '')
    // TUI right-side panel border: │ followed by dots/spaces to end of line.
    // Claude TUI renders a split layout on wide terminals (>~130 cols).
    // The right panel shows tips/status filled with middle dots (·).
    .replace(/\s*│[·\s]{10,}$/gm, '');
}

// ── Permission pattern registry ──────────────────────────────────────────────

interface PermissionPattern {
  label: string;
  test: (line: string) => boolean;
  keys: string;
}

const PERMISSION_PATTERNS: PermissionPattern[] = [
  // ── Menu patterns (most specific — check FIRST) ──────────────────────
  // These detect the TUI selection menu cursor. Must be checked before
  // text-based y/n patterns, because the screen may contain BOTH
  // "Allow...? (y/n)" text AND a "❯ Allow once" menu below it.
  // Sending "y Enter" to a menu does nothing; sending "Enter" works.

  // Numbered menu: "❯ 1. Yes" or "❯ 1. Allow"
  {
    label: 'menu-number-yes',
    test: (line) => /^[❯>►]\s*1\.\s*(?:Yes|Allow)\b/i.test(line),
    keys: 'Enter',
  },
  // Numbered menu cursor on No: "❯ 2. No" or "❯ 2. Deny" — navigate up
  {
    label: 'menu-number-no',
    test: (line) => /^[❯>►]\s*2\.\s*(?:No|Deny)\b/i.test(line),
    keys: 'Up Enter',
  },
  // Menu: cursor on Allow/Yes → Enter
  {
    label: 'menu-allow',
    test: (line) => /^[❯>►]\s+(?:Allow|Yes)\b/i.test(line),
    keys: 'Enter',
  },
  // Menu: cursor on Deny/No → navigate up (to Allow) and Enter
  {
    label: 'menu-deny',
    test: (line) => /^[❯>►]\s+(?:Deny|No)\b/i.test(line),
    keys: 'Up Enter',
  },
  // Accept edits: "⏵⏵ accept edits on" / "accept all" → Enter
  {
    label: 'accept-edits',
    test: (line) => /^[⏵►>]{1,2}\s*accept\b/i.test(line),
    keys: 'Enter',
  },

  // ── Text-based y/n/a patterns ────────────────────────────────────────
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
  // Standalone (y/n) — wrapped prompts where "(y/n)" is on its own line
  {
    label: 'standalone-yn',
    test: (line) => /^\(?\s*y(?:es)?\/n(?:o)?(?:\/a(?:lways)?)?\s*\)?\s*$/.test(line),
    keys: 'y Enter',
  },
  // "Do you want to...?" with (y/n)
  {
    label: 'do-you-yn',
    test: (line) => /\bDo you\b.*\?\s*\(?\s*y(?:es)?\/n(?:o)?\s*\)?/i.test(line),
    keys: 'y Enter',
  },

  // ── Startup / one-time prompts ───────────────────────────────────────
  // Trust this folder/directory/project
  {
    label: 'trust-folder',
    test: (line) => /\b[Tt]rust\b.*(?:folder|directory|project|workspace)\b/i.test(line),
    keys: 'y Enter',
  },
  // "dangerously skip permissions" prompt
  {
    label: 'dangerous-permissions',
    test: (line) => /\bdangerous(?:ly)?\b/i.test(line),
    keys: 'y Enter',
  },
];

/** Check if a line matches any permission/approval pattern. */
export function matchesPermissionPattern(line: string): boolean {
  return PERMISSION_PATTERNS.some(p => p.test(line));
}

// ── TmuxOutputParser ───────────────────────────────────────────────────────

type ParserState = 'waiting' | 'text' | 'tool_use' | 'tool_result';

/** Known Claude Code tool names — used to distinguish "⏺ Read" (tool) from "⏺ It looks..." (text). */
const KNOWN_TOOL_NAMES = new Set([
  'Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Agent',
  'NotebookEdit', 'TodoWrite', 'TodoRead',
  'EnterPlanMode', 'ExitPlanMode',
  'Skill', 'AskUserQuestion',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
  'EnterWorktree',
]);

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
  /** Cooldown: timestamp of last auto-approve to avoid re-firing while same prompt is visible. */
  private lastAutoApproveAt = 0;
  private lastApprovedText = '';
  private approveRetryCount = 0;
  /** Whether the screen currently shows a thinking spinner — text emitted as thinking_delta. */
  private _thinking = false;

  constructor(
    onChunk: SshChunkCallback,
    sendKeys?: (keys: string) => void,
    autoApprove = config.tmuxAutoApprovePermissions,
  ) {
    this.onChunk = onChunk;
    this.sendKeys = sendKeys ?? null;
    this.autoApprove = autoApprove;
  }

  /** Set thinking mode — text lines emitted as thinking_delta instead of text_delta. */
  setThinking(flag: boolean): void { this._thinking = flag; }

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
    // Close any open tool block so extractTextFromChunks resets insideTool
    if (this.state === 'tool_use' || this.state === 'tool_result') {
      this.onChunk({
        type: 'stream_event',
        event: { type: 'content_block_stop' },
      });
    }
  }

  /** Whether we've seen response content (not just the initial prompt). */
  hasContent(): boolean {
    return this.responseLines.length > 0;
  }

  /** Return all emitted response lines (trimmed) for diff reconciliation. */
  getResponseLines(): string[] {
    return this.responseLines;
  }

  /** Get last auto-approve timestamp (shared with full-screen scan). */
  getLastAutoApproveAt(): number {
    return this.lastAutoApproveAt;
  }

  /** Set last auto-approve timestamp (shared with full-screen scan). */
  setLastAutoApproveAt(ts: number): void {
    this.lastAutoApproveAt = ts;
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
    // Cooldown: don't re-fire within 3s (same permission stays visible across polls)
    if (this.autoApprove && Date.now() - this.lastAutoApproveAt > 3000) {
      for (const pattern of PERMISSION_PATTERNS) {
        if (pattern.test(trimmed)) {
          // Same prompt still on screen — count retries, back off after 3
          if (trimmed === this.lastApprovedText) {
            this.approveRetryCount++;
            if (this.approveRetryCount > 3) return; // give up, avoid log spam
          } else {
            this.lastApprovedText = trimmed;
            this.approveRetryCount = 0;
          }
          this.onChunk({
            type: 'stderr',
            text: `[banana-tmux] Auto-approved (${pattern.label}): ${trimmed}\n`,
          });
          if (this.sendKeys) this.sendKeys(pattern.keys);
          this.lastAutoApproveAt = Date.now();
          return;
        }
      }
    }

    // ── Prompt detection (response complete) ───────────────────────────
    // Claude TUI shows ">" or "❯" when waiting for input.
    // "❯ Try ..." is the placeholder prompt; "❯ Allow/Deny/Yes/No" and "❯ 1. Yes" are menu items.
    // Only counts if we've already seen response content.
    if (isPromptLine(trimmed) && this.hasContent()) {
      // Signal completion — handled by the caller via isPrompt flag
      return;
    }

    // ── Tool use start: "⏺ ToolName(...)" ─────────────────────────────
    // Only match known tool names — otherwise "⏺ It looks like..." (response text)
    // would be misidentified as tool use with name "It".
    if (/^[⏺●]\s+\w+/.test(trimmed)) {
      const match = trimmed.match(/^[⏺●]\s+(\w+)/);
      if (match && KNOWN_TOOL_NAMES.has(match[1])) {
        // Close previous tool block if transitioning tool→tool
        if (this.state === 'tool_use' || this.state === 'tool_result') {
          this.onChunk({
            type: 'stream_event',
            event: { type: 'content_block_stop' },
          });
        }
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
      // Emit content_block_stop when transitioning from tool_use/tool_result → text.
      // Without this, extractTextFromChunks keeps insideTool=true forever and
      // silently drops all subsequent text (including [BEGIN_WORK] markers).
      if (this.state === 'tool_use' || this.state === 'tool_result') {
        this.onChunk({
          type: 'stream_event',
          event: { type: 'content_block_stop' },
        });
      }
      this.state = 'text';
      this.responseLines.push(line);
      const deltaType = this._thinking ? 'thinking_delta' : 'text_delta';
      this.onChunk({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: deltaType, text: line + '\n' },
        },
      });
    }
  }
}

// ── Exec helpers ────────────────────────────────────────────────────────────

const PATH_PREFIX = 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.nvm/current/bin:$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH"';

/** Execute a command — locally or over SSH depending on machine type.
 *  When `conn` is provided (and not local), reuses that SSH connection instead of opening a new one.
 */
async function tmuxExec(
  machine: MachineRecord,
  command: string,
  signal?: AbortSignal,
  timeoutMs = 30_000,
  conn?: TunneledConnection,
): Promise<string> {
  if (signal?.aborted) throw new Error('Aborted');

  if (isLocalMachine(machine)) {
    const { stdout } = await execLocal(`${PATH_PREFIX} && ${command}`, { timeout: timeoutMs });
    return stdout;
  }

  // Reuse provided connection, or create a new one
  if (conn) {
    return execOnConn(conn, machine, command, signal, timeoutMs);
  }

  const { client: sshClient, cleanup } = await connectWithRetry(machine, signal);
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`SSH exec timed out (${timeoutMs}ms)`)); }, timeoutMs);
    const shell = machine.localShell || '/bin/bash';
    sshClient.exec(`${shell} -c ${shellEscape(PATH_PREFIX + ' && ' + command)}`, (err, stream) => {
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

/**
 * Run a command on an existing SSH connection (no new handshake).
 * Used by the hot polling loop in streamTmuxOutput to avoid
 * opening a new SSH connection per capture-pane call.
 */
async function execOnConn(
  conn: TunneledConnection,
  machine: MachineRecord,
  command: string,
  signal?: AbortSignal,
  timeoutMs = 10_000,
): Promise<string> {
  if (signal?.aborted) throw new Error('Aborted');
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`SSH exec timed out (${timeoutMs}ms)`)); }, timeoutMs);
    const shell = machine.localShell || '/bin/bash';
    conn.client.exec(`${shell} -c ${shellEscape(PATH_PREFIX + ' && ' + command)}`, (err, stream) => {
      if (err) { clearTimeout(timer); reject(err); return; }
      let out = '';
      let stderr = '';
      stream.on('data', (d: Buffer) => { out += d.toString(); });
      stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      stream.on('close', (code: number | null) => {
        clearTimeout(timer);
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
  conn?: TunneledConnection,
): Promise<void> {
  // Always use tmuxExec for send-keys — the `keys` string contains shell-quoted
  // arguments (e.g. 'cd /path && claude --verbose' Enter) that need a shell to
  // parse correctly. execFile + split(' ') would destroy the quoting and strip spaces.
  await tmuxExec(machine, `tmux send-keys -t ${shellEscape(tmuxName)} ${keys}`, signal, 10_000, conn);
}

/** Write content to a temp file, return the path. Uses local fs or SFTP depending on machine.
 *  When `conn` is provided (and not local), uses that connection's SFTP — cleanup is a no-op.
 */
async function writeTempFile(
  machine: MachineRecord,
  content: string,
  signal?: AbortSignal,
  conn?: TunneledConnection,
): Promise<{ path: string; cleanup: () => void }> {
  if (signal?.aborted) throw new Error('Aborted');
  const tmpPath = `/tmp/banana-tmux-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (isLocalMachine(machine)) {
    fs.writeFileSync(tmpPath, content, { mode: 0o600 });
    return { path: tmpPath, cleanup: () => {} };
  }

  // Reuse provided connection or create a new one
  const tunneled = conn ?? await connectWithRetry(machine, signal);
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
    // Only clean up if we created our own connection
    cleanup: conn ? () => {} : () => { tunneled.cleanup(); },
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
  suffix?: string,
): Promise<TmuxSession> {
  const key = tmuxKey(sessionId, suffix);
  const existing = tmuxSessions.get(key);
  if (existing) {
    // Verify tmux session still exists on remote — retry once for transient SSH errors
    let verified = false;
    for (let attempt = 0; attempt < 2 && !verified; attempt++) {
      try {
        await tmuxExec(machine, `tmux has-session -t ${shellEscape(existing.tmuxName)} 2>/dev/null`, signal, 10_000);
        verified = true;
      } catch {
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 500)); // brief retry delay
        }
      }
    }
    if (verified) {
      // Resize existing session to current desired size (old sessions may have smaller panes)
      await tmuxExec(machine, `tmux resize-window -t ${shellEscape(existing.tmuxName)} -x 120 -y 200 2>/dev/null || true`, signal, 10_000).catch(() => {});
      return existing;
    }
    // Session died — clean up and recreate
    console.warn(`[tmux-runner] Session ${existing.tmuxName} died on remote, recreating`);
    tmuxSessions.delete(key);
    if (existing.tailConn) existing.tailConn.cleanup();
  }

  const sid8 = sessionId.slice(0, 8);
  const sfx = suffix ?? '';
  const tmuxName = `banana-${sid8}${sfx}`;
  const logPath = `/tmp/banana-tmux-log-${sid8}${sfx}`;
  const isLocal = isLocalMachine(machine);

  // For remote machines, open a single connection for the entire setup sequence
  const conn = isLocal ? null : await connectWithRetry(machine, signal);
  try {
    // Verify tmux is installed
    try {
      await tmuxExec(machine, 'command -v tmux', signal, 10_000, conn ?? undefined);
    } catch {
      const hint = isLocal
        ? 'Install it with: brew install tmux (macOS) or apt install tmux (Linux)'
        : 'Install it on the remote machine: apt install tmux / yum install tmux';
      throw new Error(`tmux is not installed or not in PATH. ${hint}`);
    }

    // ── Adopt surviving tmux sessions (e.g. after server restart) ──────
    // Check if a tmux session with our name already exists. If it does and
    // claude is running inside (shows a prompt), adopt it — this preserves
    // conversation context across banana server restarts.
    let adopted = false;
    try {
      await tmuxExec(machine, `tmux has-session -t ${shellEscape(tmuxName)} 2>/dev/null`, signal, 10_000, conn ?? undefined);
      // Session exists! Check if claude is alive inside
      const screen = await tmuxExec(
        machine,
        `tmux capture-pane -t ${shellEscape(tmuxName)} -p`,
        signal,
        10_000,
        conn ?? undefined,
      );
      const cleaned = stripAnsi(screen);
      const lines = cleaned.split('\n').map(l => l.trim());
      const hasPrompt = lines.some(l => isPromptLine(l));
      const hasClaudeTui = lines.some(l =>
        /^Claude Code v[\d.]+/.test(l) ||
        /^\? for shortcuts/.test(l) ||
        /^\d+ tokens?\s*$/.test(l) ||
        /^esc to (?:interrupt|cancel)/i.test(l)
      );
      if (hasPrompt || hasClaudeTui) {
        // Claude is alive — adopt the session
        console.log(`[tmux-runner] Adopting existing tmux session ${tmuxName} (claude still running)`);
        // Resize to desired dimensions
        await tmuxExec(machine, `tmux resize-window -t ${shellEscape(tmuxName)} -x 120 -y 200 2>/dev/null || true`, signal, 10_000, conn ?? undefined).catch(() => {});
        // Ensure pipe-pane is set up (may have been lost)
        await tmuxExec(
          machine,
          `tmux pipe-pane -t ${shellEscape(tmuxName)} -o 'cat >> ${shellEscape(logPath)}'`,
          signal,
          10_000,
          conn ?? undefined,
        ).catch(() => {});
        const session: TmuxSession = { tmuxName, logPath, ready: true, tailConn: null };
        tmuxSessions.set(key, session);
        adopted = true;
      } else {
        console.log(`[tmux-runner] Existing tmux session ${tmuxName} has no claude prompt — killing and recreating`);
      }
    } catch {
      // No existing session — will create fresh below
    }

    if (adopted) {
      return tmuxSessions.get(key)!;
    }

    // Kill any stale session with the same name
    try {
      await tmuxExec(machine, `tmux kill-session -t ${shellEscape(tmuxName)} 2>/dev/null || true`, signal, 10_000, conn ?? undefined);
    } catch { /* ignore */ }

    // Remove stale log file
    try {
      await tmuxExec(machine, `rm -f ${shellEscape(logPath)}`, signal, 10_000, conn ?? undefined);
    } catch { /* ignore */ }

    // Create tmux session in detached mode — use -c to set the starting directory
    // so the shell initializes in the correct workdir (avoids race with send-keys cd).
    const startDir = workdir || '$HOME';
    await tmuxExec(
      machine,
      `tmux new-session -d -s ${shellEscape(tmuxName)} -x 120 -y 200 -c ${shellEscape(startDir)}`,
      signal,
      15_000,
      conn ?? undefined,
    );

    // Set up pipe-pane to log all output
    await tmuxExec(
      machine,
      `tmux pipe-pane -t ${shellEscape(tmuxName)} -o 'cat >> ${shellEscape(logPath)}'`,
      signal,
      10_000,
      conn ?? undefined,
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
    // B2: Hub tmux sessions run with --bare (skip CLAUDE.md, hooks, skills, MCP)
    if (suffix === '-hub') claudeArgs.push('--bare');
    if (model) claudeArgs.push('--model', shellEscape(model));

    // cd is redundant with -c but kept as safety (in case shell init changes cwd)
    const cdPart = workdir ? `cd ${shellEscape(workdir)} && ` : '';
    const fullCmd = `${cdPart}${PATH_PREFIX} && ${claudeBin} ${claudeArgs.join(' ')}`;

    // Wait for shell to initialize (oh-my-zsh, MOTD, etc.) before sending command.
    // Without this, send-keys input can be swallowed by shell startup.
    // Uses tmuxStartupDelayMs (default 1500ms, 0 in tests via config override).
    const startupDelay = config.tmuxStartupDelayMs ?? 1500;
    if (startupDelay > 0) await new Promise(r => setTimeout(r, startupDelay));

    // Send the command to tmux
    await tmuxSendKeys(machine, tmuxName, `${shellEscape(fullCmd)} Enter`, signal, conn ?? undefined);

    // Wait for claude to start (look for the initial prompt '>')
    const startedAt = Date.now();
    const timeoutMs = config.tmuxStartupTimeoutMs;
    let ready = false;

    let lastScreen = '';
    while (Date.now() - startedAt < timeoutMs) {
      if (signal?.aborted) throw new Error('Aborted');
      await new Promise(r => setTimeout(r, 2000));
      try {
        const screen = await tmuxExec(
          machine,
          `tmux capture-pane -t ${shellEscape(tmuxName)} -p`,
          signal,
          10_000,
          conn ?? undefined,
        );
        const cleaned = stripAnsi(screen);
        lastScreen = cleaned;
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        const summary = cleaned.trim().split('\n').filter(l => l.trim()).slice(-3).join(' | ');
        if (summary) {
          console.log(`[tmux-runner] Startup screen (${elapsed}s): ${summary.slice(-200)}`);
        }
        const hasPrompt = cleaned.split('\n').some(l => isPromptLine(l));
        if (hasPrompt) {
          ready = true;
          break;
        }
        if ((/error|Error|fatal|FATAL/i.test(cleaned) || /No executable.*found/i.test(cleaned) || /command not found/i.test(cleaned)) && /\$\s*$/m.test(cleaned)) {
          throw new Error(`Claude failed to start: ${cleaned.slice(-500)}`);
        }
      } catch (e) {
        if ((e as Error).message.includes('Claude failed')) throw e;
        // transient error — keep trying
      }
    }

    if (!ready) {
      try { await tmuxExec(machine, `tmux kill-session -t ${shellEscape(tmuxName)} 2>/dev/null || true`, undefined, 10_000, conn ?? undefined); } catch { /* ignore */ }
      throw new Error(`Claude did not start within ${timeoutMs}ms. Last screen:\n${lastScreen.slice(-1000)}`);
    }

    // Truncate the startup log so we start clean for the first prompt
    try {
      await tmuxExec(machine, `truncate -s 0 ${shellEscape(logPath)}`, signal, 10_000, conn ?? undefined);
    } catch { /* ignore */ }

    const session: TmuxSession = {
      tmuxName,
      logPath,
      ready: true,
      tailConn: null,
    };
    tmuxSessions.set(key, session);
    console.log(`[tmux-runner] Session ${tmuxName} ready on ${machine.alias || machine.ip}`);
    return session;
  } finally {
    if (conn) conn.cleanup();
  }
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
  // Resize pane to maximize capture area before each prompt
  const resizeCmd = `tmux resize-window -t ${shellEscape(session.tmuxName)} -x 750 -y 200 2>/dev/null || true`;

  if (isLocalMachine(machine)) {
    // Local path — no SSH connection reuse needed
    try { await tmuxExec(machine, resizeCmd, signal, 10_000); } catch { /* ignore */ }
    try {
      await tmuxExec(machine, `truncate -s 0 ${shellEscape(session.logPath)}`, signal, 10_000);
    } catch { /* ignore */ }
    const tmp = await writeTempFile(machine, prompt + '\n', signal);
    try {
      await tmuxExec(machine, `tmux load-buffer -t ${shellEscape(session.tmuxName)} ${shellEscape(tmp.path)} && tmux paste-buffer -t ${shellEscape(session.tmuxName)} -d`, signal, 15_000);
      await new Promise(r => setTimeout(r, 300));
      await tmuxSendKeys(machine, session.tmuxName, 'Enter', signal);
    } finally {
      try { await tmuxExec(machine, `rm -f ${shellEscape(tmp.path)}`, signal, 5_000); } catch { /* ignore */ }
      tmp.cleanup();
    }
    return;
  }

  // Remote path — reuse a single SSH connection for all operations
  const conn = await connectWithRetry(machine, signal);
  try {
    // Resize pane to maximize capture area
    try { await tmuxExec(machine, resizeCmd, signal, 10_000, conn); } catch { /* ignore */ }
    // Truncate the log file so we only capture output from this prompt
    try {
      await tmuxExec(machine, `truncate -s 0 ${shellEscape(session.logPath)}`, signal, 10_000, conn);
    } catch { /* ignore */ }

    // Write prompt to temp file via SFTP (reuses conn)
    const tmp = await writeTempFile(machine, prompt + '\n', signal, conn);
    try {
      // Load into tmux buffer and paste it (binary-safe prompt delivery)
      await tmuxExec(
        machine,
        `tmux load-buffer -t ${shellEscape(session.tmuxName)} ${shellEscape(tmp.path)} && tmux paste-buffer -t ${shellEscape(session.tmuxName)} -d`,
        signal,
        15_000,
        conn,
      );
      // Wait for TUI to process the paste before sending Enter
      await new Promise(r => setTimeout(r, 300));
      // Send Enter to submit the prompt
      await tmuxSendKeys(machine, session.tmuxName, 'Enter', signal, conn);
    } finally {
      // Clean up temp file
      try { await tmuxExec(machine, `rm -f ${shellEscape(tmp.path)}`, signal, 5_000, conn); } catch { /* ignore */ }
      tmp.cleanup();
    }
  } finally {
    conn.cleanup();
  }
}

/** Filter TUI chrome/noise from capture-pane output. Returns true for response content lines. */
export function isResponseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // Horizontal rules — TUI separators span the full terminal width (200 cols).
  // Table borders are typically much shorter, so only filter very long runs.
  if (/^[─━═]{80,}$/.test(t)) return false;
  // Claude logo
  if (/^[▐▛▝▘]/.test(t)) return false;
  // Status bar / footer
  if (/^\? for shortcuts/.test(t)) return false;
  if (/^esc to interrupt/i.test(t)) return false;
  if (/^esc to cancel/i.test(t)) return false;
  if (/^\d+ tokens?$/.test(t)) return false;
  // Auto-update / deprecation
  if (/^globalVersion:/.test(t)) return false;
  if (/^Claude Code has switched/.test(t)) return false;
  // Spinner / progress lines (✳ Misting…, ✻ Thinking…, ∴ Thinking…, ✶ Mulling…, etc.)
  if (/^[✳✻✽·✢∗☆★✦✧⊹✶∴] \w+/.test(t)) return false;
  // Streaming indicators with timing/tokens
  if (/^\(?\d+s\s*·/.test(t)) return false;
  if (/^↑|^↓/.test(t)) return false;
  // Shell prompt
  if (/^\w+@[\w.-]+:.*[\$#]\s*$/.test(t)) return false;
  // Command echo (the tmux send-keys command)
  if (/^cd\s+'.*&&.*export\s+PATH=/.test(t)) return false;
  // Separator lines (MOTD === blocks)
  if (/^={5,}$/.test(t)) return false;
  // Claude TUI header / welcome box
  if (/^Claude Code v[\d.]+/.test(t)) return false;
  if (/^(Opus|Sonnet|Haiku)\s+[\d.]+/.test(t)) return false;
  if (/^Welcome back\b/.test(t)) return false;
  if (/^Run \/init to create/.test(t)) return false;
  if (/^Tips for getting started/.test(t)) return false;
  if (/^Recent activity/.test(t)) return false;
  if (/^No recent activity/.test(t)) return false;
  // TUI box drawing characters (welcome box, separator frames)
  // NOTE: └ (U+2514) intentionally EXCLUDED — it's used as a tool result prefix by some Claude versions
  if (/^[╭╰╮╯│┌┐┘├┤┬┴┼]/.test(t)) return false;
  // Claude Max / org / model info lines
  if (/^·\s+Claude\s/.test(t)) return false;
  if (/^\w+['']s\s+Organization/.test(t)) return false;
  if (/^~\//.test(t)) return false;
  // Token count in footer
  if (/^\d+ tokens?\s*$/.test(t)) return false;
  // latestVersion / auto-update lines
  if (/^latestVersion:/.test(t)) return false;
  if (/Auto-update failed/.test(t)) return false;
  // tmux config warnings (e.g. "focus-events off. add 'set -g focus-events on'")
  if (/^(?:tmux:|focus-events\s)/i.test(t)) return false;
  // Status/effort indicators (e.g. "· /effort high", "● high · /effort")
  if (/^[·•]\s*\/effort\b/.test(t)) return false;
  if (/^●\s+(?:high|low|off)\b/.test(t)) return false;
  if (/[·•]\s*\/effort\b/.test(t) && t.length < 40) return false;
  // Paste notification from TUI (appears when prompt is pasted via tmux paste-buffer)
  // May appear bare "[Pasted text ...]" or with prompt prefix "❯ [Pasted text ...]"
  if (/\[Pasted text\b/.test(t)) return false;
  return true;
}

/** Check if a line is a Claude prompt indicator (response complete). */
function isPromptLine(line: string): boolean {
  const t = line.trim();
  if (/^[>❯]\s*$/.test(t)) return true;
  if (/^❯\s+/.test(t)) {
    // Exclude permission menu items: "❯ Allow/Deny/Yes/No" or "❯ 1. Yes" / "❯ 2. No"
    if (/^❯\s+(?:Allow|Deny|Yes|No)\b/i.test(t)) return false;
    if (/^❯\s+\d+\.\s*(?:Yes|No|Allow|Deny)\b/i.test(t)) return false;
    return true;
  }
  return false;
}

/**
 * Final sweep before completion: recover content lines that the per-poll
 * multiset diff missed. The diff drops lines whose text matches something
 * already on screen (e.g. a [CHANNEL_REPLY] summary repeating tool output).
 *
 * Strategy: POSITIONAL tail sweep. Find the last emitted line on the current
 * screen, then feed everything after it (excluding TUI chrome / prompts) to
 * the parser. This is order-aware and avoids the multiset cancellation bug.
 */
function sweepMissedLines(
  curLines: string[],
  parser: TmuxOutputParser,
  promptLines: Set<string>,
  _initialLineCounts: Map<string, number>,
): void {
  const emitted = parser.getResponseLines();
  if (emitted.length === 0) return;

  // Find the position of the last emitted line on the current screen.
  // Search bottom-up — the most recent content is near the bottom.
  const lastEmitted = emitted[emitted.length - 1];
  let anchorPos = -1;
  for (let i = curLines.length - 1; i >= 0; i--) {
    if (curLines[i] === lastEmitted) {
      anchorPos = i;
      break;
    }
  }

  if (anchorPos === -1) {
    // Last emitted line scrolled off — can't do positional sweep.
    // Fall back to tail: find the FIRST response-like line from the bottom
    // that is NOT a prompt/footer, and sweep from there.
    return;
  }

  // Feed all response-like lines AFTER the anchor position
  let swept = 0;
  for (let i = anchorPos + 1; i < curLines.length; i++) {
    const t = curLines[i];
    if (!t) continue;
    if (!isResponseLine(t)) continue;
    if (isPromptLine(t)) continue;
    if (promptLines.size > 0 && promptLines.has(t)) continue;
    parser.feed(t + '\n');
    swept++;
  }

  if (swept > 0) {
    console.log(`[tmux-runner] Tail sweep recovered ${swept} missed line(s) after position ${anchorPos}`);
  }
}

/**
 * Stream output from a tmux session by polling `tmux capture-pane`.
 * TUI apps (like Claude) render full-screen, so pipe-pane/tail-f produces
 * unusable raw terminal data. capture-pane returns the rendered screen.
 *
 * Uses screen-diff approach: compares consecutive captures and emits only
 * lines that are genuinely new (not present in the previous capture).
 * This avoids the false-dedup problem where identical lines across different
 * responses would be silently dropped.
 */
export async function streamTmuxOutput(
  machine: MachineRecord,
  session: TmuxSession,
  onChunk: SshChunkCallback,
  signal?: AbortSignal,
  promptText?: string,
  filterThinking = false,
): Promise<{ completed: boolean }> {
  if (signal?.aborted) throw new Error('Aborted');

  const pollIntervalMs = 250;
  let hasContent = false;
  let lastChangeAt = Date.now();

  // Build a set of prompt lines to filter out echoed prompt text from capture-pane.
  // When a long prompt is pasted via tmux, it appears on screen before claude processes it.
  // The TUI also echoes prompts prefixed with "❯ ", so we add both forms.
  const promptLines = new Set<string>();
  if (promptText) {
    for (const line of promptText.split('\n')) {
      const t = line.trim();
      if (t) {
        promptLines.add(t);
        promptLines.add(`❯ ${t}`);   // TUI prompt echo: "❯ <text>"
        promptLines.add(`> ${t}`);    // alternative prompt char
      }
    }
  }

  const sendKeysForApprove = (keys: string) => {
    tmuxSendKeys(machine, session.tmuxName, keys, signal).catch((e) => {
      console.warn(`[tmux-runner] Failed to send auto-approve keys: ${e.message}`);
    });
  };

  const parser = new TmuxOutputParser(onChunk, sendKeysForApprove);

  // Open a persistent SSH connection for the polling loop (avoids re-handshake per poll).
  // For local machines, pollConn stays null and we fall back to tmuxExec.
  let pollConn: TunneledConnection | null = null;
  if (!isLocalMachine(machine)) {
    try {
      pollConn = await connectWithRetry(machine, signal);
    } catch (e) {
      console.warn(`[tmux-runner] Failed to open persistent poll connection: ${(e as Error).message}`);
      // Fall back to per-call connections (slow but functional)
    }
  }

  /** Run capture-pane using persistent connection when available, else fallback to tmuxExec. */
  const isLocal = isLocalMachine(machine);
  const capturePane = async (): Promise<string> => {
    // Local: call tmux directly (no shell spawn) to avoid terminal title flicker
    if (isLocal) {
      return execTmuxLocal(['capture-pane', '-t', session.tmuxName, '-p'], 10_000);
    }
    const cmd = `tmux capture-pane -t ${shellEscape(session.tmuxName)} -p`;
    if (pollConn) {
      try {
        return await execOnConn(pollConn, machine, cmd, signal, 10_000);
      } catch (e) {
        // Connection may have died — try reconnecting once
        console.warn(`[tmux-runner] Poll connection lost, reconnecting: ${(e as Error).message}`);
        try { pollConn.cleanup(); } catch { /* ignore */ }
        try {
          pollConn = await connectWithRetry(machine, signal);
          return await execOnConn(pollConn, machine, cmd, signal, 10_000);
        } catch {
          pollConn = null; // give up on persistent, fall back to tmuxExec
        }
      }
    }
    return tmuxExec(machine, cmd, signal, 10_000);
  };

  // Dedup tracking for screen-scan auto-approve (avoid log spam when prompt stays visible)
  let lastScreenApproveText = '';
  let screenApproveRetries = 0;

  // Capture the initial screen as our baseline — everything here is "old".
  // We store the full line array (with positions) so we can diff properly.
  let prevLines: string[] = [];
  let prevScreen = '';
  try {
    const initial = await capturePane();
    prevScreen = stripAnsi(initial);
    prevLines = prevScreen.split('\n').map(l => l.trim());
  } catch { /* start from empty */ }

  // Save initial baseline for sweepMissedLines — lines present before the
  // response started (MOTD, shell commands, Claude welcome screen) must be
  // excluded from the final sweep to avoid leaking pre-existing content.
  const initialLineCounts = buildLineMultiset(prevLines);

  // Build a multiset (line → count) from a line array for diff comparison.
  function buildLineMultiset(lines: string[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const l of lines) {
      if (!l) continue;
      m.set(l, (m.get(l) ?? 0) + 1);
    }
    return m;
  }

  try {
    while (true) {
      if (signal?.aborted) throw new Error('Aborted');
      await new Promise(r => setTimeout(r, pollIntervalMs));
      if (signal?.aborted) throw new Error('Aborted');

      let screen: string;
      try {
        const raw = await capturePane();
        screen = stripAnsi(raw);
      } catch (e) {
        console.warn(`[tmux-runner] capture-pane failed: ${(e as Error).message}`);
        continue;
      }

      // Track raw screen changes — the multiset diff skips blank lines, so
      // whitespace-only changes (e.g. blank lines after "A few observations:")
      // are invisible to the content diff. Raw comparison catches those.
      const screenChanged = screen !== prevScreen;
      prevScreen = screen;

      const curLines = screen.split('\n').map(l => l.trim());

      // Diff: find lines in curLines that are new compared to prevLines.
      // Uses multiset subtraction — handles duplicate lines correctly.
      const prevSet = buildLineMultiset(prevLines);
      const newLines: string[] = [];
      for (const t of curLines) {
        if (!t) continue;
        const prevCount = prevSet.get(t) ?? 0;
        if (prevCount > 0) {
          prevSet.set(t, prevCount - 1); // consume one occurrence
        } else {
          newLines.push(t);
        }
      }

      // Check for spinner (agent is still working — thinking, running tools, etc.)
      // Require … (ellipsis) after the word to avoid false positives from status lines
      // like "· Claude Max" or "· Organization Policy" on enterprise instances.
      const bottomLines = curLines.filter(l => l).slice(-10);
      const hasSpinner = bottomLines.some(l => /^[✳✻✽·✢∗☆★✦✧⊹✶∴] \w+…/.test(l));

      // Detect thinking mode (hub channel only): if a spinner is active at the BOTTOM
      // of the screen, text is thinking output. Only check bottom lines — a spinner
      // scrolled up from a previous thinking phase must NOT keep thinking mode on.
      if (filterThinking) {
        parser.setThinking(hasSpinner);
      }

      // Emit new response content lines (noise-filtered, prompt-echo-filtered)
      let newContentThisPoll = false;
      for (const t of newLines) {
        // Skip echoed prompt text (pasted prompt appears on screen before processing)
        if (promptLines.size > 0 && promptLines.has(t)) continue;

        // Permission-matching always gets processed (auto-approve)
        if (matchesPermissionPattern(t)) {
          parser.feed(t + '\n');
          newContentThisPoll = true;
          hasContent = true;
          continue;
        }
        if (isResponseLine(t)) {
          newContentThisPoll = true;
          hasContent = true;
          parser.feed(t + '\n');
        }
      }

      // ── Full-screen permission scan ─────────────────────────────────
      // The diff-based check above only sees NEW lines, so it misses:
      //   - Wrapped permission prompts (e.g. "Allow Bash: <very long cmd>" on one line,
      //     "(y/n)" on the next — neither alone matches allow-yn via the diff)
      //   - Prompts that were visible in the previous poll but not yet approved
      // Scan the bottom of the full screen with its own 3s cooldown.
      // Dedup: skip if same screen text was already approved (avoid log spam).
      if (config.tmuxAutoApprovePermissions) {
        const now = Date.now();
        if (now - parser.getLastAutoApproveAt() > 3000) {
          // Same screen text still showing — count retries, give up after 3
          const screenFingerprint = bottomLines.join(' ').slice(-200);
          if (screenFingerprint === lastScreenApproveText) {
            screenApproveRetries++;
          } else {
            lastScreenApproveText = screenFingerprint;
            screenApproveRetries = 0;
          }

          if (screenApproveRetries <= 3) {
            let approved = false;
            // Check individual lines FIRST — menu items (❯ Yes, ❯ 1. Allow) are
            // more specific and need different keys than y/n text prompts. If we
            // join lines first, "Allow...? (y/n)" matches before "❯ Allow once".
            for (const line of bottomLines) {
              for (const pattern of PERMISSION_PATTERNS) {
                if (pattern.test(line)) {
                  onChunk({ type: 'stderr', text: `[banana-tmux] Auto-approved via screen scan (${pattern.label}): ${line.slice(0, 120)}\n` });
                  sendKeysForApprove(pattern.keys);
                  parser.setLastAutoApproveAt(now);
                  approved = true;
                  break;
                }
              }
              if (approved) break;
            }
            // Fallback: join bottom lines for wrapped prompts (e.g. "Allow Bash: <long>"
            // on one line, "(y/n)" on the next — neither alone matches)
            if (!approved) {
              const joinedBottom = bottomLines.join(' ');
              for (const pattern of PERMISSION_PATTERNS) {
                if (pattern.test(joinedBottom)) {
                  onChunk({ type: 'stderr', text: `[banana-tmux] Auto-approved via screen scan (${pattern.label}): ${joinedBottom.slice(0, 120)}\n` });
                  sendKeysForApprove(pattern.keys);
                  parser.setLastAutoApproveAt(now);
                  approved = true;
                  break;
                }
              }
            }
          }
        }
      }

      // Update baseline for next poll
      prevLines = curLines;

      if (newContentThisPoll || hasSpinner || screenChanged) {
        // Reset idle timer when there's new content, an active spinner, or any screen change.
        // screenChanged catches whitespace-only changes invisible to the multiset diff.
        lastChangeAt = Date.now();
      }

      // Check for prompt (response complete)
      // The TUI shows a distinctive input box when ready:
      //   ────────────────────
      //   ❯ Try "how do I..."
      //   ? for shortcuts · esc to interrupt
      //   23385 tokens
      // Require the prompt to appear WITH a TUI footer line ("? for shortcuts",
      // "esc to interrupt/cancel", or token count). This is unique to the TUI
      // "ready" state and won't match tables or other content. Also require
      // no new content this poll (screen must be stable).
      const hasPrompt = bottomLines.some(isPromptLine);
      const hasTuiFooter = bottomLines.some(l =>
        /^\? for shortcuts/.test(l) ||
        /^esc to (?:interrupt|cancel)/i.test(l) ||
        /^\d+ tokens?\s*$/.test(l)
      );
      if (hasContent && hasPrompt && hasTuiFooter && !hasSpinner && !newContentThisPoll && !screenChanged) {
        sweepMissedLines(curLines, parser, promptLines, initialLineCounts);
        console.log('[tmux-runner] Prompt detected — response complete');
        parser.flush();
        return { completed: true };
      }

      // Check for shell prompt (claude exited)
      if (hasContent && bottomLines.some(l => /\$\s*$/.test(l) && !/\\\$/.test(l))) {
        console.warn('[tmux-runner] Shell prompt detected — claude may have exited');
        parser.flush();
        onChunk({ type: 'stderr', text: '[banana-tmux] Claude process exited\n' });
        return { completed: true };
      }

      // Idle timeout — no new content for tmuxIdleCompletionMs → done
      if (hasContent && Date.now() - lastChangeAt > config.tmuxIdleCompletionMs) {
        sweepMissedLines(curLines, parser, promptLines, initialLineCounts);
        console.log(`[tmux-runner] Idle timeout (${config.tmuxIdleCompletionMs}ms) — response complete`);
        onChunk({ type: 'stderr', text: `[banana-tmux] Idle timeout — response complete\n` });
        parser.flush();
        return { completed: true };
      }

      // Debug: log screen state periodically when stuck (every 30s after content detected)
      const stuckMs = Date.now() - lastChangeAt;
      if (hasContent && stuckMs > 10_000 && stuckMs % 10_000 < pollIntervalMs * 2) {
        console.warn(`[tmux-runner] Stuck for ${(stuckMs / 1000).toFixed(0)}s — bottom: ${bottomLines.slice(-5).join(' | ')} — hasPrompt=${hasPrompt} hasSpinner=${hasSpinner} screenChanged=${screenChanged}`);
      }
    }
  } finally {
    // Clean up the persistent poll connection
    if (pollConn) {
      try { pollConn.cleanup(); } catch { /* ignore */ }
    }
  }
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
 * Send /clear to a tmux session and wait for the prompt to reappear.
 * Used to reset context before hub dispatches to avoid token accumulation.
 */
export async function clearTmuxSession(
  machine: MachineRecord,
  sessionId: string,
  signal?: AbortSignal,
  suffix?: string,
): Promise<boolean> {
  const key = tmuxKey(sessionId, suffix);
  const session = tmuxSessions.get(key);
  if (!session) return false;

  const sid8 = sessionId.slice(0, 8);
  const sfx = suffix ?? '';
  console.log(`[tmux-runner] Session ${sid8}${sfx} — sending /clear`);

  // For local machines, use the original per-call pattern
  if (isLocalMachine(machine)) {
    await tmuxSendKeys(machine, session.tmuxName, '/clear Enter', signal);
    const startedAt = Date.now();
    const timeoutMs = 30_000;
    while (Date.now() - startedAt < timeoutMs) {
      if (signal?.aborted) throw new Error('Aborted');
      await new Promise(r => setTimeout(r, 1000));
      try {
        const screen = await tmuxExec(machine, `tmux capture-pane -t ${shellEscape(session.tmuxName)} -p`, signal, 10_000);
        const lines = stripAnsi(screen).split('\n').filter(l => l.trim()).slice(-10).map(l => l.trim());
        if (lines.some(isPromptLine)) {
          console.log(`[tmux-runner] Session ${sid8}${sfx} — /clear done`);
          return true;
        }
      } catch { /* retry */ }
    }
    console.warn(`[tmux-runner] Session ${sid8}${sfx} — /clear timed out, continuing anyway`);
    return false;
  }

  // Remote — reuse a single SSH connection for send-keys + polling loop
  const conn = await connectWithRetry(machine, signal);
  try {
    await tmuxSendKeys(machine, session.tmuxName, '/clear Enter', signal, conn);

    const startedAt = Date.now();
    const timeoutMs = 30_000;
    while (Date.now() - startedAt < timeoutMs) {
      if (signal?.aborted) throw new Error('Aborted');
      await new Promise(r => setTimeout(r, 1000));
      try {
        const screen = await tmuxExec(
          machine,
          `tmux capture-pane -t ${shellEscape(session.tmuxName)} -p`,
          signal,
          10_000,
          conn,
        );
        const lines = stripAnsi(screen).split('\n').filter(l => l.trim()).slice(-10).map(l => l.trim());
        if (lines.some(isPromptLine)) {
          console.log(`[tmux-runner] Session ${sid8}${sfx} — /clear done`);
          return true;
        }
      } catch { /* retry */ }
    }

    console.warn(`[tmux-runner] Session ${sid8}${sfx} — /clear timed out, continuing anyway`);
    return false;
  } finally {
    conn.cleanup();
  }
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
  suffix?: string,
): Promise<SshRunResult> {
  if (signal?.aborted) throw new Error('Aborted');
  const startedAt = Date.now();

  const sid8 = sessionId.slice(0, 8);
  const sfx = suffix ?? '';
  console.log(`[tmux-runner] Session ${sid8}${sfx} — prompt ${prompt.length} chars`);

  // Ensure tmux session is running
  const session = await ensureTmuxSession(machine, sessionId, workdir, model, signal, suffix);

  // Send the prompt
  await sendPromptViaTmux(machine, session, prompt, signal);

  // Stream output until response complete (pass prompt text to filter echoed lines)
  // Hub channels (suffix like '-hub') filter thinking to avoid polluting channel replies.
  const isHubChannel = !!suffix;
  const { completed } = await streamTmuxOutput(machine, session, onChunk, signal, prompt, isHubChannel);

  const durationMs = Date.now() - startedAt;
  console.log(`[tmux-runner] Session ${sid8}${sfx} — done in ${durationMs}ms (completed=${completed})`);

  // Truncate log if too large (keep last 1MB) — reuse 1 connection for stat + truncate
  try {
    if (!isLocalMachine(machine)) {
      const logConn = await connectWithRetry(machine, signal);
      try {
        const sizeOutput = await tmuxExec(machine, `stat -c%s ${shellEscape(session.logPath)} 2>/dev/null || echo 0`, signal, 5_000, logConn);
        const size = parseInt(sizeOutput.trim(), 10);
        if (size > 1_048_576) {
          await tmuxExec(machine, `tail -c 1048576 ${shellEscape(session.logPath)} > ${shellEscape(session.logPath)}.tmp && mv ${shellEscape(session.logPath)}.tmp ${shellEscape(session.logPath)}`, signal, 10_000, logConn);
          console.log(`[tmux-runner] Truncated log to 1MB (was ${(size / 1_048_576).toFixed(1)}MB)`);
        }
      } finally {
        logConn.cleanup();
      }
    } else {
      const sizeOutput = await tmuxExec(machine, `stat -c%s ${shellEscape(session.logPath)} 2>/dev/null || echo 0`, signal, 5_000);
      const size = parseInt(sizeOutput.trim(), 10);
      if (size > 1_048_576) {
        await tmuxExec(machine, `tail -c 1048576 ${shellEscape(session.logPath)} > ${shellEscape(session.logPath)}.tmp && mv ${shellEscape(session.logPath)}.tmp ${shellEscape(session.logPath)}`, signal, 10_000);
        console.log(`[tmux-runner] Truncated log to 1MB (was ${(size / 1_048_576).toFixed(1)}MB)`);
      }
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
export async function abortTmuxJob(machine: MachineRecord, sessionId: string, suffix?: string): Promise<boolean> {
  const key = tmuxKey(sessionId, suffix);
  const session = tmuxSessions.get(key);
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
export async function killTmuxSession(machine: MachineRecord, sessionId: string, suffix?: string): Promise<void> {
  const key = tmuxKey(sessionId, suffix);
  const session = tmuxSessions.get(key);
  if (!session) return;

  console.log(`[tmux-runner] Killing session ${session.tmuxName}`);

  // Close any active tail connection
  if (session.tailConn) {
    session.tailConn.cleanup();
    session.tailConn = null;
  }

  if (isLocalMachine(machine)) {
    try { await tmuxExec(machine, `tmux kill-session -t ${shellEscape(session.tmuxName)} 2>/dev/null || true`); } catch { /* ignore */ }
    try { await tmuxExec(machine, `rm -f ${shellEscape(session.logPath)}`); } catch { /* ignore */ }
  } else {
    // Remote — reuse a single SSH connection for kill + cleanup
    const conn = await connectWithRetry(machine);
    try {
      try { await tmuxExec(machine, `tmux kill-session -t ${shellEscape(session.tmuxName)} 2>/dev/null || true`, undefined, 30_000, conn); } catch { /* ignore */ }
      try { await tmuxExec(machine, `rm -f ${shellEscape(session.logPath)}`, undefined, 30_000, conn); } catch { /* ignore */ }
    } finally {
      conn.cleanup();
    }
  }

  tmuxSessions.delete(key);
}

/**
 * Kill ALL tmux session variants (work + hub) for a banana session.
 * Called when a session is deleted.
 */
export async function killAllTmuxSessions(machine: MachineRecord, sessionId: string): Promise<void> {
  await killTmuxSession(machine, sessionId);
  await killTmuxSession(machine, sessionId, '-hub');
}

/** Check if a tmux session exists for the given banana sessionId. */
export function hasTmuxSession(sessionId: string, suffix?: string): boolean {
  return tmuxSessions.has(tmuxKey(sessionId, suffix));
}

/** Close all cached tmux SSH connections (for graceful shutdown). */
export function closeTmuxConnections(): void {
  for (const [key, session] of tmuxSessions) {
    try { session.tailConn?.cleanup(); } catch { /* ignore */ }
    session.tailConn = null;
  }
}
