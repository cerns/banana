import type { TaskStatus, TaskPriority } from './taskStore.js';

export interface ChannelReplyTarget {
  channelId: string;
  messageId: string;
  content: string;
}

export interface ArtifactActions {
  taskCreates: Array<{
    title: string;
    description?: string;
    status?: TaskStatus;
    assignee?: string;
    tags?: string[];
    priority?: TaskPriority;
  }>;
  taskUpdates: Array<{
    id: string;
    status?: TaskStatus;
    assignee?: string;
    title?: string;
    tags?: string[];
    priority?: TaskPriority;
  }>;
  taskComments: Array<{ id: string; text: string }>;
  docWrites: Array<{ title: string; body: string; tags?: string[] }>;
  docUpdates: Array<{ id: string; title?: string; body?: string; tags?: string[] }>;
  docAppends: Array<{ id: string; text: string }>;
  docDeletes: Array<{ id: string }>;
  /** Explicit channel reply extracted from [CHANNEL_REPLY] marker (if present). */
  channelReply?: string;
  /** Reply with all recognized markers stripped — used as the chat post body. */
  cleanedText: string;
}

const VALID_STATUSES: TaskStatus[] = ['open', 'in_progress', 'blocked', 'done', 'wontfix'];
const VALID_PRIORITIES: TaskPriority[] = ['low', 'medium', 'high'];

function parseAttrs(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  // key="value with spaces"  |  key=value-no-spaces
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const key = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    out[key] = value;
  }
  return out;
}

function parseTags(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function asStatus(raw: string | undefined): TaskStatus | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase().replace(/-/g, '_');
  return VALID_STATUSES.includes(v as TaskStatus) ? (v as TaskStatus) : undefined;
}

function asPriority(raw: string | undefined): TaskPriority | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  return VALID_PRIORITIES.includes(v as TaskPriority) ? (v as TaskPriority) : undefined;
}

export function extractArtifactActions(reply: string): ArtifactActions {
  const actions: ArtifactActions = {
    taskCreates: [],
    taskUpdates: [],
    taskComments: [],
    docWrites: [],
    docUpdates: [],
    docAppends: [],
    docDeletes: [],
    cleanedText: reply,
  };

  // ── Block markers ──────────────────────────────────────────────────────
  // [TAG attrs]\n body \n[/TAG]
  //
  // Tags use the project-specific bJIRA_* / bCONF_* prefixes (rather than
  // generic TASK_*/DOC_*) so the LLM can never accidentally trigger them
  // by writing about real Jira / Confluence in normal prose.
  const blockHandlers: Array<{
    tag: string;
    apply: (attrs: Record<string, string>, body: string) => void;
  }> = [
    {
      tag: 'bJIRA_CREATE',
      apply: (attrs, body) => {
        if (!attrs.title) {
          console.warn('[extractor] bJIRA_CREATE missing title — dropped');
          return;
        }
        actions.taskCreates.push({
          title: attrs.title,
          description: body || undefined,
          status: asStatus(attrs.status),
          assignee: attrs.assignee,
          tags: parseTags(attrs.tags),
          priority: asPriority(attrs.priority),
        });
      },
    },
    {
      tag: 'bJIRA_UPDATE',
      apply: (attrs, body) => {
        if (!attrs.id) {
          console.warn('[extractor] bJIRA_UPDATE missing id — dropped');
          return;
        }
        actions.taskUpdates.push({
          id: attrs.id,
          status: asStatus(attrs.status),
          assignee: attrs.assignee,
          title: attrs.title,
          tags: parseTags(attrs.tags),
          priority: asPriority(attrs.priority),
        });
        // Block-form with body — treat the body as a comment so the explanation is preserved
        if (body) actions.taskComments.push({ id: attrs.id, text: body });
      },
    },
    {
      tag: 'bJIRA_COMMENT',
      apply: (attrs, body) => {
        if (!attrs.id || !body) {
          console.warn('[extractor] bJIRA_COMMENT missing id or body — dropped');
          return;
        }
        actions.taskComments.push({ id: attrs.id, text: body });
      },
    },
    {
      tag: 'bCONF_WRITE',
      apply: (attrs, body) => {
        if (!attrs.title || !body) {
          console.warn('[extractor] bCONF_WRITE missing title or body — dropped');
          return;
        }
        actions.docWrites.push({
          title: attrs.title,
          body,
          tags: parseTags(attrs.tags),
        });
      },
    },
    {
      tag: 'bCONF_UPDATE',
      apply: (attrs, body) => {
        if (!attrs.id) {
          console.warn('[extractor] bCONF_UPDATE missing id — dropped');
          return;
        }
        actions.docUpdates.push({
          id: attrs.id,
          title: attrs.title,
          body: body || undefined,
          tags: parseTags(attrs.tags),
        });
      },
    },
    {
      tag: 'bCONF_APPEND',
      apply: (attrs, body) => {
        if (!attrs.id || !body) {
          console.warn('[extractor] bCONF_APPEND missing id or body — dropped');
          return;
        }
        actions.docAppends.push({ id: attrs.id, text: body });
      },
    },
    {
      tag: 'bCONF_DELETE',
      apply: (attrs) => {
        if (!attrs.id) {
          console.warn('[extractor] bCONF_DELETE missing id — dropped');
          return;
        }
        actions.docDeletes.push({ id: attrs.id });
      },
    },
  ];

  for (const { tag, apply } of blockHandlers) {
    const re = new RegExp(`\\[${tag}([^\\]]*)\\]([\\s\\S]*?)\\[/${tag}\\]`, 'gi');
    actions.cleanedText = actions.cleanedText.replace(re, (_full, attrs: string, body: string) => {
      try {
        apply(parseAttrs(attrs), body.trim());
      } catch (e) {
        console.warn(`[extractor] error parsing ${tag}:`, e);
      }
      return '';
    });
  }

  // ── Self-closing bCONF_DELETE ────────────────────────────────────────
  // [bCONF_DELETE id=bCONF-3] (no closing tag needed)
  const deleteSelfRe = /\[bCONF_DELETE([^\]]*)\](?!\s*[\s\S]*?\[\/bCONF_DELETE\])/gi;
  actions.cleanedText = actions.cleanedText.replace(deleteSelfRe, (_full, rawAttrs: string) => {
    try {
      const attrs = parseAttrs(rawAttrs);
      if (!attrs.id) {
        console.warn('[extractor] bCONF_DELETE (self-closing) missing id — dropped');
        return '';
      }
      actions.docDeletes.push({ id: attrs.id });
    } catch (e) {
      console.warn('[extractor] error parsing bCONF_DELETE:', e);
    }
    return '';
  });

  // ── Self-closing bJIRA_UPDATE ────────────────────────────────────────
  // [bJIRA_UPDATE id=bJIRA-12 status=done] (no closing tag, no body)
  const updateSelfRe = /\[bJIRA_UPDATE([^\]]*)\](?!\s*\[\/bJIRA_UPDATE\])/gi;
  actions.cleanedText = actions.cleanedText.replace(updateSelfRe, (_full, rawAttrs: string) => {
    try {
      const attrs = parseAttrs(rawAttrs);
      if (!attrs.id) {
        console.warn('[extractor] bJIRA_UPDATE (self-closing) missing id — dropped');
        return '';
      }
      actions.taskUpdates.push({
        id: attrs.id,
        status: asStatus(attrs.status),
        assignee: attrs.assignee,
        title: attrs.title,
        tags: parseTags(attrs.tags),
        priority: asPriority(attrs.priority),
      });
    } catch (e) {
      console.warn('[extractor] error parsing bJIRA_UPDATE:', e);
    }
    return '';
  });

  // ── [CHANNEL_REPLY] marker ─────────────────────────────────────────
  // Agents wrap their intended channel reply in [CHANNEL_REPLY]...[/CHANNEL_REPLY].
  // Only the content inside is posted to the channel. Everything outside stays
  // in the session only (narration, tool output, debugging). If the marker is
  // absent, all text is used (existing behavior).
  const channelReplyRe = /\[CHANNEL_REPLY\]([\s\S]*?)\[\/CHANNEL_REPLY\]/gi;
  const channelReplyParts: string[] = [];
  actions.cleanedText = actions.cleanedText.replace(channelReplyRe, (_full, body: string) => {
    channelReplyParts.push(body.trim());
    return '';
  });
  if (channelReplyParts.length > 0) {
    actions.channelReply = channelReplyParts.join('\n\n');
  }

  actions.cleanedText = actions.cleanedText.replace(/\n{3,}/g, '\n\n').trim();
  return actions;
}

