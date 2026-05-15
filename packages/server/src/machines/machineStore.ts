import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

export interface RuntimeInfo {
  runtime: 'node' | 'bun';
  version: string;   // e.g. "v20.11.1", "1.0.25"
  path: string;      // e.g. "/usr/local/bin/node"
}

export interface NetworkInterface {
  name: string;       // e.g. "eth0", "wlan0"
  ip: string;         // e.g. "192.168.1.100/24"
}

export interface SystemInfo {
  os?: string;           // e.g. "Ubuntu 22.04.3 LTS"
  kernel?: string;       // e.g. "Linux 5.15.0-91-generic"
  cpu?: string;          // e.g. "Intel(R) Core(TM) i7-12700 @ 2.10GHz"
  cpuCores?: number;     // e.g. 20
  memoryTotal?: string;  // e.g. "31Gi"
  diskTotal?: string;    // e.g. "468G"
  diskUsed?: string;     // e.g. "123G"
  diskAvail?: string;    // e.g. "321G"
  networkInterfaces?: NetworkInterface[];
  crontab?: string[];    // lines from crontab -l (excluding comments)
}

export interface MachineRecord {
  id: string;
  name: string;
  alias: string;
  ip: string;
  port: number;
  username: string;
  password?: string;
  sshKeyPath?: string;
  passphrase?: string;
  defaultWorkdir?: string;
  macAddress?: string;
  os?: string;
  notes?: string;
  runtimes?: RuntimeInfo[];
  claudePath?: string;
  systemInfo?: SystemInfo;
  runtimeDetectedAt?: string;
  /** When true (default), passes --dangerously-skip-permissions to claude CLI.
   *  Enterprise managed plans may block this flag — set to false and use
   *  permissionSettings instead. */
  skipPermissions?: boolean;
  /** Custom .claude/settings.json content to write into the workdir before
   *  running claude. Used to pre-approve tools on enterprise plans where
   *  --dangerously-skip-permissions is blocked. */
  permissionSettings?: Record<string, unknown>;
  /** Shell to use for local execution. Default: auto-detect (zsh on macOS, bash on Linux).
   *  Examples: '/bin/zsh', '/bin/bash'. Uses interactive mode (-ic) to load user PATH. */
  localShell?: string;
  /** When true, keeps claude running in a persistent tmux session instead of
   *  spawning `claude --print` per job. Permissions approved once persist for
   *  the session lifetime — required for enterprise plans that block
   *  --dangerously-skip-permissions and --permission-mode dontAsk. */
  persistentMode?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Redacted view of a machine record — password/passphrase replaced with boolean flags. */
export type RedactedMachineRecord = Omit<MachineRecord, 'password' | 'passphrase'> & {
  hasPassword: boolean;
  hasPassphrase: boolean;
};

function redact(m: MachineRecord): RedactedMachineRecord {
  const { password, passphrase, ...rest } = m;
  return { ...rest, hasPassword: !!password, hasPassphrase: !!passphrase };
}

class MachineStore {
  private machines = new Map<string, MachineRecord>();

  get(id: string): MachineRecord | undefined {
    return this.machines.get(id);
  }

  getRedacted(id: string): RedactedMachineRecord | undefined {
    const m = this.machines.get(id);
    return m ? redact(m) : undefined;
  }

  getAll(): MachineRecord[] {
    return Array.from(this.machines.values());
  }

  getAllRedacted(): RedactedMachineRecord[] {
    return this.getAll().map(redact);
  }

  findByAlias(alias: string): MachineRecord | undefined {
    for (const m of this.machines.values()) {
      if (m.alias === alias) return m;
    }
    return undefined;
  }

  upsert(record: MachineRecord): void {
    record.updatedAt = new Date().toISOString();
    this.machines.set(record.id, record);
    this.persist();
  }

  remove(id: string): boolean {
    const deleted = this.machines.delete(id);
    if (deleted) this.persist();
    return deleted;
  }

  load(): void {
    const filePath = config.machinesPersistPath;
    if (!filePath) return;
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const arr: MachineRecord[] = JSON.parse(data);
      for (const m of arr) {
        this.machines.set(m.id, m);
      }
      console.log(`[machines] Loaded ${arr.length} machines from ${filePath}`);
    } catch {
      // no file yet — that's fine
    }
  }

  private persist(): void {
    const filePath = config.machinesPersistPath;
    if (!filePath) return;
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(this.getAll(), null, 2), { mode: 0o600 });
    } catch (e) {
      console.error('[machines] persist error', e);
    }
  }
}

export const machineStore = new MachineStore();
