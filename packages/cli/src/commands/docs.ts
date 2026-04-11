import fs from 'fs';
import { apiFetch } from '../client.js';

interface DocRevision {
  version: number;
  at: string;
  by: string;
  body: string;
}

interface ChannelDoc {
  id: string;
  channelId: string;
  title: string;
  body: string;
  tags: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  history: DocRevision[];
}

function getFlag(name: string): string | undefined {
  const flag = process.argv.find(a => a.startsWith(`--${name}=`));
  return flag ? flag.split('=').slice(1).join('=') : undefined;
}

function readBodyFromFlag(): string | undefined {
  const file = getFlag('file');
  if (file) {
    return fs.readFileSync(file, 'utf8');
  }
  const body = getFlag('body');
  return body;
}

export async function docsListCommand(channel: string): Promise<void> {
  if (!channel) {
    console.error('Usage: banana docs list <channel> [--q=foo] [--tags=a,b]');
    process.exit(1);
  }
  const params = new URLSearchParams();
  const q = getFlag('q'); if (q) params.set('q', q);
  const tags = getFlag('tags'); if (tags) params.set('tags', tags);
  const qs = params.toString();
  const path = `/api/hub/channels/${channel}/docs${qs ? `?${qs}` : ''}`;

  const docs = await apiFetch<ChannelDoc[]>(path);
  if (docs.length === 0) {
    console.log(`No docs in #${channel}.`);
    return;
  }
  for (const d of docs) {
    const tagStr = d.tags.length ? ` (${d.tags.join(',')})` : '';
    console.log(`${d.id.padEnd(8)} v${d.version}  ${d.title}${tagStr}  — by ${d.author}`);
  }
}

export async function docsShowCommand(id: string): Promise<void> {
  if (!id) {
    console.error('Usage: banana docs show <id>');
    process.exit(1);
  }
  const doc = await apiFetch<ChannelDoc>(`/api/hub/docs/${id}`);
  console.log(`${doc.id} v${doc.version} — ${doc.title}`);
  console.log(`  channel: ${doc.channelId}`);
  console.log(`  author:  ${doc.author}`);
  if (doc.tags.length) console.log(`  tags:    ${doc.tags.join(', ')}`);
  console.log(`  updated: ${new Date(doc.updatedAt).toLocaleString()}`);
  console.log('');
  console.log(doc.body);
}

export async function docsCreateCommand(channel: string): Promise<void> {
  if (!channel) {
    console.error('Usage: banana docs create <channel> --title="..." --file=path/to/body.md [--tags=a,b]');
    process.exit(1);
  }
  const title = getFlag('title');
  if (!title) {
    console.error('--title is required');
    process.exit(1);
  }
  const body = readBodyFromFlag();
  if (!body) {
    console.error('--file or --body is required');
    process.exit(1);
  }
  const payload: Record<string, unknown> = { title, body };
  const tags = getFlag('tags'); if (tags) payload.tags = tags.split(',').map(s => s.trim()).filter(Boolean);

  const doc = await apiFetch<ChannelDoc>(`/api/hub/channels/${channel}/docs`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  console.log(`Created ${doc.id} v${doc.version}: ${doc.title}`);
}

export async function docsUpdateCommand(id: string): Promise<void> {
  if (!id) {
    console.error('Usage: banana docs update <id> [--title="..."] [--file=path/to/body.md] [--tags=a,b]');
    process.exit(1);
  }
  const payload: Record<string, unknown> = {};
  const title = getFlag('title'); if (title) payload.title = title;
  const body = readBodyFromFlag(); if (body !== undefined) payload.body = body;
  const tags = getFlag('tags'); if (tags) payload.tags = tags.split(',').map(s => s.trim()).filter(Boolean);

  if (Object.keys(payload).length === 0) {
    console.error('Nothing to update — pass --title, --file/--body, or --tags');
    process.exit(1);
  }

  const doc = await apiFetch<ChannelDoc>(`/api/hub/docs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  console.log(`Updated ${doc.id} → v${doc.version}`);
}

export async function docsAppendCommand(id: string): Promise<void> {
  if (!id) {
    console.error('Usage: banana docs append <id> --file=path/to/text.md');
    process.exit(1);
  }
  const text = readBodyFromFlag();
  if (!text) {
    console.error('--file or --body is required');
    process.exit(1);
  }
  const doc = await apiFetch<ChannelDoc>(`/api/hub/docs/${id}/append`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  console.log(`Appended to ${doc.id} → v${doc.version}`);
}

export async function docsHistoryCommand(id: string): Promise<void> {
  if (!id) {
    console.error('Usage: banana docs history <id>');
    process.exit(1);
  }
  const history = await apiFetch<DocRevision[]>(`/api/hub/docs/${id}/history`);
  if (history.length === 0) {
    console.log('No prior revisions.');
    return;
  }
  for (const r of history) {
    console.log(`v${r.version}  ${new Date(r.at).toLocaleString()}  by ${r.by}`);
  }
}

export async function docsRemoveCommand(id: string): Promise<void> {
  if (!id) {
    console.error('Usage: banana docs rm <id>');
    process.exit(1);
  }
  await apiFetch(`/api/hub/docs/${id}`, { method: 'DELETE' });
  console.log(`Removed ${id}`);
}
