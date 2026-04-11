import http from 'http';
import fs from 'fs';
import path from 'path';
import { handleApiRequest } from './apiRouter.js';

const DASHBOARD_DIR = path.join(__dirname, 'dashboard');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

export function createHttpServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      // Try API routes first
      const handled = await handleApiRequest(req, res);
      if (handled) return;

      // Serve static dashboard files
      let urlPath = req.url?.split('?')[0] ?? '/';
      if (urlPath === '/') urlPath = '/index.html';

      const filePath = path.join(DASHBOARD_DIR, urlPath);

      // Security: prevent path traversal
      if (!filePath.startsWith(DASHBOARD_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'text/plain' });
        res.end(data);
      });
    } catch (e) {
      console.error('[http] Error:', e);
      res.writeHead(500);
      res.end('Internal server error');
    }
  });

  return server;
}
