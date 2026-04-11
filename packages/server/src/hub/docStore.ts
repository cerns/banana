import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

export interface DocRevision {
  version: number;
  at: string;
  by: string;
  body: string;
}

export interface ChannelDoc {
  id: string;                 // "bCONF-7"
  channelId: string;
  title: string;
  body: string;               // markdown
  tags: string[];
  author: string;             // original creator
  createdAt: string;
  updatedAt: string;
  version: number;
  history: DocRevision[];
}

export interface UpdateDocFields {
  title?: string;
  body?: string;
  tags?: string[];
}

interface DocData {
  docs: ChannelDoc[];
  seqs: Array<[string, number]>;
}

class DocStore {
  // Internally keyed by `${channelId}::${id}` so per-channel IDs (bCONF-1)
  // can safely collide across channels.
  private docs = new Map<string, ChannelDoc>();
  private seqs = new Map<string, number>();

  private key(channelId: string, id: string): string {
    return `${channelId}::${id}`;
  }

  private findDoc(id: string, channelId?: string): ChannelDoc | undefined {
    if (channelId) return this.docs.get(this.key(channelId, id));
    for (const d of this.docs.values()) {
      if (d.id === id) return d;
    }
    return undefined;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  createDoc(
    channelId: string,
    title: string,
    body: string,
    author: string,
    tags: string[] = [],
  ): ChannelDoc {
    const next = (this.seqs.get(channelId) ?? 0) + 1;
    this.seqs.set(channelId, next);
    const id = `bCONF-${next}`;
    const now = new Date().toISOString();
    const doc: ChannelDoc = {
      id,
      channelId,
      title,
      body,
      tags,
      author,
      createdAt: now,
      updatedAt: now,
      version: 1,
      history: [],
    };
    this.docs.set(this.key(channelId, id), doc);
    this.persist();
    return doc;
  }

  updateDoc(id: string, patch: UpdateDocFields, by: string): ChannelDoc | undefined {
    const doc = this.findDoc(id);
    if (!doc) return undefined;
    const now = new Date().toISOString();

    // Always archive the prior version when something changes
    const titleChanged = patch.title !== undefined && patch.title !== doc.title;
    const bodyChanged = patch.body !== undefined && patch.body !== doc.body;
    const tagsChanged = patch.tags !== undefined;

    if (!titleChanged && !bodyChanged && !tagsChanged) return doc;

    this.archive(doc, by);

    if (titleChanged) doc.title = patch.title!;
    if (bodyChanged) doc.body = patch.body!;
    if (tagsChanged) doc.tags = patch.tags!;
    doc.version += 1;
    doc.updatedAt = now;

    this.persist();
    return doc;
  }

  appendDoc(id: string, text: string, by: string): ChannelDoc | undefined {
    const doc = this.findDoc(id);
    if (!doc) return undefined;
    const now = new Date().toISOString();

    this.archive(doc, by);

    doc.body = doc.body ? `${doc.body}\n\n${text}` : text;
    doc.version += 1;
    doc.updatedAt = now;

    this.persist();
    return doc;
  }

  private archive(doc: ChannelDoc, by: string): void {
    const revision: DocRevision = {
      version: doc.version,
      at: doc.updatedAt,
      by,
      body: doc.body,
    };
    doc.history.push(revision);
    const cap = config.docRevisionMax ?? 20;
    if (doc.history.length > cap) {
      doc.history = doc.history.slice(doc.history.length - cap);
    }
  }

  getDoc(id: string, channelId?: string): ChannelDoc | undefined {
    return this.findDoc(id, channelId);
  }

  getByChannel(channelId: string): ChannelDoc[] {
    const out: ChannelDoc[] = [];
    for (const doc of this.docs.values()) {
      if (doc.channelId === channelId) out.push(doc);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  search(channelId: string, q?: string, tags?: string[]): ChannelDoc[] {
    const needle = q?.toLowerCase();
    const tagSet = tags && tags.length > 0 ? new Set(tags) : null;
    const out: ChannelDoc[] = [];
    for (const doc of this.docs.values()) {
      if (doc.channelId !== channelId) continue;
      if (tagSet) {
        const overlap = doc.tags.some(t => tagSet.has(t));
        if (!overlap) continue;
      }
      if (needle) {
        const inTitle = doc.title.toLowerCase().includes(needle);
        const inBody = doc.body.toLowerCase().includes(needle);
        if (!inTitle && !inBody) continue;
      }
      out.push(doc);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  removeDoc(id: string, channelId?: string): boolean {
    if (channelId) {
      const removed = this.docs.delete(this.key(channelId, id));
      if (removed) this.persist();
      return removed;
    }
    for (const [k, d] of this.docs.entries()) {
      if (d.id === id) {
        this.docs.delete(k);
        this.persist();
        return true;
      }
    }
    return false;
  }

  getAll(): ChannelDoc[] {
    return Array.from(this.docs.values());
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  load(): void {
    const filePath = config.docsPersistPath;
    if (!filePath) return;
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const parsed: DocData = JSON.parse(data);
      if (Array.isArray(parsed.docs)) {
        for (const d of parsed.docs) this.docs.set(this.key(d.channelId, d.id), d);
      }
      if (Array.isArray(parsed.seqs)) {
        for (const [ch, n] of parsed.seqs) this.seqs.set(ch, n);
      }
      console.log(`[docs] Loaded ${this.docs.size} docs from ${filePath}`);
    } catch {
      // no file yet — fine
    }
  }

  private persistTimer: NodeJS.Timeout | null = null;
  private persistInFlight = false;
  private persistDirty = false;

  private persist(): void {
    const filePath = config.docsPersistPath;
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
    const filePath = config.docsPersistPath;
    if (!filePath) return;
    if (this.persistInFlight) return;
    if (!this.persistDirty) return;
    this.persistDirty = false;
    this.persistInFlight = true;
    try {
      const dir = path.dirname(filePath);
      await fs.promises.mkdir(dir, { recursive: true });
      const data: DocData = {
        docs: this.getAll(),
        seqs: Array.from(this.seqs.entries()),
      };
      const tmp = filePath + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
      await fs.promises.rename(tmp, filePath);
    } catch (e) {
      console.error('[docs] persist error', e);
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

  /** Test-only: clear in-memory state. */
  _resetForTests(): void {
    this.docs.clear();
    this.seqs.clear();
    this.persistDirty = false;
  }
}

export const docStore = new DocStore();
