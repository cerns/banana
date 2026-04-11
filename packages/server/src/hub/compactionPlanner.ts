/**
 * Pure helpers for planning a channel compaction:
 *   - token estimation (cheap heuristic ≈ 4 chars per token)
 *   - canonical "transcript line" formatting for a hub message
 *   - splitting an ordered message list into chunks that each fit under
 *     a maximum token budget without ever splitting a message in the middle
 *
 * Kept dependency-free so it can be unit tested without spinning up the
 * SSH / hub stack.
 */

import type { HubMessage } from './hubStore.js';

/**
 * Conservative chars-per-token heuristic for English + code mixed text.
 * Real tokenizers vary by model; 4.0 is a safe default for Claude family.
 */
const CHARS_PER_TOKEN = 4;

/** Approximate token count for a string. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Canonical single-line header + body format used in compaction transcripts. */
export function formatMessageForTranscript(m: HubMessage): string {
  const tagPart = m.tags.length > 0 ? ` [${m.tags.join(',')}]` : '';
  return `[${m.fromName} @ ${m.timestamp}] (depth ${m.depth})${tagPart}\n${m.content}`;
}

/** Standard separator placed between formatted messages in a transcript. */
export const TRANSCRIPT_SEPARATOR = '\n\n---\n\n';

/**
 * Split an ordered list of messages into chunks. Each chunk's combined
 * transcript is at most `maxTokensPerChunk` tokens (estimated). Messages
 * are NEVER split in the middle — if a single message exceeds the budget
 * it becomes its own (oversized) chunk. Order is preserved across chunks.
 *
 * Empty input returns an empty array.
 */
export function splitMessagesIntoChunks(
  messages: HubMessage[],
  maxTokensPerChunk: number,
): HubMessage[][] {
  if (messages.length === 0) return [];
  if (maxTokensPerChunk <= 0) return [messages.slice()];

  const chunks: HubMessage[][] = [];
  let current: HubMessage[] = [];
  let currentTokens = 0;
  const sepTokens = estimateTokens(TRANSCRIPT_SEPARATOR);

  for (const m of messages) {
    const msgTokens = estimateTokens(formatMessageForTranscript(m)) + sepTokens;
    // If adding this message overflows the chunk AND the chunk already has
    // at least one message, flush the current chunk first.
    if (current.length > 0 && currentTokens + msgTokens > maxTokensPerChunk) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(m);
    currentTokens += msgTokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Build the joined transcript string for a chunk. */
export function buildTranscript(messages: HubMessage[]): string {
  return messages.map(formatMessageForTranscript).join(TRANSCRIPT_SEPARATOR);
}
