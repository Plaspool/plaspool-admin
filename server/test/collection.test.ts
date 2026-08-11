/**
 * A test suite that is never run is indistinguishable from one that passes, and
 * Vitest reports both as success. `vitest.config.ts` had four blind spots where
 * a whole file could be added and silently never execute:
 *
 *   - nothing under `api/` — the Vercel entrypoint's own directory
 *   - nothing at the repo root
 *   - no `*.spec.ts` anywhere, though nothing forbids the name
 *   - no `.test.tsx` under `server/` or `shared/`
 *
 * This asserts on the config's source text, which is unusual and deliberate: a
 * config cannot observe its own collection, and a test placed in a blind spot
 * to prove the blind spot exists would simply not run. Reading the patterns is
 * the only check that can fail when the patterns narrow again.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = readFileSync('vitest.config.ts', 'utf8');

/** The `include:` array of one named project, as written. */
function includesOf(project: string): string {
  const start = config.indexOf(`name: '${project}'`);
  expect(start, `no project named ${project}`).toBeGreaterThan(-1);
  const open = config.indexOf('include:', start);
  expect(open, `project ${project} declares no include`).toBeGreaterThan(-1);
  return config.slice(open, config.indexOf(']', open) + 1);
}

describe('every project collects every test file under it', () => {
  it.each(['shared', 'client', 'server', 'ui'])('%s declares an include', (project) => {
    expect(includesOf(project)).toContain('{test,spec}');
  });

  it('server reaches api/ and the repo root, not just server/', () => {
    const include = includesOf('server');
    expect(include).toContain('server/**/*.{test,spec}.{ts,tsx}');
    expect(include).toContain('api/**/*.{test,spec}.{ts,tsx}');
    // Bare pattern = repo root. `leak.ts`-style reproduction scripts and any
    // top-level regression test land here.
    expect(include).toMatch(/'\*\.\{test,spec\}\.\{ts,tsx\}'/);
  });

  it('shared and server accept .tsx as well as .ts', () => {
    expect(includesOf('shared')).toContain('{ts,tsx}');
    expect(includesOf('server')).toContain('{ts,tsx}');
  });

  it('src stays split by extension, because jsdom is not free', () => {
    // The one intentional narrowing. `client` runs under node and `ui` under
    // jsdom; a global jsdom environment costs ~60s of setup and breaks the
    // data suites, whose fake-indexeddb Blob loses `.arrayBuffer()` under it.
    expect(includesOf('client')).toContain('src/**/*.{test,spec}.ts');
    expect(includesOf('ui')).toContain('src/**/*.{test,spec}.tsx');
  });
});
