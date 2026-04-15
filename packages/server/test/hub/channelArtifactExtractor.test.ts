import { describe, it, expect } from 'vitest';
import { extractArtifactActions, parseReplyToChannel, stripReplyToChannel, parseReplyRouting, extractChannelReply } from '../../src/hub/channelArtifactExtractor.js';

describe('extractArtifactActions', () => {
  describe('bJIRA_CREATE', () => {
    it('parses a basic bJIRA_CREATE with body as description', () => {
      const reply = `OK, I'll add this.

[bJIRA_CREATE title="Fix LCP > 4s" status=open assignee=qa-bob tags=perf,frontend priority=high]
Lighthouse score is below threshold; need to investigate render-blocking JS.
[/bJIRA_CREATE]

Done.`;
      const a = extractArtifactActions(reply);
      expect(a.taskCreates).toHaveLength(1);
      const t = a.taskCreates[0];
      expect(t.title).toBe('Fix LCP > 4s');
      expect(t.status).toBe('open');
      expect(t.assignee).toBe('qa-bob');
      expect(t.tags).toEqual(['perf', 'frontend']);
      expect(t.priority).toBe('high');
      expect(t.description).toContain('Lighthouse');
      expect(a.cleanedText).toContain("OK, I'll add this");
      expect(a.cleanedText).toContain('Done.');
      expect(a.cleanedText).not.toContain('bJIRA_CREATE');
    });

    it('drops bJIRA_CREATE missing title', () => {
      const reply = `[bJIRA_CREATE status=open]\nbody\n[/bJIRA_CREATE]`;
      const a = extractArtifactActions(reply);
      expect(a.taskCreates).toHaveLength(0);
    });

    it('handles unquoted title (no spaces)', () => {
      const reply = `[bJIRA_CREATE title=fixbug status=open]\nfoo\n[/bJIRA_CREATE]`;
      const a = extractArtifactActions(reply);
      expect(a.taskCreates).toHaveLength(1);
      expect(a.taskCreates[0].title).toBe('fixbug');
    });
  });

  describe('bJIRA_UPDATE', () => {
    it('parses self-closing bJIRA_UPDATE', () => {
      const reply = `Marking it done. [bJIRA_UPDATE id=bJIRA-12 status=done assignee=cas-pop]`;
      const a = extractArtifactActions(reply);
      expect(a.taskUpdates).toHaveLength(1);
      expect(a.taskUpdates[0]).toEqual({
        id: 'bJIRA-12',
        status: 'done',
        assignee: 'cas-pop',
        title: undefined,
        tags: undefined,
        priority: undefined,
      });
      expect(a.cleanedText).toContain('Marking it done.');
      expect(a.cleanedText).not.toContain('bJIRA_UPDATE');
    });

    it('parses block-form bJIRA_UPDATE with body as comment', () => {
      const reply = `[bJIRA_UPDATE id=bJIRA-5 status=blocked]
Waiting on infra approval.
[/bJIRA_UPDATE]`;
      const a = extractArtifactActions(reply);
      expect(a.taskUpdates).toHaveLength(1);
      expect(a.taskUpdates[0].status).toBe('blocked');
      expect(a.taskComments).toHaveLength(1);
      expect(a.taskComments[0].id).toBe('bJIRA-5');
      expect(a.taskComments[0].text).toContain('Waiting on infra');
    });

    it('drops bJIRA_UPDATE missing id', () => {
      const reply = `[bJIRA_UPDATE status=done]`;
      const a = extractArtifactActions(reply);
      expect(a.taskUpdates).toHaveLength(0);
    });
  });

  describe('bJIRA_COMMENT', () => {
    it('parses a comment block', () => {
      const reply = `[bJIRA_COMMENT id=bJIRA-1]Lighthouse 78 — needs perf work[/bJIRA_COMMENT]`;
      const a = extractArtifactActions(reply);
      expect(a.taskComments).toHaveLength(1);
      expect(a.taskComments[0]).toEqual({
        id: 'bJIRA-1',
        text: 'Lighthouse 78 — needs perf work',
      });
      expect(a.cleanedText).not.toContain('bJIRA_COMMENT');
    });
  });

  describe('bCONF_WRITE / bCONF_UPDATE / bCONF_APPEND', () => {
    it('parses bCONF_WRITE', () => {
      const reply = `[bCONF_WRITE title="Auth Spec" tags=auth,api]
# Auth Spec
JWT all the way.
[/bCONF_WRITE]`;
      const a = extractArtifactActions(reply);
      expect(a.docWrites).toHaveLength(1);
      expect(a.docWrites[0].title).toBe('Auth Spec');
      expect(a.docWrites[0].tags).toEqual(['auth', 'api']);
      expect(a.docWrites[0].body).toContain('# Auth Spec');
    });

    it('parses bCONF_UPDATE', () => {
      const reply = `[bCONF_UPDATE id=bCONF-3 title="Auth Spec v2"]
new body content
[/bCONF_UPDATE]`;
      const a = extractArtifactActions(reply);
      expect(a.docUpdates).toHaveLength(1);
      expect(a.docUpdates[0].id).toBe('bCONF-3');
      expect(a.docUpdates[0].title).toBe('Auth Spec v2');
      expect(a.docUpdates[0].body).toContain('new body content');
    });

    it('parses bCONF_APPEND', () => {
      const reply = `[bCONF_APPEND id=bCONF-3]
## Update 2026-04-10
fixed thing
[/bCONF_APPEND]`;
      const a = extractArtifactActions(reply);
      expect(a.docAppends).toHaveLength(1);
      expect(a.docAppends[0].id).toBe('bCONF-3');
      expect(a.docAppends[0].text).toContain('## Update');
    });

    it('drops bCONF_WRITE missing title', () => {
      const reply = `[bCONF_WRITE tags=x]\nbody\n[/bCONF_WRITE]`;
      const a = extractArtifactActions(reply);
      expect(a.docWrites).toHaveLength(0);
    });
  });

  describe('multiple markers', () => {
    it('parses mixed task + doc markers in one reply', () => {
      const reply = `Status update:

[bJIRA_UPDATE id=bJIRA-1 status=in_progress]

[bJIRA_CREATE title="Add caching" tags=perf]
Cache the auth response for 60s.
[/bJIRA_CREATE]

[bCONF_APPEND id=bCONF-2]
## Today
shipped bJIRA-1
[/bCONF_APPEND]

That's all for now.`;
      const a = extractArtifactActions(reply);
      expect(a.taskUpdates).toHaveLength(1);
      expect(a.taskCreates).toHaveLength(1);
      expect(a.docAppends).toHaveLength(1);
      expect(a.cleanedText).toContain('Status update:');
      expect(a.cleanedText).toContain("That's all");
      expect(a.cleanedText).not.toContain('bJIRA_');
      expect(a.cleanedText).not.toContain('bCONF_');
    });
  });

  describe('forgiving parsing', () => {
    it('handles case-insensitive tags', () => {
      const reply = `[bjira_create title="x"]\nbody\n[/bjira_create]`;
      const a = extractArtifactActions(reply);
      expect(a.taskCreates).toHaveLength(1);
    });

    it('handles extra whitespace in attributes', () => {
      const reply = `[bJIRA_UPDATE   id = bJIRA-1   status = done  ]`;
      const a = extractArtifactActions(reply);
      expect(a.taskUpdates).toHaveLength(1);
      expect(a.taskUpdates[0].status).toBe('done');
    });

    it('preserves malformed/unknown markers in cleanedText (no crash)', () => {
      const reply = `Hi [NOT_A_REAL_MARKER foo=bar] still works`;
      const a = extractArtifactActions(reply);
      expect(a.cleanedText).toContain('NOT_A_REAL_MARKER');
      expect(a.taskCreates).toHaveLength(0);
    });

    it('ignores invalid status values', () => {
      const reply = `[bJIRA_UPDATE id=bJIRA-1 status=banana]`;
      const a = extractArtifactActions(reply);
      expect(a.taskUpdates).toHaveLength(1);
      expect(a.taskUpdates[0].status).toBeUndefined();
    });

    it('does NOT match generic TASK_/DOC_ words an LLM might write in normal prose', () => {
      // Critical: agents can talk about "task creation" or write "[DOC_WRITE]" in
      // a code example without accidentally mutating the store. Only the b-prefixed
      // markers are reserved.
      const reply = `Here's how a generic task tracker might look:
[TASK_CREATE title="example"]
not a real action — just docs
[/TASK_CREATE]
And [DOC_WRITE title="x"]still nothing[/DOC_WRITE].`;
      const a = extractArtifactActions(reply);
      expect(a.taskCreates).toHaveLength(0);
      expect(a.docWrites).toHaveLength(0);
      expect(a.cleanedText).toContain('TASK_CREATE');
      expect(a.cleanedText).toContain('DOC_WRITE');
    });
  });

  describe('cleanedText', () => {
    it('returns input unchanged when no markers present', () => {
      const reply = 'just a normal reply';
      const a = extractArtifactActions(reply);
      expect(a.cleanedText).toBe('just a normal reply');
    });

    it('collapses excess blank lines after stripping markers', () => {
      const reply = `Before

[bJIRA_UPDATE id=bJIRA-1 status=done]


After`;
      const a = extractArtifactActions(reply);
      // Should not have 3+ consecutive newlines
      expect(a.cleanedText).not.toMatch(/\n{3,}/);
      expect(a.cleanedText).toContain('Before');
      expect(a.cleanedText).toContain('After');
    });
  });

  describe('CHANNEL_REPLY', () => {
    it('extracts channel reply content and strips marker from cleanedText', () => {
      const reply = `Let me check the files and make the fix.
Editing templates...

[CHANNEL_REPLY]
Shipped GA4 ID fix — commit 16631b0. All 3 templates updated.
[/CHANNEL_REPLY]

Done, moving on.`;
      const a = extractArtifactActions(reply);
      expect(a.channelReply).toBe('Shipped GA4 ID fix — commit 16631b0. All 3 templates updated.');
      expect(a.cleanedText).not.toContain('CHANNEL_REPLY');
      expect(a.cleanedText).toContain('Let me check');
      expect(a.cleanedText).toContain('Done, moving on');
    });

    it('joins multiple channel reply blocks', () => {
      const reply = `[CHANNEL_REPLY]Part 1[/CHANNEL_REPLY]
middle text
[CHANNEL_REPLY]Part 2[/CHANNEL_REPLY]`;
      const a = extractArtifactActions(reply);
      expect(a.channelReply).toBe('Part 1\n\nPart 2');
    });

    it('returns undefined channelReply when no marker is present', () => {
      const a = extractArtifactActions('Just a normal reply.');
      expect(a.channelReply).toBeUndefined();
    });

    it('is case-insensitive', () => {
      const reply = '[channel_reply]Summary here[/channel_reply]';
      const a = extractArtifactActions(reply);
      expect(a.channelReply).toBe('Summary here');
    });

    it('works alongside bJIRA/bCONF markers', () => {
      const reply = `[bJIRA_UPDATE id=bJIRA-1 status=done]
[CHANNEL_REPLY]Fixed the LCP issue. Tests pass.[/CHANNEL_REPLY]`;
      const a = extractArtifactActions(reply);
      expect(a.taskUpdates).toHaveLength(1);
      expect(a.channelReply).toBe('Fixed the LCP issue. Tests pass.');
    });
  });
});

