import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import type { MachineRecord } from '../../src/machines/machineStore.js';

// Mock config before importing machineStore
vi.mock('../../src/config.js', () => ({
  config: {
    machinesPersistPath: '/tmp/banana-test-machines.json',
  },
}));

// Mock fs to avoid real file I/O
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

function makeMachine(overrides: Partial<MachineRecord> = {}): MachineRecord {
  return {
    id: 'machine-1',
    name: 'test-machine',
    alias: 'tm1',
    ip: '192.168.1.1',
    port: 22,
    username: 'root',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('MachineStore', () => {
  let MachineStoreModule: typeof import('../../src/machines/machineStore.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-import to get a fresh store each test
    vi.resetModules();
    MachineStoreModule = await import('../../src/machines/machineStore.js');
  });

  describe('CRUD operations', () => {
    it('should return undefined for non-existent machine', () => {
      expect(MachineStoreModule.machineStore.get('nonexistent')).toBeUndefined();
    });

    it('should upsert and retrieve a machine', () => {
      const machine = makeMachine();
      MachineStoreModule.machineStore.upsert(machine);
      const result = MachineStoreModule.machineStore.get('machine-1');
      expect(result).toBeDefined();
      expect(result!.name).toBe('test-machine');
      expect(result!.ip).toBe('192.168.1.1');
    });

    it('should update updatedAt on upsert', () => {
      const machine = makeMachine({ updatedAt: '2020-01-01T00:00:00.000Z' });
      MachineStoreModule.machineStore.upsert(machine);
      const result = MachineStoreModule.machineStore.get('machine-1');
      expect(result!.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
    });

    it('should overwrite existing machine on upsert', () => {
      MachineStoreModule.machineStore.upsert(makeMachine({ name: 'original' }));
      MachineStoreModule.machineStore.upsert(makeMachine({ name: 'updated' }));
      expect(MachineStoreModule.machineStore.get('machine-1')!.name).toBe('updated');
    });

    it('should getAll machines', () => {
      MachineStoreModule.machineStore.upsert(makeMachine({ id: 'a' }));
      MachineStoreModule.machineStore.upsert(makeMachine({ id: 'b' }));
      expect(MachineStoreModule.machineStore.getAll()).toHaveLength(2);
    });

    it('should remove a machine and return true', () => {
      MachineStoreModule.machineStore.upsert(makeMachine());
      expect(MachineStoreModule.machineStore.remove('machine-1')).toBe(true);
      expect(MachineStoreModule.machineStore.get('machine-1')).toBeUndefined();
    });

    it('should return false when removing non-existent machine', () => {
      expect(MachineStoreModule.machineStore.remove('nonexistent')).toBe(false);
    });
  });

  describe('findByAlias', () => {
    it('should find machine by alias', () => {
      MachineStoreModule.machineStore.upsert(makeMachine({ alias: 'prod1' }));
      const found = MachineStoreModule.machineStore.findByAlias('prod1');
      expect(found).toBeDefined();
      expect(found!.alias).toBe('prod1');
    });

    it('should return undefined for unknown alias', () => {
      expect(MachineStoreModule.machineStore.findByAlias('unknown')).toBeUndefined();
    });
  });

  describe('redaction', () => {
    it('should redact password and passphrase', () => {
      MachineStoreModule.machineStore.upsert(
        makeMachine({ password: 'secret123', passphrase: 'pass456' }),
      );
      const redacted = MachineStoreModule.machineStore.getRedacted('machine-1');
      expect(redacted).toBeDefined();
      expect(redacted!.hasPassword).toBe(true);
      expect(redacted!.hasPassphrase).toBe(true);
      expect((redacted as any).password).toBeUndefined();
      expect((redacted as any).passphrase).toBeUndefined();
    });

    it('should set hasPassword=false when no password', () => {
      MachineStoreModule.machineStore.upsert(makeMachine());
      const redacted = MachineStoreModule.machineStore.getRedacted('machine-1');
      expect(redacted!.hasPassword).toBe(false);
      expect(redacted!.hasPassphrase).toBe(false);
    });

    it('should return undefined for non-existent redacted', () => {
      expect(MachineStoreModule.machineStore.getRedacted('none')).toBeUndefined();
    });

    it('should getAllRedacted with secrets stripped', () => {
      MachineStoreModule.machineStore.upsert(makeMachine({ password: 'pw' }));
      const all = MachineStoreModule.machineStore.getAllRedacted();
      expect(all).toHaveLength(1);
      expect(all[0].hasPassword).toBe(true);
      expect((all[0] as any).password).toBeUndefined();
    });
  });

  describe('persistence', () => {
    it('should call writeFileSync on upsert', () => {
      MachineStoreModule.machineStore.upsert(makeMachine());
      expect(fs.writeFileSync).toHaveBeenCalled();
      const [filePath, , opts] = (fs.writeFileSync as any).mock.calls[0];
      expect(filePath).toBe('/tmp/banana-test-machines.json');
      expect(opts).toEqual({ mode: 0o600 });
    });

    it('should call writeFileSync on remove', () => {
      MachineStoreModule.machineStore.upsert(makeMachine());
      vi.mocked(fs.writeFileSync).mockClear();
      MachineStoreModule.machineStore.remove('machine-1');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should not crash on persist error', () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('disk full');
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => MachineStoreModule.machineStore.upsert(makeMachine())).not.toThrow();
      consoleSpy.mockRestore();
    });
  });

  describe('runtime fields', () => {
    it('should persist and load runtime fields correctly', () => {
      const machine = makeMachine({
        runtimes: [
          { runtime: 'node', version: 'v20.11.1', path: '/usr/local/bin/node' },
          { runtime: 'bun', version: '1.0.25', path: '/usr/local/bin/bun' },
        ],
        claudePath: '/usr/local/bin/claude',
        runtimeDetectedAt: '2024-06-01T00:00:00.000Z',
      });
      MachineStoreModule.machineStore.upsert(machine);

      const stored = MachineStoreModule.machineStore.get('machine-1');
      expect(stored!.runtimes).toHaveLength(2);
      expect(stored!.runtimes![0].runtime).toBe('node');
      expect(stored!.runtimes![1].runtime).toBe('bun');
      expect(stored!.claudePath).toBe('/usr/local/bin/claude');
      expect(stored!.runtimeDetectedAt).toBe('2024-06-01T00:00:00.000Z');
    });

    it('should include runtime fields in redacted output', () => {
      MachineStoreModule.machineStore.upsert(makeMachine({
        runtimes: [{ runtime: 'node', version: 'v18.0.0', path: '/usr/bin/node' }],
        claudePath: '/usr/bin/claude',
        runtimeDetectedAt: '2024-06-01T00:00:00.000Z',
      }));
      const redacted = MachineStoreModule.machineStore.getRedacted('machine-1');
      expect(redacted!.runtimes).toHaveLength(1);
      expect(redacted!.claudePath).toBe('/usr/bin/claude');
    });

    it('should handle machines without runtime fields', () => {
      MachineStoreModule.machineStore.upsert(makeMachine());
      const stored = MachineStoreModule.machineStore.get('machine-1');
      expect(stored!.runtimes).toBeUndefined();
      expect(stored!.claudePath).toBeUndefined();
    });
  });

  describe('load', () => {
    it('should load machines from disk', () => {
      const machines = [makeMachine({ id: 'loaded-1' }), makeMachine({ id: 'loaded-2' })];
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(machines));
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      MachineStoreModule.machineStore.load();
      expect(MachineStoreModule.machineStore.getAll()).toHaveLength(2);
      consoleSpy.mockRestore();
    });

    it('should handle missing file gracefully', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(() => MachineStoreModule.machineStore.load()).not.toThrow();
    });
  });
});
