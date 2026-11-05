import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['db/tests/global-setup.ts'],
    // Off unless asked for: see the header of apps/api/src/test/access-trace.setup.ts.
    setupFiles: process.env.HRMS_ACCESS_TRACE_DIR ? ['apps/api/src/test/access-trace.setup.ts'] : [],
    // The web app has its own config (jsdom); it is tested with `npm test -w apps/web`.
    exclude: ['**/node_modules/**', 'apps/web/**'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // Each file gets its own cloned database, so files can run in parallel against the one server.
    fileParallelism: true,
    maxWorkers: 4,
    minWorkers: 1,
  },
});
