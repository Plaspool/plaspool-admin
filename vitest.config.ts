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
 * The same failure mode is why every include below is `**\/*.{test,spec}.{ts,tsx}`
 * rather than `**\/*.test.ts`. The narrow patterns left four blind spots, each
 * of which swallows a file whole with no error anywhere:
 *
 * - nothing under `api/` — where the Vercel entrypoint lives
 * - nothing at the repo root
 * - no `*.spec.ts` anywhere, though nothing forbids the name
 * - no `.test.tsx` under `server/` or `shared/`
 *
 * The one deliberate exception is `src/`, which is split by extension and not
 * by directory: `.test.ts` runs under node and `.test.tsx` under jsdom, because
 * making jsdom global costs ~60s of environment setup and breaks the data
 * suites (see below).
 *
 * Two more things this encodes:
 *
 * - The `server` timeout bump exists because `freshDb()` boots PGlite, runs
 *   migrations and seeds users. `hookTimeout` is twice `testTimeout` because
 *   that boot happens in `beforeAll` and its cost is dominated by how many
 *   other workers are compiling WASM at the same moment, not by anything the
 *   suite does. Four server files opening their own database already made
 *   20 000 ms thin enough to lose: measured, a single boot is ~1.5 s, but
 *   three suites racing on a loaded machine push it past 20 s and the file
 *   fails in `beforeAll` with every test in it reported as SKIPPED — which is
 *   a red bar with no failing assertion anywhere to explain it.
 *
 *   The HTTP surface added five more database-opening suites and the margin
 *   went from thin to gone: `migrations.test.ts`, which boots several PGlite
 *   instances INSIDE a test body rather than in a hook, timed out at 22.2 s
 *   against the 20 000 ms ceiling with nothing wrong with it. Raised to
 *   60 000 ms. This is a ceiling on machine contention, not on anything a
 *   test is allowed to take: no suite here does 60 s of work, and a genuine
 *   hang still fails, just later.
 * - Creating this file stops Vitest reading `vite.config.ts`, so the `ui`
 *   project has to declare the React plugin itself.
 *
 * Deliberately NOT a global jsdom environment, and deliberately no
 * `setupFiles: ['fake-indexeddb/auto']`. The data suites run against
 * fake-indexeddb, which they each import on line 1; under jsdom the Blob they
 * hand back has no `.arrayBuffer()`, which breaks the export round trip
 * (measured: 51/52) and costs ~60s of environment setup.
 */

/**
 * The server suites run real code, and real code reads `SESSION_SECRET` — the
 * session and invite token ids are HMACs under it. These are test values, not
 * secrets: `DATABASE_URL` is never dialled (every suite builds its own PGlite)
 * and the origin list is only parsed.
 */
const serverEnv = {
  DATABASE_URL: 'postgres://localhost/unused-in-tests',
  SESSION_SECRET: 'test-session-secret-not-used-in-production',
  APP_ORIGINS: 'http://localhost:5173',
  NODE_ENV: 'test',
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          include: ['shared/**/*.{test,spec}.{ts,tsx}'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'client',
          include: ['src/**/*.{test,spec}.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'server',
          include: [
            'server/**/*.{test,spec}.{ts,tsx}',
            'api/**/*.{test,spec}.{ts,tsx}',
            '*.{test,spec}.{ts,tsx}',
          ],
          environment: 'node',
          env: serverEnv,
          testTimeout: 60000,
          hookTimeout: 120000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'ui',
          include: ['src/**/*.{test,spec}.tsx'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
