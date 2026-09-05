/**
 * THE REGRESSION TEST FOR A CROSS-ENVIRONMENT PURGE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * This module used to export a module-level constant pinned to
 * `https://plaspool.com`. Once `admin.dev.plaspool.com` went live that became a
 * boundary violation with no symptom on either side: a product edited in the
 * DEVELOPMENT admin fired its purge at PRODUCTION's `/api/revalidate`, so the
 * live shop re-rendered pages nothing had changed, and the development
 * storefront's own cache was never purged at all and served stale catalogue
 * until its ISR window expired.
 *
 * Nothing failed. Both ends answered 200. The only way to see it was to read
 * the URL, which is the same shape of bug `storefront-url.test.ts` was written
 * for — a link that resolves, to the wrong place.
 *
 * So these tests assert on the STRING THAT IS POSTED TO. A test that only
 * checked "a purge was attempted" would have passed for the whole life of the
 * bug — `revalidate.test.ts` did exactly that.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storefrontOrigin, DEFAULT_STOREFRONT_ORIGIN } from '../../storefront-url';
import { storefrontRevalidateUrl } from './revalidate-url';

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.STOREFRONT_ORIGIN;
  delete process.env.STOREFRONT_ORIGIN;
});
afterEach(() => {
  if (saved === undefined) delete process.env.STOREFRONT_ORIGIN;
  else process.env.STOREFRONT_ORIGIN = saved;
});

describe('storefrontRevalidateUrl', () => {
  /*
   * The default stays in the repository, which is what the module header has
   * always argued for and what makes the `NODE_ENV === 'test'` guard in
   * `revalidate.ts` meaningful: there is no unset-by-default state, so the
   * suite's protection against firing real POSTs is the guard rather than an
   * accidentally-empty variable.
   */
  it('defaults to the production storefront when nothing is configured', () => {
    expect(storefrontRevalidateUrl()).toBe(`${DEFAULT_STOREFRONT_ORIGIN}/api/revalidate`);
  });

  /*
   * ⚠  THE ASSERTION THE BUG WOULD HAVE FAILED.
   *
   * The development admin sets `STOREFRONT_ORIGIN=https://dev.plaspool.com`.
   * Before this change the purge went to plaspool.com regardless.
   */
  it('follows STOREFRONT_ORIGIN, so the development admin purges the development shop', () => {
    process.env.STOREFRONT_ORIGIN = 'https://dev.plaspool.com';

    expect(storefrontRevalidateUrl()).toBe('https://dev.plaspool.com/api/revalidate');
    expect(storefrontRevalidateUrl()).not.toContain('//plaspool.com');
  });

  /*
   * ⚠  PER CALL, NOT ONCE AT IMPORT — the specific defect that made the old
   * shape wrong, and the one a naive fix reintroduces.
   *
   * `storefrontOrigin()` reads the environment on every call precisely because
   * these run in a reused Vercel lambda, where a value captured at import time
   * is whatever the container started with. Rebuilding the URL from it at
   * module scope would throw that away and read identically to a fix.
   */
  it('reads the environment per call rather than capturing it at import', () => {
    expect(storefrontRevalidateUrl()).toBe(`${DEFAULT_STOREFRONT_ORIGIN}/api/revalidate`);

    process.env.STOREFRONT_ORIGIN = 'https://later.example';
    expect(storefrontRevalidateUrl()).toBe('https://later.example/api/revalidate');
  });

  /*
   * `storefrontOrigin()` strips a trailing slash rather than trusting whoever
   * set the variable. Asserted here too because this module concatenates a path
   * beginning with `/`, and `//api/revalidate` is a protocol-relative URL in
   * some clients — a purge that silently goes nowhere.
   */
  it('does not double the slash when the origin carries one', () => {
    process.env.STOREFRONT_ORIGIN = 'https://dev.plaspool.com/';

    expect(storefrontRevalidateUrl()).toBe('https://dev.plaspool.com/api/revalidate');
  });

  /*
   * The point of the change: ONE value decides where a customer's links go and
   * where a purge is sent. They were separate constants holding the same
   * string, which is a pair that can drift — and did, the moment a second
   * environment existed.
   */
  it('purges the same origin customer links are built from', () => {
    process.env.STOREFRONT_ORIGIN = 'https://dev.plaspool.com';

    expect(storefrontRevalidateUrl().startsWith(storefrontOrigin())).toBe(true);
  });
});
