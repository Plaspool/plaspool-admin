/**
 * The Vercel entrypoint, and the deployment config that has to agree with it.
 *
 * NOTHING ELSE IN THE SUITE LOOKS AT THIS FILE. Every route test drives
 * `app.request()`, which is the same object this exports — so the app can be
 * perfect and production can still 404 or 500 on everything, because of how the
 * handler is exported, where the file sits, or what `vercel.json` names. Those
 * are the things asserted here, and each of them is a whole-application outage
 * rather than a bug.
 *
 * THIS FILE LIVES IN `server/`, NOT IN `api/`. Everything under `api/` becomes
 * a serverless function under zero-config detection, so while it sat there it
 * deployed as `entrypoint.test.func` — a public production endpoint at
 * `/api/entrypoint.test`, with `vitest` (a devDependency) pulled into the
 * bundle. Confirmed live. `.vercelignore` now excludes `**\/*.test.ts` as well,
 * so a test file dropped into `api/` later still cannot become a route.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import handler, { runtime } from '../api/index';

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
  functions: Record<string, { runtime?: string; maxDuration?: number }>;
  rewrites: { source: string; destination: string }[];
};

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  engines?: { node?: string };
};

describe('api/index.ts', () => {
  it('exports a DEFAULT handler, not the Next.js named-method form', () => {
    /*
     * `export const GET = handle(app)` is the Next.js App Router convention.
     * This is a Vite project whose functions come from the `api/` directory,
     * where Vercel's Node builder looks for a default export and ignores named
     * ones — so the Next form would 500 every route in production while passing
     * every other test in this repository.
     */
    expect(typeof handler).toBe('function');
    const source = readFileSync('api/index.ts', 'utf8');
    expect(source).toContain('export default handle(app)');
    // Anchored to a line start so the docblock explaining the Next.js form
    // does not count as using it.
    expect(source).not.toMatch(/^export const (GET|POST|PATCH|DELETE) =/m);
  });

  it('actually serves, and one handler covers every method', async () => {
    const get = await handler(new Request('https://studio.test/api/health'));
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ ok: true });

    // Method-agnostic: `handle` returns `(req) => app.fetch(req)`. A POST to an
    // unrouted path reaches the Origin guard, which is proof the same function
    // dispatches a non-GET.
    const post = await handler(
      new Request('https://studio.test/api/posts', { method: 'POST' }),
    );
    expect(post.status).toBe(403);
  });

  it('serves the path unmodified, so /api routes need the /api prefix', async () => {
    // The rewrite rewrites the DESTINATION FILE, not the path — `/api/(.*)` to
    // `/api` leaves `c.req.path` as `/api/auth/login`. Mounting the routers at
    // `/auth/login` would 404 everything in production.
    const stripped = await handler(new Request('https://studio.test/health'));
    expect(stripped.status).toBe(404);
  });

  it('runs on Node, and the version is pinned by engines, not by functions.runtime', () => {
    // scrypt is `node:crypto` (spec §6) and does not exist on the edge.
    expect(runtime).toBe('nodejs');

    /*
     * THE REGRESSION THIS EXISTS FOR. `functions[].runtime` in `vercel.json` is
     * the npm package spec of a COMMUNITY runtime (`now-php@1.0.0`), not a Node
     * version. `"nodejs24.x"` there made `vercel build` and `vercel dev` both
     * abort with "Function Runtimes must have a valid version" — nothing could
     * build. Reproduced identically with 24/22/20/18.x.
     *
     * The previous version of this test asserted
     * `expect(configured.runtime).toMatch(/^nodejs\d+\.x$/)`, which pinned the
     * WRONG contract and went green on a config the platform rejects.
     */
    for (const configured of Object.values(vercel.functions)) {
      expect(configured.runtime).toBeUndefined();
    }
    expect(pkg.engines?.node).toMatch(/^\d+\.x$/);
  });

  it('vercel.json names a pattern that matches the entrypoint', () => {
    const keys = Object.keys(vercel.functions);
    expect(keys).toHaveLength(1);
    const asRegex = new RegExp(`^${keys[0].replace(/\*/g, '[^/]*')}$`);
    expect(asRegex.test('api/index.ts')).toBe(true);
  });

  it('routes EVERY /api path, at any depth, to the one function', () => {
    /*
     * The outage this replaces: with `api/[[...route]].ts` and no explicit
     * rewrite, the platform emitted `^/api/([^/]+)$` — one segment — followed
     * by `^/api(/.*)?$ → 404`. `/api/posts` worked; `/api/auth/login`,
     * `/api/posts/:id` and `/api/posts/:id/publish` were a platform 404 with
     * the application never invoked. Login was unreachable in production.
     */
    const [api] = vercel.rewrites;
    expect(api.destination).toBe('/api');
    const source = new RegExp(`^${api.source}$`);
    for (const path of [
      '/api/health',
      '/api/posts',
      '/api/auth/login',
      '/api/auth/me',
      '/api/posts/p_1',
      '/api/posts/p_1/publish',
      '/api/posts/p_1/revisions/r_1/restore',
      '/api/a/b/c',
    ]) {
      expect([path, source.test(path)]).toEqual([path, true]);
    }
  });

  it('the SPA rewrite comes after /api and does not swallow it', () => {
    // Without the negative lookahead every API request would be answered with
    // index.html — a 200 of HTML where the client expects JSON. Order matters
    // as much as the pattern: Vercel takes the FIRST matching rewrite.
    const spa = vercel.rewrites[1];
    expect(spa.destination).toBe('/index.html');
    const source = new RegExp(`^${spa.source}$`);
    expect(source.test('/api/posts')).toBe(false);
    expect(source.test('/api/auth/login')).toBe(false);
    expect(source.test('/editor/p_1')).toBe(true);
    expect(source.test('/')).toBe(true);
  });

  it('the test file is excluded from the deployment', () => {
    /*
     * `api/entrypoint.test.ts` deployed as `entrypoint.test.func` and was
     * reachable at `/api/entrypoint.test`, with vitest in the bundle.
     */
    const ignore = readFileSync('.vercelignore', 'utf8');
    expect(ignore).toMatch(/^\*\*\/\*\.test\.ts$/m);
    expect(readdirSync('api')).toEqual(['index.ts']);
  });
});

