import { Client } from 'ssh2';
import fs from 'fs';
import type { MachineRecord } from '../machines/machineStore.js';
import { config } from '../config.js';
import { jumpHostStore, type JumpHost } from './jumpHostStore.js';

export interface SshRunResult {
  exitCode: number;
  durationMs: number;
  claudeSessionId?: string;
  /** Total input tokens reported by the Claude API for this run. Extracted
   *  from stream-json events (message_start or result). Used for auto-compact
   *  threshold checking — when this exceeds `compactTokenThreshold`, the next
   *  prompt will run /compact first. */
  inputTokens?: number;
}

export type SshChunkCallback = (chunk: unknown) => void;

/** A connection that may tunnel through jump hosts. Call cleanup() instead of client.end(). */
export interface TunneledConnection {
  client: Client;
  cleanup: () => void;
}

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

/** Build ssh2 connect config for a JumpHost. */
function buildJumpHostConfig(hop: JumpHost): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    host: hop.host,
    port: hop.port,
    username: hop.username,
    readyTimeout: config.sshReadyTimeoutMs,
    keepaliveInterval: 10_000,
    keepaliveCountMax: config.sshKeepaliveCountMax,
  };
  if (hop.sshKeyPath) {
    cfg.privateKey = fs.readFileSync(hop.sshKeyPath);
    if (hop.passphrase) cfg.passphrase = hop.passphrase;
  } else if (hop.password) {
    cfg.password = hop.password;
  }
  return cfg;
}

/** Promise wrapper: connect a Client with given config, resolve on 'ready'. */
function connectClientAsync(clientCfg: Record<string, unknown>): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const onReady = () => { if (settled) return; settled = true; conn.removeListener('error', onError); resolve(conn); };
    const onError = (err: Error) => { if (settled) return; settled = true; conn.removeListener('ready', onReady); try { conn.end(); } catch { /* noop */ } reject(err); };
    conn.once('ready', onReady);
    conn.once('error', onError);
    conn.connect(clientCfg);
  });
}

/** Promise wrapper for ssh2 forwardOut. Returns a duplex stream. */
function forwardOutAsync(client: Client, dstHost: string, dstPort: number): Promise<any> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, dstHost, dstPort, (err, stream) => {
      if (err) reject(err);
      else resolve(stream);
    });
  });
}

/** Persistent jump-host tunnel cache.
 *  Maintains a single connection chain to the jump hosts. Target connections
 *  are multiplexed via forwardOut channels — only 1 SSH handshake with the
 *  jump host regardless of how many targets connect in parallel.
 *  If the tunnel dies, close/error events invalidate the cache and the next
 *  getLastHop() call rebuilds it automatically. */
class JumpTunnelCache {
  private chain: Client[] = [];
  private configHash = '';
  private connecting: Promise<Client> | null = null;

  async getLastHop(jumpHosts: JumpHost[]): Promise<Client> {
    const hash = jumpHosts.map(h => `${h.username}@${h.host}:${h.port}`).join(',');

    if (hash === this.configHash && this.chain.length > 0) {
      return this.chain[this.chain.length - 1];
    }

    if (!this.connecting) {
      this.connecting = this.buildChain(jumpHosts, hash).finally(() => {
        this.connecting = null;
      });
    }

    return this.connecting;
  }

  private async buildChain(jumpHosts: JumpHost[], hash: string): Promise<Client> {
    this.close();

    const firstCfg = buildJumpHostConfig(jumpHosts[0]);
    const firstClient = await connectClientAsync(firstCfg);
    this.chain.push(firstClient);
    firstClient.on('close', () => this.invalidate());
    firstClient.on('error', () => this.invalidate());

    let current = firstClient;
    for (let i = 1; i < jumpHosts.length; i++) {
      const hop = jumpHosts[i];
      const sock = await forwardOutAsync(current, hop.host, hop.port);
      const next = await connectClientAsync({ ...buildJumpHostConfig(hop), sock });
      this.chain.push(next);
      next.on('close', () => this.invalidate());
      next.on('error', () => this.invalidate());
      current = next;
    }

    this.configHash = hash;
    console.log(`[ssh-runner] Jump host tunnel established: ${jumpHosts.map(h => `${h.username}@${h.host}:${h.port}`).join(' → ')}`);
    return current;
  }

  private invalidate() { this.configHash = ''; }

  close() {
    for (const c of [...this.chain].reverse()) { try { c.end(); } catch { /* noop */ } }
    this.chain = [];
    this.configHash = '';
  }
}

