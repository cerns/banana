import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

export interface HubChannel {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  createdBy: string;
}

export interface HubDispatch {
  sessionId: string;
  jobId: string;
  status: 'queued' | 'running' | 'skipped' | 'acted' | 'error';
  startedAt?: string;
  finishedAt?: string;
}

export interface HubMessage {
  id: string;
  channelId: string;
  from: string;
  fromName: string;
  content: string;
  tags: string[];
  mentions: string[];
  parentId?: string;
  depth: number;
  timestamp: string;
  status: 'pending' | 'dispatched' | 'complete';
  dispatches: HubDispatch[];
  /** Cached compacted thread context (ancestors) used when dispatching. */
  contextSummary?: string;
}

interface HubData {
  channels: HubChannel[];
  messages: HubMessage[];
}

class HubStore {
  private channels = new Map<string, HubChannel>();
  private messages = new Map<string, HubMessage>();

  // ── Channel CRUD ──────────────────────────────────────────────────────────

  createChannel(id: string, name: string, createdBy: string, description?: string): HubChannel {
    const channel: HubChannel = {
      id,
      name,
      description,
      createdAt: new Date().toISOString(),
      createdBy,
    };
    this.channels.set(id, channel);
    this.persist();
    return channel;
  }

  getChannel(id: string): HubChannel | undefined {
    return this.channels.get(id);
  }

  getAllChannels(): HubChannel[] {
    return Array.from(this.channels.values());
  }

  ensureChannel(id: string, createdBy: string): HubChannel {
    const existing = this.channels.get(id);
    if (existing) return existing;
    return this.createChannel(id, `#${id}`, createdBy);
  }

  // ── Message CRUD ──────────────────────────────────────────────────────────

  addMessage(msg: HubMessage): void {
    this.messages.set(msg.id, msg);
    this.persist();
  }

  getMessage(id: string): HubMessage | undefined {
    return this.messages.get(id);
  }

  getByChannel(channelId: string, since?: string): HubMessage[] {
    const results: HubMessage[] = [];
    for (const msg of this.messages.values()) {
      if (msg.channelId === channelId) {
        if (since && msg.timestamp <= since) continue;
        results.push(msg);
      }
    }
    return results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  getThread(parentId: string): HubMessage[] {
    const results: HubMessage[] = [];
    // Include the parent itself
    const parent = this.messages.get(parentId);
    if (parent) results.push(parent);
    // Find all children recursively
    const findChildren = (id: string) => {
      for (const msg of this.messages.values()) {
        if (msg.parentId === id) {
          results.push(msg);
          findChildren(msg.id);
        }
      }
    };
    findChildren(parentId);
    return results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  getAll(): HubMessage[] {
    return Array.from(this.messages.values());
  }

  // ── Dispatch tracking ─────────────────────────────────────────────────────

  addDispatch(messageId: string, dispatch: HubDispatch): void {
    const msg = this.messages.get(messageId);
    if (!msg) return;
    msg.dispatches.push(dispatch);
    if (msg.status === 'pending') msg.status = 'dispatched';
    this.persist();
  }

  updateDispatch(messageId: string, sessionId: string, fields: Partial<HubDispatch>): void {
    const msg = this.messages.get(messageId);
    if (!msg) return;
    const dispatch = msg.dispatches.find(d => d.sessionId === sessionId);
    if (!dispatch) return;
    Object.assign(dispatch, fields);
    this.persist();
  }

  updateStatus(messageId: string, status: HubMessage['status']): void {
    const msg = this.messages.get(messageId);
    if (!msg) return;
    msg.status = status;
    this.persist();
  }

  /** Walk parentId chain upward, returning ancestors from root → direct parent. */
  getAncestorChain(messageId: string): HubMessage[] {
    const chain: HubMessage[] = [];
    let current = this.messages.get(messageId);
    const seen = new Set<string>();
    while (current?.parentId) {
      if (seen.has(current.parentId)) break; // guard against cycles
      seen.add(current.parentId);
      const parent = this.messages.get(current.parentId);
      if (!parent) break;
      chain.unshift(parent);
      current = parent;
    }
    return chain;
  }

  setContextSummary(messageId: string, summary: string): void {
    const msg = this.messages.get(messageId);
    if (!msg) return;
    msg.contextSummary = summary;
    this.persist();
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  load(): void {
    const filePath = config.hubPersistPath;
    if (!filePath) return;
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const parsed: HubData = JSON.parse(data);
      if (Array.isArray(parsed.channels)) {
        for (const ch of parsed.channels) {
          this.channels.set(ch.id, ch);
        }
      }
      if (Array.isArray(parsed.messages)) {
        for (const msg of parsed.messages) {
          this.messages.set(msg.id, msg);
        }
      }
      console.log(`[hub] Loaded ${this.channels.size} channels, ${this.messages.size} messages from ${filePath}`);
    } catch {
      // no file yet — that's fine
    }
  }

  // Debounced async persistence — same rationale as sessionStore.
  private persistTimer: NodeJS.Timeout | null = null;
  private persistInFlight = false;
  private persistDirty = false;

  private persist(): void {
    const filePath = config.hubPersistPath;
    if (!filePath) return;
    this.persistDirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushPersist();
    }, 250);
  }

  async persistNow(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.flushPersist();
  }

  private async flushPersist(): Promise<void> {
    const filePath = config.hubPersistPath;
    if (!filePath) return;
    if (this.persistInFlight) return;
    if (!this.persistDirty) return;
    this.persistDirty = false;
    this.persistInFlight = true;
    try {
      const dir = path.dirname(filePath);
      await fs.promises.mkdir(dir, { recursive: true });
      const data: HubData = {
        channels: this.getAllChannels(),
        messages: this.getAll(),
      };
      const tmp = filePath + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
      await fs.promises.rename(tmp, filePath);
    } catch (e) {
      console.error('[hub] persist error', e);
    } finally {
      this.persistInFlight = false;
      if (this.persistDirty && !this.persistTimer) {
        this.persistTimer = setTimeout(() => {
          this.persistTimer = null;
          void this.flushPersist();
        }, 250);
      }
    }
  }
}

export const hubStore = new HubStore();
