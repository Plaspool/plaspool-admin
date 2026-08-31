/**
 * The emailed second factor (migration 0700), end to end through the real app:
 * password → challenge → code in the recorder's outbox → session.
 *
 * The recorder mailer carries `assertConfigured` so the route treats the
 * deployment as mail-capable; the unconfigured case is its own test, because
 * "falls open without mail" is a decision that must not regress silently in
 * either direction.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb } from '../test/harness';
import type { TestCtx } from '../test/harness';
import { httpClient, json } from '../test/http';
import type { HttpClient } from '../test/http';
import { CODE_ATTEMPT_LIMIT } from '../repo/login-challenges';
import type { Mailer } from '../mail/port';

let ctx: TestCtx;

/** Configured, records everything, sends nothing. */
class RecorderMailer implements Mailer {
  sent: { to: string; subject: string; text: string; html: string }[] = [];
  assertConfigured(): void {}
  send(msg: { to: string; subject: string; text: string; html: string }): Promise<void> {
    this.sent.push(msg);
    return Promise.resolve();
  }
}

/** No `assertConfigured` throw is impossible — this one THROWS, the shape a
 * deployment without RESEND_API_KEY presents. */
class UnconfiguredMailer implements Mailer {
  sent: unknown[] = [];
  assertConfigured(): void {
    throw new Error('RESEND_API_KEY is not set');
  }
  send(): Promise<void> {
    return Promise.reject(new Error('unreachable'));
  }
}

/** Configured but the provider is down. */
class BrokenMailer implements Mailer {
  assertConfigured(): void {}
  send(): Promise<void> {
    return Promise.reject(new Error('provider 500'));
  }
}

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  await ctx.db.execute(sql`DELETE FROM auth_login_challenges`);
  /* The 2FA flag is per-test: seeds default to false (harness). */
  await ctx.db.execute(sql`UPDATE users SET two_factor_email = false`);
});

async function protect(email: string): Promise<void> {
  await ctx.db.execute(
    sql`UPDATE users SET two_factor_email = true WHERE email = ${email}`,
  );
}

/** The code out of the last mail — the subject leads with it by design. */
function codeFrom(mailer: RecorderMailer): string {
  const last = mailer.sent[mailer.sent.length - 1];
  const match = last.text.match(/\b(\d{6})\b/);
  if (!match) throw new Error(`no code in: ${last.text}`);
  return match[1];
}

