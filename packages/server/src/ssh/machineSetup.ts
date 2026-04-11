import { Client } from 'ssh2';
import type { MachineRecord } from '../machines/machineStore.js';
import { buildConnectConfig } from './sshRunner.js';
import { parseDetectionOutput, DETECT_COMMAND, type DetectionResult } from './runtimeDetector.js';

export interface SetupStep {
  phase: 'bun' | 'claude' | 'detect';
  status: 'running' | 'done' | 'skipped' | 'error';
  message: string;
}

export type SetupStepCallback = (step: SetupStep) => void;

const PATH_PREFIX = 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.nvm/current/bin:$PATH"';

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

export function setupMachine(
  machine: MachineRecord,
  onStep: SetupStepCallback,
): Promise<DetectionResult> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error('Setup timed out after 120s'));
    }, 120_000);

    conn.on('ready', async () => {
      try {
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
            clearTimeout(timeout);
            conn.end();
            reject(new Error(errMsg));
            return;
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
            clearTimeout(timeout);
            conn.end();
            reject(new Error(errMsg));
            return;
          }
          onStep({ phase: 'claude', status: 'done', message: `claude installed (${claudeInstall.stdout.trim()})` });
        }

        // 3. Run runtime detection (reuse shared DETECT_COMMAND for runtimes + system info)
        onStep({ phase: 'detect', status: 'running', message: 'Detecting runtimes and system info...' });
        const detectResult = await execCommand(conn, DETECT_COMMAND);
        const detection = parseDetectionOutput(detectResult.stdout);
        onStep({ phase: 'detect', status: 'done', message: `Found ${detection.runtimes.length} runtime(s)` });

        clearTimeout(timeout);
        conn.end();
        resolve(detection);
      } catch (err) {
        clearTimeout(timeout);
        conn.end();
        reject(err);
      }
    });

    conn.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    conn.connect(buildConnectConfig(machine));
  });
}
