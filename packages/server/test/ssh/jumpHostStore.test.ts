import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config
vi.mock('../../src/config.js', () => ({
  config: { jumpHostPersistPath: '/tmp/test-jumphosts.json' },
}));

// Mock fs
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: (...args: any[]) => mockReadFileSync(...args),
      writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
      mkdirSync: (...args: any[]) => mockMkdirSync(...args),
    },
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
    mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  };
});

describe('jumpHostStore', () => {
  let jumpHostStore: typeof import('../../src/ssh/jumpHostStore.js');

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();
    jumpHostStore = await import('../../src/ssh/jumpHostStore.js');
  });

  it('should start with empty disabled config', () => {
    const cfg = jumpHostStore.jumpHostStore.getConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.hosts).toEqual([]);
  });

  it('should load config from disk', () => {
    const data = JSON.stringify({
      enabled: true,
      hosts: [{ id: 'h1', host: '1.2.3.4', port: 22, username: 'root', label: 'bastion' }],
    });
    mockReadFileSync.mockReturnValue(data);

    jumpHostStore.jumpHostStore.load();
    const cfg = jumpHostStore.jumpHostStore.getConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.hosts).toHaveLength(1);
    expect(cfg.hosts[0].host).toBe('1.2.3.4');
  });

  it('should handle missing file on load gracefully', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    jumpHostStore.jumpHostStore.load();
    expect(jumpHostStore.jumpHostStore.getConfig().hosts).toEqual([]);
  });

  it('should add a host and persist', () => {
    const host = { id: 'h1', host: '10.0.0.1', port: 22, username: 'admin', label: 'hop1' };
    jumpHostStore.jumpHostStore.addHost(host);
    expect(jumpHostStore.jumpHostStore.getConfig().hosts).toHaveLength(1);
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('should update a host', () => {
    jumpHostStore.jumpHostStore.addHost({ id: 'h1', host: '10.0.0.1', port: 22, username: 'admin' });
    const updated = jumpHostStore.jumpHostStore.updateHost('h1', { username: 'root' });
    expect(updated).toBe(true);
    expect(jumpHostStore.jumpHostStore.getConfig().hosts[0].username).toBe('root');
    expect(jumpHostStore.jumpHostStore.getConfig().hosts[0].id).toBe('h1');
  });

  it('should return false when updating nonexistent host', () => {
    expect(jumpHostStore.jumpHostStore.updateHost('nope', { host: 'x' })).toBe(false);
  });

  it('should remove a host', () => {
    jumpHostStore.jumpHostStore.addHost({ id: 'h1', host: '10.0.0.1', port: 22, username: 'admin' });
    jumpHostStore.jumpHostStore.addHost({ id: 'h2', host: '10.0.0.2', port: 22, username: 'admin' });
    expect(jumpHostStore.jumpHostStore.removeHost('h1')).toBe(true);
    expect(jumpHostStore.jumpHostStore.getConfig().hosts).toHaveLength(1);
    expect(jumpHostStore.jumpHostStore.getConfig().hosts[0].id).toBe('h2');
  });

  it('should return false when removing nonexistent host', () => {
    expect(jumpHostStore.jumpHostStore.removeHost('nope')).toBe(false);
  });

  it('should reorder hosts', () => {
    jumpHostStore.jumpHostStore.addHost({ id: 'a', host: '1.1.1.1', port: 22, username: 'u' });
    jumpHostStore.jumpHostStore.addHost({ id: 'b', host: '2.2.2.2', port: 22, username: 'u' });
    jumpHostStore.jumpHostStore.addHost({ id: 'c', host: '3.3.3.3', port: 22, username: 'u' });
    jumpHostStore.jumpHostStore.reorderHosts(['c', 'a', 'b']);
    const hosts = jumpHostStore.jumpHostStore.getConfig().hosts;
    expect(hosts[0].id).toBe('c');
    expect(hosts[1].id).toBe('a');
    expect(hosts[2].id).toBe('b');
  });

  it('should toggle enabled', () => {
    jumpHostStore.jumpHostStore.setEnabled(true);
    expect(jumpHostStore.jumpHostStore.getConfig().enabled).toBe(true);
    jumpHostStore.jumpHostStore.setEnabled(false);
    expect(jumpHostStore.jumpHostStore.getConfig().enabled).toBe(false);
  });

  it('should replace entire config with setConfig', () => {
    jumpHostStore.jumpHostStore.setConfig({
      enabled: true,
      hosts: [
        { id: 'x', host: '5.5.5.5', port: 2222, username: 'test' },
      ],
    });
    const cfg = jumpHostStore.jumpHostStore.getConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.hosts).toHaveLength(1);
    expect(cfg.hosts[0].port).toBe(2222);
  });

  it('should redact passwords and passphrases', () => {
    jumpHostStore.jumpHostStore.addHost({
      id: 'h1', host: '10.0.0.1', port: 22, username: 'admin',
      password: 'secret', passphrase: 'pp',
    });
    const redacted = jumpHostStore.jumpHostStore.getRedactedConfig();
    expect(redacted.hosts[0].hasPassword).toBe(true);
    expect(redacted.hosts[0].hasPassphrase).toBe(true);
    expect((redacted.hosts[0] as any).password).toBeUndefined();
    expect((redacted.hosts[0] as any).passphrase).toBeUndefined();
  });

  it('should persist with 0o600 permissions', () => {
    jumpHostStore.jumpHostStore.addHost({ id: 'h1', host: '10.0.0.1', port: 22, username: 'admin' });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { mode: 0o600 },
    );
  });
});
