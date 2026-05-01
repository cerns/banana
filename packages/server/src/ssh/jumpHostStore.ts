import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

export interface JumpHost {
  id: string;
  host: string;
  port: number;
  username: string;
  sshKeyPath?: string;
  password?: string;
  passphrase?: string;
  label?: string;
}

export interface JumpHostConfig {
  enabled: boolean;
  hosts: JumpHost[];
}

export type RedactedJumpHost = Omit<JumpHost, 'password' | 'passphrase'> & {
  hasPassword: boolean;
  hasPassphrase: boolean;
};

export interface RedactedJumpHostConfig {
  enabled: boolean;
  hosts: RedactedJumpHost[];
}

function redactHost(h: JumpHost): RedactedJumpHost {
  const { password, passphrase, ...rest } = h;
  return { ...rest, hasPassword: !!password, hasPassphrase: !!passphrase };
}

class JumpHostStore {
  private cfg: JumpHostConfig = { enabled: false, hosts: [] };

  constructor() {
    this.load();
  }

  load(): void {
    const filePath = config.jumpHostPersistPath;
    if (!filePath) return;
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(data) as JumpHostConfig;
      this.cfg = { enabled: !!parsed.enabled, hosts: Array.isArray(parsed.hosts) ? parsed.hosts : [] };
      console.log(`[jumphosts] Loaded ${this.cfg.hosts.length} jump host(s), enabled=${this.cfg.enabled}`);
    } catch (err) {
      const msg = (err as Error).message || '';
      if (!msg.includes('ENOENT')) {
        console.warn(`[jumphosts] Failed to load from ${filePath}: ${msg}`);
      }
    }
  }

  getConfig(): JumpHostConfig {
    return this.cfg;
  }

  getRedactedConfig(): RedactedJumpHostConfig {
    return { enabled: this.cfg.enabled, hosts: this.cfg.hosts.map(redactHost) };
  }

  setEnabled(enabled: boolean): void {
    this.cfg.enabled = enabled;
    this.persist();
  }

  addHost(host: JumpHost): void {
    this.cfg.hosts.push(host);
    this.persist();
  }

  updateHost(id: string, updates: Partial<JumpHost>): boolean {
    const idx = this.cfg.hosts.findIndex(h => h.id === id);
    if (idx === -1) return false;
    this.cfg.hosts[idx] = { ...this.cfg.hosts[idx], ...updates, id };
    this.persist();
    return true;
  }

  removeHost(id: string): boolean {
    const before = this.cfg.hosts.length;
    this.cfg.hosts = this.cfg.hosts.filter(h => h.id !== id);
    if (this.cfg.hosts.length === before) return false;
    this.persist();
    return true;
  }

  reorderHosts(ids: string[]): void {
    const map = new Map(this.cfg.hosts.map(h => [h.id, h]));
    const reordered: JumpHost[] = [];
    for (const id of ids) {
      const h = map.get(id);
      if (h) { reordered.push(h); map.delete(id); }
    }
    // Append any hosts not in the ids list (shouldn't happen, but safety)
    for (const h of map.values()) reordered.push(h);
    this.cfg.hosts = reordered;
    this.persist();
  }

  /** Replace entire config (used by PUT /api/jumphosts). */
  setConfig(newCfg: JumpHostConfig): void {
    this.cfg = { enabled: !!newCfg.enabled, hosts: Array.isArray(newCfg.hosts) ? newCfg.hosts : [] };
    this.persist();
  }

  private persist(): void {
    const filePath = config.jumpHostPersistPath;
    if (!filePath) return;
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(this.cfg, null, 2), { mode: 0o600 });
    } catch (e) {
      console.error('[jumphosts] persist error', e);
    }
  }
}

export const jumpHostStore = new JumpHostStore();
