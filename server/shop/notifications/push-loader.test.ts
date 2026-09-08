/**
 * `web-push` UNDER THE PRODUCTION MODULE LOADER.
 *
 * The second dependency in this repository to carry the CommonJS trap that made
 * the whole CSV feature a 500 for its entire life (CLAUDE.md §5), and it is
 * invisible to every other kind of test: `vite.server.config.ts` builds the
 * function with `ssr`, which EXTERNALISES node_modules, so the bundle keeps
 * `import … from 'web-push'` verbatim and NODE's OWN ESM LOADER resolves it in
 * production — while vitest goes through vite-node, which interops CommonJS and
 * makes every form work.
 *
 * Measured on web-push 3.6.7, exactly as papaparse behaved:
 *
 *     Object.keys(ns) -> ['WebPushError', 'default', 'module.exports',
 *                         'supportedContentEncodings']
 *     ns.sendNotification         -> undefined      (a production 500)
 *     ns.default.sendNotification -> function       (what the default import gives)
 *
 * So a namespace import passes this suite and 500s live, and a NAMED import is
 * worse still — the same lexer blindness makes `import { sendNotification }` a
 * link-time SyntaxError under Node.
 *
 * This test reads `push.ts`'s OWN import line and its OWN member accesses out of
 * the source, then runs them through a real `node --input-type=module`. It
 * cannot rot as the file changes, and it fails the moment somebody "tidies" the
 * import into a namespace or a named one.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = 'server/shop/notifications/push.ts';

describe('web-push under the production module loader', () => {
  it("resolves every member push.ts uses, with push.ts's own import line", () => {
    const source = readFileSync(SOURCE, 'utf8');

    const importLine = source.match(/^import .*from 'web-push';$/m)?.[0]?.trim();
    expect(importLine, `no web-push import found in ${SOURCE}`).toBeTruthy();

    const local = importLine!.match(/^import (?:\* as )?(\w+)/)![1];
    // The call sites — webpush.setVapidDetails, webpush.sendNotification.
    const used = [
      ...new Set(
        [...source.matchAll(new RegExp(String.raw`\b${local}\.(\w+)`, 'g'))].map((m) => m[1]),
      ),
    ];
    expect(used.length, `${SOURCE} dereferences nothing on ${local}`).toBeGreaterThan(0);

    const probe = [
      importLine!,
      `const used = ${JSON.stringify(used)};`,
      `const kinds = Object.fromEntries(used.map((k) => [k, typeof ${local}?.[k]]));`,
      'console.log(JSON.stringify(kinds));',
    ].join(' ');

    /*
     * `--input-type=module -e` and not a temp file, for csv.test.ts's reason:
     * Node resolves a bare specifier from the IMPORTING FILE's directory, so a
     * probe written to the OS temp dir cannot see node_modules at all and dies
     * with ERR_MODULE_NOT_FOUND — a red test that proves nothing. An --eval
     * module resolves from cwd, which vitest runs at the repo root: the same
     * node_modules the deployment ships.
     */
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(JSON.parse(out.trim())).toEqual(
      Object.fromEntries(used.map((name) => [name, 'function'])),
    );
  }, 30_000);

  it('a namespace import of web-push would NOT work — the trap is real, not theoretical', () => {
    /*
     * The negative control, and the reason the test above is not a tautology.
     * Without this, a future maintainer reading "we must use a default import"
     * has only an assertion to go on; this demonstrates the failure it prevents,
     * against the real package, on the real loader.
     */
    const probe = [
      "import * as ns from 'web-push';",
      "console.log(JSON.stringify({ sendNotification: typeof ns.sendNotification }));",
    ].join(' ');

    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(JSON.parse(out.trim())).toEqual({ sendNotification: 'undefined' });
  }, 30_000);
});
