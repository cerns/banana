import { apiFetch } from '../client.js';

export async function killCommand(sessionPrefix: string): Promise<void> {
  if (!sessionPrefix) {
    console.error('Usage: banana kill <session-id-prefix>');
    process.exit(1);
  }

  await apiFetch(`/api/sessions/${sessionPrefix}`, { method: 'DELETE' });
  console.log(`Session ${sessionPrefix} killed.`);
}
