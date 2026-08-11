/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
