import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * FOUR projects, and `shared` is not optional.
 *
 * With only `src`/`server` projects, `npx vitest run` reports success and
 * silently omits `shared/**` entirely, while `npx vitest run shared/x.test.ts`
 * exits 1 with "No test files found" — which reads exactly like a passing red
 * gate. An entire suite can go missing behind a green bar.
 *
 * Two more things this encodes:
 *
 * - The `server` timeout bump exists because `freshDb()` boots PGlite, runs
 *   migrations and seeds users.
 * - Creating this file stops Vitest reading `vite.config.ts`, so the `ui`
 *   project has to declare the React plugin itself.
 *
 * Deliberately NOT a global jsdom environment, and deliberately no
 * `setupFiles: ['fake-indexeddb/auto']`. The data suites run against
 * fake-indexeddb, which they each import on line 1; under jsdom the Blob they
 * hand back has no `.arrayBuffer()`, which breaks the export round trip
 * (measured: 51/52) and costs ~60s of environment setup.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'shared', include: ['shared/**/*.test.ts'], environment: 'node' },
      },
      {
        test: { name: 'client', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        test: {
          name: 'server',
          include: ['server/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20000,
          hookTimeout: 20000,
        },
      },
      {
        plugins: [react()],
        test: { name: 'ui', include: ['src/**/*.test.tsx'], environment: 'jsdom' },
      },
    ],
  },
});
