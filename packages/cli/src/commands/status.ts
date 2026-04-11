import { apiFetch } from '../client.js';

interface Health {
  status: string;
  connectedClients: number;
  totalSessions: number;
  uptime: number;
}

export async function statusCommand(): Promise<void> {
  const health = await apiFetch<Health>('/api/health');

  console.log(`Status        : ${health.status}`);
  console.log(`Connected     : ${health.connectedClients} client(s)`);
  console.log(`Total sessions: ${health.totalSessions}`);
  console.log(`Uptime        : ${Math.floor(health.uptime)}s`);
}
