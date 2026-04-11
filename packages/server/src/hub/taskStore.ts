import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'wontfix';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface TaskActivity {
  at: string;
  by: string;
  kind: 'created' | 'status' | 'assignee' | 'comment' | 'edit';
  text?: string;
  from?: string;
  to?: string;
}

export interface ChannelTask {
  id: string;                 // "bJIRA-23"
  channelId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assignee?: string;
  reporter: string;
  tags: string[];
  priority?: TaskPriority;
  parentId?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  activity: TaskActivity[];
}

export interface CreateTaskFields {
  title: string;
  description?: string;
  status?: TaskStatus;
  assignee?: string;
  tags?: string[];
  priority?: TaskPriority;
  parentId?: string;
}

export interface UpdateTaskFields {
  title?: string;
  description?: string;
  status?: TaskStatus;
  assignee?: string;
  tags?: string[];
  priority?: TaskPriority;
}

export interface TaskFilter {
  status?: TaskStatus[];
  assignee?: string;
  tag?: string;
}

interface TaskData {
  tasks: ChannelTask[];
  seqs: Array<[string, number]>;
}

const CLOSED_STATUSES: TaskStatus[] = ['done', 'wontfix'];

class TaskStore {
  // Internally keyed by `${channelId}::${id}` so per-channel IDs (bJIRA-1)
  // can safely collide across channels.
  private tasks = new Map<string, ChannelTask>();
  private seqs = new Map<string, number>();