const jumpTunnelCache = new JumpTunnelCache();

/** Connect to the target machine through a persistent jump host tunnel.
 *  The tunnel is shared — target-side failures do NOT destroy it. */
export async function connectThroughJumpHosts(
  machine: MachineRecord,
  jumpHosts: JumpHost[],
  signal?: AbortSignal,
): Promise<TunneledConnection> {
  if (signal?.aborted) throw new Error('Aborted');

  let lastHop: Client;
  try {
    lastHop = await jumpTunnelCache.getLastHop(jumpHosts);
  } catch (err) {
    throw new Error(`Jump host connect failed: ${(err as Error).message}`);
  }
  if (signal?.aborted) throw new Error('Aborted');

  let targetSock: any;
  try {
    targetSock = await forwardOutAsync(lastHop, machine.ip, machine.port);
  } catch (err) {
    throw new Error(`Jump host forwardOut to ${machine.ip}:${machine.port} failed: ${(err as Error).message}`);
  }

  try {
    const targetCfg = { ...buildConnectConfig(machine), sock: targetSock };
    const targetClient = await connectClientAsync(targetCfg);
    return {
      client: targetClient,
      cleanup: () => { try { targetClient.end(); } catch { /* noop */ } },
    };
  } catch (err) {
    throw new Error(`Target SSH handshake via tunnel failed: ${(err as Error).message}`);
  }
}

/** Test the full jump host chain connectivity (without a target machine).
 *  Connects through each hop and runs `echo ok && hostname` on the last hop. */
export async function testJumpHostChain(jumpHosts: JumpHost[]): Promise<string> {
  if (jumpHosts.length === 0) return 'No jump hosts configured';

  const allClients: Client[] = [];
  const cleanup = () => { for (const c of allClients) { try { c.end(); } catch { /* noop */ } } };

  try {
    const firstCfg = buildJumpHostConfig(jumpHosts[0]);
    const firstClient = await connectClientAsync(firstCfg);
    allClients.push(firstClient);

    let currentClient = firstClient;
    for (let i = 1; i < jumpHosts.length; i++) {
      const nextHop = jumpHosts[i];
      const sock = await forwardOutAsync(currentClient, nextHop.host, nextHop.port);
      const nextCfg = { ...buildJumpHostConfig(nextHop), sock };
      const nextClient = await connectClientAsync(nextCfg);
      allClients.push(nextClient);
      currentClient = nextClient;
    }

    // Run test command on the last hop
    const output = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('Test timed out after 30s')); }, 30_000);
      currentClient.exec('echo ok && hostname', (err, stream) => {
        if (err) { clearTimeout(timeout); cleanup(); reject(err); return; }
        let out = '';
        stream.on('data', (d: Buffer) => { out += d.toString(); });
        stream.stderr.on('data', (d: Buffer) => { out += d.toString(); });
        stream.on('close', () => { clearTimeout(timeout); cleanup(); resolve(out.trim()); });
      });
    });
    return output;
  } catch (err) {
    cleanup();
    throw err;
  }
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

/** Connect with exponential backoff + jitter for transient handshake failures.
 *  Returns a TunneledConnection — call cleanup() instead of client.end(). */
export async function connectWithRetry(
  machine: MachineRecord,
  signal?: AbortSignal,
): Promise<TunneledConnection> {
  // Check if jump hosts are enabled
  const jhCfg = jumpHostStore.getConfig();
  const useJumpHosts = jhCfg.enabled && jhCfg.hosts.length > 0;

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
      if (useJumpHosts) {
        return await connectThroughJumpHosts(machine, jhCfg.hosts, signal);
      }
      const client = await connectOnce(machine);
      return { client, cleanup: () => { try { client.end(); } catch { /* noop */ } } };
    } catch (err) {
      lastErr = err as Error;
      if (!isRetryableConnectError(lastErr)) throw lastErr;
    }
  }
  throw lastErr;
}

/** Test SSH connectivity — runs `echo ok && hostname` and returns the output. */
export async function testSshConnection(machine: MachineRecord): Promise<string> {
  const { client: conn, cleanup } = await connectWithRetry(machine);
  return new Promise((resolve, reject) => {
    // 120s — sshd may be congested if the machine is busy with parallel jobs
    // (e.g. claude auto-compacting a conversation, which can take 60-90s).
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('SSH command timed out after 120s'));
    }, 120_000);

    conn.exec('echo ok && hostname', (err, stream) => {
      if (err) { clearTimeout(timeout); cleanup(); reject(err); return; }
      let output = '';
      stream.on('data', (data: Buffer) => { output += data.toString(); });
      stream.stderr.on('data', (data: Buffer) => { output += data.toString(); });
      stream.on('close', () => {
        clearTimeout(timeout);
        cleanup();
        resolve(output.trim());
      });
    });
  });
}

