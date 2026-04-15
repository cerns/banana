import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

export interface QueuedMessage {
  hubMessageId: string;
  queuedAt: string;
  engagement?: 'mentioned' | 'expert' | 'listen' | 'triggered';
}

export interface SessionRecord {
  sessionId: string;
  clientId: string;
  hostname: string;
  workdir: string;
  connectedAt: string;
  disconnectedAt?: string;
  status: 'connected' | 'disconnected';
  jobs: JobRecord[];
  type: 'local' | 'remote';
  name?: string;
  machineId?: string;
  claudeSessionId?: string;
  remoteWorkdir?: string;
  role?: string;
  screenName?: string;
  interests?: string[];
  rolePrompt?: string;
  channels?: string[];
  hubQueue?: QueuedMessage[];
  /** Claude model alias or full ID — passed to claude CLI as --model.
   * Examples: "opus", "sonnet", "haiku", "claude-sonnet-4-6". Empty/undefined
   * lets the remote CLI pick its default. */
  model?: string;
  /** Number of resumed turns since the last /compact. Auto-compact triggers
   * when this reaches config.compactAfterTurns. */
  turnsSinceCompact?: number;
}

export type JobSource = 'adhoc' | 'hub' | 'trigger' | 'self-trigger' | 'talking';

export interface JobRecord {
  jobId: string;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  durationMs?: number;
  chunks: unknown[];
  error?: string;
  source?: JobSource;
}

// Debounce window: coalesce many writes (e.g. streaming chunks) into one
// async write per interval, so heavy SSH traffic never blocks the event loop.
const PERSIST_DEBOUNCE_MS = 250;

class SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private persistTimer: NodeJS.Timeout | null = null;
  private persistInFlight = false;
  private persistDirty = false;

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  getAll(): SessionRecord[] {
    return Array.from(this.sessions.values());
  }

  findByClientId(clientId: string): SessionRecord | undefined {
    for (const s of this.sessions.values()) {
      if (s.clientId === clientId) return s;
    }
    return undefined;
  }

  upsert(record: SessionRecord): void {
    this.sessions.set(record.sessionId, record);
    this.persist();
  }

  addChunk(sessionId: string, jobId: string, chunk: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const job = session.jobs.find(j => j.jobId === jobId);
    if (!job) return;
    const maxChunks = config.historyMax;
    if (job.chunks.length < maxChunks) {
      job.chunks.push(chunk);
    }
    this.persist();
  }

  finishJob(sessionId: string, jobId: string, exitCode: number, durationMs: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const job = session.jobs.find(j => j.jobId === jobId);
    if (!job) return;
    job.exitCode = exitCode;
    job.durationMs = durationMs;
    job.finishedAt = new Date().toISOString();
    this.persist();
  }

  errorJob(sessionId: string, jobId: string, error: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const job = session.jobs.find(j => j.jobId === jobId);
    if (!job) return;
    job.error = error;
    job.finishedAt = new Date().toISOString();
    this.persist();
  }

  updateMeta(sessionId: string, fields: Partial<Pick<SessionRecord, 'name' | 'claudeSessionId' | 'remoteWorkdir' | 'role' | 'screenName' | 'interests' | 'rolePrompt' | 'channels' | 'hubQueue' | 'model' | 'turnsSinceCompact'>>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    Object.assign(session, fields);
    this.persist();
  }

  load(): void {
    if (!config.persistPath) return;
    try {
      const data = fs.readFileSync(config.persistPath, 'utf8');
      const arr: SessionRecord[] = JSON.parse(data);
      for (const s of arr) {
        // Normalize legacy records that lack the `type` field
        if (!s.type) s.type = 'local';
        s.status = 'disconnected';
        this.sessions.set(s.sessionId, s);
      }
      console.log(`[store] Loaded ${arr.length} sessions from ${config.persistPath}`);
    } catch {
      // no file yet, that's fine
    }
  }

  /** Schedule a debounced async write. Safe to call from hot paths
   * (e.g. per-chunk) — coalesces into ~4 writes/sec max. */
  private persist(): void {
    if (!config.persistPath) return;
    this.persistDirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushPersist();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Force an immediate flush — used on shutdown. */
  async persistNow(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.flushPersist();
  }

  private async flushPersist(): Promise<void> {
    if (!config.persistPath) return;
    if (this.persistInFlight) return; // a write is already running; we'll re-flush after it
    if (!this.persistDirty) return;
    this.persistDirty = false;
    this.persistInFlight = true;
    try {
      const dir = path.dirname(config.persistPath);
      await fs.promises.mkdir(dir, { recursive: true });
      // No pretty-printing — sessions can hold thousands of stream chunks
      // and pretty-print roughly doubles serialization cost.
      const data = JSON.stringify(this.getAll());
      const tmp = config.persistPath + '.tmp';
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, config.persistPath);
    } catch (e) {
      console.error('[store] persist error', e);
    } finally {
      this.persistInFlight = false;
      // If new writes accumulated during the async flush, schedule another.
      if (this.persistDirty && !this.persistTimer) {
        this.persistTimer = setTimeout(() => {
          this.persistTimer = null;
          void this.flushPersist();
        }, PERSIST_DEBOUNCE_MS);
      }
    }
  }
}

export const sessionStore = new SessionStore();
