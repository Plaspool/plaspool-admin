import { defineConfig } from 'vite';

/**
 * Bundle the server into ONE ESM module for the Vercel function.
 *
 * WHY THIS EXISTS, because it is not obvious and the failure it fixes is
 * invisible to every test in this repository.
 *
 * `@vercel/node` does not bundle. It transpiles each `.ts` to a sibling `.js`,
 * traces the imports, and ships the tree — preserving every import specifier
 * verbatim. `package.json` is `"type": "module"` (Vite requires it), so the
 * function runs under Node's ESM loader, and that loader requires an EXPLICIT
 * FILE EXTENSION on every relative import. This codebase is written for
 * `moduleResolution: "bundler"` and has 145 extensionless relative specifiers
 * across `server/` and `shared/`. The result, measured on a real deployment:
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find module
 *     '/var/task/server/index' imported from /var/task/api/index.js
 *
 * — a `FUNCTION_INVOCATION_FAILED` 500 on EVERY route including `/api/health`,
 * which is registered before the database middleware precisely so it can answer
 * with no environment at all. The failure is at module load, so nothing in the
 * application ever runs.
 *
 * Nothing local catches it. `tsc -b` only typechecks; `tsx` and Vitest both
 * resolve extensionless specifiers; and every route test calls `app.request()`
 * in process, so the suite never crosses Node's loader. The API surface has
 * been "shipped" since the HTTP tasks and has never once served a request in
 * production.
 *
 * Two ways out. Add `.js` to 145 imports — which rewrites files a concurrent
 * session owns and re-opens the same hole the next time somebody writes an
 * import the way the rest of the codebase writes them. Or bundle, so the
 * function has exactly ONE relative specifier and it carries its extension.
 * This is the second. It also makes the cold start cheaper: one module to read
 * instead of a traced tree.
 *
 * `ssr` externalises everything in `node_modules`, so the bundle carries this
 * repository's own code and nothing else — `@vercel/nft` still traces the real
 * dependencies from the import statements left behind.
 */
export default defineConfig({
  build: {
    ssr: 'server/index.ts',
    outDir: 'api-build',
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: 'server.js',
        format: 'esm',
      },
    },
  },
});
