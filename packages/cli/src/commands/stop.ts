import { apiFetch } from '../client.js';

export async function stopCommand(sessionPrefix: string): Promise<void> {
  if (!sessionPrefix) {
    console.error('Usage: banana stop <session-id-prefix>');
    process.exit(1);
  }

  const res = await apiFetch(`/api/sessions/${sessionPrefix}/abort`, { method: 'POST' }) as { aborted?: boolean };
  if (res.aborted) {
    console.log(`Session ${sessionPrefix} — job aborted.`);
  } else {
    console.log(`Session ${sessionPrefix} — no active job to abort.`);
  }
}
