/**
 * `npm run dev:api` was broken at HEAD.
 *
 * `package.json` has pointed it at `tsx server/dev.ts` since Task 1, and the
 * file did not exist — so `dev:api` died with `Cannot find module`, and
 * `dev:all` took the Vite dev server down with it under `concurrently`. No test
 * looked at either script, so nothing said so.
 *
 * These assert the script and the file agree, and that the file actually
 * serves, rather than merely existing.
 */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEV_PORT, app } from './dev';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
};

describe('the dev API server', () => {
  it('dev:api names a file that exists', () => {
    const script = pkg.scripts['dev:api'];
    expect(script).toBeTruthy();
    // The generalised form of the defect: whatever the script points at must be
    // on disk, so renaming or deleting the entrypoint fails here.
    const target = script.split(/\s+/).find((word) => word.endsWith('.ts'));
    expect(target).toBeTruthy();
    expect(existsSync(target!)).toBe(true);
  });

  it('dev:all runs it alongside Vite', () => {
    expect(pkg.scripts['dev:all']).toContain('dev:api');
    expect(pkg.scripts['dev:all']).toContain('npm:dev');
  });

  it('serves a health route, so the proxy target is real', async () => {
    // Driven through `app.request()` rather than a listening socket: no port to
    // collide with the other suites, and no teardown to leak.
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('listens on the port vite.config.ts proxies /api to', () => {
    expect(DEV_PORT).toBe(8787);
    expect(readFileSync('vite.config.ts', 'utf8')).toContain(
      `http://localhost:${DEV_PORT}`,
    );
  });

  it('importing it does not start a listener or demand the full environment', async () => {
    // Importing this module above did not bind a port — if it had, a second
    // import in the same process would throw EADDRINUSE. It also must not
    // reach `getEnv()`: a dev server that refuses to answer until DATABASE_URL
    // and SESSION_SECRET are set is a worse failure than the one being fixed.
    const again = await import('./dev');
    expect(again.app).toBe(app);
    expect(readFileSync('server/dev.ts', 'utf8')).not.toContain("from './env'");
  });
});
