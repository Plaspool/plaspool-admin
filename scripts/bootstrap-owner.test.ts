/**
 * The owner bootstrap has to produce a row THE CLERK EXCHANGE accepts.
 *
 * That sentence used to end "the LOGIN ROUTE accepts", and the substitution is
 * the whole story of this file. The script's job never was to write a
 * well-formed hash — it was to produce a row that the one route capable of
 * minting a session will honour. That route is now
 * `POST /api/auth/clerk/exchange`, so this runs the emitted SQL verbatim
 * against a real migrated database and then signs in over HTTP through it.
 *
 * Asserting the emitted string "looks like SQL" would pass for a row nobody
 * can sign in as, which is exactly the failure this suite exists to catch.
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../server/test/harness';
import { httpClient, json } from '../server/test/http';
import { resetEnvCacheForTests } from '../server/env';
import { registerClerkVerifier, resetClerkVerifier } from '../server/routes/clerk';
import type { AuthUser } from '../shared/types';

const EMAIL = 'bootstrap-owner@example.com';

/** Run the real script, in the mode a human would use for the SQL editor. */
function emitSql(args: string[]): string {
  return execFileSync(
    'npx',
    ['tsx', 'scripts/bootstrap-owner.ts', ...args, '--print-sql'],
    // `stderr: 'pipe'` so the human trailer never lands in the captured SQL —
    // stdout is the contract.
    { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/** Everything the script emitted, minus its comments. */
async function run(db: TestCtx['db'], emitted: string): Promise<void> {
  for (const statement of emitted
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)) {
    await db.execute(sql.raw(statement));
  }
}

let ctx: TestCtx;
let emitted: string;

beforeAll(async () => {
  /* Imports are hoisted, so set the key and clear the memo before anything
     reads it — the same dance `server/routes/clerk.test.ts` documents. */
  process.env.CLERK_SECRET_KEY = 'sk_test_suite_only';
  resetEnvCacheForTests();
  ctx = await freshDb();
  emitted = emitSql(['--email', EMAIL, '--name', 'Bootstrap Owner']);
}, 120_000);

afterAll(async () => {
  delete process.env.CLERK_SECRET_KEY;
  resetEnvCacheForTests();
  resetClerkVerifier();
  await ctx.close();
});

describe('the owner bootstrap', () => {
  it('emits SQL that a real database accepts', async () => {
    await run(ctx.db, emitted);
    const res = await ctx.db.execute(
      sql`SELECT email, role, disabled_at FROM users WHERE email = ${EMAIL}`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ email: EMAIL, role: 'owner', disabled_at: null });
  });

  /*
   * THE ONE THAT MATTERS. The row is written by a script and read by the
   * exchange, and nothing else proves those two agree — least of all a test
   * that inspects the row it just wrote.
   */
  it('produces a row the Clerk exchange signs in', async () => {
    registerClerkVerifier({ verify: async () => ({ email: EMAIL, name: 'Bootstrap Owner' }) });
    const c = httpClient(ctx.db);
    const res = await c.post('/api/auth/clerk/exchange', { token: 'whatever' });
    expect(res.status).toBe(200);
    expect((await json<{ user: AuthUser }>(res)).user).toMatchObject({
      email: EMAIL,
      role: 'owner',
    });
    /* And the cookie is the ordinary one: the next request needs no Clerk. */
    expect((await c.get('/api/auth/me')).status).toBe(200);
  });

  it('writes a password nobody holds — and a different one every run', async () => {
    /*
     * `users.password_hash` is NOT NULL, so the script must write SOMETHING.
     * A shared sentinel across every bootstrapped row would be one guess away
     * from being every account's password the day a password route returns, so
     * two runs must not agree. Nothing reads the column today; this is a guard
     * against a future that does.
     */
    const first = await ctx.db.execute(
      sql`SELECT password_hash FROM users WHERE email = ${EMAIL}`,
    );
    const hash = String(first.rows[0].password_hash);
    expect(hash).toMatch(/^scrypt\$/);

    const second = emitSql(['--email', 'someone-else@example.com', '--name', 'Someone Else']);
    expect(second).not.toContain(hash);
  }, 120_000);

  /*
   * Re-running is the BREAK-GLASS path: an owner who was disabled — or whose
   * row predates their Clerk account — is put back in a state the exchange
   * admits, without a duplicate row.
   */
  it('is idempotent, and re-enables an account that was locked out', async () => {
    await ctx.db.execute(
      sql`UPDATE users SET disabled_at = ${Date.now()} WHERE email = ${EMAIL}`,
    );
    registerClerkVerifier({ verify: async () => ({ email: EMAIL }) });
    /* Locked out for real: the exchange refuses a disabled account by name. */
    expect(
      (await httpClient(ctx.db).post('/api/auth/clerk/exchange', { token: 't' })).status,
    ).toBe(403);

    /* One word: `shell: true` splits an argument on spaces, so a two-word
       name would arrive truncated and the assertion below would be about
       argv quoting rather than about the script. */
    await run(ctx.db, emitSql(['--email', EMAIL, '--name', 'Renamed']));

    expect(
      (await httpClient(ctx.db).post('/api/auth/clerk/exchange', { token: 't' })).status,
    ).toBe(200);
    const row = await ctx.db.execute(
      sql`SELECT count(*)::int AS n, max(display_name) AS name FROM users WHERE email = ${EMAIL}`,
    );
    // ON CONFLICT updated rather than duplicated, and the name came along.
    expect(Number(row.rows[0].n)).toBe(1);
    expect(String(row.rows[0].name)).toBe('Renamed');
  }, 120_000);

  it('refuses a malformed address rather than writing a row nobody can use', () => {
    /*
     * The address IS the credential now — it is what the exchange matches a
     * verified Clerk identity against — so a typo here is not a cosmetic
     * problem, it is an owner row that admits nobody. Caught before any SQL is
     * emitted.
     */
    expect(() => emitSql(['--email', 'not-an-email', '--name', 'X'])).toThrow();
    expect(() => emitSql(['--name', 'X'])).toThrow();
    // The control: a well-formed address does emit.
    expect(() => emitSql(['--email', 'fine@example.com', '--name', 'X'])).not.toThrow();
  }, 60_000);
});
