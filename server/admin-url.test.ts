/**
 * THE REGRESSION TEST FOR BOTH BUGS THIS MODULE EXISTS TO FIX.
 *
 * The module had no test file at all until now, which is how it shipped the
 * second bug two days after the first.
 *
 * **2026-09-02.** `POST /api/invites` built its link from `APP_ORIGINS[0]` and
 * mailed a developer `https://blog-admin-app-gold.vercel.app/#/`. Clerk's
 * production key is domain-locked to `plaspool.com` and refuses to load on a
 * `*.vercel.app` host, so the invitee got a logo on a blank page. The fix
 * pinned one constant.
 *
 * **2026-09-05.** One constant is one too few. This application answers on two
 * real hosts — the production target at `admin.plaspool.com` and a preview
 * deployment aliased to `admin.dev.plaspool.com` — and they run against
 * DIFFERENT DATABASES. An owner on the dev host minted an invite and the mail
 * read `https://admin.plaspool.com/#/`: a working link to a deployment where
 * the invite row does not exist. The invitee signs in and is told they are not
 * on the team.
 *
 * WHAT THESE TESTS ASSERT, AND WHY IT IS THE STRING. CLAUDE.md §2: a green
 * suite here has repeatedly meant nothing, because the defect is never "no link
 * was produced" — it is "a plausible link to the wrong place". Every case below
 * pins the exact string a human would click, and several pin what it must NOT
 * be, because an assertion that merely checked "there is a URL" passed
 * throughout both bugs' entire lives.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_ORIGINS,
  DEFAULT_ADMIN_ORIGIN,
  DEV_ADMIN_ORIGIN,
  adminOrigin,
} from './admin-url';

/** A REAL alias of this deployment, and a member of `APP_ORIGINS` in
 *  production. That is the entire trap: it is allow-listed, it serves the app,
 *  and it is dead for anyone who has to sign in. */
const VERCEL_ALIAS = 'https://blog-admin-app-gold.vercel.app';

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.ADMIN_ORIGIN;
  delete process.env.ADMIN_ORIGIN;
});
afterEach(() => {
  if (saved === undefined) delete process.env.ADMIN_ORIGIN;
  else process.env.ADMIN_ORIGIN = saved;
});