/**
 * Read the context window size (input tokens) from the Claude session JSONL
 * on the remote machine. Finds the file by session ID under ~/.claude/projects/
 * using `find`, then sums `input_tokens` + `cache_creation_input_tokens` +
 * `cache_read_input_tokens` from the last usage line. This gives the true
 * context window size — `input_tokens` alone is near-zero when caching is active.
 *
 * Returns undefined if the file doesn't exist or the value can't be read.
 */
export async function getRemoteContextTokens(
  machine: MachineRecord,
  workdir: string,
  claudeSessionId: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  if (!claudeSessionId) return undefined;

  // Find the session JSONL by ID — avoids guessing Claude's directory encoding.
  const fileName = `${shellEscape(claudeSessionId + '.jsonl')}`;
  const cmd = `f=$(find ~/.claude/projects -name ${fileName} 2>/dev/null | head -1) && [ -n "$f" ] && grep '"cache_read_input_tokens"' "$f" | tail -1 | grep -oE '"(input_tokens|cache_creation_input_tokens|cache_read_input_tokens)":[0-9]+' | grep -o '[0-9]*' | awk '{s+=$1} END {print s}'`;

  try {
    const { client: conn, cleanup } = await connectWithRetry(machine, signal);
    return new Promise<number | undefined>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn(`[ssh-runner] getRemoteContextTokens timed out for ${claudeSessionId.slice(0, 8)}`);
        cleanup();
        resolve(undefined);
      }, 15_000);

      conn.exec(cmd, (err, stream) => {
        if (err) {
          console.warn(`[ssh-runner] getRemoteContextTokens exec error: ${err.message}`);
          clearTimeout(timeout); cleanup(); resolve(undefined); return;
        }
        let output = '';
        let stderr = '';
        stream.on('data', (data: Buffer) => { output += data.toString(); });
        stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
        stream.on('close', (code: number | null) => {
          clearTimeout(timeout);
          cleanup();
          const tokens = parseInt(output.trim(), 10);
          if (Number.isFinite(tokens) && tokens > 0) {
            resolve(tokens);
          } else {
            console.warn(`[ssh-runner] getRemoteContextTokens: no result (exit=${code}, output=${JSON.stringify(output.trim())}, stderr=${JSON.stringify(stderr.trim())}, session=${claudeSessionId.slice(0, 8)})`);
            resolve(undefined);
          }
        });
      });
    });
  } catch (err) {
    console.warn(`[ssh-runner] getRemoteContextTokens connect error: ${(err as Error).message}`);
    return undefined;
  }
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

  // Prompt is written to a temp file on the remote via SFTP, then piped
  // into claude via stdin redirection. This completely sidesteps shell
  // escaping — single quotes, double quotes, backticks, dollar signs,
  // newlines, and any other special characters are transferred as raw
  // bytes over SFTP with zero shell interpretation.
  const tmpFile = `/tmp/banana-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // `trap '' HUP` makes the shell (and child processes) ignore SIGHUP.
  // This is critical because PTY mode sends SIGHUP on SSH disconnections,
  // which would otherwise kill claude mid-tool-call during transient
  // network blips. SIGTERM (used by abort) still works normally.
  const pathPrefix = "trap '' HUP; export PATH=\"$HOME/.bun/bin:$HOME/.local/bin:$HOME/.nvm/current/bin:$PATH\"";
  const cmdParts = [pathPrefix];
  if (workdir) cmdParts.push(`cd ${shellEscape(workdir)}`);
  cmdParts.push(`${claudeBin} ${args.join(' ')} < ${shellEscape(tmpFile)}`);
  // Clean up temp file (best-effort, runs even if claude exits with error)
  const command = cmdParts.join(' && ') + `; rm -f ${shellEscape(tmpFile)}`;

  console.log(`[ssh-runner] Connecting to ${machine.username}@${machine.ip}:${machine.port}`);
  console.log(`[ssh-runner] Command: ${claudeBin}${model ? ` --model ${model}` : ''}${resumeId ? ' --resume' : ''} (prompt ${prompt.length} chars via SFTP temp file)`);

  const { client: conn, cleanup } = await connectWithRetry(machine, signal);

  // Write prompt to remote temp file via SFTP (binary-safe, no shell involved)
  await new Promise<void>((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) { reject(err); return; }
      const ws = sftp.createWriteStream(tmpFile, { mode: 0o600 });
      ws.on('error', (e: Error) => { sftp.end(); reject(e); });
      ws.end(Buffer.from(prompt, 'utf8'), () => { sftp.end(); resolve(); });
    });
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    conn.on('error', (err) => {
      settle(() => { cleanup(); reject(err); });
    });

    // PTY is needed for line-buffered streaming output (without PTY, stdout
    // is fully buffered and nothing streams back until the process exits).
    // SIGHUP from PTY disconnect is neutralized by `trap '' HUP` in the
    // command prefix, so claude survives transient network blips.
    // Since the prompt is delivered via a temp file (not stdin), PTY is
    // always safe — no stdin data to mangle via line discipline.
    conn.exec(command, { pty: true }, (err, stream) => {
      if (err) { settle(() => { cleanup(); reject(err); }); return; }

      let buffer = '';
      let claudeSessionId: string | undefined;
      let inputTokens: number | undefined;

      // ── Idle timeout: reset on every stdout/stderr data event ────────
      // If no output arrives for `sshIdleTimeoutMs`, we consider the
      // process stalled and send SIGTERM + close. Disabled when set to 0.
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idleMs = config.sshIdleTimeoutMs;

      // Handle stream-level errors (transient SSH channel failures during
      // execution). Without this, a channel error mid-tool-call would leave
      // the promise hanging or emit an uncaught error.
      stream.on('error', (streamErr: Error) => {
        console.error(`[ssh-runner] stream error: ${streamErr.message}`);
        if (idleTimer) clearTimeout(idleTimer);
        settle(() => { cleanup(); reject(streamErr); });
      });
      const resetIdleTimer = () => {
        if (idleMs <= 0) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          console.warn(`[ssh-runner] Idle timeout (${idleMs}ms no output) — killing process`);
          onChunk({ type: 'stderr', text: `[banana] idle timeout: no output for ${Math.round(idleMs / 1000)}s — terminating\n` });
          stream.signal('TERM');
          setTimeout(() => stream.close(), 3000);
        }, idleMs);
      };
      resetIdleTimer(); // start the clock

      stream.on('data', (data: Buffer) => {
        resetIdleTimer();
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
            // Extract input_tokens — top-level on result events
            if (typeof p.input_tokens === 'number') {
              inputTokens = p.input_tokens;
            }
            // Also check stream_event → message_start → message.usage.input_tokens
            if (p.type === 'stream_event') {
              const evt = p.event as Record<string, unknown> | undefined;
              if (evt?.type === 'message_start') {
                const msg = evt.message as Record<string, unknown> | undefined;
                const usage = msg?.usage as Record<string, unknown> | undefined;
                if (typeof usage?.input_tokens === 'number') {
                  inputTokens = usage.input_tokens as number;
                }
              }
            }
            onChunk(parsed);
          }
        }
      });

      stream.stderr.on('data', (data: Buffer) => {
        resetIdleTimer();
        const text = data.toString();
        console.error(`[ssh-runner] stderr: ${text.trim()}`);
        onChunk({ type: 'stderr', text });
      });

      stream.on('close', (code: number | null) => {
        if (idleTimer) clearTimeout(idleTimer);
        // Flush remaining buffer
        if (buffer.trim()) {
          const parsed = parseLine(buffer);
          if (parsed !== null) {
            const p = parsed as Record<string, unknown>;
            if (typeof p.session_id === 'string') claudeSessionId = p.session_id;
            if (typeof p.input_tokens === 'number') inputTokens = p.input_tokens;
            onChunk(parsed);
          }
        }
        const durationMs = Date.now() - startedAt;
        console.log(`[ssh-runner] Exited with code ${code} after ${durationMs}ms${claudeSessionId ? ` session=${claudeSessionId}` : ''}${inputTokens ? ` tokens=${inputTokens}` : ''}`);
        settle(() => { cleanup(); resolve({ exitCode: code ?? 0, durationMs, claudeSessionId, inputTokens }); });
      });

      // Abort support — send SIGTERM equivalent via signal() on the SSH channel
      const onAbort = () => {
        if (idleTimer) clearTimeout(idleTimer);
        console.log('[ssh-runner] Aborting SSH execution');
        stream.signal('TERM');
        setTimeout(() => stream.close(), 3000);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      stream.on('close', () => signal?.removeEventListener('abort', onAbort));
    });
  });
}