describe('parseReplyToChannel', () => {
  it('parses a [REPLY_TO_CHANNEL] block with channel and message IDs', () => {
    const text = `I did the work.
[REPLY_TO_CHANNEL][#project][%abc-123-def]
Shipped the fix — commit 16631b0.
[/REPLY_TO_CHANNEL]`;
    const result = parseReplyToChannel(text);
    expect(result).toEqual({
      channelId: 'project',
      messageId: 'abc-123-def',
      content: 'Shipped the fix — commit 16631b0.',
    });
  });

  it('returns null when no marker is present', () => {
    expect(parseReplyToChannel('Just normal output')).toBeNull();
  });

  it('handles multiline content', () => {
    const text = `[REPLY_TO_CHANNEL][#perf][%msg-42]
Done:
- Fixed LCP
- Updated templates

Blocked: nothing
[/REPLY_TO_CHANNEL]`;
    const result = parseReplyToChannel(text);
    expect(result).not.toBeNull();
    expect(result!.channelId).toBe('perf');
    expect(result!.messageId).toBe('msg-42');
    expect(result!.content).toContain('Fixed LCP');
    expect(result!.content).toContain('Blocked: nothing');
  });
});

describe('stripReplyToChannel', () => {
  it('strips the marker block from text', () => {
    const text = `Before
[REPLY_TO_CHANNEL][#ch][%msg]content[/REPLY_TO_CHANNEL]
After`;
    const stripped = stripReplyToChannel(text);
    expect(stripped).not.toContain('REPLY_TO_CHANNEL');
    expect(stripped).toContain('Before');
    expect(stripped).toContain('After');
  });
});

