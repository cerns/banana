import { Client } from 'ssh2';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, exec as execCb } from 'child_process';
import type { MachineRecord } from '../machines/machineStore.js';
import { config } from '../config.js';
import { jumpHostStore, type JumpHost } from './jumpHostStore.js';

/** Manual exec wrapper — avoids util.promisify's custom symbol requirement for exec. */
export function execLocal(cmd: string, opts?: { timeout?: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execCb(cmd, opts ?? {}, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout as string, stderr: stderr as string });
    });
  });
}

/** Get shell + args for local execution. Uses interactive mode to load user PATH/env. */
export function getLocalShell(machine: MachineRecord): [string, string[]] {
  if (machine.localShell) {
    return [machine.localShell, ['-ic']];
  }
  // Auto-detect: zsh on macOS (default shell), bash elsewhere
  if (os.platform() === 'darwin') {
    return ['/bin/zsh', ['-ic']];
  }
  return ['/bin/bash', ['-ic']];
}

/** Returns true if the machine should execute locally (empty/localhost/127.0.0.1). */
export function isLocalMachine(machine: MachineRecord): boolean {
  if (!machine.ip) return true;
  const ip = machine.ip.trim().toLowerCase();
  return ip === '' || ip === 'localhost' || ip === '127.0.0.1';
}

/** Default .claude/settings.json for enterprise plans that block --dangerously-skip-permissions.
 *  Uses tool names without globs — allows ALL uses of each tool.
 *  Combined with --permission-mode dontAsk, this auto-approves listed tools
 *  and auto-denies everything else (no prompts, no hanging). */
const DEFAULT_PERMISSION_SETTINGS = {
  permissions: {
    allow: [
      'Bash',
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
      'NotebookEdit',
    ],
  },
};

/** Whether machine needs permission settings provisioned (skipPermissions is false). */
function needsPermissionSettings(machine: MachineRecord): boolean {
  return machine.skipPermissions === false;
}

/** Get the permission settings to write — machine override or defaults. */
function getPermissionSettings(machine: MachineRecord): Record<string, unknown> {
  return machine.permissionSettings ?? DEFAULT_PERMISSION_SETTINGS;
}

/** Write settings JSON to a path, creating directories as needed. */
async function writeSettingsFile(settingsPath: string, content: string): Promise<void> {
  const dir = path.dirname(settingsPath);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(settingsPath, content, { mode: 0o644 });
}

/** Provision .claude/settings.json locally before running claude.
 *  Writes to both project-level (workdir/.claude/) and user-level (~/.claude/)
 *  to maximize compatibility with enterprise managed settings. */
async function provisionLocalSettings(workdir: string, machine: MachineRecord): Promise<void> {
  const content = JSON.stringify(getPermissionSettings(machine), null, 2);

  // Project-level: workdir/.claude/settings.json
  const projectSettings = path.join(workdir, '.claude', 'settings.json');
  await writeSettingsFile(projectSettings, content);

  // User-level: ~/.claude/settings.json (fallback if project-level is overridden)
  const home = process.env.HOME || process.env.USERPROFILE || '/root';
  const userSettings = path.join(home, '.claude', 'settings.json');
  await writeSettingsFile(userSettings, content);

  console.log(`[ssh-runner] Provisioned permission settings (project + user level) for enterprise mode`);
}

/** Provision .claude/settings.json on remote via SSH + SFTP.
 *  Writes to both project-level and user-level (~/.claude/). */
