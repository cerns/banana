import { apiFetch } from '../client.js';

export async function sendCommand(sessionPrefix: string, prompt: string): Promise<void> {
  if (!sessionPrefix || !prompt) {
    console.error('Usage: banana send <session-id-prefix> <prompt>');
    process.exit(1);
  }

  const result = await apiFetch<{ jobId: string }>(`/api/sessions/${sessionPrefix}/send`, {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  });

  console.log(`Job dispatched: ${result.jobId}`);
}
