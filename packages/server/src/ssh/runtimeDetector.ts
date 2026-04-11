import { Client } from 'ssh2';
import type { MachineRecord, RuntimeInfo, SystemInfo, NetworkInterface } from '../machines/machineStore.js';
import { buildConnectConfig } from './sshRunner.js';

export interface DetectionResult {
  runtimes: RuntimeInfo[];
  claudePath: string;
  systemInfo: SystemInfo;
}

const PATH_PREFIX = 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.nvm/current/bin:$PATH"';

const DETECT_COMMAND = [
  PATH_PREFIX,
  // Runtimes
  'echo "---node---"',
  '(command -v node 2>/dev/null && node --version 2>/dev/null || echo "not-found")',
  'echo "---bun---"',
  '(command -v bun 2>/dev/null && bun --version 2>/dev/null || echo "not-found")',
  'echo "---claude---"',
  '(command -v claude 2>/dev/null || echo "not-found")',
  // System info
  'echo "---os---"',
  '(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || echo "$(uname -s) $(uname -r)")',
  'echo "---kernel---"',
  'uname -sr',
  'echo "---cpu---"',
  '(grep "model name" /proc/cpuinfo 2>/dev/null | head -1 | sed "s/model name[[:space:]]*:[[:space:]]*//" || sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "unknown")',
  'echo "---cpu-cores---"',
  '(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo "0")',
  'echo "---memory---"',
  '(free -h 2>/dev/null | awk "/^Mem:/{print \\$2}" || echo "unknown")',
  'echo "---disk---"',
  'df -h / 2>/dev/null | awk -v OFS="|" "NR==2{print \\$2,\\$3,\\$4}"',
  'echo "---network---"',
  '(ip -o -4 addr show 2>/dev/null | awk -v OFS="|" "{print \\$2,\\$4}" || echo "unknown")',
  'echo "---crontab---"',
  '(crontab -l 2>/dev/null || echo "no-crontab")',
].join(' && ');

export { DETECT_COMMAND };

function parseSection(lines: string[]): { path: string; version: string } | null {
  if (lines.length === 0 || lines[0] === 'not-found') return null;
  const p = lines[0];
  const version = lines.length > 1 ? lines[1] : '';
  return { path: p, version };
}

export function parseDetectionOutput(raw: string): DetectionResult {
  const runtimes: RuntimeInfo[] = [];
  let claudePath = '';

  const sections: Record<string, string[]> = {};
  let current = '';

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    const marker = trimmed.match(/^---(\S+)---$/);
    if (marker) { current = marker[1]; sections[current] = []; continue; }
    if (current && trimmed) {
      sections[current].push(trimmed);
    }
  }

  const nodeInfo = parseSection(sections['node'] ?? []);
  if (nodeInfo) {
    runtimes.push({ runtime: 'node', version: nodeInfo.version, path: nodeInfo.path });
  }

  const bunInfo = parseSection(sections['bun'] ?? []);
  if (bunInfo) {
    runtimes.push({ runtime: 'bun', version: bunInfo.version, path: bunInfo.path });
  }

  const claudeLines = sections['claude'] ?? [];
  if (claudeLines.length > 0 && claudeLines[0] !== 'not-found') {
    claudePath = claudeLines[0];
  }

  // System info
  const systemInfo: SystemInfo = {};

  const osLines = sections['os'] ?? [];
  if (osLines.length > 0) systemInfo.os = osLines[0];

  const kernelLines = sections['kernel'] ?? [];
  if (kernelLines.length > 0) systemInfo.kernel = kernelLines[0];

  const cpuLines = sections['cpu'] ?? [];
  if (cpuLines.length > 0 && cpuLines[0] !== 'unknown') systemInfo.cpu = cpuLines[0];

  const coreLines = sections['cpu-cores'] ?? [];
  if (coreLines.length > 0) {
    const n = parseInt(coreLines[0], 10);
    if (n > 0) systemInfo.cpuCores = n;
  }

  const memLines = sections['memory'] ?? [];
  if (memLines.length > 0 && memLines[0] !== 'unknown') systemInfo.memoryTotal = memLines[0];

  const diskLines = sections['disk'] ?? [];
  if (diskLines.length > 0) {
    const parts = diskLines[0].split('|');
    if (parts.length >= 3) {
      systemInfo.diskTotal = parts[0];
      systemInfo.diskUsed = parts[1];
      systemInfo.diskAvail = parts[2];
    }
  }

  const netLines = sections['network'] ?? [];
  if (netLines.length > 0) {
    const interfaces: NetworkInterface[] = [];
    for (const nl of netLines) {
      const parts = nl.split('|');
      if (parts.length >= 2) {
        interfaces.push({ name: parts[0], ip: parts[1] });
      }
    }
    if (interfaces.length > 0) systemInfo.networkInterfaces = interfaces;
  }

  const crontabLines = sections['crontab'] ?? [];
  if (crontabLines.length > 0 && crontabLines[0] !== 'no-crontab') {
    const entries = crontabLines.filter(l => !l.startsWith('#'));
    if (entries.length > 0) systemInfo.crontab = entries;
  }

  return { runtimes, claudePath, systemInfo };
}

export function detectRuntimes(machine: MachineRecord): Promise<DetectionResult> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error('Runtime detection timed out after 15s'));
    }, 15_000);

    conn.on('ready', () => {
      conn.exec(DETECT_COMMAND, (err, stream) => {
        if (err) { clearTimeout(timeout); conn.end(); reject(err); return; }
        let output = '';
        stream.on('data', (data: Buffer) => { output += data.toString(); });
        stream.stderr.on('data', () => { /* ignore stderr */ });
        stream.on('close', () => {
          clearTimeout(timeout);
          conn.end();
          resolve(parseDetectionOutput(output));
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    conn.connect(buildConnectConfig(machine));
  });
}
