import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { config } from '../config.js';
import { dashboardConnections } from './dashboardBroadcast.js';

export { broadcastToDashboards } from './dashboardBroadcast.js';

const HELLO_TIMEOUT_MS = 5_000;

function send(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

export function createWsServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    let authenticated = false;

    // Hello timeout — close if no auth in 5s
    const helloTimer = setTimeout(() => {
      if (!authenticated) {
        ws.close(4001, 'Hello timeout');
      }
    }, HELLO_TIMEOUT_MS);

    ws.on('message', (rawData) => {
      const raw = rawData.toString();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      // Handle dashboard auth
      if (msg.type === 'DASHBOARD_CONNECT') {
        if (msg.token !== config.token) {
          send(ws, { type: 'DASHBOARD_REJECT', reason: 'INVALID_TOKEN' });
          ws.close(4003, 'Invalid token');
          return;
        }
        clearTimeout(helloTimer);
        dashboardConnections.add(ws);
        authenticated = true;
        send(ws, { type: 'DASHBOARD_ACK' });
        console.log('[ws] Dashboard connected');
        return;
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (dashboardConnections.has(ws)) {
        dashboardConnections.delete(ws);
        console.log('[ws] Dashboard disconnected');
      }
    });

    ws.on('error', (err) => {
      console.error('[ws] Socket error:', err.message);
    });
  });

  return wss;
}
