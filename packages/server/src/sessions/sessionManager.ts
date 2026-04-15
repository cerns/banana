import { randomUUID } from 'crypto';
import { sessionStore, type SessionRecord, type JobRecord, type JobSource } from './sessionStore.js';

export function createJob(sessionId: string, prompt: string, source?: JobSource): JobRecord {
  const session = sessionStore.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const job: JobRecord = {
    jobId: randomUUID(),
    prompt,
    startedAt: new Date().toISOString(),
    chunks: [],
    source,
  };
  session.jobs.push(job);
  sessionStore.upsert(session);
  return job;
}

export interface CreateRemoteSessionOpts {
  role?: string;
  screenName?: string;
  interests?: string[];
  rolePrompt?: string;
  channels?: string[];
  model?: string;
}

export function createRemoteSession(machineId: string, name: string, workdir?: string, opts?: CreateRemoteSessionOpts): SessionRecord {
  const record: SessionRecord = {
    sessionId: randomUUID(),
    clientId: '',
    hostname: name,
    workdir: workdir ?? '',
    connectedAt: new Date().toISOString(),
    status: 'connected',
    jobs: [],
    type: 'remote',
    name,
    machineId,
    remoteWorkdir: workdir,
    role: opts?.role,
    screenName: opts?.screenName,
    interests: opts?.interests,
    rolePrompt: opts?.rolePrompt,
    channels: opts?.channels,
    model: opts?.model,
  };
  sessionStore.upsert(record);
  return record;
}

export function updateSessionName(sessionId: string, name: string): void {
  sessionStore.updateMeta(sessionId, { name });
}

export function updateClaudeSessionId(sessionId: string, claudeSessionId: string): void {
  sessionStore.updateMeta(sessionId, { claudeSessionId });
}

export function resolveSessionId(prefix: string): string | undefined {
  const all = sessionStore.getAll();
  const match = all.find(s => s.sessionId.startsWith(prefix));
  return match?.sessionId;
}
