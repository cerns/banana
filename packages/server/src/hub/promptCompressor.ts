/**
 * LLMLingua-style heuristic prompt compressor.
 *
 * Pure-JS, zero-dep text compression aimed at reducing token usage by
 * 20–40% on chatty / verbose inputs without changing meaning. Designed
 * for hub prompts where the bulk of the text is conversational chat
 * history rather than precise spec.
 *
 * Strategy:
 *   1. Code blocks (```fenced```) and inline `code` are preserved verbatim.
 *   2. Common filler words ("basically", "just", "really", ...) are dropped.
 *   3. Wordy phrases are rewritten ("in order to" → "to").
 *   4. Whitespace is collapsed (runs of spaces, trailing spaces, 3+ newlines).
 *   5. Adjacent duplicate lines are deduplicated.
 *   6. Long URLs are NOT shortened (would change meaning if the agent quotes them).
 *
 * The transform is idempotent: compressPrompt(compressPrompt(x)) === compressPrompt(x).
 */

const FILLER_WORDS = new Set([
  'basically',
  'really',
  'actually',
  'literally',
  'honestly',
  'simply',
  'obviously',
  'clearly',
  'definitely',
  'absolutely',
  'essentially',
  'particularly',
  'specifically',
  'kinda',
  'sorta',
  'somewhat',
]);

const FILLER_PHRASES: Array<[RegExp, string]> = [
  [/\bkind of\b/gi, ''],
  [/\bsort of\b/gi, ''],
  [/\bin order to\b/gi, 'to'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bfor the purpose of\b/gi, 'for'],
  [/\bwith regard to\b/gi, 'about'],
  [/\bwith respect to\b/gi, 'about'],
  [/\bin the event that\b/gi, 'if'],
  [/\bin spite of the fact that\b/gi, 'although'],
  [/\bit is important to note that\b/gi, ''],
  [/\bplease note that\b/gi, ''],
  [/\bit should be noted that\b/gi, ''],
  [/\bas a matter of fact\b/gi, ''],
  [/\bat the end of the day\b/gi, ''],
  [/\bneedless to say\b/gi, ''],
  [/\bas you can see\b/gi, ''],
  [/\bin my opinion\b/gi, ''],
  [/\bI think that\b/gi, ''],
  [/\bI believe that\b/gi, ''],
];

export interface CompressOptions {
  preserveCodeBlocks?: boolean;
  dropFillers?: boolean;
  collapseWhitespace?: boolean;
  dedupeLines?: boolean;
}

export interface CompressionStats {
  beforeChars: number;
  afterChars: number;
  ratio: number;
  saved: number;
}

/**
 * Compress text heuristically. Preserves code blocks. Idempotent.
 */
export function compressPrompt(text: string, opts: CompressOptions = {}): string {
  if (!text) return text;

  const {
    preserveCodeBlocks = true,
    dropFillers = true,
    collapseWhitespace = true,
    dedupeLines = true,
  } = opts;

  const segments = preserveCodeBlocks ? splitCodeAndProse(text) : [{ kind: 'prose' as const, text }];

  const out: string[] = [];
  for (const seg of segments) {
    if (seg.kind === 'code') {
      out.push(seg.text);
      continue;
    }
    let s = seg.text;
    if (dropFillers) s = stripFillers(s);
    if (collapseWhitespace) s = collapseWhitespace_(s);
    if (dedupeLines) s = dedupeAdjacentLines(s);
    out.push(s);
  }

  let joined = out.join('');

  // Final cross-segment whitespace normalization (only if we touched whitespace).
  if (collapseWhitespace) {
    joined = joined.replace(/\n{3,}/g, '\n\n');
  }
  return joined;
}

export function compressionStats(before: string, after: string): CompressionStats {
  const b = before.length;
  const a = after.length;
  return {
    beforeChars: b,
    afterChars: a,
    ratio: b > 0 ? a / b : 1,
    saved: Math.max(0, b - a),
  };
}

interface Segment {
  kind: 'prose' | 'code';
  text: string;
}

/**
 * Split text into alternating prose / code segments. Code segments are
 * fenced ``` blocks OR inline `code` spans, both preserved verbatim.
 * We split on fenced blocks first (multi-line) then on inline backticks
 * inside the prose pieces.
 */
function splitCodeAndProse(text: string): Segment[] {
  const segments: Segment[] = [];
  const fenceRe = /```[\s\S]*?```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text))) {
    if (m.index > last) {
      segments.push(...splitInlineCode(text.slice(last, m.index)));
    }
    segments.push({ kind: 'code', text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    segments.push(...splitInlineCode(text.slice(last)));
  }
  return segments;
}

function splitInlineCode(text: string): Segment[] {
  const segments: Segment[] = [];
  const re = /`[^`\n]+`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      segments.push({ kind: 'prose', text: text.slice(last, m.index) });
    }
    segments.push({ kind: 'code', text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    segments.push({ kind: 'prose', text: text.slice(last) });
  }
  return segments;
}

function stripFillers(text: string): string {
  let out = text;
  // Multi-word phrase substitutions first (so single-word pass doesn't fragment them).
  for (const [re, repl] of FILLER_PHRASES) {
    out = out.replace(re, repl);
  }
  // Single-word fillers — only true word matches (Latin letters + apostrophe).
  out = out.replace(/\b[a-zA-Z']+\b/g, (match) => {
    return FILLER_WORDS.has(match.toLowerCase()) ? '' : match;
  });
  return out;
}

function collapseWhitespace_(text: string): string {
  return text
    // Trim trailing spaces/tabs on each line
    .replace(/[ \t]+$/gm, '')
    // Collapse runs of 2+ spaces/tabs into a single space (within a line)
    .replace(/[ \t]{2,}/g, ' ')
    // Strip leading space before common punctuation (left over by filler removal)
    .replace(/ +([,.;:!?)])/g, '$1')
    // Strip space after opening parens (left over by filler removal)
    .replace(/(\() +/g, '$1')
    // Collapse 3+ blank lines into 2
    .replace(/\n{3,}/g, '\n\n');
}

function dedupeAdjacentLines(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let prev: string | null = null;
  for (const line of lines) {
    const norm = line.trim();
    if (norm.length > 0 && norm === prev) continue;
    out.push(line);
    prev = norm;
  }
  return out.join('\n');
}