async function provisionRemoteSettings(conn: Client, workdir: string, machine: MachineRecord): Promise<void> {
  const content = JSON.stringify(getPermissionSettings(machine), null, 2);
  const projectDir = `${workdir}/.claude`;
  const userDir = '$HOME/.claude';

  // mkdir -p for both locations
  await new Promise<void>((resolve, reject) => {
    conn.exec(`mkdir -p ${shellEscape(projectDir)} && mkdir -p ${userDir}`, (err, stream) => {
      if (err) { reject(err); return; }
      stream.on('close', () => resolve());
      stream.on('error', (e: Error) => reject(e));
      stream.resume();
    });
  });

  // Write project-level settings via SFTP
  await new Promise<void>((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) { reject(err); return; }
      const ws = sftp.createWriteStream(`${projectDir}/settings.json`, { mode: 0o644 });
      ws.on('error', (e: Error) => { sftp.end(); reject(e); });
      ws.end(Buffer.from(content, 'utf8'), () => { sftp.end(); resolve(); });
    });
  });

  // Write user-level settings via exec (SFTP can't expand $HOME)
  await new Promise<void>((resolve, reject) => {
    const escaped = content.replace(/'/g, "'\"'\"'");
    conn.exec(`cat > ${userDir}/settings.json << 'BANANA_EOF'\n${content}\nBANANA_EOF`, (err, stream) => {
      if (err) { reject(err); return; }
      stream.on('close', () => resolve());
      stream.on('error', (e: Error) => reject(e));
      stream.resume();
    });
  });

  console.log(`[ssh-runner] Provisioned permission settings (project + user level) for enterprise mode`);
}

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

/** Close the global jump host tunnel cache (for graceful shutdown). */
export function closeJumpTunnelCache(): void {
  jumpTunnelCache.close();
}

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
  // Check if jump hosts are enabled — skip for local machines (no IP to forward to)
  const jhCfg = jumpHostStore.getConfig();
  const useJumpHosts = jhCfg.enabled && jhCfg.hosts.length > 0 && !isLocalMachine(machine);

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

/** Test SSH connectivity — runs `echo ok && hostname` and returns the output.
 *  For local machines (empty IP), runs the command locally via child_process. */