describe('parseReplyRouting', () => {
  it('extracts channelId and messageId from routing header', () => {
    const prompt = `[ROLE: QA]\n\n[REPLY_TO_CHANNEL][#perf][%msg-42]\n---\nDo the work.`;
    const result = parseReplyRouting(prompt);
    expect(result).toEqual({ channelId: 'perf', messageId: 'msg-42' });
  });

  it('returns null when no routing header is present', () => {
    expect(parseReplyRouting('Just a normal prompt')).toBeNull();
  });

  it('extracts only the routing — does not require closing tag', () => {
    const prompt = `[REPLY_TO_CHANNEL][#project][%abc-123]`;
    const result = parseReplyRouting(prompt);
    expect(result).toEqual({ channelId: 'project', messageId: 'abc-123' });
  });
});

describe('extractChannelReply', () => {
  it('extracts [CHANNEL_REPLY] content from output', () => {
    const text = `Tool output...done.
[CHANNEL_REPLY]
bJIRA-9 PASS — all checks green.
**Done:** launch ready
[/CHANNEL_REPLY]`;
    const result = extractChannelReply(text);
    expect(result).toContain('bJIRA-9 PASS');
    expect(result).toContain('launch ready');
  });

  it('returns null when no [CHANNEL_REPLY] marker is present', () => {
    expect(extractChannelReply('Just normal text output')).toBeNull();
  });

  it('joins multiple [CHANNEL_REPLY] blocks', () => {
    const text = `[CHANNEL_REPLY]Part 1[/CHANNEL_REPLY]
Middle text
[CHANNEL_REPLY]Part 2[/CHANNEL_REPLY]`;
    const result = extractChannelReply(text);
    expect(result).toBe('Part 1\n\nPart 2');
  });

  it('returns null for empty [CHANNEL_REPLY] blocks', () => {
    expect(extractChannelReply('[CHANNEL_REPLY][/CHANNEL_REPLY]')).toBeNull();
  });

  it('handles nested bJIRA markers inside [CHANNEL_REPLY]', () => {
    const text = `[CHANNEL_REPLY]
QA done.
[bJIRA_UPDATE id=bJIRA-9 status=done]
Verified.
[/bJIRA_UPDATE]
[/CHANNEL_REPLY]`;
    const result = extractChannelReply(text);
    expect(result).toContain('QA done.');
    expect(result).toContain('bJIRA_UPDATE'); // raw extraction, no artifact processing
  });
});
