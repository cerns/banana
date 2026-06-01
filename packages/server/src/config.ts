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
  // SSH idle timeout — how many milliseconds of zero stdout/stderr output
  // before the runner sends SIGTERM + closes the channel. Resets on every
  // chunk of output. Default 1800s (30 min) — tool calls like large builds,
  // file searches, and API calls can run silently for 10-20 min while
  // internally progressing. Set to 0 to disable.
  sshIdleTimeoutMs: parseInt(process.env.BANANA_SSH_IDLE_TIMEOUT_MS ?? '1800000', 10),
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
  // Auto-compact: when the last run's input token count exceeds this threshold,
  // run /compact before the next prompt to keep context lean. Set to 0 to disable.
  // Default 10000 — triggers compact early to keep context lean.
  compactTokenThreshold: parseInt(process.env.BANANA_COMPACT_TOKEN_THRESHOLD ?? '10000', 10),
  jumpHostPersistPath: process.env.BANANA_JUMPHOSTS_PATH ?? path.join(os.homedir(), '.banana', 'jumphosts.json'),
  // ── Hub dispatch tuning ──────────────────────────────────────────────────
  // Max agentic turns for work sessions (--max-turns).
  sshMaxTurns: parseInt(process.env.BANANA_SSH_MAX_TURNS ?? '25', 10),
  // Max agentic turns for hub chat dispatches (text-only, low).
  hubChatMaxTurns: parseInt(process.env.BANANA_HUB_CHAT_MAX_TURNS ?? '3', 10),
  // Max sessions in wave1 of staggered dispatch (A2).
  hubWaveSize: parseInt(process.env.BANANA_HUB_WAVE_SIZE ?? '2', 10),
  // ── Persistent tmux mode ─────────────────────────────────────────────────
  // How long to wait for claude to start inside tmux before giving up.
  tmuxStartupTimeoutMs: parseInt(process.env.BANANA_TMUX_STARTUP_TIMEOUT ?? '60000', 10),
  // Idle time (no output) before considering the response complete.
  tmuxIdleCompletionMs: parseInt(process.env.BANANA_TMUX_IDLE_COMPLETION ?? '30000', 10),
  // Auto-approve permission prompts (y/n) detected in TUI output.
  tmuxAutoApprovePermissions: process.env.BANANA_TMUX_AUTO_APPROVE !== '0',
  // Delay (ms) after tmux new-session before sending the claude command.
  // Gives the shell time to initialize (oh-my-zsh, MOTD, etc.).
  tmuxStartupDelayMs: parseInt(process.env.BANANA_TMUX_STARTUP_DELAY ?? '1500', 10),
  // Persist tmux session metadata so sessions survive server restarts.
  tmuxPersistPath: process.env.BANANA_TMUX_PATH ?? path.join(os.homedir(), '.banana', 'tmux-sessions.json'),
};

if (!config.token) {
  console.error('BANANA_TOKEN env var is required');
  process.exit(1);
}
