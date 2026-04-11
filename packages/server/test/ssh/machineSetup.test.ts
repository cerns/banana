import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { MachineRecord } from '../../src/machines/machineStore.js';
import type { SetupStep } from '../../src/ssh/machineSetup.js';

// Mock config
vi.mock('../../src/config.js', () => ({
  config: { machinesPersistPath: '' },
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

/** Helper: simulate exec that responds with given stdout/code based on command pattern */
function setupExecSequence(responses: { match: RegExp; stdout: string; stderr?: string; code: number }[]) {
  let callIndex = 0;
  mockClientInstance.exec.mockImplementation((cmd: string, cb: Function) => {
    const stream = createMockStream();
    cb(null, stream);

    // Find matching response
    const response = responses[callIndex] ?? { stdout: '', stderr: '', code: 1 };
    callIndex++;

    setTimeout(() => {
      if (response.stdout) stream.emit('data', Buffer.from(response.stdout));
      if (response.stderr) stream.stderr.emit('data', Buffer.from(response.stderr));
      stream.emit('close', response.code);
    }, 0);
  });
}

describe('machineSetup', () => {
  let machineSetup: typeof import('../../src/ssh/machineSetup.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doMock('ssh2', () => ({
      Client: vi.fn().mockImplementation(() => {
        mockClientInstance = createMockClient();
        return mockClientInstance;
      }),
    }));
    machineSetup = await import('../../src/ssh/machineSetup.js');
  });

  it('should install bun and claude when neither exists', async () => {
    const machine = makeMachine();
    const steps: SetupStep[] = [];
    const promise = machineSetup.setupMachine(machine, (step) => steps.push(step));

    // Set up exec sequence: bun check (fail), bun install (ok), bun verify (ok),
    // claude check (fail), claude install (ok), detect (ok)
    setupExecSequence([
      { match: /bun --version/, stdout: '', code: 127 },
      { match: /bun\.sh\/install/, stdout: 'installed\n', code: 0 },
      { match: /bun --version/, stdout: '1.1.0\n', code: 0 },
      { match: /command -v claude/, stdout: '', code: 1 },
      { match: /claude-code@latest/, stdout: '1.0.0\n', code: 0 },
      { match: /---node---/, stdout: '---node---\nnot-found\n---bun---\n/home/user/.bun/bin/bun\n1.1.0\n---claude---\n/home/user/.bun/bin/claude\n', code: 0 },
    ]);
    mockClientInstance.emit('ready');

    const result = await promise;
    expect(result.runtimes).toHaveLength(1);
    expect(result.runtimes[0].runtime).toBe('bun');
    expect(result.claudePath).toBe('/home/user/.bun/bin/claude');

    // Check steps were emitted
    expect(steps.some(s => s.phase === 'bun' && s.status === 'done')).toBe(true);
    expect(steps.some(s => s.phase === 'claude' && s.status === 'done')).toBe(true);
    expect(steps.some(s => s.phase === 'detect' && s.status === 'done')).toBe(true);
    expect(mockClientInstance.end).toHaveBeenCalled();
  });

  it('should skip bun when already installed', async () => {
    const machine = makeMachine();
    const steps: SetupStep[] = [];
    const promise = machineSetup.setupMachine(machine, (step) => steps.push(step));

    setupExecSequence([
      { match: /bun --version/, stdout: '1.0.25\n', code: 0 },
      { match: /command -v claude/, stdout: '', code: 1 },
      { match: /claude-code@latest/, stdout: '1.0.0\n', code: 0 },
      { match: /---node---/, stdout: '---node---\nnot-found\n---bun---\n/usr/bin/bun\n1.0.25\n---claude---\n/usr/bin/claude\n', code: 0 },
    ]);
    mockClientInstance.emit('ready');

    const result = await promise;
    expect(steps.some(s => s.phase === 'bun' && s.status === 'skipped')).toBe(true);
    expect(steps.some(s => s.phase === 'claude' && s.status === 'done')).toBe(true);
    expect(result.runtimes).toHaveLength(1);
  });

  it('should skip both when already installed and return system info', async () => {
    const machine = makeMachine();
    const steps: SetupStep[] = [];
    const promise = machineSetup.setupMachine(machine, (step) => steps.push(step));

    const detectOutput = [
      '---node---', 'not-found',
      '---bun---', '/usr/bin/bun', '1.0.25',
      '---claude---', '/usr/bin/claude',
      '---os---', 'Ubuntu 22.04.3 LTS',
      '---kernel---', 'Linux 5.15.0',
      '---cpu---', 'Intel i7',
      '---cpu-cores---', '8',
      '---memory---', '16Gi',
      '---disk---', '500G|200G|280G',
      '---network---', 'eth0|10.0.0.1/24',
    ].join('\n');

    setupExecSequence([
      { match: /bun --version/, stdout: '1.0.25\n', code: 0 },
      { match: /command -v claude/, stdout: '/usr/bin/claude\n', code: 0 },
      { match: /---node---/, stdout: detectOutput, code: 0 },
    ]);
    mockClientInstance.emit('ready');

    const result = await promise;
    expect(steps.some(s => s.phase === 'bun' && s.status === 'skipped')).toBe(true);
    expect(steps.some(s => s.phase === 'claude' && s.status === 'skipped')).toBe(true);
    expect(steps.some(s => s.phase === 'detect' && s.status === 'done')).toBe(true);
    expect(result.claudePath).toBe('/usr/bin/claude');
    expect(result.systemInfo.os).toBe('Ubuntu 22.04.3 LTS');
    expect(result.systemInfo.cpuCores).toBe(8);
    expect(result.systemInfo.memoryTotal).toBe('16Gi');
    expect(result.systemInfo.networkInterfaces).toHaveLength(1);
  });

  it('should reject on SSH connection error', async () => {
    const machine = makeMachine();
    const steps: SetupStep[] = [];
    const promise = machineSetup.setupMachine(machine, (step) => steps.push(step));

    mockClientInstance.emit('error', new Error('Connection refused'));

    await expect(promise).rejects.toThrow('Connection refused');
  });

  it('should reject and report error step when bun install fails', async () => {
    const machine = makeMachine();
    const steps: SetupStep[] = [];
    const promise = machineSetup.setupMachine(machine, (step) => steps.push(step));

    setupExecSequence([
      { match: /bun --version/, stdout: '', code: 127 },
      { match: /bun\.sh\/install/, stdout: '', stderr: 'curl failed', code: 1 },
    ]);
    mockClientInstance.emit('ready');

    await expect(promise).rejects.toThrow('bun install failed');
    expect(steps.some(s => s.phase === 'bun' && s.status === 'error')).toBe(true);
    expect(mockClientInstance.end).toHaveBeenCalled();
  });

  it('should reject and report error step when claude install fails', async () => {
    const machine = makeMachine();
    const steps: SetupStep[] = [];
    const promise = machineSetup.setupMachine(machine, (step) => steps.push(step));

    setupExecSequence([
      { match: /bun --version/, stdout: '1.0.25\n', code: 0 },
      { match: /command -v claude/, stdout: '', code: 1 },
      { match: /claude-code@latest/, stdout: '', stderr: 'install error', code: 1 },
    ]);
    mockClientInstance.emit('ready');

    await expect(promise).rejects.toThrow('claude install failed');
    expect(steps.some(s => s.phase === 'claude' && s.status === 'error')).toBe(true);
    expect(mockClientInstance.end).toHaveBeenCalled();
  });

  it('should reject on exec error', async () => {
    const machine = makeMachine();
    const steps: SetupStep[] = [];
    const promise = machineSetup.setupMachine(machine, (step) => steps.push(step));

    mockClientInstance.exec.mockImplementation((_cmd: string, cb: Function) => {
      cb(new Error('exec failed'));
    });
    mockClientInstance.emit('ready');

    await expect(promise).rejects.toThrow('exec failed');
  });
});
