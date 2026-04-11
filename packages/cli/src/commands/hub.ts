import { apiFetch } from '../client.js';

interface HubChannel {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
}

interface HubMessage {
  id: string;
  channelId: string;
  fromName: string;
  content: string;
  tags: string[];
  mentions: string[];
  depth: number;
  timestamp: string;
  status: string;
}

export async function hubChannelsCommand(): Promise<void> {
  const channels = await apiFetch<HubChannel[]>('/api/hub/channels');

  if (channels.length === 0) {
    console.log('No channels found.');
    return;
  }

  const header = ['ID', 'NAME', 'DESCRIPTION', 'CREATED'].map(h => h.padEnd(20)).join('  ');
  console.log(header);
  console.log('\u2500'.repeat(header.length));

  for (const ch of channels) {
    const row = [
      ch.id.slice(0, 18).padEnd(20),
      ch.name.slice(0, 18).padEnd(20),
      (ch.description ?? '-').slice(0, 18).padEnd(20),
      new Date(ch.createdAt).toLocaleString().slice(0, 18).padEnd(20),
    ].join('  ');
    console.log(row);
  }
}

export async function hubPostCommand(channel: string, message: string, tags?: string): Promise<void> {
  if (!channel || !message) {
    console.error('Usage: banana hub post <channel> <message> [--tags=x,y]');
    process.exit(1);
  }

  const tagList = tags ? tags.split(',').map(s => s.trim()).filter(Boolean) : [];

  const result = await apiFetch<HubMessage>('/api/hub/messages', {
    method: 'POST',
    body: JSON.stringify({
      channelIds: [channel],
      content: message,
      tags: tagList,
      mentions: [],
    }),
  });

  console.log(`Posted to #${channel}: ${result.id.slice(0, 8)}`);
}

export async function hubMessagesCommand(channel: string): Promise<void> {
  if (!channel) {
    console.error('Usage: banana hub messages <channel>');
    process.exit(1);
  }

  const messages = await apiFetch<HubMessage[]>(`/api/hub/channels/${channel}/messages`);

  if (messages.length === 0) {
    console.log(`No messages in #${channel}.`);
    return;
  }

  for (const m of messages) {
    const indent = '  '.repeat(Math.min(m.depth, 5));
    const tags = m.tags.length ? ` [${m.tags.join(', ')}]` : '';
    const mentions = m.mentions.length ? ` @${m.mentions.join(' @')}` : '';
    const time = new Date(m.timestamp).toLocaleTimeString();
    console.log(`${indent}${time} ${m.fromName}: ${m.content.slice(0, 200)}${tags}${mentions} (${m.status})`);
  }
}
