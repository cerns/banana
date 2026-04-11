import { apiFetch } from '../client.js';

interface Session {
  sessionId: string;
  hostname: string;
  workdir: string;
  status: string;
  connectedAt: string;
  jobCount: number;
  type?: string;
  name?: string;
}

export async function listCommand(): Promise<void> {
  const sessions = await apiFetch<Session[]>('/api/sessions');

  if (sessions.length === 0) {
    console.log('No sessions found.');
    return;
  }

  const header = ['ID', 'NAME', 'TYPE', 'HOST', 'STATUS', 'JOBS'].map(h => h.padEnd(16)).join('  ');
  console.log(header);
  console.log('\u2500'.repeat(header.length));

  for (const s of sessions) {
    const row = [
      s.sessionId.slice(0, 8).padEnd(16),
      (s.name ?? '-').slice(0, 14).padEnd(16),
      (s.type ?? 'local').padEnd(16),
      (s.hostname ?? '?').slice(0, 14).padEnd(16),
      s.status.padEnd(16),
      String(s.jobCount ?? 0).padEnd(16),
    ].join('  ');
    console.log(row);
  }
}
