/**
 * Types for the generated server bundle.
 *
 * `api-build/server.js` is written by `vite.server.config.ts` during
 * `npm run build`. It is build output — gitignored, absent on a clean checkout,
 * and carrying no declarations of its own — so `api/index.ts` importing it
 * would otherwise be a TS2307 on any machine that has not built yet, including
 * the first `tsc -b` of the build that produces it.
 *
 * The type is not restated here. It is read back off `server/index.ts`, so the
 * bundle cannot claim an export shape the source does not have: rename or
 * remove `app` there and this stops compiling, which is the whole point of
 * declaring it rather than reaching for `any`.
 */
declare module '*/api-build/server.js' {
  export const app: (typeof import('../server/index'))['app'];
}