describe('adminOrigin', () => {
  it('defaults to production, IN THE REPOSITORY rather than the environment', () => {
    /*
     * The default is in code for the reason `storefront-url.ts` and
     * `payments/utils/callback-url.ts` both give for pinning theirs: this is a
     * public URL that appears in mail we send, so there is nothing to protect,
     * and a value living only in the environment goes stale silently. It is
     * also what a caller with no request context — a script, a future job —
     * gets, and production is the safe answer there.
     */
    expect(adminOrigin()).toBe(DEFAULT_ADMIN_ORIGIN);
    expect(adminOrigin()).toBe('https://admin.plaspool.com');
  });

  it('THE 2026-09-05 BUG: a request from the dev admin gets a DEV link', () => {
    /*
     * This is the assertion that fails before the fix, and the only one that
     * matters. It returned the production origin, which is a link to a database
     * that has never heard of the invite the mail is about.
     */
    expect(adminOrigin(DEV_ADMIN_ORIGIN)).toBe('https://admin.dev.plaspool.com');
    expect(adminOrigin(DEV_ADMIN_ORIGIN)).not.toBe(DEFAULT_ADMIN_ORIGIN);
  });

  it('a request from the production admin still gets the production link', () => {
    expect(adminOrigin(DEFAULT_ADMIN_ORIGIN)).toBe(DEFAULT_ADMIN_ORIGIN);
  });

  it('THE 2026-09-02 BUG: a *.vercel.app alias is DISCARDED, not echoed back', () => {
    /*
     * The safety property of the whole change, stated as a test. The request's
     * origin is a KEY into `ADMIN_ORIGINS`, never a value — so passing one that
     * is not in the pair cannot put it in a link, and the production default
     * stands. Without this, "use the request's origin" would simply be the
     * 2026-09-02 bug with an extra step.
     */
    expect(adminOrigin(VERCEL_ALIAS)).toBe(DEFAULT_ADMIN_ORIGIN);
    expect(adminOrigin(VERCEL_ALIAS)).not.toContain('vercel.app');
  });

  it('a FORGED origin buys an attacker nothing — the output is always a pinned host', () => {
    /*
     * `originGuard` already refuses an unsafe method whose `Origin` is not in
     * `APP_ORIGINS`, so a forged header does not reach these callers at all.
     * This is the second lock: even handed one directly, the function can only
     * ever return a hostname we own and publish.
     */
    for (const forged of [
      'https://evil.test',
      'https://admin.plaspool.com.evil.test',
      'https://admin-plaspool.com',
      'https://evil-admin.plaspool.com.attacker.test',
      'http://admin.plaspool.com',
      'not a url at all',
      '',
      '   ',
    ]) {
      expect(adminOrigin(forged)).toBe(DEFAULT_ADMIN_ORIGIN);
    }
  });

  it('matches by EQUALITY, never by suffix — the rule `originGuard` states', () => {
    /*
     * `origin.endsWith('.plaspool.com')` is not a check, and this repository
     * already writes that down once in `middleware/origin.ts`. A subdomain of a
     * domain an attacker controls ends with anything they like.
     */
    expect(adminOrigin('https://admin.dev.plaspool.com.evil.test')).toBe(DEFAULT_ADMIN_ORIGIN);
    expect(adminOrigin('https://not-admin.dev.plaspool.com')).toBe(DEFAULT_ADMIN_ORIGIN);
  });

  it('is overridable, and the variable beats the request', () => {
    /*
     * `ADMIN_ORIGIN` is a deliberate act — somebody typed it into an
     * environment scope — so it wins over an inference. It is also the escape
     * hatch for a third admin host before anyone edits `ADMIN_ORIGINS`.
     */
    process.env.ADMIN_ORIGIN = 'https://admin.staging.plaspool.com';
    expect(adminOrigin()).toBe('https://admin.staging.plaspool.com');
    expect(adminOrigin(DEV_ADMIN_ORIGIN)).toBe('https://admin.staging.plaspool.com');
  });

  it('READS THE ENVIRONMENT PER CALL, not once at import', () => {
    /*
     * A module-level `const` is captured once per process, and this runs inside
     * a Vercel lambda reused across invocations — so a value read at import
     * time is whatever was set when the container happened to start.
     */
    process.env.ADMIN_ORIGIN = 'https://first.test';
    expect(adminOrigin()).toBe('https://first.test');
    process.env.ADMIN_ORIGIN = 'https://second.test';
    expect(adminOrigin()).toBe('https://second.test');
  });

  it('strips a trailing slash from either source, so no link has a double one', () => {
    /*
     * Callers concatenate a path beginning with `/`, and `//#/` is a
     * protocol-relative URL in some clients. A browser never sends a trailing
     * slash on `Origin`, but a hand-set variable is the likeliest way to get
     * this wrong and the request arm costs nothing to cover too.
     */
    process.env.ADMIN_ORIGIN = 'https://admin.test/';
    expect(adminOrigin()).toBe('https://admin.test');
    process.env.ADMIN_ORIGIN = 'https://admin.test///';
    expect(adminOrigin()).toBe('https://admin.test');
    delete process.env.ADMIN_ORIGIN;
    expect(adminOrigin(`${DEV_ADMIN_ORIGIN}/`)).toBe(DEV_ADMIN_ORIGIN);
  });

  it('ignores a blank variable rather than building links onto nothing', () => {
    // An unset variable in a shell script routinely becomes the empty string.
    process.env.ADMIN_ORIGIN = '   ';
    expect(adminOrigin()).toBe(DEFAULT_ADMIN_ORIGIN);
    expect(adminOrigin(DEV_ADMIN_ORIGIN)).toBe(DEV_ADMIN_ORIGIN);
  });
});

describe('ADMIN_ORIGINS', () => {
  it('holds only hosts where Clerk can actually load', () => {
    /*
     * The list is what makes the request arm safe, so its CONTENTS are worth an
     * assertion rather than a comment. Clerk's `pk_live_` key is domain-locked
     * to plaspool.com: an `*.vercel.app` entry here would re-open the
     * 2026-09-02 bug from the other end, by making the dead host a legitimate
     * answer instead of a discarded one.
     */
    expect(ADMIN_ORIGINS).toContain(DEFAULT_ADMIN_ORIGIN);
    expect(ADMIN_ORIGINS).toContain(DEV_ADMIN_ORIGIN);
    for (const origin of ADMIN_ORIGINS) {
      expect(origin).toMatch(/^https:\/\/[a-z0-9.-]+\.plaspool\.com$/);
      expect(origin).not.toContain('vercel.app');
      expect(origin.endsWith('/')).toBe(false);
    }
  });
});
