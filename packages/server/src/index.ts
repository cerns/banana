import { config } from './config.js';
import { sessionStore } from './sessions/sessionStore.js';
import { machineStore } from './machines/machineStore.js';
import { hubStore } from './hub/hubStore.js';
import { taskStore } from './hub/taskStore.js';
import { docStore } from './hub/docStore.js';
import { createHttpServer } from './http/httpServer.js';
import { createWsServer } from './ws/wsServer.js';
import { pushManager } from './push/pushManager.js';
import { drainGlobalQueue } from './hub/hubRouter.js';

sessionStore.load();
machineStore.load();
hubStore.load();
taskStore.load();
docStore.load();
pushManager.init();

const httpServer = createHttpServer();
createWsServer(httpServer);

httpServer.listen(config.port, () => {
  console.log(`[banana] Server running on http://localhost:${config.port}`);
  console.log(`[banana] Dashboard: http://localhost:${config.port}`);
  console.log(`[banana] Token configured: ${config.token ? 'yes' : 'NO (set BANANA_TOKEN)'}`);

  // Recover queued hub dispatches from previous session. Runs after the
  // HTTP server is ready so SSH connections can be established.
  const pending = sessionStore.getAll().filter(s => s.hubQueue?.length).length;
  if (pending > 0) {
    console.log(`[banana] Recovering queued hub dispatches for ${pending} session(s)`);
    drainGlobalQueue();
  }
});

httpServer.on('error', (err) => {
  console.error('[banana] Server error:', err);
  process.exit(1);
});
