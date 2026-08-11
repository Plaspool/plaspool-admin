/**
 * The Vercel entrypoint, and the deployment config that has to agree with it.
 *
 * NOTHING ELSE IN THE SUITE LOOKS AT THIS FILE. Every route test drives
 * `app.request()`, which is the same object this exports — so the app can be
 * perfect and production can still 404 or 500 on everything, because of how the
 * handler is exported, where the file sits, or what `vercel.json` names. Those
 * are the three things asserted here, and each of them is a whole-application
 * outage rather than a bug.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import handler, { runtime } from './[[...route]]';

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
  functions: Record<string, { runtime: string; maxDuration?: number }>;
  rewrites: { source: string; destination: string }[];
};

describe('api/[[...route]].ts', () => {
  it('exports a DEFAULT handler, not the Next.js named-method form', () => {
    /*
     * `export const GET = handle(app)` is the Next.js App Router convention.
     * This is a Vite project whose functions come from the `api/` directory,
     * where Vercel's Node builder looks for a default export and ignores named
     * ones — so the Next form would 500 every route in production while passing
     * every other test in this repository.
     */
    expect(typeof handler).toBe('function');
    const named = readFileSync('api/[[...route]].ts', 'utf8');
    expect(named).toContain('export default handle(app)');
    // Anchored to a line start so the docblock explaining the Next.js form
    // does not count as using it.
    expect(named).not.toMatch(/^export const (GET|POST|PATCH|DELETE) =/m);
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
    // The catch-all rewrites nothing — it only decides which function runs.
    // Mounting the routers at `/posts` would 404 everything in production.
    const stripped = await handler(new Request('https://studio.test/health'));
    expect(stripped.status).toBe(404);
  });

  it('runs on Node, never the edge runtime', () => {
    // scrypt is `node:crypto` (spec §6) and does not exist on the edge.
    expect(runtime).toBe('nodejs');
    const configured = Object.values(vercel.functions)[0];
    expect(configured.runtime).toMatch(/^nodejs\d+\.x$/);
  });

  it('vercel.json names a pattern that matches this file', () => {
    /*
     * `[` and `]` are glob character-class metacharacters, so the literal key
     * `api/[[...route]].ts` is NOT a pattern that matches the file called
     * `api/[[...route]].ts` — it is a character class. The key has to be one
     * that matches by wildcard instead.
     */
    const keys = Object.keys(vercel.functions);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain('[');
    const asRegex = new RegExp(`^${keys[0].replace(/\*/g, '[^/]*')}$`);
    expect(asRegex.test('api/[[...route]].ts')).toBe(true);
  });

  it('the SPA rewrite does not swallow /api', () => {
    // Without the negative lookahead every API request would be answered with
    // index.html — a 200 of HTML where the client expects JSON.
    const [rewrite] = vercel.rewrites;
    expect(rewrite.destination).toBe('/index.html');
    const source = new RegExp(`^${rewrite.source}$`);
    expect(source.test('/api/posts')).toBe(false);
    expect(source.test('/api/auth/login')).toBe(false);
    expect(source.test('/editor/p_1')).toBe(true);
    expect(source.test('/')).toBe(true);
  });
});
