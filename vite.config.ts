/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // `server/dev.ts` listens on 8787. Same path prefix as production, where the
  // Vercel catch-all passes `/api/*` through unmodified.
  server: { proxy: { '/api': 'http://localhost:8787' } },
  // NOTE: Vitest reads `vitest.config.ts` when it exists and never loads this
  // file, so the block below is inert. It is kept only as the record of why
  // the test environment is `node` and not `jsdom`; the live copy of this
  // reasoning lives in `vitest.config.ts`.
  test: {
    // Deliberately NOT a global jsdom environment. The data suites run against
    // fake-indexeddb, and under jsdom the Blob they hand back has no
    // .arrayBuffer(), which breaks the export round trip (measured: 51/52) and
    // costs ~60s of environment setup. The editor suites opt in per file with
    // a `// @vitest-environment jsdom` docblock instead. Vitest 4 removed
    // environmentMatchGlobs, so the docblock is the supported route.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
