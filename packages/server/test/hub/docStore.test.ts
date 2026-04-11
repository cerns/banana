import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

vi.mock('../../src/config.js', () => ({
  config: {
    docsPersistPath: '/tmp/banana-test-docs.json',
    docRevisionMax: 3,
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

describe('DocStore', () => {
  let mod: typeof import('../../src/hub/docStore.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mod = await import('../../src/hub/docStore.js');
  });

  describe('createDoc', () => {
    it('generates sequential bCONF-N per channel', () => {
      const a = mod.docStore.createDoc('ch1', 'A', 'body a', 'alice');
      const b = mod.docStore.createDoc('ch1', 'B', 'body b', 'alice');
      expect(a.id).toBe('bCONF-1');
      expect(b.id).toBe('bCONF-2');
      expect(a.version).toBe(1);
    });

    it('isolates sequence numbers across channels', () => {
      const a = mod.docStore.createDoc('ch1', 'A', 'a', 'u');
      const b = mod.docStore.createDoc('ch2', 'B', 'b', 'u');
      expect(a.id).toBe('bCONF-1');
      expect(b.id).toBe('bCONF-1');
    });

    it('starts with empty history', () => {
      const d = mod.docStore.createDoc('ch1', 'A', 'a', 'u');
      expect(d.history).toEqual([]);
    });
  });

  describe('updateDoc', () => {
    it('bumps version and archives prior revision', () => {
      const d = mod.docStore.createDoc('ch1', 'Title', 'v1 body', 'alice');
      mod.docStore.updateDoc(d.id, { body: 'v2 body' }, 'bob');
      const updated = mod.docStore.getDoc(d.id)!;
      expect(updated.version).toBe(2);
      expect(updated.body).toBe('v2 body');
      expect(updated.history).toHaveLength(1);
      expect(updated.history[0].version).toBe(1);
      expect(updated.history[0].body).toBe('v1 body');
    });

    it('updates title and tags', () => {
      const d = mod.docStore.createDoc('ch1', 'Old', 'b', 'u');
      mod.docStore.updateDoc(d.id, { title: 'New', tags: ['x'] }, 'u');
      const updated = mod.docStore.getDoc(d.id)!;
      expect(updated.title).toBe('New');
      expect(updated.tags).toEqual(['x']);
      expect(updated.version).toBe(2);
    });

    it('caps history at docRevisionMax (3 in tests)', () => {
      const d = mod.docStore.createDoc('ch1', 'A', 'v1', 'u');
      for (let i = 2; i <= 7; i++) {
        mod.docStore.updateDoc(d.id, { body: `v${i}` }, 'u');
      }
      const updated = mod.docStore.getDoc(d.id)!;
      expect(updated.version).toBe(7);
      expect(updated.history).toHaveLength(3);
      // Oldest retained should be the most recent 3 versions before current
      expect(updated.history.map(h => h.body)).toEqual(['v4', 'v5', 'v6']);
    });

    it('returns undefined for unknown doc', () => {
      expect(mod.docStore.updateDoc('bCONF-99', { body: 'x' }, 'u')).toBeUndefined();
    });

    it('no-op when no fields change', () => {
      const d = mod.docStore.createDoc('ch1', 'A', 'b', 'u');
      mod.docStore.updateDoc(d.id, {}, 'u');
      const updated = mod.docStore.getDoc(d.id)!;
      expect(updated.version).toBe(1);
      expect(updated.history).toHaveLength(0);
    });
  });

  describe('appendDoc', () => {
    it('appends body and bumps version', () => {
      const d = mod.docStore.createDoc('ch1', 'A', 'orig', 'u');
      mod.docStore.appendDoc(d.id, 'extra', 'bob');
      const updated = mod.docStore.getDoc(d.id)!;
      expect(updated.body).toBe('orig\n\nextra');
      expect(updated.version).toBe(2);
      expect(updated.history).toHaveLength(1);
      expect(updated.history[0].body).toBe('orig');
    });

    it('returns undefined for unknown doc', () => {
      expect(mod.docStore.appendDoc('bCONF-99', 'x', 'u')).toBeUndefined();
    });
  });

  describe('search', () => {
    beforeEach(() => {
      mod.docStore.createDoc('ch1', 'Auth Spec', '# Auth\nUses JWT for tokens', 'alice', ['auth', 'security']);
      mod.docStore.createDoc('ch1', 'Perf Plan', '# Performance\nLighthouse > 90', 'bob', ['perf']);
      mod.docStore.createDoc('ch2', 'Other', 'unrelated', 'u');
    });

    it('matches title substring', () => {
      const r = mod.docStore.search('ch1', 'auth');
      expect(r).toHaveLength(1);
    });

    it('matches body substring', () => {
      const r = mod.docStore.search('ch1', 'lighthouse');
      expect(r).toHaveLength(1);
      expect(r[0].title).toBe('Perf Plan');
    });

    it('filters by tag intersection', () => {
      const r = mod.docStore.search('ch1', undefined, ['security']);
      expect(r).toHaveLength(1);
    });

    it('combines q and tag filter', () => {
      const r = mod.docStore.search('ch1', 'jwt', ['auth']);
      expect(r).toHaveLength(1);
    });
  });

  describe('removeDoc', () => {
    it('removes a doc', () => {
      const d = mod.docStore.createDoc('ch1', 'X', 'b', 'u');
      expect(mod.docStore.removeDoc(d.id)).toBe(true);
      expect(mod.docStore.getDoc(d.id)).toBeUndefined();
    });

    it('returns false for unknown', () => {
      expect(mod.docStore.removeDoc('bCONF-99')).toBe(false);
    });
  });

  describe('persistence', () => {
    it('persists on create', async () => {
      mod.docStore.createDoc('ch1', 'A', 'b', 'u');
      await mod.docStore.persistNow();
      expect(fs.promises.writeFile).toHaveBeenCalled();
    });

    it('round-trips through load()', () => {
      const data = {
        docs: [{
          id: 'bCONF-3', channelId: 'ch1', title: 'restored', body: 'b', tags: [],
          author: 'u', createdAt: '', updatedAt: '', version: 1, history: [],
        }],
        seqs: [['ch1', 3]],
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data));
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      mod.docStore.load();

      expect(mod.docStore.getDoc('bCONF-3')).toBeDefined();
      const next = mod.docStore.createDoc('ch1', 'next', 'b', 'u');
      expect(next.id).toBe('bCONF-4');
      consoleSpy.mockRestore();
    });

    it('handles missing file gracefully', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(() => mod.docStore.load()).not.toThrow();
    });
  });
});