describe('the protected login', () => {
  it('answers a ticket, mails a code, and the pair mints the session', async () => {
    await protect(ctx.users.owner.email);
    const mailer = new RecorderMailer();
    const c = httpClient(ctx.db, { mailer });

    const first = await c.post('/api/auth/login', {
      email: ctx.users.owner.email,
      password: SEED_PASSWORD,
    });
    expect(first.status).toBe(200);
    const body = await json<{ twoFactor?: { ticket: string }; user?: unknown }>(first);
    expect(body.user).toBeUndefined();
    expect(body.twoFactor?.ticket).toBeTruthy();
    /* NO SESSION YET — the password alone must not authenticate. */
    expect((await c.get('/api/auth/me')).status).toBe(401);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe(ctx.users.owner.email);
    expect(mailer.sent[0].subject).toContain(codeFrom(mailer));

    const second = await c.post('/api/auth/login/code', {
      ticket: body.twoFactor!.ticket,
      code: codeFrom(mailer),
    });
    expect(second.status).toBe(200);
    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(200);
  });

  it('an unprotected account signs in in one step, mail or no mail', async () => {
    const mailer = new RecorderMailer();
    const c = httpClient(ctx.db, { mailer });
    const res = await c.post('/api/auth/login', {
      email: ctx.users.writer.email,
      password: SEED_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect((await json<{ user?: { email: string } }>(res)).user?.email).toBe(
      ctx.users.writer.email,
    );
    expect(mailer.sent).toHaveLength(0);
  });

  it('fails CLOSED when no mailer is configured — the factor is never waived by config', async () => {
    /* The first cut fell open here and the security critic killed it: one
     * missing baked-at-build env var must not quietly turn every protected
     * login single-factor. Dev checkouts are unaffected — nothing there has
     * two_factor_email set. */
    await protect(ctx.users.owner.email);
    const c = httpClient(ctx.db, { mailer: new UnconfiguredMailer() });
    const res = await c.post('/api/auth/login', {
      email: ctx.users.owner.email,
      password: SEED_PASSWORD,
    });
    expect(res.status).toBe(503);
    expect((await json<{ error: string }>(res)).error).toBe('two_factor_unavailable');
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('fails CLOSED when the configured provider is down — 503, no session, no waiver', async () => {
    await protect(ctx.users.owner.email);
    const c = httpClient(ctx.db, { mailer: new BrokenMailer() });
    const res = await c.post('/api/auth/login', {
      email: ctx.users.owner.email,
      password: SEED_PASSWORD,
    });
    expect(res.status).toBe(503);
    expect((await json<{ error: string }>(res)).error).toBe('two_factor_unavailable');
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });
});

describe('the code step', () => {
  async function challenge(c: HttpClient): Promise<string> {
    const res = await c.post('/api/auth/login', {
      email: ctx.users.owner.email,
      password: SEED_PASSWORD,
    });
    const body = await json<{ twoFactor: { ticket: string } }>(res);
    return body.twoFactor.ticket;
  }

  it('a wrong code is a 401 and spends an attempt; the ceiling consumes the challenge', async () => {
    await protect(ctx.users.owner.email);
    const mailer = new RecorderMailer();
    const c = httpClient(ctx.db, { mailer });
    const ticket = await challenge(c);

    for (let i = 0; i < CODE_ATTEMPT_LIMIT; i += 1) {
      expect((await c.post('/api/auth/login/code', { ticket, code: '000000' })).status).toBe(
        401,
      );
    }
    /* The RIGHT code is now dead too — the ceiling consumed the challenge. */
    expect(
      (await c.post('/api/auth/login/code', { ticket, code: codeFrom(mailer) })).status,
    ).toBe(401);
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('a spent challenge cannot mint twice', async () => {
    await protect(ctx.users.owner.email);
    const mailer = new RecorderMailer();
    const c = httpClient(ctx.db, { mailer });
    const ticket = await challenge(c);
    const code = codeFrom(mailer);

    expect((await c.post('/api/auth/login/code', { ticket, code })).status).toBe(200);
    c.clearCookies();
    expect((await c.post('/api/auth/login/code', { ticket, code })).status).toBe(401);
  });

  it('an expired challenge refuses, however right the code is', async () => {
    await protect(ctx.users.owner.email);
    const mailer = new RecorderMailer();
    const c = httpClient(ctx.db, { mailer });
    const ticket = await challenge(c);
    await ctx.db.execute(sql`UPDATE auth_login_challenges SET expires_at = 1`);
    expect(
      (await c.post('/api/auth/login/code', { ticket, code: codeFrom(mailer) })).status,
    ).toBe(401);
  });

  it('a disabled account cannot finish a login it started', async () => {
    await protect(ctx.users.owner.email);
    const mailer = new RecorderMailer();
    const c = httpClient(ctx.db, { mailer });
    const ticket = await challenge(c);
    await ctx.db.execute(
      sql`UPDATE users SET disabled_at = ${Date.now()} WHERE email = ${ctx.users.owner.email}`,
    );
    expect(
      (await c.post('/api/auth/login/code', { ticket, code: codeFrom(mailer) })).status,
    ).toBe(401);
    await ctx.db.execute(sql`UPDATE users SET disabled_at = NULL`);
  });

  it('resend replaces the code on the same challenge and answers 202 for garbage too', async () => {
    await protect(ctx.users.owner.email);
    const mailer = new RecorderMailer();
    const c = httpClient(ctx.db, { mailer });
    const ticket = await challenge(c);
    const firstCode = codeFrom(mailer);

    expect((await c.post('/api/auth/login/resend', { ticket })).status).toBe(202);
    expect(mailer.sent).toHaveLength(2);
    const secondCode = codeFrom(mailer);

    /* The old code died with the resend; the new one works. */
    if (firstCode !== secondCode) {
      expect(
        (await c.post('/api/auth/login/code', { ticket, code: firstCode })).status,
      ).toBe(401);
    }
    expect(
      (await c.post('/api/auth/login/code', { ticket, code: secondCode })).status,
    ).toBe(200);

    /* An invented ticket gets the same 202 and mails nothing. */
    const before = mailer.sent.length;
    expect(
      (await c.post('/api/auth/login/resend', { ticket: 'not-a-ticket' })).status,
    ).toBe(202);
    expect(mailer.sent).toHaveLength(before);
  });
});