  private key(channelId: string, id: string): string {
    return `${channelId}::${id}`;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  createTask(channelId: string, fields: CreateTaskFields, reporter: string): ChannelTask {
    const next = (this.seqs.get(channelId) ?? 0) + 1;
    this.seqs.set(channelId, next);
    const id = `bJIRA-${next}`;
    const now = new Date().toISOString();
    const task: ChannelTask = {
      id,
      channelId,
      title: fields.title,
      description: fields.description,
      status: fields.status ?? 'open',
      assignee: fields.assignee,
      reporter,
      tags: fields.tags ?? [],
      priority: fields.priority,
      parentId: fields.parentId,
      createdAt: now,
      updatedAt: now,
      activity: [{ at: now, by: reporter, kind: 'created' }],
    };
    this.tasks.set(this.key(channelId, id), task);
    this.persist();
    return task;
  }

  private findTask(id: string, channelId?: string): ChannelTask | undefined {
    if (channelId) return this.tasks.get(this.key(channelId, id));
    for (const t of this.tasks.values()) {
      if (t.id === id) return t;
    }
    return undefined;
  }

  updateTask(id: string, patch: UpdateTaskFields, by: string): ChannelTask | undefined {
    const task = this.findTask(id);
    if (!task) return undefined;
    const now = new Date().toISOString();

    if (patch.status !== undefined && patch.status !== task.status) {
      task.activity.push({
        at: now, by, kind: 'status',
        from: task.status, to: patch.status,
      });
      task.status = patch.status;
      if (CLOSED_STATUSES.includes(patch.status)) {
        task.closedAt = now;
      } else {
        task.closedAt = undefined;
      }
    }
    if (patch.assignee !== undefined && patch.assignee !== task.assignee) {
      task.activity.push({
        at: now, by, kind: 'assignee',
        from: task.assignee, to: patch.assignee,
      });
      task.assignee = patch.assignee;
    }
    if (patch.title !== undefined && patch.title !== task.title) {
      task.activity.push({
        at: now, by, kind: 'edit',
        text: 'title', from: task.title, to: patch.title,
      });
      task.title = patch.title;
    }
    if (patch.description !== undefined && patch.description !== task.description) {
      task.activity.push({ at: now, by, kind: 'edit', text: 'description' });
      task.description = patch.description;
    }
    if (patch.tags !== undefined) {
      task.activity.push({
        at: now, by, kind: 'edit',
        text: 'tags', from: task.tags.join(','), to: patch.tags.join(','),
      });
      task.tags = patch.tags;
    }
    if (patch.priority !== undefined && patch.priority !== task.priority) {
      task.activity.push({
        at: now, by, kind: 'edit',
        text: 'priority', from: task.priority, to: patch.priority,
      });
      task.priority = patch.priority;
    }

    task.updatedAt = now;
    this.persist();
    return task;
  }

  addComment(id: string, text: string, by: string): ChannelTask | undefined {
    const task = this.findTask(id);
    if (!task) return undefined;
    const now = new Date().toISOString();
    task.activity.push({ at: now, by, kind: 'comment', text });
    task.updatedAt = now;
    this.persist();
    return task;
  }

  getTask(id: string, channelId?: string): ChannelTask | undefined {
    return this.findTask(id, channelId);
  }

  getByChannel(channelId: string, filter?: TaskFilter): ChannelTask[] {
    const out: ChannelTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.channelId !== channelId) continue;
      if (filter?.status && !filter.status.includes(task.status)) continue;
      if (filter?.assignee && task.assignee !== filter.assignee) continue;
      if (filter?.tag && !task.tags.includes(filter.tag)) continue;
      out.push(task);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  search(channelId: string, q?: string, tags?: string[]): ChannelTask[] {
    const needle = q?.toLowerCase();
    const tagSet = tags && tags.length > 0 ? new Set(tags) : null;
    const out: ChannelTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.channelId !== channelId) continue;
      if (tagSet) {
        const overlap = task.tags.some(t => tagSet.has(t));
        if (!overlap) continue;
      }
      if (needle) {
        const inTitle = task.title.toLowerCase().includes(needle);
        const inDesc = task.description?.toLowerCase().includes(needle) ?? false;
        const inComments = task.activity.some(a =>
          a.kind === 'comment' && a.text?.toLowerCase().includes(needle),
        );
        if (!inTitle && !inDesc && !inComments) continue;
      }
      out.push(task);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  removeTask(id: string, channelId?: string): boolean {
    if (channelId) {
      const removed = this.tasks.delete(this.key(channelId, id));
      if (removed) this.persist();
      return removed;
    }
    // No channel given: find and remove by id alone
    for (const [k, t] of this.tasks.entries()) {
      if (t.id === id) {
        this.tasks.delete(k);
        this.persist();
        return true;
      }
    }
    return false;
  }

  getAll(): ChannelTask[] {
    return Array.from(this.tasks.values());
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  load(): void {
    const filePath = config.tasksPersistPath;
    if (!filePath) return;
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const parsed: TaskData = JSON.parse(data);
      if (Array.isArray(parsed.tasks)) {
        for (const t of parsed.tasks) this.tasks.set(this.key(t.channelId, t.id), t);
      }
      if (Array.isArray(parsed.seqs)) {
        for (const [ch, n] of parsed.seqs) this.seqs.set(ch, n);
      }
      console.log(`[tasks] Loaded ${this.tasks.size} tasks from ${filePath}`);
    } catch {
      // no file yet — fine
    }
  }

  private persistTimer: NodeJS.Timeout | null = null;
  private persistInFlight = false;
  private persistDirty = false;

  private persist(): void {
    const filePath = config.tasksPersistPath;
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
    const filePath = config.tasksPersistPath;
    if (!filePath) return;
    if (this.persistInFlight) return;
    if (!this.persistDirty) return;
    this.persistDirty = false;
    this.persistInFlight = true;
    try {
      const dir = path.dirname(filePath);
      await fs.promises.mkdir(dir, { recursive: true });
      const data: TaskData = {
        tasks: this.getAll(),
        seqs: Array.from(this.seqs.entries()),
      };
      const tmp = filePath + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
      await fs.promises.rename(tmp, filePath);
    } catch (e) {
      console.error('[tasks] persist error', e);
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
    this.tasks.clear();
    this.seqs.clear();
    this.persistDirty = false;
  }
}

export const taskStore = new TaskStore();
