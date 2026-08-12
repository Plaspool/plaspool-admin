/**
 * The owner bootstrap has to produce a row the LOGIN ROUTE accepts.
 *
 * A hash that is merely well-formed is not enough: the hash is minted by one
 * module and read by another, and the only claim that matters is that
 * `POST /api/auth/login` answers 200 for it. So this runs the emitted SQL
 * verbatim against a real migrated database and then signs in over HTTP —
 * rather than asserting the string looks like `scrypt$…`, which would pass for
 * a hash nobody can log in with.
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../server/test/harness';
import { httpClient, json } from '../server/test/http';
import type { AuthUser } from '../shared/types';

const EMAIL = 'bootstrap-owner@example.com';
const PASSWORD = 'bootstrap-password-1234';

/** Run the real script, in the mode a human would use for the SQL editor. */
function emitSql(args: string[]): string {
  return execFileSync(
    'npx',
    ['tsx', 'scripts/set-owner-password.ts', ...args, '--print-sql'],
    // `stderr: 'pipe'` so the human trailer never lands in the captured SQL —
    // stdout is the contract.
    { env: { ...process.env, OWNER_PASSWORD: PASSWORD }, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

let ctx: TestCtx;
let emitted: string;

beforeAll(async () => {
  ctx = await freshDb();
  emitted = emitSql(['--email', EMAIL, '--name', 'Bootstrap Owner']);
}, 120_000);

afterAll(async () => {
  await ctx.close();
});

/** Everything before the sessions DELETE, which needs a user_id to exist. */
async function runEmitted(): Promise<void> {
  for (const statement of emitted
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)) {
    await ctx.db.execute(sql.raw(statement));
  }
}

describe('the owner bootstrap', () => {
  it('emits SQL that a real database accepts', async () => {
    await runEmitted();
    const res = await ctx.db.execute(
      sql`SELECT email, role, disabled_at FROM users WHERE email = ${EMAIL}`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ email: EMAIL, role: 'owner', disabled_at: null });
  });

  /* THE ONE THAT MATTERS: the hash is minted by the script and read by the
     login route, and nothing else proves those two agree. */
  it('mints a password the login route actually accepts', async () => {
    const c = httpClient(ctx.db);
    const res = await c.post('/api/auth/login', { email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    const body = await json<{ user: AuthUser }>(res);
    expect(body.user).toMatchObject({ email: EMAIL, role: 'owner' });
  });

  it('refuses the wrong password, so the row is not simply permissive', async () => {
    const c = httpClient(ctx.db);
    const res = await c.post('/api/auth/login', { email: EMAIL, password: 'not-the-password' });
    expect(res.status).toBe(401);
  });

  /* Re-running it is the RESET path, and a reset that leaves the old password
     working is not a reset. */
  it('is idempotent, and a second run replaces the password', async () => {
    const second = 'a-completely-different-1234';
    const rerun = execFileSync(
      'npx',
      ['tsx', 'scripts/set-owner-password.ts', '--email', EMAIL, '--name', 'Renamed Owner', '--print-sql'],
      {
        env: { ...process.env, OWNER_PASSWORD: second },
        encoding: 'utf8',
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    for (const statement of rerun
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await ctx.db.execute(sql.raw(statement));
    }

    const c = httpClient(ctx.db);
    expect((await c.post('/api/auth/login', { email: EMAIL, password: second })).status).toBe(200);
    expect((await c.post('/api/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(401);

    // Still exactly one row — ON CONFLICT updated rather than duplicated.
    const count = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM users WHERE email = ${EMAIL}`);
    expect(Number(count.rows[0].n)).toBe(1);
  }, 120_000);

  it('refuses a password the API would refuse anyway', () => {
    expect(() => emitSql(['--email', 'x@example.com', '--name', 'X', '--role', 'owner'])).not.toThrow();
    expect(() =>
      execFileSync('npx', ['tsx', 'scripts/set-owner-password.ts', '--email', 'x@example.com', '--name', 'X', '--print-sql'], {
        env: { ...process.env, OWNER_PASSWORD: 'short' },
        encoding: 'utf8',
        shell: true,
        stdio: 'pipe',
      }),
    ).toThrow();
  }, 60_000);
});