/**
 * Parse [REPLY_TO_CHANNEL][#channelId][%messageId] markers from raw output.
 * Enables ad-hoc sessions to explicitly post replies to a channel.
 * Returns the first match found (agents should only use one per reply).
 */
export function parseReplyToChannel(text: string): ChannelReplyTarget | null {
  // [REPLY_TO_CHANNEL][#channelId][%messageId]
  // content
  // [/REPLY_TO_CHANNEL]
  const blockRe = /\[REPLY_TO_CHANNEL\]\[#([^\]]+)\]\[%([^\]]+)\]\s*([\s\S]*?)\[\/REPLY_TO_CHANNEL\]/i;
  const m = text.match(blockRe);
  if (m) {
    return { channelId: m[1].trim(), messageId: m[2].trim(), content: m[3].trim() };
  }
  return null;
}

/** Strip [REPLY_TO_CHANNEL]...[/REPLY_TO_CHANNEL] blocks from text. */
export function stripReplyToChannel(text: string): string {
  return text.replace(/\[REPLY_TO_CHANNEL\]\[#[^\]]+\]\[%[^\]]+\]\s*[\s\S]*?\[\/REPLY_TO_CHANNEL\]/gi, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Extract routing metadata [REPLY_TO_CHANNEL][#channelId][%messageId] from text.
 * Unlike parseReplyToChannel, this only extracts the routing header — it does NOT
 * require a closing tag or content block.  Used to recover channel/message routing
 * from a job's PROMPT when the agent's OUTPUT uses [CHANNEL_REPLY] (content-only).
 */
export function parseReplyRouting(text: string): { channelId: string; messageId: string } | null {
  const m = text.match(/\[REPLY_TO_CHANNEL\]\[#([^\]]+)\]\[%([^\]]+)\]/i);
  if (!m) return null;
  return { channelId: m[1].trim(), messageId: m[2].trim() };
}

/**
 * Extract [CHANNEL_REPLY]...[/CHANNEL_REPLY] content from text.
 * Returns the joined content of all [CHANNEL_REPLY] blocks, or null if none found.
 */
export function extractChannelReply(text: string): string | null {
  const re = /\[CHANNEL_REPLY\]([\s\S]*?)\[\/CHANNEL_REPLY\]/gi;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim();
    if (body) parts.push(body);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}