/**
 * The real thing, opt-in.
 *
 * `vercel build` needs a Vercel account, network and `vercel pull`, so it
 * cannot be a default gate in a suite that has to run offline — the assertions
 * above are the offline proxy for each of its findings. Run it deliberately:
 *
 *     VERCEL_BUILD_TEST=1 npx vitest run server/entrypoint.test.ts
 */
const buildIt = process.env.VERCEL_BUILD_TEST === '1' ? it : it.skip;

describe('vercel build (opt-in)', () => {
  buildIt('builds, and emits exactly one function that every /api path reaches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vercel-build-'));
    try {
      execFileSync('git', ['archive', '--format=tar', '-o', join(dir, 'src.tar'), 'HEAD']);
      execFileSync('tar', ['-xf', join(dir, 'src.tar'), '-C', dir]);
      cpSync('node_modules', join(dir, 'node_modules'), { recursive: true });
      execFileSync('npx', ['vercel', 'build', '--yes'], { cwd: dir, stdio: 'inherit' });

      const config = JSON.parse(
        readFileSync(join(dir, '.vercel/output/config.json'), 'utf8'),
      ) as { routes: { src?: string; dest?: string; status?: number }[] };

      const funcs = readdirSync(join(dir, '.vercel/output/functions'));
      expect(funcs.filter((f) => f.endsWith('.func'))).toEqual(['api/index.func']);

      for (const path of ['/api/health', '/api/auth/login', '/api/a/b/c']) {
        const hit = config.routes.find((r) => r.src && new RegExp(r.src).test(path));
        expect([path, hit?.status]).toEqual([path, undefined]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
