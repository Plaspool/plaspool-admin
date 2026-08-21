/**
 * THE REGRESSION TEST FOR THE BUG THIS MODULE EXISTS TO FIX.
 *
 * On 2026-08-21 a customer received a shipment notice whose "view your order"
 * link pointed at `https://blog-admin-app-gold.vercel.app/shop/orders/…` — the
 * ADMIN dashboard. Following it gets a login screen for a system they have no
 * account on.
 *
 * The cause was that every customer link was built from `APP_ORIGINS[0]`, which
 * is the admin application's CORS allow-list rather than the shop's address. The
 * two answer different questions and coincide only on a localhost dev box, which
 * is exactly why it survived: it was invisible in the whole suite and in every
 * manual check that did not read the delivered link.
 *
 * CLAUDE.md §2 says a green suite here has repeatedly meant nothing, and this is
 * a textbook case of the shape it describes. So these tests assert on the STRING
 * A CUSTOMER WOULD CLICK, and one of them asserts specifically that it is NOT the
 * admin origin — a test that only checked "there is a link" would have passed
 * throughout the bug's entire life.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STOREFRONT_ORIGIN, orderUrl, storefrontOrigin } from './storefront-url';

const ADMIN_ORIGIN = 'https://blog-admin-app-gold.vercel.app';

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.STOREFRONT_ORIGIN;
  delete process.env.STOREFRONT_ORIGIN;
});
afterEach(() => {
  if (saved === undefined) delete process.env.STOREFRONT_ORIGIN;
  else process.env.STOREFRONT_ORIGIN = saved;
});

describe('storefrontOrigin', () => {
  it('defaults to the storefront, IN THE REPOSITORY rather than the environment', () => {
    /*
     * The default is in code for the reason `payments/utils/callback-url.ts` gives
     * for pinning the same host: this is a public URL that appears in mail the
     * shop sends, so there is no secret to protect, and a value that lives only in
     * the environment goes stale silently — which is precisely what happened to
     * `PAYMENTS_CALLBACK_URL`.
     */
    expect(storefrontOrigin()).toBe(DEFAULT_STOREFRONT_ORIGIN);
    expect(storefrontOrigin()).not.toBe(ADMIN_ORIGIN);
    expect(storefrontOrigin()).not.toContain('blog-admin');
  });

  it('is overridable, so a preview can point elsewhere without a code change', () => {
    process.env.STOREFRONT_ORIGIN = 'https://preview.shop.test';
    expect(storefrontOrigin()).toBe('https://preview.shop.test');
  });

  it('READS THE ENVIRONMENT PER CALL, not once at import', () => {
    /*
     * A module-level `const` is captured once per process, and this runs inside a
     * Vercel lambda that is reused across invocations — so a value read at import
     * time is the value from whenever the container happened to start.
     */
    process.env.STOREFRONT_ORIGIN = 'https://first.test';
    expect(storefrontOrigin()).toBe('https://first.test');
    process.env.STOREFRONT_ORIGIN = 'https://second.test';
    expect(storefrontOrigin()).toBe('https://second.test');
  });

  it('strips a trailing slash, so no link is ever built with a double one', () => {
    /*
     * Every caller concatenates a path beginning with `/`. An origin ending in one
     * produces `//shop/orders/…`, which is a protocol-relative path in some
     * clients and a 404 in the rest — and it is the single most likely way for
     * somebody setting this variable by hand to get it wrong.
     */
    process.env.STOREFRONT_ORIGIN = 'https://shop.test/';
    expect(storefrontOrigin()).toBe('https://shop.test');
    process.env.STOREFRONT_ORIGIN = 'https://shop.test///';
    expect(storefrontOrigin()).toBe('https://shop.test');
  });

  it('ignores a blank variable rather than building links onto nothing', () => {
    // An unset variable in a shell script routinely becomes the empty string.
    process.env.STOREFRONT_ORIGIN = '   ';
    expect(storefrontOrigin()).toBe(DEFAULT_STOREFRONT_ORIGIN);
  });
});

describe('orderUrl', () => {
  it('builds the customer-facing order page on the STOREFRONT', () => {
    process.env.STOREFRONT_ORIGIN = 'https://shop.test';
    expect(orderUrl('2026-000005-F', 'tok123')).toBe(
      'https://shop.test/shop/orders/2026-000005-F?token=tok123',
    );
  });

  it('encodes both the order number and the token', () => {
    /*
     * The token is base64url with a hex tail and the order number is
     * `YYYY-NNNNNN-C`, so neither NEEDS escaping today. It is done anyway because
     * a mail already delivered cannot be corrected: the day either format grows a
     * `+` or a `/`, an unescaped link silently opens the wrong order or none.
     */
    process.env.STOREFRONT_ORIGIN = 'https://shop.test';
    const url = orderUrl('a b/c', 'tok+with/slash=');
    expect(url).toContain('/shop/orders/a%20b%2Fc');
    expect(url).toContain('token=tok%2Bwith%2Fslash%3D');
  });
});