export async function testSshConnection(machine: MachineRecord): Promise<string> {
  if (isLocalMachine(machine)) {
    const { stdout } = await execLocal('echo ok && hostname', { timeout: 120_000 });
    return stdout.trim();
  }

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

  if (isLocalMachine(machine)) {
    try {
      const { stdout, stderr } = await execLocal(cmd, { timeout: 15_000 });
      const tokens = parseInt(stdout.trim(), 10);
      if (Number.isFinite(tokens) && tokens > 0) return tokens;
      console.warn(`[ssh-runner] getRemoteContextTokens (local): no result (output=${JSON.stringify(stdout.trim())}, stderr=${JSON.stringify(stderr.trim())}, session=${claudeSessionId.slice(0, 8)})`);
      return undefined;
    } catch (err) {
      console.warn(`[ssh-runner] getRemoteContextTokens (local) error: ${(err as Error).message}`);
      return undefined;
    }
  }

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

/** Run Claude CLI locally via child_process.spawn. Same streaming/parsing as SSH. */
async function runClaudeLocally(
  machine: MachineRecord,
  prompt: string,
  workdir: string,
  onChunk: SshChunkCallback,
  resumeId?: string,
  signal?: AbortSignal,
  model?: string,
): Promise<SshRunResult> {
  const startedAt = Date.now();
  const claudeBin = getClaudeBin(machine);

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  if (machine.skipPermissions === false) {
    // Enterprise mode: use dontAsk + settings.json allow rules (no prompts)
    args.push('--permission-mode', 'dontAsk');
  } else {
    args.push('--dangerously-skip-permissions');
  }
  if (model) args.push('--model', model);
  if (resumeId) args.push('--resume', resumeId);

  // Provision .claude/settings.json for enterprise plans
  if (needsPermissionSettings(machine) && workdir) {
    await provisionLocalSettings(workdir, machine);
  }

  // Write prompt to a local temp file
  const tmpFile = `/tmp/banana-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.promises.writeFile(tmpFile, prompt, { mode: 0o600 });

  // Build shell command: cd + claude + stdin redirect + cleanup
  const cmdParts: string[] = [];
  if (workdir) cmdParts.push(`cd ${shellEscape(workdir)}`);
  cmdParts.push(`${claudeBin} ${args.join(' ')} < ${shellEscape(tmpFile)}`);
  const command = cmdParts.join(' && ') + `; rm -f ${shellEscape(tmpFile)}`;

  console.log(`[ssh-runner] Running locally: ${claudeBin}${model ? ` --model ${model}` : ''}${resumeId ? ' --resume' : ''} (prompt ${prompt.length} chars)`);

  const [shell, shellArgs] = getLocalShell(machine);
  console.log(`[ssh-runner] Shell: ${shell} ${shellArgs.join(' ')}`);

  return new Promise((resolve, reject) => {
    const child = spawn(shell, [...shellArgs, command], {
      cwd: workdir || undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    let claudeSessionId: string | undefined;
    let inputTokens: number | undefined;
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    // Idle timeout
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const idleMs = config.sshIdleTimeoutMs;
    const resetIdleTimer = () => {
      if (idleMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.warn(`[ssh-runner] Idle timeout (${idleMs}ms no output) — killing local process`);
        onChunk({ type: 'stderr', text: `[banana] idle timeout: no output for ${Math.round(idleMs / 1000)}s — terminating\n` });
        child.kill('SIGTERM');
      }, idleMs);
    };
    resetIdleTimer();

    child.stdout.on('data', (data: Buffer) => {
      resetIdleTimer();
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const parsed = parseLine(line);
        if (parsed !== null) {
          const p = parsed as Record<string, unknown>;
          if (typeof p.session_id === 'string') claudeSessionId = p.session_id;
          if (typeof p.input_tokens === 'number') inputTokens = p.input_tokens;
          if (p.type === 'stream_event') {
            const evt = p.event as Record<string, unknown> | undefined;
            if (evt?.type === 'message_start') {
              const msg = evt.message as Record<string, unknown> | undefined;
              const usage = msg?.usage as Record<string, unknown> | undefined;
              if (typeof usage?.input_tokens === 'number') inputTokens = usage.input_tokens as number;
            }
          }
          onChunk(parsed);
        }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      resetIdleTimer();
      const text = data.toString();
      console.error(`[ssh-runner] stderr (local): ${text.trim()}`);
      onChunk({ type: 'stderr', text });
    });

    child.on('error', (err) => {
      if (idleTimer) clearTimeout(idleTimer);
      settle(() => reject(err));
    });

    child.on('close', (code) => {
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
      console.log(`[ssh-runner] Local process exited with code ${code} after ${durationMs}ms${claudeSessionId ? ` session=${claudeSessionId}` : ''}${inputTokens ? ` tokens=${inputTokens}` : ''}`);
      settle(() => resolve({ exitCode: code ?? 0, durationMs, claudeSessionId, inputTokens }));
    });

    // Abort support
    const onAbort = () => {
      if (idleTimer) clearTimeout(idleTimer);
      console.log('[ssh-runner] Aborting local execution');
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', () => signal?.removeEventListener('abort', onAbort));
  });
}

/** Extended options for runClaudeOverSsh. */
export interface SshRunOptions {
  resumeId?: string;
  signal?: AbortSignal;
  model?: string;
  /** When true, adds --bare (skips CLAUDE.md, hooks, skills, MCP). For hub chat. */
  bare?: boolean;
  /** System prompt written to a temp file and passed via --append-system-prompt-file. */
  systemPrompt?: string;
  /** Max agentic turns (--max-turns). */
  maxTurns?: number;
}

/** Run Claude CLI over SSH, streaming output chunks. Supports abort via AbortSignal.
 *  For local machines (empty IP), spawns claude locally via child_process. */
export async function runClaudeOverSsh(
  machine: MachineRecord,
  prompt: string,
  workdir: string,
  onChunk: SshChunkCallback,
  resumeId?: string,
  signal?: AbortSignal,
  model?: string,
  opts?: SshRunOptions,
): Promise<SshRunResult> {
  // Merge legacy positional args with opts
  const _resumeId = opts?.resumeId ?? resumeId;
  const _signal = opts?.signal ?? signal;
  const _model = opts?.model ?? model;
  const _bare = opts?.bare ?? false;
  const _systemPrompt = opts?.systemPrompt;
  const _maxTurns = opts?.maxTurns;

  if (_signal?.aborted) throw new Error('Aborted');

  if (isLocalMachine(machine)) {
    return runClaudeLocally(machine, prompt, workdir, onChunk, _resumeId, _signal, _model);
  }

  const startedAt = Date.now();
  const claudeBin = getClaudeBin(machine);

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  if (_bare) {
    args.push('--bare');
  }
  if (machine.skipPermissions === false) {
    // Enterprise mode: use dontAsk + settings.json allow rules (no prompts)
    args.push('--permission-mode', 'dontAsk');
  } else {
    args.push('--dangerously-skip-permissions');
  }

  if (_model) {
    args.push('--model', shellEscape(_model));
  }

  if (_resumeId) {
    args.push('--resume', shellEscape(_resumeId));
  }

  if (_maxTurns !== undefined) {
    args.push('--max-turns', String(_maxTurns));
  }

  // Prompt is written to a temp file on the remote via SFTP, then piped
  // into claude via stdin redirection. This completely sidesteps shell
  // escaping — single quotes, double quotes, backticks, dollar signs,
  // newlines, and any other special characters are transferred as raw
  // bytes over SFTP with zero shell interpretation.
  const tmpFile = `/tmp/banana-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  console.log(`[ssh-runner] Connecting to ${machine.username}@${machine.ip}:${machine.port}`);
  console.log(`[ssh-runner] Command: ${claudeBin}${_model ? ` --model ${_model}` : ''}${_resumeId ? ' --resume' : ''}${_bare ? ' --bare' : ''} (prompt ${prompt.length} chars via SFTP temp file)`);

  const { client: conn, cleanup } = await connectWithRetry(machine, _signal);

  // Provision .claude/settings.json for enterprise plans
  if (needsPermissionSettings(machine) && workdir) {
    await provisionRemoteSettings(conn, workdir, machine);
  }

  // Write prompt to remote temp file via SFTP (binary-safe, no shell involved)
  await new Promise<void>((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) { reject(err); return; }
      const ws = sftp.createWriteStream(tmpFile, { mode: 0o600 });
      ws.on('error', (e: Error) => { sftp.end(); reject(e); });
      ws.end(Buffer.from(prompt, 'utf8'), () => { sftp.end(); resolve(); });
    });
  });

  // B1: Write system prompt to a temp file and pass via --append-system-prompt
  let sysPromptFile: string | undefined;
  if (_systemPrompt) {
    sysPromptFile = `/tmp/banana-sysprompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await new Promise<void>((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) { reject(err); return; }
        const ws = sftp.createWriteStream(sysPromptFile!, { mode: 0o600 });
        ws.on('error', (e: Error) => { sftp.end(); reject(e); });
        ws.end(Buffer.from(_systemPrompt!, 'utf8'), () => { sftp.end(); resolve(); });
      });
    });
    args.push('--append-system-prompt', shellEscape(sysPromptFile));
  }

  // Build command AFTER SFTP writes (args may have been modified by system prompt)
  // `trap '' HUP` makes the shell (and child processes) ignore SIGHUP.
  // This is critical because PTY mode sends SIGHUP on SSH disconnections,
  // which would otherwise kill claude mid-tool-call during transient
  // network blips. SIGTERM (used by abort) still works normally.
  const pathPrefix = "trap '' HUP; export PATH=\"$HOME/.bun/bin:$HOME/.local/bin:$HOME/.nvm/current/bin:$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH\"";
  const cmdParts = [pathPrefix];
  if (workdir) cmdParts.push(`cd ${shellEscape(workdir)}`);
  cmdParts.push(`${claudeBin} ${args.join(' ')} < ${shellEscape(tmpFile)}`);
  // Clean up temp files (best-effort, runs even if claude exits with error)
  const cleanupFiles = [tmpFile, ...(sysPromptFile ? [sysPromptFile] : [])].map(f => shellEscape(f)).join(' ');
  const command = cmdParts.join(' && ') + `; rm -f ${cleanupFiles}`;

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
