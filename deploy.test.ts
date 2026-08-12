/**
 * The deployment wiring for the API reference.
 *
 * `docs/api/` is static HTML that lives outside `src/`, so nothing imports it
 * and Vite would never emit it. Two separate things have to stay true for it to
 * be reachable in production, and BOTH fail silently:
 *
 * 1. the build has to copy it into `outDir` — if the plugin is dropped, the
 *    site still builds and deploys, just without the docs;
 * 2. the SPA catch-all in `vercel.json` must not swallow the path — if the
 *    negative lookahead loses its `docs/` arm, every docs URL quietly starts
 *    serving the app's `index.html` instead, which looks like a broken link
 *    rather than a config regression.
 *
 * Neither shows up in a typecheck, a unit test, or a successful deploy. So the
 * regex is EXERCISED here rather than pattern-matched as a string: a test that
 * only greps for `docs/` would pass against a lookahead that does not work.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Rewrite {
  source: string;
  destination: string;
}
interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}
interface VercelConfig {
  outputDirectory: string;
  rewrites: Rewrite[];
  headers?: HeaderRule[];
}

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as VercelConfig;
const viteConfig = readFileSync('vite.config.ts', 'utf8');

const DOCS_ENTRY = '/docs/api/index.html';

/** The catch-all is the last rewrite; everything above it is more specific. */
const catchAll = vercel.rewrites[vercel.rewrites.length - 1];

describe('the API reference is deployed, not just local', () => {
  it('is copied into the build output', () => {
    expect(viteConfig).toContain('copyApiDocs');
    // Registered, not merely defined — a plugin absent from `plugins` is inert.
    expect(viteConfig).toMatch(/plugins:\s*\[[^\]]*copyApiDocs\(\)/);
  });

  it('copies from the one canonical location', () => {
    expect(viteConfig).toContain("'docs/api'");
    // The source files the plugin copies must actually be there.
    expect(readFileSync('docs/api/index.html', 'utf8')).toContain('API_SURFACES');
    expect(readFileSync('docs/api/routes.js', 'utf8')).toContain('window.API_ROUTES');
  });

  /*
   * THE ONE THAT MATTERS. Vercel checks the filesystem before applying
   * `rewrites`, so a real file at `/docs/api/index.html` is served directly —
   * but only if the catch-all does not claim it first.
   */
  describe('the SPA catch-all does not swallow the docs', () => {
    const pattern = new RegExp(`^${catchAll.source}$`);

    it('leaves every docs path to the filesystem', () => {
      for (const path of [
        DOCS_ENTRY,
        '/docs/api/routes.js',
        '/docs/api/',
        '/docs/anything/else.png',
      ]) {
        expect(`${path} → ${pattern.test(path) ? 'SPA' : 'filesystem'}`).toBe(
          `${path} → filesystem`,
        );
      }
    });

    it('still routes the app itself, so the exclusion did not over-reach', () => {
      for (const path of ['/', '/read/abc', '/settings', '/accept-invite']) {
        expect(`${path} → ${pattern.test(path) ? 'SPA' : 'filesystem'}`).toBe(`${path} → SPA`);
      }
    });

    it('still leaves the API alone', () => {
      expect(pattern.test('/api/public/posts')).toBe(false);
    });
  });

  /*
   * `/docs/api` has no extension and matches no file, so the filesystem cannot
   * serve it and the catch-all no longer claims it — without these it is a 404.
   */
  it('serves the bare directory path', () => {
    for (const source of ['/docs/api', '/docs/api/']) {
      const rule = vercel.rewrites.find((r) => r.source === source);
      expect(`${source} → ${rule?.destination ?? 'MISSING'}`).toBe(`${source} → ${DOCS_ENTRY}`);
    }
  });

  it('is ordered ahead of the catch-all', () => {
    const docsIndex = vercel.rewrites.findIndex((r) => r.source === '/docs/api');
    const catchAllIndex = vercel.rewrites.indexOf(catchAll);
    expect(docsIndex).toBeGreaterThan(-1);
    expect(docsIndex).toBeLessThan(catchAllIndex);
  });

  /*
   * This page maps the owner-only admin surface as well as the public one. It
   * is deployed for the team, and search engines are told to stay out of it —
   * in a header, because a `<meta>` tag does not cover `routes.js`.
   */
  it('is kept out of search results', () => {
    const rule = vercel.headers?.find((h) => h.source.startsWith('/docs/api'));
    const tag = rule?.headers.find((h) => h.key.toLowerCase() === 'x-robots-tag');
    expect(tag?.value).toContain('noindex');
    expect(readFileSync('docs/api/index.html', 'utf8')).toContain('name="robots"');
  });
});
