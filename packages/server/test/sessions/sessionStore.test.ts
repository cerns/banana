import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import type { SessionRecord, JobRecord } from '../../src/sessions/sessionStore.js';

vi.mock('../../src/config.js', () => ({
  config: {
    persistPath: '/tmp/banana-test-sessions.json',
    historyMax: 5,
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const promises = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      promises,
    },
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    promises,
  };
});

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: 'sess-1',
    clientId: 'client-1',
    hostname: 'test-host',
    workdir: '/home/test',
    connectedAt: '2024-01-01T00:00:00.000Z',
    status: 'connected',
    jobs: [],
    type: 'local',
    ...overrides,
  };
}

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: 'job-1',
    prompt: 'hello world',
    startedAt: '2024-01-01T00:00:00.000Z',
    chunks: [],
    ...overrides,
  };
}

describe('SessionStore', () => {
  let mod: typeof import('../../src/sessions/sessionStore.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mod = await import('../../src/sessions/sessionStore.js');
  });

  describe('basic CRUD', () => {
    it('should return undefined for non-existent session', () => {
      expect(mod.sessionStore.get('nonexistent')).toBeUndefined();
    });

    it('should upsert and get a session', () => {
      const session = makeSession();
      mod.sessionStore.upsert(session);
      expect(mod.sessionStore.get('sess-1')).toBeDefined();
      expect(mod.sessionStore.get('sess-1')!.hostname).toBe('test-host');
    });

    it('should getAll sessions', () => {
      mod.sessionStore.upsert(makeSession({ sessionId: 'a' }));
      mod.sessionStore.upsert(makeSession({ sessionId: 'b' }));
      expect(mod.sessionStore.getAll()).toHaveLength(2);
    });

    it('should findByClientId', () => {
      mod.sessionStore.upsert(makeSession({ clientId: 'c1' }));
      expect(mod.sessionStore.findByClientId('c1')).toBeDefined();
      expect(mod.sessionStore.findByClientId('c1')!.clientId).toBe('c1');
    });

    it('should return undefined for unknown clientId', () => {
      expect(mod.sessionStore.findByClientId('unknown')).toBeUndefined();
    });
  });

  describe('addChunk', () => {
    it('should add chunks to a job', () => {
      const session = makeSession({ jobs: [makeJob()] });
      mod.sessionStore.upsert(session);

      mod.sessionStore.addChunk('sess-1', 'job-1', { type: 'text', text: 'hello' });
      const result = mod.sessionStore.get('sess-1')!;
      expect(result.jobs[0].chunks).toHaveLength(1);
    });

    it('should respect historyMax limit', () => {
      const session = makeSession({ jobs: [makeJob()] });
      mod.sessionStore.upsert(session);

      for (let i = 0; i < 10; i++) {
        mod.sessionStore.addChunk('sess-1', 'job-1', { i });
      }
      // historyMax is 5
      expect(mod.sessionStore.get('sess-1')!.jobs[0].chunks).toHaveLength(5);
    });

    it('should no-op for non-existent session', () => {
      expect(() => mod.sessionStore.addChunk('none', 'job-1', {})).not.toThrow();
    });

    it('should no-op for non-existent job', () => {
      mod.sessionStore.upsert(makeSession());
      expect(() => mod.sessionStore.addChunk('sess-1', 'no-job', {})).not.toThrow();
    });
  });

  describe('finishJob', () => {
    it('should set exitCode, durationMs, finishedAt', () => {
      const session = makeSession({ jobs: [makeJob()] });
      mod.sessionStore.upsert(session);

      mod.sessionStore.finishJob('sess-1', 'job-1', 0, 1500);
      const job = mod.sessionStore.get('sess-1')!.jobs[0];
      expect(job.exitCode).toBe(0);
      expect(job.durationMs).toBe(1500);
      expect(job.finishedAt).toBeDefined();
    });

    it('should no-op for non-existent session', () => {
      expect(() => mod.sessionStore.finishJob('none', 'job-1', 0, 100)).not.toThrow();
    });

    it('should no-op for non-existent job', () => {
      mod.sessionStore.upsert(makeSession());
      expect(() => mod.sessionStore.finishJob('sess-1', 'no-job', 0, 100)).not.toThrow();
    });
  });

  describe('errorJob', () => {
    it('should set error and finishedAt', () => {
      const session = makeSession({ jobs: [makeJob()] });
      mod.sessionStore.upsert(session);

      mod.sessionStore.errorJob('sess-1', 'job-1', 'something went wrong');
      const job = mod.sessionStore.get('sess-1')!.jobs[0];
      expect(job.error).toBe('something went wrong');
      expect(job.finishedAt).toBeDefined();
    });

    it('should no-op for non-existent session', () => {
      expect(() => mod.sessionStore.errorJob('none', 'job-1', 'err')).not.toThrow();
    });

    it('should no-op for non-existent job', () => {
      mod.sessionStore.upsert(makeSession());
      expect(() => mod.sessionStore.errorJob('sess-1', 'no-job', 'err')).not.toThrow();
    });
  });

  describe('updateMeta', () => {
    it('should update name', () => {
      mod.sessionStore.upsert(makeSession());
      mod.sessionStore.updateMeta('sess-1', { name: 'my-session' });
      expect(mod.sessionStore.get('sess-1')!.name).toBe('my-session');
    });

    it('should update claudeSessionId', () => {
      mod.sessionStore.upsert(makeSession());
      mod.sessionStore.updateMeta('sess-1', { claudeSessionId: 'claude-abc' });
      expect(mod.sessionStore.get('sess-1')!.claudeSessionId).toBe('claude-abc');
    });

    it('should update remoteWorkdir', () => {
      mod.sessionStore.upsert(makeSession());
      mod.sessionStore.updateMeta('sess-1', { remoteWorkdir: '/new/path' });
      expect(mod.sessionStore.get('sess-1')!.remoteWorkdir).toBe('/new/path');
    });

    it('should no-op for non-existent session', () => {
      expect(() => mod.sessionStore.updateMeta('none', { name: 'x' })).not.toThrow();
    });

    it('should update role', () => {
      mod.sessionStore.upsert(makeSession());
      mod.sessionStore.updateMeta('sess-1', { role: 'CEO' });
      expect(mod.sessionStore.get('sess-1')!.role).toBe('CEO');
    });

    it('should update screenName', () => {
      mod.sessionStore.upsert(makeSession());
      mod.sessionStore.updateMeta('sess-1', { screenName: 'ceo-1' });
      expect(mod.sessionStore.get('sess-1')!.screenName).toBe('ceo-1');
    });

    it('should update interests', () => {
      mod.sessionStore.upsert(makeSession());
      mod.sessionStore.updateMeta('sess-1', { interests: ['backend', 'api'] });
      expect(mod.sessionStore.get('sess-1')!.interests).toEqual(['backend', 'api']);
    });

    it('should update channels', () => {
      mod.sessionStore.upsert(makeSession());
      mod.sessionStore.updateMeta('sess-1', { channels: ['general', 'dev'] });
      expect(mod.sessionStore.get('sess-1')!.channels).toEqual(['general', 'dev']);
    });

    it('should update hubQueue', () => {
      mod.sessionStore.upsert(makeSession());
      mod.sessionStore.updateMeta('sess-1', {
        hubQueue: [{ hubMessageId: 'msg-1', queuedAt: '2024-01-01T00:00:00Z' }],
      });
      expect(mod.sessionStore.get('sess-1')!.hubQueue).toHaveLength(1);
    });
  });

  describe('load', () => {
    it('should load sessions from file', () => {
      const sessions = [
        makeSession({ sessionId: 's1', status: 'connected' }),
        makeSession({ sessionId: 's2', status: 'connected' }),
      ];
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(sessions));
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      mod.sessionStore.load();

      expect(mod.sessionStore.getAll()).toHaveLength(2);
      // All loaded sessions should be set to disconnected
      expect(mod.sessionStore.get('s1')!.status).toBe('disconnected');
      expect(mod.sessionStore.get('s2')!.status).toBe('disconnected');
      consoleSpy.mockRestore();
    });

    it('should normalize legacy records without type field', () => {
      const legacy = [{ sessionId: 'legacy-1', clientId: 'c1', hostname: 'h', workdir: '/w', connectedAt: '', status: 'connected', jobs: [] }];
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(legacy));
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      mod.sessionStore.load();

      const loaded = mod.sessionStore.get('legacy-1');
      expect(loaded!.type).toBe('local');
      consoleSpy.mockRestore();
    });

    it('should handle missing file gracefully', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(() => mod.sessionStore.load()).not.toThrow();
    });
  });

  describe('persist', () => {
    it('should write to disk on upsert (debounced async)', async () => {
      mod.sessionStore.upsert(makeSession());
      await mod.sessionStore.persistNow();
      expect(fs.promises.writeFile).toHaveBeenCalled();
      expect(fs.promises.rename).toHaveBeenCalled();
    });

    it('should not crash on persist failure', async () => {
      vi.mocked(fs.promises.writeFile).mockRejectedValueOnce(new Error('disk error'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mod.sessionStore.upsert(makeSession());
      await expect(mod.sessionStore.persistNow()).resolves.toBeUndefined();
      consoleSpy.mockRestore();
    });

    it('should debounce many writes into one', async () => {
      vi.mocked(fs.promises.writeFile).mockClear();
      mod.sessionStore.upsert(makeSession({ sessionId: 's-debounce-1' }));
      mod.sessionStore.upsert(makeSession({ sessionId: 's-debounce-2' }));
      mod.sessionStore.upsert(makeSession({ sessionId: 's-debounce-3' }));
      // No write yet — debounced
      expect(fs.promises.writeFile).not.toHaveBeenCalled();
      await mod.sessionStore.persistNow();
      expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
    });
  });
});
