/// <reference types="vitest/config" />
import { cpSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const root = dirname(fileURLToPath(import.meta.url))

/**
 * Ship `docs/api/` with the site.
 *
 * The API reference is plain static HTML that lives OUTSIDE `src/`, so Vite
 * never sees it: nothing imports it, and it is not in `public/`. Without this
 * it exists only on a developer's machine — which is how it came to be
 * documented as "open it on localhost".
 *
 * A build-time copy rather than a move into `public/`: the docs are source
 * material that a reader browses in the repository, and `public/` is the
 * app's own asset folder. Copying keeps one canonical location.
 *
 * `closeBundle` rather than `writeBundle`, so the copy lands after Vite has
 * finished writing (and, on a fresh build, after it has emptied `outDir` —
 * doing this earlier would delete it again).
 */
function copyApiDocs(): Plugin {
  let outDir = 'dist'
  return {
    name: 'copy-api-docs',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      const from = resolve(root, 'docs/api')
      if (!existsSync(from)) {
        this.warn('docs/api is missing — the published site will have no API reference')
        return
      }
      cpSync(from, resolve(root, outDir, 'docs/api'), { recursive: true })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), copyApiDocs()],
  /*
   * `server/dev.ts` listens on 8787, and the proxy keeps the SAME path prefix
   * as production, where the Vercel catch-all passes `/api/*` through
   * unmodified — so a route that works here works there.
   *
   * The port is overridable through `API_PORT` in `.env` (read with `loadEnv`
   * because Vite does not put unprefixed variables on `process.env`), and
   * `server/dev.ts` reads `PORT` for the same reason. Neither has a default
   * that differs from what this file has always used. It exists because two
   * checkouts of this repository can be running at once — that is the normal
   * state here — and the second one cannot bind 8787, which previously meant
   * its frontend silently proxied to the FIRST one's API and its database.
   */
  server: {
    proxy: {
      '/api': `http://localhost:${loadEnv(mode, process.cwd(), '').API_PORT || 8787}`,
    },
  },
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
}))
