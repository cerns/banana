import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { MachineRecord } from '../../src/machines/machineStore.js';

// Mock config
vi.mock('../../src/config.js', () => ({
  config: {
    machinesPersistPath: '',
    sshReadyTimeoutMs: 30_000,
    sshKeepaliveCountMax: 60,
    sshConnectRetries: 0,
    jumpHostPersistPath: '',
  },
}));

// Mock fs for key file reading
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-key-data')),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
    readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-key-data')),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

function createMockStream() {
  const stream = new EventEmitter() as any;
  stream.stderr = new EventEmitter();
  return stream;
}

function createMockClient() {
  const client = new EventEmitter() as any;
  client.exec = vi.fn();
  client.end = vi.fn();
  client.connect = vi.fn();
  return client;
}

let mockClientInstance: any;
vi.mock('ssh2', () => ({
  Client: vi.fn().mockImplementation(() => {
    mockClientInstance = createMockClient();
    return mockClientInstance;
  }),
}));

// Drain microtask queue so connectWithRetry → conn.exec() settles
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

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

describe('runtimeDetector', () => {
  let runtimeDetector: typeof import('../../src/ssh/runtimeDetector.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doMock('ssh2', () => ({
      Client: vi.fn().mockImplementation(() => {
        mockClientInstance = createMockClient();
        return mockClientInstance;
      }),
    }));
    runtimeDetector = await import('../../src/ssh/runtimeDetector.js');
  });

  describe('parseDetectionOutput', () => {
    it('should parse both node and bun detected', () => {
      const output = [
        '---node---',
        '/usr/local/bin/node',
        'v20.11.1',
        '---bun---',
        '/usr/local/bin/bun',
        '1.0.25',
        '---claude---',
        '/usr/local/bin/claude',
      ].join('\n');

      const result = runtimeDetector.parseDetectionOutput(output);
      expect(result.runtimes).toHaveLength(2);
      expect(result.runtimes[0]).toEqual({ runtime: 'node', version: 'v20.11.1', path: '/usr/local/bin/node' });
      expect(result.runtimes[1]).toEqual({ runtime: 'bun', version: '1.0.25', path: '/usr/local/bin/bun' });
      expect(result.claudePath).toBe('/usr/local/bin/claude');
    });

    it('should parse only node detected', () => {
      const output = [
        '---node---',
        '/usr/bin/node',
        'v18.0.0',
        '---bun---',
        'not-found',
        '---claude---',
        '/usr/bin/claude',
      ].join('\n');

      const result = runtimeDetector.parseDetectionOutput(output);
      expect(result.runtimes).toHaveLength(1);
      expect(result.runtimes[0].runtime).toBe('node');
      expect(result.claudePath).toBe('/usr/bin/claude');
    });

    it('should parse only bun detected', () => {
      const output = [
        '---node---',
        'not-found',
        '---bun---',
        '/home/user/.bun/bin/bun',
        '1.1.0',
        '---claude---',
        'not-found',
      ].join('\n');

      const result = runtimeDetector.parseDetectionOutput(output);
      expect(result.runtimes).toHaveLength(1);
      expect(result.runtimes[0].runtime).toBe('bun');
      expect(result.claudePath).toBe('');
    });

    it('should parse neither detected', () => {
      const output = [
        '---node---',
        'not-found',
        '---bun---',
        'not-found',
        '---claude---',
        'not-found',
      ].join('\n');

      const result = runtimeDetector.parseDetectionOutput(output);
      expect(result.runtimes).toHaveLength(0);
      expect(result.claudePath).toBe('');
    });

    it('should handle claude in PATH', () => {
      const output = '---node---\nnot-found\n---bun---\nnot-found\n---claude---\n/opt/claude/bin/claude';
      const result = runtimeDetector.parseDetectionOutput(output);
      expect(result.claudePath).toBe('/opt/claude/bin/claude');
    });

    it('should handle claude not in PATH', () => {
      const output = '---node---\nnot-found\n---bun---\nnot-found\n---claude---\nnot-found';
      const result = runtimeDetector.parseDetectionOutput(output);
      expect(result.claudePath).toBe('');
    });

    it('should handle malformed output gracefully', () => {
      const result = runtimeDetector.parseDetectionOutput('some random garbage');
      expect(result.runtimes).toHaveLength(0);
      expect(result.claudePath).toBe('');
    });

    it('should handle empty output gracefully', () => {
      const result = runtimeDetector.parseDetectionOutput('');
      expect(result.runtimes).toHaveLength(0);
      expect(result.claudePath).toBe('');
    });

    it('should parse full system info sections', () => {
      const output = [
        '---node---', '/usr/bin/node', 'v20.11.1',
        '---bun---', 'not-found',
        '---claude---', '/usr/bin/claude',
        '---os---', 'Ubuntu 22.04.3 LTS',
        '---kernel---', 'Linux 5.15.0-91-generic',
        '---cpu---', 'Intel(R) Core(TM) i7-12700 @ 2.10GHz',
        '---cpu-cores---', '20',
        '---memory---', '31Gi',
        '---disk---', '468G|123G|321G',
        '---network---', 'eth0|192.168.1.100/24', 'wlan0|10.0.0.5/24',
        '---crontab---', '# comment line', '0 * * * * /usr/bin/backup.sh', '30 2 * * * /opt/cleanup.sh',
      ].join('\n');

      const result = runtimeDetector.parseDetectionOutput(output);
      expect(result.runtimes).toHaveLength(1);
      expect(result.claudePath).toBe('/usr/bin/claude');
      expect(result.systemInfo.os).toBe('Ubuntu 22.04.3 LTS');
      expect(result.systemInfo.kernel).toBe('Linux 5.15.0-91-generic');
      expect(result.systemInfo.cpu).toBe('Intel(R) Core(TM) i7-12700 @ 2.10GHz');
      expect(result.systemInfo.cpuCores).toBe(20);
      expect(result.systemInfo.memoryTotal).toBe('31Gi');
      expect(result.systemInfo.diskTotal).toBe('468G');
      expect(result.systemInfo.diskUsed).toBe('123G');
      expect(result.systemInfo.diskAvail).toBe('321G');
      expect(result.systemInfo.networkInterfaces).toHaveLength(2);
      expect(result.systemInfo.networkInterfaces![0]).toEqual({ name: 'eth0', ip: '192.168.1.100/24' });
      expect(result.systemInfo.networkInterfaces![1]).toEqual({ name: 'wlan0', ip: '10.0.0.5/24' });
      expect(result.systemInfo.crontab).toEqual(['0 * * * * /usr/bin/backup.sh', '30 2 * * * /opt/cleanup.sh']);
    });

    it('should return empty systemInfo when no system sections present', () => {
      const output = '---node---\nnot-found\n---bun---\nnot-found\n---claude---\nnot-found';
      const result = runtimeDetector.parseDetectionOutput(output);
      expect(result.systemInfo).toEqual({});
    });

    it('should handle partial system info', () => {
      const output = [
        '---node---', 'not-found',
        '---bun---', 'not-found',
        '---claude---', 'not-found',
        '---os---', 'Debian GNU/Linux 12',
        '---kernel---', 'Linux 6.1.0-18-amd64',
        '---cpu---', 'unknown',
        '---cpu-cores---', '0',
        '---memory---', 'unknown',
        '---disk---', '',
        '---network---', '',
      ].join('\n');

      const result = runtimeDetector.parseDetectionOutput(output);
      expect(result.systemInfo.os).toBe('Debian GNU/Linux 12');
      expect(result.systemInfo.kernel).toBe('Linux 6.1.0-18-amd64');
      expect(result.systemInfo.cpu).toBeUndefined();
      expect(result.systemInfo.cpuCores).toBeUndefined();
      expect(result.systemInfo.memoryTotal).toBeUndefined();
      expect(result.systemInfo.diskTotal).toBeUndefined();
      expect(result.systemInfo.networkInterfaces).toBeUndefined();
      expect(result.systemInfo.crontab).toBeUndefined();
    });

    it('should handle no-crontab output', () => {
      const output = [
        '---node---', 'not-found',
        '---bun---', 'not-found',
        '---claude---', 'not-found',
        '---crontab---', 'no-crontab',
      ].join('\n');

      const result = runtimeDetector.parseDetectionOutput(output);
      expect(result.systemInfo.crontab).toBeUndefined();
    });

    it('should handle crontab with only comments', () => {
      const output = [
        '---node---', 'not-found',
        '---bun---', 'not-found',
        '---claude---', 'not-found',
        '---crontab---', '# m h dom mon dow command', '# nothing here',
      ].join('\n');

      const result = runtimeDetector.parseDetectionOutput(output);
      expect(result.systemInfo.crontab).toBeUndefined();
    });
  });

  describe('detectRuntimes', () => {
    it('should resolve with detection result on success', async () => {
      const machine = makeMachine();
      const promise = runtimeDetector.detectRuntimes(machine);

      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((_cmd: string, cb: Function) => {
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();

      stream.emit('data', Buffer.from('---node---\n/usr/bin/node\nv20.0.0\n---bun---\nnot-found\n---claude---\n/usr/bin/claude\n'));
      stream.emit('close');

      const result = await promise;
      expect(result.runtimes).toHaveLength(1);
      expect(result.runtimes[0].runtime).toBe('node');
      expect(result.claudePath).toBe('/usr/bin/claude');
      expect(mockClientInstance.end).toHaveBeenCalled();
    });

    it('should reject on SSH connection error', async () => {
      const machine = makeMachine();
      const promise = runtimeDetector.detectRuntimes(machine);

      mockClientInstance.emit('error', new Error('Connection refused'));

      await expect(promise).rejects.toThrow('Connection refused');
    });

    it('should reject on exec error', async () => {
      const machine = makeMachine();
      const promise = runtimeDetector.detectRuntimes(machine);

      mockClientInstance.exec.mockImplementation((_cmd: string, cb: Function) => {
        cb(new Error('exec failed'));
      });
      mockClientInstance.emit('ready');
      await flush();

      await expect(promise).rejects.toThrow('exec failed');
    });

    it('should ignore stderr output', async () => {
      const machine = makeMachine();
      const promise = runtimeDetector.detectRuntimes(machine);

      const stream = createMockStream();
      mockClientInstance.exec.mockImplementation((_cmd: string, cb: Function) => {
        cb(null, stream);
      });
      mockClientInstance.emit('ready');
      await flush();

      stream.stderr.emit('data', Buffer.from('warning: something'));
      stream.emit('data', Buffer.from('---node---\n/usr/bin/node\nv20.0.0\n---bun---\nnot-found\n---claude---\nnot-found\n'));
      stream.emit('close');

      const result = await promise;
      expect(result.runtimes).toHaveLength(1);
    });
  });
});
