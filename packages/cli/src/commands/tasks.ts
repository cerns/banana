import { apiFetch } from '../client.js';

interface TaskActivity {
  at: string;
  by: string;
  kind: string;
  text?: string;
  from?: string;
  to?: string;
}

interface ChannelTask {
  id: string;
  channelId: string;
  title: string;
  description?: string;
  status: string;
  assignee?: string;
  reporter: string;
  tags: string[];
  priority?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  activity: TaskActivity[];
}

function getFlag(name: string): string | undefined {
  const flag = process.argv.find(a => a.startsWith(`--${name}=`));
  return flag ? flag.split('=').slice(1).join('=') : undefined;
}

function statusBadge(s: string): string {
  return `[${s}]`.padEnd(14);
}

export async function tasksListCommand(channel: string): Promise<void> {
  if (!channel) {
    console.error('Usage: banana tasks list <channel> [--status=open] [--q=foo] [--tags=a,b] [--assignee=name]');
    process.exit(1);
  }
  const params = new URLSearchParams();
  const status = getFlag('status'); if (status) params.set('status', status);
  const q = getFlag('q'); if (q) params.set('q', q);
  const tags = getFlag('tags'); if (tags) params.set('tags', tags);
  const assignee = getFlag('assignee'); if (assignee) params.set('assignee', assignee);
  const qs = params.toString();
  const path = `/api/hub/channels/${channel}/tasks${qs ? `?${qs}` : ''}`;

  const tasks = await apiFetch<ChannelTask[]>(path);
  if (tasks.length === 0) {
    console.log(`No tasks in #${channel}.`);
    return;
  }
  for (const t of tasks) {
    const assigneeStr = t.assignee ? ` @${t.assignee}` : '';
    const tagStr = t.tags.length ? ` (${t.tags.join(',')})` : '';
    const prio = t.priority ? ` !${t.priority}` : '';
    console.log(`${t.id.padEnd(8)} ${statusBadge(t.status)}${assigneeStr}${tagStr}${prio} — ${t.title}`);
  }
}

export async function tasksShowCommand(id: string): Promise<void> {
  if (!id) {
    console.error('Usage: banana tasks show <id>');
    process.exit(1);
  }
  const task = await apiFetch<ChannelTask>(`/api/hub/tasks/${id}`);
  console.log(`${task.id} — ${task.title}`);
  console.log(`  channel:  ${task.channelId}`);
  console.log(`  status:   ${task.status}`);
  if (task.assignee) console.log(`  assignee: ${task.assignee}`);
  console.log(`  reporter: ${task.reporter}`);
  if (task.tags.length) console.log(`  tags:     ${task.tags.join(', ')}`);
  if (task.priority) console.log(`  priority: ${task.priority}`);
  console.log(`  created:  ${new Date(task.createdAt).toLocaleString()}`);
  console.log(`  updated:  ${new Date(task.updatedAt).toLocaleString()}`);
  if (task.description) {
    console.log('');
    console.log(task.description);
  }
  if (task.activity.length) {
    console.log('');
    console.log('Activity:');
    for (const a of task.activity) {
      const t = new Date(a.at).toLocaleString();
      let line = `  ${t}  ${a.by}  ${a.kind}`;
      if (a.from !== undefined || a.to !== undefined) line += `: ${a.from ?? '∅'} → ${a.to ?? '∅'}`;
      if (a.text) line += `: ${a.text}`;
      console.log(line);
    }
  }
}

export async function tasksCreateCommand(channel: string): Promise<void> {
  if (!channel) {
    console.error('Usage: banana tasks create <channel> --title="..." [--description=...] [--assignee=...] [--tags=a,b] [--priority=high]');
    process.exit(1);
  }
  const title = getFlag('title');
  if (!title) {
    console.error('--title is required');
    process.exit(1);
  }
  const body: Record<string, unknown> = { title };
  const description = getFlag('description'); if (description) body.description = description;
  const assignee = getFlag('assignee'); if (assignee) body.assignee = assignee;
  const tags = getFlag('tags'); if (tags) body.tags = tags.split(',').map(s => s.trim()).filter(Boolean);
  const priority = getFlag('priority'); if (priority) body.priority = priority;

  const task = await apiFetch<ChannelTask>(`/api/hub/channels/${channel}/tasks`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  console.log(`Created ${task.id}: ${task.title}`);
}

export async function tasksUpdateCommand(id: string): Promise<void> {
  if (!id) {
    console.error('Usage: banana tasks update <id> [--status=...] [--assignee=...] [--title=...] [--tags=a,b] [--priority=...]');
    process.exit(1);
  }
  const body: Record<string, unknown> = {};
  const status = getFlag('status'); if (status) body.status = status;
  const assignee = getFlag('assignee'); if (assignee) body.assignee = assignee;
  const title = getFlag('title'); if (title) body.title = title;
  const description = getFlag('description'); if (description) body.description = description;
  const tags = getFlag('tags'); if (tags) body.tags = tags.split(',').map(s => s.trim()).filter(Boolean);
  const priority = getFlag('priority'); if (priority) body.priority = priority;

  if (Object.keys(body).length === 0) {
    console.error('Nothing to update — pass at least one --field=value');
    process.exit(1);
  }

  const task = await apiFetch<ChannelTask>(`/api/hub/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  console.log(`Updated ${task.id}: status=${task.status}${task.assignee ? ` assignee=${task.assignee}` : ''}`);
}

export async function tasksCommentCommand(id: string, text: string): Promise<void> {
  if (!id || !text) {
    console.error('Usage: banana tasks comment <id> "<text>"');
    process.exit(1);
  }
  await apiFetch(`/api/hub/tasks/${id}/comments`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  console.log(`Comment added to ${id}`);
}

export async function tasksRemoveCommand(id: string): Promise<void> {
  if (!id) {
    console.error('Usage: banana tasks rm <id>');
    process.exit(1);
  }
  await apiFetch(`/api/hub/tasks/${id}`, { method: 'DELETE' });
  console.log(`Removed ${id}`);
}
