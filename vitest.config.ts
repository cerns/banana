import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: '.',
    include: ['packages/*/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'packages/server/src/machines/**',
        'packages/server/src/sessions/**',
        'packages/server/src/ssh/**',
        'packages/server/src/hub/**',
        'packages/server/src/http/apiRouter.ts',
        'packages/server/src/config.ts',
        'packages/server/src/ws/dashboardBroadcast.ts',
      ],
      reporter: ['text', 'text-summary'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
});
