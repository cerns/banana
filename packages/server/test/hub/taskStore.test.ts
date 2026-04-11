import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

vi.mock('../../src/config.js', () => ({
  config: {
    tasksPersistPath: '/tmp/banana-test-tasks.json',
    docRevisionMax: 20,
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

describe('TaskStore', () => {
  let mod: typeof import('../../src/hub/taskStore.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mod = await import('../../src/hub/taskStore.js');
  });

  describe('createTask', () => {
    it('generates sequential bJIRA-N per channel', () => {
      const a = mod.taskStore.createTask('ch1', { title: 'first' }, 'alice');
      const b = mod.taskStore.createTask('ch1', { title: 'second' }, 'alice');
      expect(a.id).toBe('bJIRA-1');
      expect(b.id).toBe('bJIRA-2');
    });

    it('isolates sequence numbers across channels', () => {
      const a = mod.taskStore.createTask('ch1', { title: 'a' }, 'u');
      const b = mod.taskStore.createTask('ch2', { title: 'b' }, 'u');
      const c = mod.taskStore.createTask('ch1', { title: 'c' }, 'u');
      expect(a.id).toBe('bJIRA-1');
      expect(b.id).toBe('bJIRA-1');
      expect(c.id).toBe('bJIRA-2');
    });

    it('records a "created" activity entry', () => {
      const t = mod.taskStore.createTask('ch1', { title: 'x' }, 'alice');
      expect(t.activity).toHaveLength(1);
      expect(t.activity[0].kind).toBe('created');
      expect(t.activity[0].by).toBe('alice');
    });

    it('defaults status to open', () => {
      const t = mod.taskStore.createTask('ch1', { title: 'x' }, 'u');
      expect(t.status).toBe('open');
    });
  });

  describe('updateTask', () => {
    it('appends activity entry on status change with from/to', () => {
      const t = mod.taskStore.createTask('ch1', { title: 'x' }, 'u');
      mod.taskStore.updateTask(t.id, { status: 'in_progress' }, 'alice');
      const updated = mod.taskStore.getTask(t.id)!;
      expect(updated.status).toBe('in_progress');
      const log = updated.activity.find(a => a.kind === 'status');
      expect(log).toBeDefined();
      expect(log!.from).toBe('open');
      expect(log!.to).toBe('in_progress');
      expect(log!.by).toBe('alice');
    });

    it('appends activity entry on assignee change', () => {
      const t = mod.taskStore.createTask('ch1', { title: 'x', assignee: 'bob' }, 'u');
      mod.taskStore.updateTask(t.id, { assignee: 'carol' }, 'alice');
      const updated = mod.taskStore.getTask(t.id)!;
      const log = updated.activity.find(a => a.kind === 'assignee');
      expect(log).toBeDefined();
      expect(log!.from).toBe('bob');
      expect(log!.to).toBe('carol');
    });

    it('sets closedAt when transitioning to done', () => {
      const t = mod.taskStore.createTask('ch1', { title: 'x' }, 'u');
      mod.taskStore.updateTask(t.id, { status: 'done' }, 'alice');
      expect(mod.taskStore.getTask(t.id)!.closedAt).toBeDefined();
    });

    it('clears closedAt when reopening', () => {
      const t = mod.taskStore.createTask('ch1', { title: 'x' }, 'u');
      mod.taskStore.updateTask(t.id, { status: 'done' }, 'u');
      mod.taskStore.updateTask(t.id, { status: 'open' }, 'u');
      expect(mod.taskStore.getTask(t.id)!.closedAt).toBeUndefined();
    });

    it('returns undefined for unknown task', () => {
      expect(mod.taskStore.updateTask('bJIRA-999', { status: 'done' }, 'u')).toBeUndefined();
    });

    it('does not log status change when status is unchanged', () => {
      const t = mod.taskStore.createTask('ch1', { title: 'x' }, 'u');
      mod.taskStore.updateTask(t.id, { status: 'open' }, 'u');
      const updated = mod.taskStore.getTask(t.id)!;
      const statusLogs = updated.activity.filter(a => a.kind === 'status');
      expect(statusLogs).toHaveLength(0);
    });
  });

  describe('addComment', () => {
    it('appends a comment activity', () => {
      const t = mod.taskStore.createTask('ch1', { title: 'x' }, 'u');
      mod.taskStore.addComment(t.id, 'looks good', 'reviewer');
      const updated = mod.taskStore.getTask(t.id)!;
      const c = updated.activity.find(a => a.kind === 'comment');
      expect(c).toBeDefined();
      expect(c!.text).toBe('looks good');
      expect(c!.by).toBe('reviewer');
    });

    it('returns undefined for unknown task', () => {
      expect(mod.taskStore.addComment('bJIRA-999', 'x', 'u')).toBeUndefined();
    });
  });

  describe('getByChannel', () => {
    beforeEach(() => {
      mod.taskStore.createTask('ch1', { title: 'open task', tags: ['perf'], assignee: 'alice' }, 'u');
      mod.taskStore.createTask('ch1', { title: 'done task', status: 'done', tags: ['auth'], assignee: 'bob' }, 'u');
      mod.taskStore.createTask('ch1', { title: 'blocked', status: 'blocked', tags: ['perf', 'frontend'] }, 'u');
      mod.taskStore.createTask('ch2', { title: 'other ch' }, 'u');
    });

    it('returns only tasks for given channel', () => {
      const ch1 = mod.taskStore.getByChannel('ch1');
      expect(ch1).toHaveLength(3);
    });

    it('filters by status array', () => {
      const open = mod.taskStore.getByChannel('ch1', { status: ['open', 'blocked'] });
      expect(open).toHaveLength(2);
    });

    it('filters by assignee', () => {
      const alice = mod.taskStore.getByChannel('ch1', { assignee: 'alice' });
      expect(alice).toHaveLength(1);
      expect(alice[0].title).toBe('open task');
    });

    it('filters by tag', () => {
      const perf = mod.taskStore.getByChannel('ch1', { tag: 'perf' });
      expect(perf).toHaveLength(2);
    });
  });

  describe('search', () => {
    beforeEach(() => {
      mod.taskStore.createTask('ch1', {
        title: 'Fix LCP > 4s', description: 'Lighthouse score', tags: ['perf'],
      }, 'u');
      mod.taskStore.createTask('ch1', {
        title: 'JWT refresh', tags: ['auth', 'backend'],
      }, 'u');
      mod.taskStore.createTask('ch2', { title: 'other channel LCP' }, 'u');
    });

    it('matches title substring (case-insensitive)', () => {
      const r = mod.taskStore.search('ch1', 'lcp');
      expect(r).toHaveLength(1);
      expect(r[0].title).toContain('LCP');
    });

    it('matches description substring', () => {
      const r = mod.taskStore.search('ch1', 'lighthouse');
      expect(r).toHaveLength(1);
    });

    it('matches comment text', () => {
      const t = mod.taskStore.search('ch1', 'lighthouse')[0];
      mod.taskStore.addComment(t.id, 'extra note about something else', 'u');
      const r = mod.taskStore.search('ch1', 'extra note');
      expect(r).toHaveLength(1);
    });

    it('filters by tag intersection', () => {
      const r = mod.taskStore.search('ch1', undefined, ['auth']);
      expect(r).toHaveLength(1);
      expect(r[0].title).toContain('JWT');
    });

    it('combines q and tag filter', () => {
      const r = mod.taskStore.search('ch1', 'jwt', ['auth']);
      expect(r).toHaveLength(1);
    });

    it('returns empty for non-matching channel', () => {
      const r = mod.taskStore.search('nope', 'lcp');
      expect(r).toHaveLength(0);
    });
  });

  describe('removeTask', () => {
    it('removes a task and returns true', () => {
      const t = mod.taskStore.createTask('ch1', { title: 'x' }, 'u');
      expect(mod.taskStore.removeTask(t.id)).toBe(true);
      expect(mod.taskStore.getTask(t.id)).toBeUndefined();
    });

    it('returns false for unknown task', () => {
      expect(mod.taskStore.removeTask('bJIRA-999')).toBe(false);
    });
  });

  describe('persistence', () => {
    it('persists on create', async () => {
      mod.taskStore.createTask('ch1', { title: 'persist me' }, 'u');
      await mod.taskStore.persistNow();
      expect(fs.promises.writeFile).toHaveBeenCalled();
    });

    it('round-trips through load()', () => {
      const data = {
        tasks: [{
          id: 'bJIRA-7', channelId: 'ch1', title: 'restored', status: 'open',
          reporter: 'u', tags: [], createdAt: '', updatedAt: '', activity: [],
        }],
        seqs: [['ch1', 7]],
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data));
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      mod.taskStore.load();

      expect(mod.taskStore.getTask('bJIRA-7')).toBeDefined();
      expect(mod.taskStore.getTask('bJIRA-7')!.title).toBe('restored');
      // Sequence is restored: next create in ch1 gets bJIRA-8
      const next = mod.taskStore.createTask('ch1', { title: 'next' }, 'u');
      expect(next.id).toBe('bJIRA-8');
      consoleSpy.mockRestore();
    });

    it('handles missing file gracefully', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(() => mod.taskStore.load()).not.toThrow();
    });
  });
});
