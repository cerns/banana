import { Client } from 'ssh2';
import { exec as execCb } from 'child_process';
import type { MachineRecord } from '../machines/machineStore.js';
import { connectWithRetry, isLocalMachine } from './sshRunner.js';
import { parseDetectionOutput, DETECT_COMMAND, type DetectionResult } from './runtimeDetector.js';

function execLocal(cmd: string, opts?: { timeout?: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execCb(cmd, opts ?? {}, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout as string, stderr: stderr as string });
    });
  });
}

export interface SetupStep {
  phase: 'bun' | 'claude' | 'detect';
  status: 'running' | 'done' | 'skipped' | 'error';
  message: string;
}

export type SetupStepCallback = (step: SetupStep) => void;

const PATH_PREFIX = 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.nvm/current/bin:$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH"';

function execCommand(conn: Client, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) { reject(err); return; }
      let stdout = '';
      let stderr = '';
      stream.on('data', (data: Buffer) => { stdout += data.toString(); });
      stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      stream.on('close', (code: number | null) => {
        resolve({ stdout, stderr, code: code ?? 0 });
      });
    });
  });
}

export async function setupMachine(
  machine: MachineRecord,
  onStep: SetupStepCallback,
): Promise<DetectionResult> {
  if (isLocalMachine(machine)) {
    onStep({ phase: 'bun', status: 'skipped', message: 'Local machine — skipping SSH setup' });
    onStep({ phase: 'claude', status: 'skipped', message: 'Local machine — skipping SSH setup' });
    onStep({ phase: 'detect', status: 'running', message: 'Detecting local runtimes and system info...' });
    const { stdout } = await execLocal(DETECT_COMMAND, { timeout: 15_000 });
    const detection = parseDetectionOutput(stdout);
    onStep({ phase: 'detect', status: 'done', message: `Found ${detection.runtimes.length} runtime(s)` });
    return detection;
  }

  const { client: conn, cleanup } = await connectWithRetry(machine);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    cleanup();
  }, 120_000);

  try {
    if (timedOut) throw new Error('Setup timed out after 120s');
    // 1. Check if bun exists
    onStep({ phase: 'bun', status: 'running', message: 'Checking for bun...' });
    const bunCheck = await execCommand(conn, '$HOME/.bun/bin/bun --version 2>/dev/null || bun --version 2>/dev/null');

    if (bunCheck.code === 0 && bunCheck.stdout.trim()) {
      onStep({ phase: 'bun', status: 'skipped', message: `bun already installed (${bunCheck.stdout.trim()})` });
    } else {
      onStep({ phase: 'bun', status: 'running', message: 'Installing bun...' });
      const bunInstall = await execCommand(conn, 'curl -fsSL https://bun.sh/install | bash');
      if (bunInstall.code !== 0) {
        const errMsg = `bun install failed (exit ${bunInstall.code}): ${bunInstall.stderr.trim()}`;
        onStep({ phase: 'bun', status: 'error', message: errMsg });
        throw new Error(errMsg);
      }
      // Verify installation
      const bunVerify = await execCommand(conn, '$HOME/.bun/bin/bun --version');
      onStep({ phase: 'bun', status: 'done', message: `bun installed (${bunVerify.stdout.trim()})` });
    }

    // 2. Check if claude exists
    onStep({ phase: 'claude', status: 'running', message: 'Checking for claude...' });
    const claudeCheck = await execCommand(conn, `${PATH_PREFIX} && command -v claude 2>/dev/null`);

    if (claudeCheck.code === 0 && claudeCheck.stdout.trim()) {
      onStep({ phase: 'claude', status: 'skipped', message: `claude already installed (${claudeCheck.stdout.trim()})` });
    } else {
      onStep({ phase: 'claude', status: 'running', message: 'Installing claude code (this may take a minute)...' });
      const claudeInstall = await execCommand(conn, '$HOME/.bun/bin/bunx --bun @anthropic-ai/claude-code@latest --version');
      if (claudeInstall.code !== 0) {
        const errMsg = `claude install failed (exit ${claudeInstall.code}): ${claudeInstall.stderr.trim()}`;
        onStep({ phase: 'claude', status: 'error', message: errMsg });
        throw new Error(errMsg);
      }
      onStep({ phase: 'claude', status: 'done', message: `claude installed (${claudeInstall.stdout.trim()})` });
    }

    // 3. Run runtime detection (reuse shared DETECT_COMMAND for runtimes + system info)
    onStep({ phase: 'detect', status: 'running', message: 'Detecting runtimes and system info...' });
    const detectResult = await execCommand(conn, DETECT_COMMAND);
    const detection = parseDetectionOutput(detectResult.stdout);
    onStep({ phase: 'detect', status: 'done', message: `Found ${detection.runtimes.length} runtime(s)` });

    clearTimeout(timeout);
    cleanup();
    return detection;
  } catch (err) {
    clearTimeout(timeout);
    cleanup();
    throw err;
  }
}
