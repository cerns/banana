import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { persistPath: '', historyMax: 1000 },
}));

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

describe('sessionManager', () => {
  let sessionManager: typeof import('../../src/sessions/sessionManager.js');
  let sessionStore: typeof import('../../src/sessions/sessionStore.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    sessionStore = await import('../../src/sessions/sessionStore.js');
    sessionManager = await import('../../src/sessions/sessionManager.js');
  });

  describe('createJob', () => {
    it('should create a job on existing session', () => {
      const session = sessionManager.createRemoteSession('m1', 'test', '/w');
      const job = sessionManager.createJob(session.sessionId, 'do something');
      expect(job.jobId).toBeDefined();
      expect(job.prompt).toBe('do something');
      expect(job.startedAt).toBeDefined();
      expect(job.chunks).toEqual([]);
    });

    it('should add job to session jobs array', () => {
      const session = sessionManager.createRemoteSession('m1', 'test', '/w');
      sessionManager.createJob(session.sessionId, 'job1');
      sessionManager.createJob(session.sessionId, 'job2');
      const stored = sessionStore.sessionStore.get(session.sessionId);
      expect(stored!.jobs).toHaveLength(2);
    });

    it('should throw for non-existent session', () => {
      expect(() => sessionManager.createJob('bad-id', 'prompt')).toThrow('not found');
    });
  });

  describe('createRemoteSession', () => {
    it('should create a remote session with correct fields', () => {
      const session = sessionManager.createRemoteSession('machine-1', 'my-session', '/remote/path');
      expect(session.type).toBe('remote');
      expect(session.name).toBe('my-session');
      expect(session.machineId).toBe('machine-1');
      expect(session.remoteWorkdir).toBe('/remote/path');
      expect(session.hostname).toBe('my-session');
      expect(session.status).toBe('connected');
      expect(session.clientId).toBe('');
    });

    it('should default workdir to empty when not provided', () => {
      const session = sessionManager.createRemoteSession('machine-1', 'name');
      expect(session.workdir).toBe('');
      expect(session.remoteWorkdir).toBeUndefined();
    });

    it('should accept role and screenName opts', () => {
      const session = sessionManager.createRemoteSession('machine-1', 'ceo', '/w', {
        role: 'CEO',
        screenName: 'ceo-1',
        interests: ['strategy'],
        rolePrompt: 'You are the CEO.',
        channels: ['general', 'exec'],
      });
      expect(session.role).toBe('CEO');
      expect(session.screenName).toBe('ceo-1');
      expect(session.interests).toEqual(['strategy']);
      expect(session.rolePrompt).toBe('You are the CEO.');
      expect(session.channels).toEqual(['general', 'exec']);
    });

    it('should leave hub fields undefined when opts not provided', () => {
      const session = sessionManager.createRemoteSession('machine-1', 'plain', '/w');
      expect(session.role).toBeUndefined();
      expect(session.screenName).toBeUndefined();
      expect(session.interests).toBeUndefined();
    });
  });

  describe('updateSessionName', () => {
    it('should update the name field', () => {
      const session = sessionManager.createRemoteSession('m1', 'test', '/w');
      sessionManager.updateSessionName(session.sessionId, 'renamed');
      expect(sessionStore.sessionStore.get(session.sessionId)!.name).toBe('renamed');
    });
  });

  describe('updateClaudeSessionId', () => {
    it('should update claudeSessionId', () => {
      const session = sessionManager.createRemoteSession('m1', 'test', '/w');
      sessionManager.updateClaudeSessionId(session.sessionId, 'claude-xyz');
      expect(sessionStore.sessionStore.get(session.sessionId)!.claudeSessionId).toBe('claude-xyz');
    });
  });

  describe('resolveSessionId', () => {
    it('should resolve by prefix', () => {
      const session = sessionManager.createRemoteSession('m1', 'test', '/w');
      const prefix = session.sessionId.slice(0, 8);
      expect(sessionManager.resolveSessionId(prefix)).toBe(session.sessionId);
    });

    it('should resolve by full id', () => {
      const session = sessionManager.createRemoteSession('m1', 'test', '/w');
      expect(sessionManager.resolveSessionId(session.sessionId)).toBe(session.sessionId);
    });

    it('should return undefined for unknown prefix', () => {
      expect(sessionManager.resolveSessionId('nonexistent')).toBeUndefined();
    });
  });
});
