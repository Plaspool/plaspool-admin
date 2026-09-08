/**
 * NOTHING UNDER `server/shop/logistics/` MAY IMPORT AN UNVETTED PACKAGE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FAILURE THIS GUARDS, WHICH HAS ALREADY HAPPENED HERE (PR #98). The
 * product CSV export and import were dead in production for their entire life
 * because of one namespace import of a CommonJS package: vitest interops
 * CommonJS happily, and Node under Vercel's ESM loader does not. Every test was
 * green, every review passed, and the feature 500'd for months for every user.
 *
 * A courier subsystem is exactly where that repeats. Both providers ship SDKs,
 * both are CommonJS, and reaching for one is the obvious move for a signature
 * helper or an HTTP wrapper at 2am. Spec §8 answers it with a rule — Node
 * `crypto` plus `fetch`, no new npm dependency — and a rule with no mechanism
 * behind it is a convention, which is what "shared, append-only" was.
 *
 * So: every `.ts` in this folder and below is read, every module specifier is
 * pulled out of it, and anything that is not relative, not `node:*` and not on
 * the allow-list below fails HERE, at the first `npm test`, naming the file and
 * the specifier — rather than in production, in a route nobody exercises until
 * a parcel needs booking.
 *
 * TESTS ARE SCANNED TOO, deliberately. A suite that imports a package the
 * production code may not is a suite that has proven nothing about what will
 * run on Vercel, and it is one refactor away from the import moving.
 *
 * THE ALLOW-LIST IS A DECISION, not a snapshot. Adding to it means stating that
 * the package is ESM-safe under Node's loader — which is a claim about the
 * package's `exports` map and about how it is imported, and is worth the
 * deliberate line it costs here.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = 'server/shop/logistics';

/**
 * The packages this subsystem is permitted, and nothing else.
 *
 * Exact specifiers, not prefixes: `drizzle-orm/pg-core` is listed in its own
 * right, so a new subpath of an allowed package is still a new decision.
 */
const ALLOWED = new Set(['zod', 'hono', 'drizzle-orm', 'drizzle-orm/pg-core', 'vitest']);

/** Every `.ts` under the subsystem, subfolders included, as repo-relative paths.
 *  A walk rather than a list written by hand (`server/nul-bytes.test.ts`
 *  doctrine): a guard whose coverage is enumerated stops covering the file
 *  somebody adds next week. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Every module specifier a file names, however it names it.
 *
 * Four patterns rather than one, because one lazy pattern spanning statements
 * mis-attributes a bare `import 'x';` to the next statement's `from`. Anchored
 * at the start of a line for the static forms, so a specifier quoted inside a
 * doc comment (whose continuation lines start with `*`) is prose and not an
 * import. `require(` is included even though nothing here should have one: it
 * is the exact shape of the PR #98 defect.
 */
export function specifiersIn(source: string): string[] {
  const patterns = [
    /^[ \t]*(?:import|export)\b[^;]*?\bfrom[ \t]*['"]([^'"]+)['"]/gm,
    /^[ \t]*import[ \t]+['"]([^'"]+)['"]/gm,
    /\bimport[ \t]*\([ \t]*['"]([^'"]+)['"][ \t]*\)/g,
    /\brequire[ \t]*\([ \t]*['"]([^'"]+)['"][ \t]*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1]!));
}

const isRelative = (spec: string): boolean => spec.startsWith('./') || spec.startsWith('../');
const isNodeBuiltin = (spec: string): boolean => spec.startsWith('node:');

/**
 * Excluded by name, because a file that greps for a shape contains it — the
 * `server/marketing/no-hardcoded-labels.test.ts` exemption, for the identical
 * reason. Its positive control below quotes two offending specifiers on
 * purpose, and they are prose here rather than imports. Its own two real
 * imports are `node:fs` and `vitest`, both of which the rule allows and both of
 * which are visible at the top of this file.
 */
const SELF = `${ROOT}/imports.test.ts`;

const sources = walk(ROOT).filter((path) => path !== SELF);

describe('the walk itself', () => {
  /*
   * THE GUARD'S OWN GUARD. A scan that finds no files passes hardest of all, so
   * a folder rename or a typo in ROOT would turn this file green and silent.
   */
  it('finds the sources it claims to be reading, subfolders included', () => {
    expect(sources).toContain(`${ROOT}/port.ts`);
    expect(sources).toContain(`${ROOT}/routes.ts`);
    expect(sources).toContain(`${ROOT}/schema.ts`);
    // The adapters live one level down; a walk that stopped at the top would
    // skip exactly the files most likely to reach for a provider SDK.
    expect(sources.some((p) => p.startsWith(`${ROOT}/fez/`))).toBe(true);
    expect(sources.some((p) => p.startsWith(`${ROOT}/terminal/`))).toBe(true);
    expect(sources.length).toBeGreaterThan(15);
  });

  it('extracts the specifiers it claims to extract', () => {
    /* The positive control for the patterns above. Each line is a form that
     * appears in this codebase, plus the two shapes the rule exists to catch. */
    const found = specifiersIn(
      [
        "import { z } from 'zod';",
        "import type { Db } from '../../db/client';",
        'import {',
        '  a,',
        "} from './port';",
        "import 'node:crypto';",
        "export * from './schema';",
        "export type { X } from './port';",
        "const m = await import('some-lazy-pkg');",
        "const cjs = require('a-commonjs-pkg');",
      ].join('\n'),
    );
    expect(found.sort()).toEqual(
      [
        'zod',
        '../../db/client',
        './port',
        'node:crypto',
        './schema',
        './port',
        'some-lazy-pkg',
        'a-commonjs-pkg',
      ].sort(),
    );
  });

  it('does not read a specifier out of prose', () => {
    // Block-comment continuation lines start with `*`, which the anchors reject.
    expect(specifiersIn(" * import kaboom from 'some-cjs-sdk';\n")).toEqual([]);
  });
});

describe('every import in the delivery-courier subsystem', () => {
  it('is relative, a node: builtin, or an allow-listed ESM-safe package', () => {
    const offenders = sources.flatMap((path) =>
      specifiersIn(readFileSync(path, 'utf8'))
        .filter((spec) => !isRelative(spec) && !isNodeBuiltin(spec) && !ALLOWED.has(spec))
        .map((spec) => `${path}: ${spec}`),
    );
    /*
     * Named rather than counted. "3 offending imports" sends the next reader
     * back to a grep; the file and the specifier are the whole fix.
     */
    expect(offenders).toEqual([]);
  });

  it('is judged by a rule that refuses the shape PR #98 shipped', () => {
    /*
     * The NEGATIVE control the assertion above needs. A filter that accepted
     * everything would make it green forever, and this is the exact import that
     * killed the CSV export in production — a bare package specifier, indistinct
     * from the allowed ones by eye.
     */
    const offending = (spec: string) => !isRelative(spec) && !isNodeBuiltin(spec) && !ALLOWED.has(spec);
    expect(offending('csv-parse/sync')).toBe(true);
    expect(offending('fez-delivery-sdk')).toBe(true);
    // And the allowed shapes are genuinely allowed, so the guard is not just
    // refusing everything.
    expect(offending('./fez/adapter')).toBe(false);
    expect(offending('../../db/client')).toBe(false);
    expect(offending('node:crypto')).toBe(false);
    expect(offending('zod')).toBe(false);
  });
});
