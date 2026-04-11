import { Client } from 'ssh2';
import fs from 'fs';
import type { MachineRecord } from '../machines/machineStore.js';
import { config } from '../config.js';

export interface SshRunResult {
  exitCode: number;
  durationMs: number;
  claudeSessionId?: string;
}

export type SshChunkCallback = (chunk: unknown) => void;

function parseLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** POSIX-safe single-quote escaping: wraps in single quotes, escapes internal quotes. */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

export function buildConnectConfig(machine: MachineRecord): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    host: machine.ip,
    port: machine.port,
    username: machine.username,
    readyTimeout: config.sshReadyTimeoutMs,
    keepaliveInterval: 10_000,
    keepaliveCountMax: config.sshKeepaliveCountMax,
  };
  if (machine.sshKeyPath) {
    cfg.privateKey = fs.readFileSync(machine.sshKeyPath);
    if (machine.passphrase) cfg.passphrase = machine.passphrase;
  } else if (machine.password) {
    cfg.password = machine.password;
  }
  return cfg;
}

/** Returns true if an SSH connect-phase error is worth retrying. We retry
 * transient network/handshake failures, but NOT auth failures or post-connect
 * problems (those should fail fast and surface to the user). */
export function isRetryableConnectError(err: Error): boolean {
  const msg = (err && err.message) || '';
  if (/authentication|All configured authentication methods failed|permission denied/i.test(msg)) {
    return false;
  }
  return /handshake|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|EPIPE|EAI_AGAIN|read ECONN|socket hang up/i.test(msg);
}

/** Open one SSH connection and resolve when 'ready' fires. */
function connectOnce(machine: MachineRecord): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const onReady = () => {
      if (settled) return;
      settled = true;
      conn.removeListener('error', onError);
      resolve(conn);
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      conn.removeListener('ready', onReady);
      try { conn.end(); } catch { /* noop */ }
      reject(err);
    };
    conn.once('ready', onReady);
    conn.once('error', onError);
    conn.connect(buildConnectConfig(machine));
  });
}

/** Connect with exponential backoff + jitter for transient handshake failures. */
export async function connectWithRetry(
  machine: MachineRecord,
  signal?: AbortSignal,
): Promise<Client> {
  const maxAttempts = Math.max(1, config.sshConnectRetries + 1);
  let lastErr: Error = new Error('SSH connect failed');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new Error('Aborted');
    if (attempt > 1) {
      const backoff = 500 * Math.pow(2, attempt - 2) + Math.floor(Math.random() * 500);
      console.warn(`[ssh-runner] connect retry ${attempt}/${maxAttempts} in ${backoff}ms — last error: ${lastErr.message}`);
      await new Promise<void>(r => setTimeout(r, backoff));
      if (signal?.aborted) throw new Error('Aborted');
    }
    try {
      return await connectOnce(machine);
    } catch (err) {
      lastErr = err as Error;
      if (!isRetryableConnectError(lastErr)) throw lastErr;
    }
  }
  throw lastErr;
}

/** Test SSH connectivity — runs `echo ok && hostname` and returns the output. */
export async function testSshConnection(machine: MachineRecord): Promise<string> {
  const conn = await connectWithRetry(machine);
  return new Promise((resolve, reject) => {
    // 120s — sshd may be congested if the machine is busy with parallel jobs
    // (e.g. claude auto-compacting a conversation, which can take 60-90s).
    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error('SSH command timed out after 120s'));
    }, 120_000);

    conn.exec('echo ok && hostname', (err, stream) => {
      if (err) { clearTimeout(timeout); conn.end(); reject(err); return; }
      let output = '';
      stream.on('data', (data: Buffer) => { output += data.toString(); });
      stream.stderr.on('data', (data: Buffer) => { output += data.toString(); });
      stream.on('close', () => {
        clearTimeout(timeout);
        conn.end();
        resolve(output.trim());
      });
    });
  });
}

/** Determine the claude CLI invocation for a machine based on detected runtimes. */
function getClaudeBin(machine: MachineRecord): string {
  const hasBun = machine.runtimes?.some(r => r.runtime === 'bun');
  if (hasBun) return 'bunx --bun claude';
  const hasNode = machine.runtimes?.some(r => r.runtime === 'node');
  if (hasNode && machine.claudePath) return machine.claudePath;
  if (hasNode) return 'npx -y claude';
  return 'claude';
}

/** Run Claude CLI over SSH, streaming output chunks. Supports abort via AbortSignal. */
export async function runClaudeOverSsh(
  machine: MachineRecord,
  prompt: string,
  workdir: string,
  onChunk: SshChunkCallback,
  resumeId?: string,
  signal?: AbortSignal,
  model?: string,
): Promise<SshRunResult> {
  if (signal?.aborted) throw new Error('Aborted');

  const startedAt = Date.now();
  const claudeBin = getClaudeBin(machine);

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
  ];

  if (model) {
    args.push('--model', shellEscape(model));
  }

  if (resumeId) {
    args.push('--resume', shellEscape(resumeId));
  }

  args.push(shellEscape(prompt));

  const pathPrefix = 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.nvm/current/bin:$PATH"';
  const cmdParts = [pathPrefix];
  if (workdir) cmdParts.push(`cd ${shellEscape(workdir)}`);
  cmdParts.push(`${claudeBin} ${args.join(' ')}`);
  const command = cmdParts.join(' && ');

  console.log(`[ssh-runner] Connecting to ${machine.username}@${machine.ip}:${machine.port}`);
  console.log(`[ssh-runner] Command: ${command}`);

  const conn = await connectWithRetry(machine, signal);

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    conn.on('error', (err) => {
      settle(() => { try { conn.end(); } catch { /* noop */ } reject(err); });
    });

    conn.exec(command, { pty: true }, (err, stream) => {
      if (err) { settle(() => { conn.end(); reject(err); }); return; }

      let buffer = '';
      let claudeSessionId: string | undefined;

      stream.on('data', (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const parsed = parseLine(line);
          if (parsed !== null) {
            const p = parsed as Record<string, unknown>;
            if (typeof p.session_id === 'string') {
              claudeSessionId = p.session_id;
            }
            onChunk(parsed);
          }
        }
      });

      stream.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        console.error(`[ssh-runner] stderr: ${text.trim()}`);
        onChunk({ type: 'stderr', text });
      });

      stream.on('close', (code: number | null) => {
        // Flush remaining buffer
        if (buffer.trim()) {
          const parsed = parseLine(buffer);
          if (parsed !== null) {
            const p = parsed as Record<string, unknown>;
            if (typeof p.session_id === 'string') claudeSessionId = p.session_id;
            onChunk(parsed);
          }
        }
        const durationMs = Date.now() - startedAt;
        console.log(`[ssh-runner] Exited with code ${code} after ${durationMs}ms${claudeSessionId ? ` session=${claudeSessionId}` : ''}`);
        settle(() => { conn.end(); resolve({ exitCode: code ?? 0, durationMs, claudeSessionId }); });
      });

      // Abort support — send SIGTERM equivalent via signal() on the SSH channel
      const onAbort = () => {
        console.log('[ssh-runner] Aborting SSH execution');
        stream.signal('TERM');
        setTimeout(() => stream.close(), 3000);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      stream.on('close', () => signal?.removeEventListener('abort', onAbort));
    });
  });
}
