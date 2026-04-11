import { apiFetch } from '../client.js';
import { createInterface } from 'readline';

interface RuntimeInfo {
  runtime: 'node' | 'bun';
  version: string;
  path: string;
}

interface NetworkInterface {
  name: string;
  ip: string;
}

interface SystemInfo {
  os?: string;
  kernel?: string;
  cpu?: string;
  cpuCores?: number;
  memoryTotal?: string;
  diskTotal?: string;
  diskUsed?: string;
  diskAvail?: string;
  networkInterfaces?: NetworkInterface[];
  crontab?: string[];
}

interface MachineRedacted {
  id: string;
  name: string;
  alias: string;
  ip: string;
  port: number;
  username: string;
  hasPassword: boolean;
  sshKeyPath?: string;
  hasPassphrase: boolean;
  defaultWorkdir?: string;
  os?: string;
  notes?: string;
  runtimes?: RuntimeInfo[];
  claudePath?: string;
  systemInfo?: SystemInfo;
  runtimeDetectedAt?: string;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function machinesListCommand(): Promise<void> {
  const machines = await apiFetch<MachineRedacted[]>('/api/machines');
  if (machines.length === 0) {
    console.log('No machines configured.');
    return;
  }

  const header = ['ID (prefix)', 'NAME', 'HOST', 'OS', 'CPU/MEM', 'RUNTIMES'].map(h => h.padEnd(18)).join('  ');
  console.log(header);
  console.log('\u2500'.repeat(header.length));

  for (const m of machines) {
    const si = m.systemInfo;
    const osStr = si?.os?.slice(0, 16) ?? '\u2014';
    const cpuMem = si ? `${si.cpuCores ?? '?'}c/${si.memoryTotal ?? '?'}` : '\u2014';
    const runtimes = (m.runtimes && m.runtimes.length > 0)
      ? m.runtimes.map(r => `${r.runtime}@${r.version}`).join(', ')
      : '\u2014';
    const row = [
      m.id.slice(0, 8).padEnd(18),
      m.name.slice(0, 16).padEnd(18),
      `${m.username}@${m.ip}:${m.port}`.slice(0, 28).padEnd(18),
      osStr.padEnd(18),
      cpuMem.padEnd(18),
      runtimes,
    ].join('  ');
    console.log(row);
  }
}

export async function machinesAddCommand(): Promise<void> {
  const name = await prompt('Machine name: ');
  const alias = await prompt(`Alias [${name}]: `) || name;
  const ip = await prompt('Host/IP: ');
  const portStr = await prompt('SSH port [22]: ');
  const port = parseInt(portStr) || 22;
  const username = await prompt('Username: ');
  const password = await prompt('Password (leave blank for key auth): ');
  const sshKeyPath = password ? '' : await prompt('SSH key path [~/.ssh/id_rsa]: ') || '~/.ssh/id_rsa';
  const passphrase = sshKeyPath ? await prompt('Key passphrase (optional): ') : '';
  const defaultWorkdir = await prompt('Default working dir (optional): ');

  if (!name || !ip || !username) {
    console.error('Name, Host, and Username are required.');
    process.exit(1);
  }

  const body: Record<string, unknown> = { name, alias, ip, port, username };
  if (password) body.password = password;
  if (sshKeyPath) body.sshKeyPath = sshKeyPath;
  if (passphrase) body.passphrase = passphrase;
  if (defaultWorkdir) body.defaultWorkdir = defaultWorkdir;

  const result = await apiFetch<MachineRedacted>('/api/machines', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  console.log(`Machine created: ${result.name} (${result.id.slice(0, 8)})`);
}

export async function machinesRemoveCommand(idPrefix: string): Promise<void> {
  if (!idPrefix) {
    console.error('Usage: banana machines rm <id-prefix>');
    process.exit(1);
  }

  // Find machine by prefix
  const machines = await apiFetch<MachineRedacted[]>('/api/machines');
  const match = machines.find(m => m.id.startsWith(idPrefix));
  if (!match) {
    console.error(`No machine found matching prefix: ${idPrefix}`);
    process.exit(1);
  }

  await apiFetch(`/api/machines/${match.id}`, { method: 'DELETE' });
  console.log(`Removed machine: ${match.name} (${match.id.slice(0, 8)})`);
}

export async function machinesDetectCommand(idPrefix: string): Promise<void> {
  if (!idPrefix) {
    console.error('Usage: banana machines detect <id-prefix>');
    process.exit(1);
  }

  const machines = await apiFetch<MachineRedacted[]>('/api/machines');
  const match = machines.find(m => m.id.startsWith(idPrefix));
  if (!match) {
    console.error(`No machine found matching prefix: ${idPrefix}`);
    process.exit(1);
  }

  console.log(`Detecting runtimes on ${match.name} (${match.username}@${match.ip}:${match.port})…`);
  const result = await apiFetch<{ runtimes: RuntimeInfo[]; claudePath: string; systemInfo: SystemInfo; runtimeDetectedAt: string }>(
    `/api/machines/${match.id}/detect`,
    { method: 'POST' },
  );

  if (result.runtimes.length === 0) {
    console.log('No runtimes detected.');
  } else {
    for (const r of result.runtimes) {
      console.log(`  ${r.runtime} ${r.version} (${r.path})`);
    }
  }
  console.log(`  claude: ${result.claudePath || 'not found'}`);

  const si = result.systemInfo;
  if (si) {
    console.log('');
    console.log('System info:');
    if (si.os) console.log(`  OS:      ${si.os}`);
    if (si.kernel) console.log(`  Kernel:  ${si.kernel}`);
    if (si.cpu) console.log(`  CPU:     ${si.cpu}${si.cpuCores ? ` (${si.cpuCores} cores)` : ''}`);
    if (si.memoryTotal) console.log(`  Memory:  ${si.memoryTotal}`);
    if (si.diskTotal) console.log(`  Disk:    ${si.diskUsed} used / ${si.diskTotal} total (${si.diskAvail} avail)`);
    if (si.networkInterfaces && si.networkInterfaces.length > 0) {
      console.log('  Network:');
      for (const iface of si.networkInterfaces) {
        console.log(`    ${iface.name}: ${iface.ip}`);
      }
    }
    if (si.crontab && si.crontab.length > 0) {
      console.log(`  Crontab (${si.crontab.length} entries):`);
      for (const entry of si.crontab) {
        console.log(`    ${entry}`);
      }
    }
  }
}

export async function machinesSetupCommand(idPrefix: string): Promise<void> {
  if (!idPrefix) {
    console.error('Usage: banana machines setup <id-prefix>');
    process.exit(1);
  }

  const machines = await apiFetch<MachineRedacted[]>('/api/machines');
  const match = machines.find(m => m.id.startsWith(idPrefix));
  if (!match) {
    console.error(`No machine found matching prefix: ${idPrefix}`);
    process.exit(1);
  }

  console.log(`Setting up ${match.name} (${match.username}@${match.ip}:${match.port})…`);
  const result = await apiFetch<{
    steps?: { phase: string; status: string; message: string }[];
    runtimes?: RuntimeInfo[];
    claudePath?: string;
    runtimeDetectedAt?: string;
    error?: string;
  }>(`/api/machines/${match.id}/setup`, { method: 'POST' });

  if (result.steps) {
    for (const step of result.steps) {
      const icon = step.status === 'done' ? '+' : step.status === 'skipped' ? '-' : step.status === 'error' ? '!' : '*';
      console.log(`  [${icon}] ${step.phase}: ${step.message}`);
    }
  }

  if (result.error) {
    console.error(`Setup failed: ${result.error}`);
    process.exit(1);
  }

  if (result.runtimes && result.runtimes.length > 0) {
    console.log('Detected runtimes:');
    for (const r of result.runtimes) {
      console.log(`  ${r.runtime} ${r.version} (${r.path})`);
    }
  }
  console.log(`  claude: ${result.claudePath || 'not found'}`);
}

export async function machinesCrontabCommand(idPrefix: string): Promise<void> {
  if (!idPrefix) {
    console.error('Usage: banana machines crontab <id-prefix>');
    process.exit(1);
  }

  const machines = await apiFetch<MachineRedacted[]>('/api/machines');
  const match = machines.find(m => m.id.startsWith(idPrefix));
  if (!match) {
    console.error(`No machine found matching prefix: ${idPrefix}`);
    process.exit(1);
  }

  // If we already have cached systemInfo with crontab, show it
  if (match.systemInfo?.crontab && match.systemInfo.crontab.length > 0) {
    console.log(`Crontab for ${match.name} (cached from last detect):`);
    for (const entry of match.systemInfo.crontab) {
      console.log(`  ${entry}`);
    }
    return;
  }

  // Otherwise, run detect to get fresh data
  console.log(`Fetching crontab from ${match.name} (${match.username}@${match.ip}:${match.port})…`);
  const result = await apiFetch<{ systemInfo: SystemInfo }>(
    `/api/machines/${match.id}/detect`,
    { method: 'POST' },
  );

  const crontab = result.systemInfo?.crontab;
  if (!crontab || crontab.length === 0) {
    console.log('No crontab entries found.');
  } else {
    console.log(`Crontab for ${match.name} (${crontab.length} entries):`);
    for (const entry of crontab) {
      console.log(`  ${entry}`);
    }
  }
}

export async function machinesTestCommand(idPrefix: string): Promise<void> {
  if (!idPrefix) {
    console.error('Usage: banana machines test <id-prefix>');
    process.exit(1);
  }

  const machines = await apiFetch<MachineRedacted[]>('/api/machines');
  const match = machines.find(m => m.id.startsWith(idPrefix));
  if (!match) {
    console.error(`No machine found matching prefix: ${idPrefix}`);
    process.exit(1);
  }

  console.log(`Testing connection to ${match.name} (${match.username}@${match.ip}:${match.port})…`);
  const result = await apiFetch<{ ok: boolean; output?: string; error?: string }>(
    `/api/machines/${match.id}/test`,
    { method: 'POST' },
  );
  if (result.ok) {
    console.log(`Connected: ${result.output}`);
  } else {
    console.error(`Failed: ${result.error}`);
    process.exit(1);
  }
}
