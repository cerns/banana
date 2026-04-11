import { WebSocket } from 'ws';

export const dashboardConnections = new Set<WebSocket>();

export function broadcastToDashboards(data: unknown): void {
  const msg = JSON.stringify(data);
  for (const ws of dashboardConnections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}
