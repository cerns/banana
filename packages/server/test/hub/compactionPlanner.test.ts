import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  formatMessageForTranscript,
  splitMessagesIntoChunks,
  buildTranscript,
  TRANSCRIPT_SEPARATOR,
} from '../../src/hub/compactionPlanner.js';
import type { HubMessage } from '../../src/hub/hubStore.js';

function makeMsg(id: string, content: string, overrides: Partial<HubMessage> = {}): HubMessage {
  return {
    id,
    channelId: 'ch',
    from: 'u',
    fromName: 'U',
    content,
    tags: [],
    mentions: [],
    depth: 0,
    timestamp: '2024-01-01T00:00:00Z',
    status: 'pending',
    dispatches: [],
    ...overrides,
  };
}

describe('compactionPlanner', () => {
  describe('estimateTokens', () => {
    it('returns 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('uses ~4 chars per token heuristic', () => {
      expect(estimateTokens('abcd')).toBe(1);
      expect(estimateTokens('a'.repeat(400))).toBe(100);
      expect(estimateTokens('a'.repeat(401))).toBe(101);
    });
  });

  describe('formatMessageForTranscript', () => {
    it('includes name, timestamp, depth, and content', () => {
      const m = makeMsg('a', 'hello world');
      const out = formatMessageForTranscript(m);
      expect(out).toContain('U');
      expect(out).toContain('2024-01-01');
      expect(out).toContain('hello world');
      expect(out).toContain('depth 0');
    });

    it('includes tags when present', () => {
      const m = makeMsg('a', 'hi', { tags: ['perf', 'frontend'] });
      expect(formatMessageForTranscript(m)).toContain('[perf,frontend]');
    });

    it('omits tag block when no tags', () => {
      const out = formatMessageForTranscript(makeMsg('a', 'hi'));
      expect(out).not.toContain('[]');
    });
  });

  describe('splitMessagesIntoChunks', () => {
    it('returns empty array for empty input', () => {
      expect(splitMessagesIntoChunks([], 100)).toEqual([]);
    });

    it('returns a single chunk when everything fits', () => {
      const msgs = [makeMsg('a', 'short'), makeMsg('b', 'short'), makeMsg('c', 'short')];
      const chunks = splitMessagesIntoChunks(msgs, 10000);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toHaveLength(3);
    });

    it('splits into multiple chunks when total exceeds the budget', () => {
      // Each message ~50 tokens (200 chars). Budget 100 tokens → ~2 messages per chunk.
      const msgs = Array.from({ length: 6 }, (_, i) => makeMsg(`m${i}`, 'x'.repeat(180)));
      const chunks = splitMessagesIntoChunks(msgs, 100);
      expect(chunks.length).toBeGreaterThan(1);
      // Total messages preserved across chunks
      const total = chunks.reduce((s, c) => s + c.length, 0);
      expect(total).toBe(6);
    });

    it('preserves message order across chunks', () => {
      const msgs = Array.from({ length: 12 }, (_, i) => makeMsg(`m${i}`, 'x'.repeat(200)));
      const chunks = splitMessagesIntoChunks(msgs, 100);
      const flatIds = chunks.flat().map(m => m.id);
      expect(flatIds).toEqual(msgs.map(m => m.id));
    });

    it('never splits a single message — oversized message becomes its own chunk', () => {
      const huge = makeMsg('huge', 'x'.repeat(10000));
      const small = makeMsg('small', 'tiny');
      const chunks = splitMessagesIntoChunks([huge, small], 100);
      // huge gets its own (oversized) chunk; small is in a separate chunk
      const hugeChunk = chunks.find(c => c.some(m => m.id === 'huge'));
      expect(hugeChunk).toBeDefined();
      expect(hugeChunk!.find(m => m.id === 'huge')).toBeDefined();
      // huge message content is preserved unchanged
      expect(hugeChunk!.find(m => m.id === 'huge')!.content.length).toBe(10000);
    });

    it('keeps an oversized message at the front in its own chunk', () => {
      const huge = makeMsg('huge', 'x'.repeat(10000));
      const a = makeMsg('a', 'tiny');
      const b = makeMsg('b', 'tiny');
      const chunks = splitMessagesIntoChunks([a, huge, b], 100);
      // Order is preserved: small a, then big chunk, then small b
      const flat = chunks.flat().map(m => m.id);
      expect(flat).toEqual(['a', 'huge', 'b']);
      // The huge message gets its own chunk (cannot share with anything since
      // it alone overflows the budget)
      const hugeChunk = chunks.find(c => c.length === 1 && c[0].id === 'huge');
      expect(hugeChunk).toBeDefined();
    });

    it('returns single chunk when maxTokensPerChunk is non-positive (degenerate)', () => {
      const msgs = [makeMsg('a', 'x'), makeMsg('b', 'y')];
      const chunks = splitMessagesIntoChunks(msgs, 0);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toHaveLength(2);
    });
  });

  describe('buildTranscript', () => {
    it('joins messages with the canonical separator', () => {
      const msgs = [makeMsg('a', 'one'), makeMsg('b', 'two')];
      const t = buildTranscript(msgs);
      expect(t).toContain('one');
      expect(t).toContain('two');
      expect(t).toContain(TRANSCRIPT_SEPARATOR);
    });

    it('returns empty string for empty input', () => {
      expect(buildTranscript([])).toBe('');
    });
  });
});
