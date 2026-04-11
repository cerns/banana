# Project Banana

Multi-session Claude Code orchestration system. Monorepo with npm workspaces.
All sessions are remote (SSH-only) — no local client package.

## Stack
- Node.js / TypeScript (CommonJS, ES2022)
- `ws` for WebSockets, vanilla HTML/JS dashboard, Node 18+ built-ins
- **No `import.meta.url`** — uses `__dirname` (CommonJS)

## Structure
```
packages/
  server/   HTTP + WS hub, REST API, dashboard at /
  cli/      `banana` binary — HTTP REST client
```

## Build & Run
```bash
npm install
npm run build   # compiles all packages; server also copies dashboard static files

BANANA_TOKEN=test node packages/server/dist/index.js
BANANA_TOKEN=test node packages/cli/dist/index.js <cmd>
```

## Environment Variables
```
BANANA_TOKEN=          # required everywhere
BANANA_PORT=3000       # server
BANANA_HISTORY_MAX=1000
BANANA_PERSIST_PATH=   # optional file persistence
BANANA_CLAUDE_BIN=claude
```

## WebSocket Protocol

### Dashboard → Server / Server → Dashboard
- `DASHBOARD_CONNECT` — auth
- `DASHBOARD_ACK` — auth OK
- `DASHBOARD_REJECT` — auth failed
- `DASHBOARD_EVENT` — forwards OUTPUT_CHUNK/DONE/ERROR + SESSION_CONNECTED/DISCONNECTED

## Testing
```bash
npm test              # run all tests once
npm run test:watch    # watch mode
npm run test:coverage # run with coverage report
```

- **Framework**: vitest 3.x with `@vitest/coverage-v8`
- **Config**: `vitest.config.ts` at repo root
- **Test files**: `packages/server/test/**/*.test.ts`
- **Coverage thresholds**: 90% lines/functions/statements, 85% branches

### Test Structure
```
packages/server/test/
  config.test.ts                    # env var loading, defaults, missing token
  machines/machineStore.test.ts     # CRUD, redaction, persistence, findByAlias
  sessions/sessionStore.test.ts     # CRUD, chunks, jobs, updateMeta, legacy normalization
  sessions/sessionManager.test.ts   # remote sessions, jobs, prefix resolve
  ssh/sshRunner.test.ts             # SSH connection, claude execution, shell escape, auth
  ssh/remoteSessionExecutor.test.ts # job orchestration, abort, error flows, broadcasts
  http/apiRouter.test.ts            # all REST endpoints, CORS, auth, machine+session CRUD
  ws/dashboardBroadcast.test.ts     # broadcast to open/closed connections
```

### Mocking Patterns
- `vi.mock('../../src/config.js')` — stub config values
- `vi.mock('fs')` — mock file I/O for store persistence
- `vi.mock('ssh2')` — EventEmitter-based mock Client and streams
- `vi.resetModules()` + dynamic `await import()` — isolate singletons between tests
- `createReq()` / `createRes()` helpers — mock HTTP request/response for apiRouter tests

## REST API
```
GET    /api/machines
GET    /api/machines/:id
POST   /api/machines
PUT    /api/machines/:id
DELETE /api/machines/:id
POST   /api/machines/:id/test

GET    /api/sessions
GET    /api/sessions/:id
POST   /api/sessions                → create remote session
PATCH  /api/sessions/:id            → rename session
POST   /api/sessions/:id/send       → { jobId }
POST   /api/sessions/:id/abort     → stop running job
DELETE /api/sessions/:id
GET    /api/health
```

## CLI Commands
```
banana list
banana send <id-prefix> <prompt>
banana logs <id-prefix>
banana stop <id-prefix>
banana kill <id-prefix>
banana status
banana machines              # list machines
banana machines add          # interactive add
banana machines rm <id>      # remove machine
banana machines test <id>    # test SSH connection
```

## Key Details
- Hello timeout: 5s for dashboard WS auth
- Claude invoked over SSH via `remoteSessionExecutor.ts` → `sshRunner.ts`
- Session ID prefix matching (first 8 chars) supported in CLI
- Dashboard static files: `src/http/dashboard/` → copied to `dist/http/dashboard/` at build
