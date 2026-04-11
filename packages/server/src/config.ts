import os from 'os';
import path from 'path';

export const config = {
  token: process.env.BANANA_TOKEN ?? '',
  port: parseInt(process.env.BANANA_PORT ?? '3000', 10),
  historyMax: parseInt(process.env.BANANA_HISTORY_MAX ?? '1000', 10),
  persistPath: process.env.BANANA_PERSIST_PATH ?? path.join(os.homedir(), '.banana', 'sessions.json'),
  machinesPersistPath: process.env.BANANA_MACHINES_PATH ?? path.join(os.homedir(), '.banana', 'machines.json'),
  hubPersistPath: process.env.BANANA_HUB_PATH ?? path.join(os.homedir(), '.banana', 'hub.json'),
  hubMaxChainDepth: parseInt(process.env.BANANA_HUB_MAX_DEPTH ?? '5', 10),
  hubMaxConcurrentJobs: parseInt(process.env.BANANA_HUB_MAX_CONCURRENT ?? '10', 10),
  hubCooldownMs: parseInt(process.env.BANANA_HUB_COOLDOWN_MS ?? '10000', 10),
  // Maximum [IM_TALKING] / [IM_THINKING] continuation rounds per thread before
  // the system force-stops the loop. Each round re-invokes the SAME agent that
  // emitted the marker; siblings posts at the same depth as the first reply.
  hubMaxTalkRounds: parseInt(process.env.BANANA_HUB_MAX_TALK_ROUNDS ?? '10', 10),
  // Channel-scoped task & doc stores (Jira/Confluence-lite).
  tasksPersistPath: process.env.BANANA_TASKS_PATH ?? path.join(os.homedir(), '.banana', 'tasks.json'),
  docsPersistPath: process.env.BANANA_DOCS_PATH ?? path.join(os.homedir(), '.banana', 'docs.json'),
  taskContextMax: parseInt(process.env.BANANA_TASK_CONTEXT_MAX ?? '8', 10),
  docContextMax: parseInt(process.env.BANANA_DOC_CONTEXT_MAX ?? '5', 10),
  docRevisionMax: parseInt(process.env.BANANA_DOC_REVISION_MAX ?? '20', 10),
  // SSH keepalive — how many missed pings before the connection is considered
  // dead. At 10s interval, default 60 = ~10 minutes of silence allowed (agents
  // often run tools for several minutes without producing stream-json output).
  sshKeepaliveCountMax: parseInt(process.env.BANANA_SSH_KEEPALIVE_COUNT ?? '60', 10),
  // How long ssh2 waits for the SSH handshake (KEX) to complete before
  // emitting "Timed out while waiting for handshake". Bumped from the previous
  // hard-coded 15s because parallel hub dispatch can briefly congest sshd.
  sshReadyTimeoutMs: parseInt(process.env.BANANA_SSH_READY_TIMEOUT ?? '30000', 10),
  // Retry the SSH connect phase this many times on transient handshake /
  // connection errors (with exponential backoff + jitter). Auth errors and
  // post-connect failures are NOT retried.
  sshConnectRetries: parseInt(process.env.BANANA_SSH_CONNECT_RETRIES ?? '2', 10),
  // Heuristic prompt compression (LLMLingua-style). Strips filler words,
  // rewrites wordy phrases, collapses whitespace, dedupes adjacent lines.
  // Code blocks (``` and `inline`) are preserved verbatim. Set to "0" to
  // disable; default is enabled.
  promptCompressEnabled: process.env.BANANA_PROMPT_COMPRESS !== '0',
  // Channel compaction chunking. When the transcript estimated tokens exceed
  // this threshold, the compactor splits the messages into chunks ≤ this
  // many tokens (never splitting a single message) and runs the LLM on each
  // chunk in turn, then concatenates the chunk summaries into one. Default
  // 80000 leaves headroom under common 100k context limits for the prompt
  // scaffolding + the response.
  compactChunkTokens: parseInt(process.env.BANANA_COMPACT_CHUNK_TOKENS ?? '80000', 10),
};

if (!config.token) {
  console.error('BANANA_TOKEN env var is required');
  process.exit(1);
}
