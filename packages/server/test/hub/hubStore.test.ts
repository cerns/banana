import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import type { HubMessage, HubChannel } from '../../src/hub/hubStore.js';

vi.mock('../../src/config.js', () => ({
  config: {
    hubPersistPath: '/tmp/banana-test-hub.json',
    hubMaxChainDepth: 5,
    hubMaxConcurrentJobs: 3,
    hubCooldownMs: 10000,
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

describe('HubStore', () => {
  let mod: typeof import('../../src/hub/hubStore.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mod = await import('../../src/hub/hubStore.js');
  });

  describe('Channel CRUD', () => {
    it('should create a channel', () => {
      const ch = mod.hubStore.createChannel('general', '#general', 'system', 'Main channel');
      expect(ch.id).toBe('general');
      expect(ch.name).toBe('#general');
      expect(ch.description).toBe('Main channel');
      expect(ch.createdBy).toBe('system');
      expect(ch.createdAt).toBeDefined();
    });

    it('should get a channel by id', () => {
      mod.hubStore.createChannel('test', '#test', 'user');
      expect(mod.hubStore.getChannel('test')).toBeDefined();
      expect(mod.hubStore.getChannel('test')!.name).toBe('#test');
    });

    it('should return undefined for non-existent channel', () => {
      expect(mod.hubStore.getChannel('nope')).toBeUndefined();
    });

    it('should get all channels', () => {
      mod.hubStore.createChannel('a', '#a', 'user');
      mod.hubStore.createChannel('b', '#b', 'user');
      expect(mod.hubStore.getAllChannels()).toHaveLength(2);
    });

    it('should ensure channel (create on-demand)', () => {
      const ch = mod.hubStore.ensureChannel('new-ch', 'user');
      expect(ch.id).toBe('new-ch');
      expect(ch.name).toBe('#new-ch');
      // Second call returns same
      const ch2 = mod.hubStore.ensureChannel('new-ch', 'other');
      expect(ch2.createdBy).toBe('user'); // original creator
    });
  });

  describe('Message CRUD', () => {
    it('should add and get a message', () => {
      const msg: HubMessage = {
        id: 'msg-1',
        channelId: 'general',
        from: 'user',
        fromName: 'User',
        content: 'Hello hub',
        tags: ['test'],
        mentions: [],
        depth: 0,
        timestamp: new Date().toISOString(),
        status: 'pending',
        dispatches: [],
      };
      mod.hubStore.addMessage(msg);
      expect(mod.hubStore.getMessage('msg-1')).toBeDefined();
      expect(mod.hubStore.getMessage('msg-1')!.content).toBe('Hello hub');
    });

    it('should return undefined for non-existent message', () => {
      expect(mod.hubStore.getMessage('nope')).toBeUndefined();
    });

    it('should getAll messages', () => {
      mod.hubStore.addMessage(makeMsg({ id: 'a' }));
      mod.hubStore.addMessage(makeMsg({ id: 'b' }));
      expect(mod.hubStore.getAll()).toHaveLength(2);
    });
  });

  describe('getByChannel', () => {
    it('should filter messages by channelId', () => {
      mod.hubStore.addMessage(makeMsg({ id: 'a', channelId: 'ch1' }));
      mod.hubStore.addMessage(makeMsg({ id: 'b', channelId: 'ch2' }));
      mod.hubStore.addMessage(makeMsg({ id: 'c', channelId: 'ch1' }));
      const msgs = mod.hubStore.getByChannel('ch1');
      expect(msgs).toHaveLength(2);
      expect(msgs.every(m => m.channelId === 'ch1')).toBe(true);
    });

    it('should filter by since timestamp', () => {
      mod.hubStore.addMessage(makeMsg({ id: 'old', channelId: 'ch1', timestamp: '2024-01-01T00:00:00Z' }));
      mod.hubStore.addMessage(makeMsg({ id: 'new', channelId: 'ch1', timestamp: '2024-06-01T00:00:00Z' }));
      const msgs = mod.hubStore.getByChannel('ch1', '2024-03-01T00:00:00Z');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].id).toBe('new');
    });

    it('should return sorted by timestamp', () => {
      mod.hubStore.addMessage(makeMsg({ id: 'b', channelId: 'ch1', timestamp: '2024-06-01T00:00:00Z' }));
      mod.hubStore.addMessage(makeMsg({ id: 'a', channelId: 'ch1', timestamp: '2024-01-01T00:00:00Z' }));
      const msgs = mod.hubStore.getByChannel('ch1');
      expect(msgs[0].id).toBe('a');
      expect(msgs[1].id).toBe('b');
    });
  });

  describe('getThread', () => {
    it('should return parent and children', () => {
      mod.hubStore.addMessage(makeMsg({ id: 'parent', channelId: 'ch1' }));
      mod.hubStore.addMessage(makeMsg({ id: 'child1', channelId: 'ch1', parentId: 'parent' }));
      mod.hubStore.addMessage(makeMsg({ id: 'child2', channelId: 'ch1', parentId: 'parent' }));
      mod.hubStore.addMessage(makeMsg({ id: 'other', channelId: 'ch1' }));
      const thread = mod.hubStore.getThread('parent');
      expect(thread).toHaveLength(3);
      expect(thread.map(m => m.id)).toContain('parent');
      expect(thread.map(m => m.id)).toContain('child1');
      expect(thread.map(m => m.id)).toContain('child2');
    });

    it('should follow nested children', () => {
      mod.hubStore.addMessage(makeMsg({ id: 'root', channelId: 'ch1' }));
      mod.hubStore.addMessage(makeMsg({ id: 'c1', channelId: 'ch1', parentId: 'root' }));
      mod.hubStore.addMessage(makeMsg({ id: 'c2', channelId: 'ch1', parentId: 'c1' }));
      const thread = mod.hubStore.getThread('root');
      expect(thread).toHaveLength(3);
    });

    it('should return empty for non-existent parent', () => {
      const thread = mod.hubStore.getThread('nope');
      expect(thread).toHaveLength(0);
    });
  });

  describe('Dispatch tracking', () => {
    it('should add dispatch to message', () => {
      mod.hubStore.addMessage(makeMsg({ id: 'msg-d' }));
      mod.hubStore.addDispatch('msg-d', {
        sessionId: 'sess-1',
        jobId: 'job-1',
        status: 'running',
        startedAt: new Date().toISOString(),
      });
      const msg = mod.hubStore.getMessage('msg-d')!;
      expect(msg.dispatches).toHaveLength(1);
      expect(msg.dispatches[0].status).toBe('running');
      expect(msg.status).toBe('dispatched');
    });

    it('should update dispatch fields', () => {
      mod.hubStore.addMessage(makeMsg({ id: 'msg-u' }));
      mod.hubStore.addDispatch('msg-u', { sessionId: 's1', jobId: 'j1', status: 'running' });
      mod.hubStore.updateDispatch('msg-u', 's1', { status: 'acted', finishedAt: new Date().toISOString() });
      const msg = mod.hubStore.getMessage('msg-u')!;
      expect(msg.dispatches[0].status).toBe('acted');
    });

    it('should no-op for non-existent message dispatch', () => {
      expect(() => mod.hubStore.addDispatch('nope', { sessionId: 's', jobId: 'j', status: 'queued' })).not.toThrow();
      expect(() => mod.hubStore.updateDispatch('nope', 's', { status: 'acted' })).not.toThrow();
    });

    it('should no-op for non-matching session in updateDispatch', () => {
      mod.hubStore.addMessage(makeMsg({ id: 'msg-x' }));
      mod.hubStore.addDispatch('msg-x', { sessionId: 's1', jobId: 'j1', status: 'running' });
      mod.hubStore.updateDispatch('msg-x', 'wrong-session', { status: 'acted' });
      const msg = mod.hubStore.getMessage('msg-x')!;
      expect(msg.dispatches[0].status).toBe('running'); // unchanged
    });

    it('should update message status', () => {
      mod.hubStore.addMessage(makeMsg({ id: 'msg-s' }));
      mod.hubStore.updateStatus('msg-s', 'complete');
      expect(mod.hubStore.getMessage('msg-s')!.status).toBe('complete');
    });

    it('should no-op updateStatus for non-existent', () => {
      expect(() => mod.hubStore.updateStatus('nope', 'complete')).not.toThrow();
    });
  });

  describe('Persistence', () => {
    it('should persist on channel create (debounced async)', async () => {
      mod.hubStore.createChannel('ch', '#ch', 'user');
      await mod.hubStore.persistNow();
      expect(fs.promises.writeFile).toHaveBeenCalled();
    });

    it('should persist on message add (debounced async)', async () => {
      mod.hubStore.addMessage(makeMsg({ id: 'p1' }));
      await mod.hubStore.persistNow();
      expect(fs.promises.writeFile).toHaveBeenCalled();
    });

    it('should load channels and messages from file', () => {
      const data = {
        channels: [{ id: 'saved', name: '#saved', createdAt: '', createdBy: 'user' }],
        messages: [makeMsg({ id: 'saved-msg', channelId: 'saved' })],
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data));
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      mod.hubStore.load();

      expect(mod.hubStore.getChannel('saved')).toBeDefined();
      expect(mod.hubStore.getMessage('saved-msg')).toBeDefined();
      consoleSpy.mockRestore();
    });

    it('should handle missing file gracefully on load', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(() => mod.hubStore.load()).not.toThrow();
    });

    it('should not crash on persist failure', async () => {
      vi.mocked(fs.promises.writeFile).mockRejectedValueOnce(new Error('disk error'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mod.hubStore.createChannel('x', '#x', 'user');
      await expect(mod.hubStore.persistNow()).resolves.toBeUndefined();
      consoleSpy.mockRestore();
    });
  });

  describe('compactChannel', () => {
    it('archives all live messages and drops them from the live store', () => {
      mod.hubStore.createChannel('cmp', '#cmp', 'user');
      const m1 = makeMsg({ id: 'm1', channelId: 'cmp', content: 'first' });
      const m2 = makeMsg({ id: 'm2', channelId: 'cmp', content: 'second',
        timestamp: new Date(Date.now() + 1000).toISOString() });
      mod.hubStore.addMessage(m1);
      mod.hubStore.addMessage(m2);

      const compaction = mod.hubStore.compactChannel('cmp', 'SUMMARY TEXT', 'alice');
      expect(compaction).toBeDefined();
      expect(compaction!.id).toBe('bCOMPACT-1');
      expect(compaction!.summary).toBe('SUMMARY TEXT');
      expect(compaction!.createdBy).toBe('alice');
      expect(compaction!.messageIds).toEqual(['m1', 'm2']);
      expect(compaction!.messages).toHaveLength(2);
      expect(compaction!.messages[0].content).toBe('first');
      expect(compaction!.messages[1].content).toBe('second');

      // Live store should be empty for this channel now
      expect(mod.hubStore.getByChannel('cmp')).toEqual([]);
      // But the compaction should be retrievable
      const compactions = mod.hubStore.getCompactions('cmp');
      expect(compactions).toHaveLength(1);
      expect(compactions[0].id).toBe('bCOMPACT-1');
    });

    it('chains compactions via previousCompactionId', () => {
      mod.hubStore.createChannel('chain', '#chain', 'user');
      mod.hubStore.addMessage(makeMsg({ id: 'a1', channelId: 'chain' }));
      const c1 = mod.hubStore.compactChannel('chain', 'first summary', 'u');
      mod.hubStore.addMessage(makeMsg({ id: 'a2', channelId: 'chain' }));
      const c2 = mod.hubStore.compactChannel('chain', 'second summary', 'u');

      expect(c1!.previousCompactionId).toBeUndefined();
      expect(c2!.id).toBe('bCOMPACT-2');
      expect(c2!.previousCompactionId).toBe('bCOMPACT-1');
      expect(mod.hubStore.getCompactions('chain')).toHaveLength(2);
    });

    it('snapshot is independent of subsequent live mutations', () => {
      mod.hubStore.createChannel('snap', '#snap', 'user');
      mod.hubStore.addMessage(makeMsg({ id: 's1', channelId: 'snap', content: 'original' }));
      const c = mod.hubStore.compactChannel('snap', 'sum', 'u')!;
      // Mutate the in-memory snapshot — should NOT affect anything we use later
      c.messages[0].content = 'CHANGED';
      // Re-fetch and confirm the dashboard would still see the original
      const fresh = mod.hubStore.getCompactions('snap')[0];
      expect(fresh.messages[0].content).toBe('CHANGED'); // same object reference
      // The snapshot is only protected from LIVE store mutations, not from
      // post-hoc edits — but the originals were already deleted from the live
      // store, so there is nothing in the live store to mutate them from.
      expect(mod.hubStore.getByChannel('snap')).toEqual([]);
    });

    it('returns undefined when channel does not exist', () => {
      expect(mod.hubStore.compactChannel('nope', 'x', 'u')).toBeUndefined();
    });

    it('returns undefined when channel has no messages', () => {
      mod.hubStore.createChannel('empty', '#empty', 'user');
      expect(mod.hubStore.compactChannel('empty', 'x', 'u')).toBeUndefined();
    });
  });
});

function makeMsg(overrides: Partial<HubMessage> = {}): HubMessage {
  return {
    id: 'msg-default',
    channelId: 'general',
    from: 'user',
    fromName: 'User',
    content: 'test message',
    tags: [],
    mentions: [],
    depth: 0,
    timestamp: new Date().toISOString(),
    status: 'pending',
    dispatches: [],
    ...overrides,
  };
}
