/**
 * WHICH STOREFRONT PAYSTACK RETURNS THE CUSTOMER TO.
 *
 * ═══ WHY THIS FILE DRIVES THE ROUTER AND NOT JUST THE FUNCTION ═══
 * CLAUDE.md §2's standing complaint is that a green suite here has repeatedly
 * meant nothing, because the bug lives in the wiring rather than in the unit.
 * That is exactly the shape of the defect this file exists for: `storefrontOrigin`
 * has been correct and available the whole time — `revalidate-url.ts` was already
 * calling it — and payments still redirected to production, because nothing
 * PASSED THE REQUEST'S ORIGIN to it. A unit test of `paymentsCallbackUrl('…')`
 * would have passed on the broken code, since the broken code never called it.
 *
 * So the assertion below is on the value handed to the PROVIDER, reached through
 * the real `createPaymentRoutes` behind the real `originGuard`, with the header
 * a browser would actually send. That is the only reading that could have gone
 * red before the fix.
 *
 * WHAT IT COST WHEN THIS WAS WRONG: a test payment made on `admin.dev.plaspool.com`
 * was stamped with production's `/checkout/complete`, so Paystack redirected the
 * customer to the LIVE shop, which called `/confirm` against the LIVE API, whose
 * database has never seen a dev intent — a 404 on a payment that succeeded.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { freshDb } from '../../../test/harness';
import { toResponse } from '../../../middleware/errors';
import { originGuard } from '../../../middleware/origin';
import { FakeProvider } from '../provider/fake';
import { fakeCheckoutPort } from '../checkout';
import { createPaymentRoutes } from '../routes';
import { resetPayments } from '../test/db';
import { resetPaymentsEnv } from '../config';
import {
  DEFAULT_STOREFRONT_ORIGIN,
  DEV_STOREFRONT_ORIGIN,
  STOREFRONT_ORIGINS,
} from '../../storefront-url';
import { CHECKOUT_COMPLETE_PATH, paymentsCallbackUrl } from './callback-url';
import type { AppEnv } from '../../../app-env';
import type { CreateIntentRequest, ProviderIntent } from '../provider/types';
import type { Db } from '../../../db/client';

let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: Db;
let provider: RecordingProvider;

const CHECKOUT = 'crt_callback';
const checkout = fakeCheckoutPort({
  [CHECKOUT]: { checkoutId: CHECKOUT, total: 40_333, currency: 'NGN' },
});

/**
 * A `FakeProvider` that remembers the `callbackUrl` it was asked for.
 *
 * `FakeProvider.calls` records the reference, the key and the amount — never
 * this field, because until now nothing varied it. Recording it here rather than
 * widening `calls` keeps the change local to the suite that needs it.
 */
class RecordingProvider extends FakeProvider {
  callbackUrls: (string | undefined)[] = [];

  override createIntent(req: CreateIntentRequest): Promise<ProviderIntent> {
    this.callbackUrls.push(req.callbackUrl);
    return super.createIntent(req);
  }
}

/**
 * The app as `server/index.ts` builds it, minus what this suite does not need —
 * the same shape `webhook.test.ts` uses, and behind a REAL `originGuard` whose
 * allow-list holds both storefronts, because that is what the dev deployment's
 * `APP_ORIGINS` has to hold for any of this to be reachable at all.
 */
function app(): Hono<AppEnv> {
  const root = new Hono<AppEnv>();
  root.use('*', async (c, next) => {
    c.set('requestId', 'test-request');
    c.set('dbFactory', () => db);
    c.set('user', null);
    await next();
  });
  root.onError((err, c) => toResponse(err, c.get('requestId') ?? ''));
  root.use('/api/*', originGuard([...STOREFRONT_ORIGINS]));
  root.route('/api', createPaymentRoutes({ provider, checkout }));
  return root;
}

/** Create an intent the way the storefront's browser does, from `origin`. */
async function createIntentFrom(origin: string, idempotencyKey: string): Promise<Response> {
  return app().request('/api/shop/payments/intents', {
    method: 'POST',
    body: JSON.stringify({ checkoutId: CHECKOUT, email: 'buyer@example.com', idempotencyKey }),
    headers: { 'content-type': 'application/json', Origin: origin },
  });
}

beforeAll(async () => {
  ctx = await freshDb();
  db = ctx.db;
});

beforeEach(async () => {
  await resetPayments(db);
  provider = new RecordingProvider();
  delete process.env.STOREFRONT_ORIGIN;
  delete process.env.PAYMENTS_CALLBACK_URL;
  delete process.env.PAYSTACK_SECRET_KEY;
  /*
   * `paymentsEnv()` MEMOISES, so without this the first case to read it fixes
   * `PAYMENTS_CALLBACK_URL` for the whole file and the override case below
   * silently asserts the previous case's value. That is not a bug in the
   * subject — on Vercel these variables bake at build time, so per-process is
   * exactly the lifetime production has — but it makes the env-var override
   * untestable in-process without the reset the module exports for it.
   */
  resetPaymentsEnv();
});

afterAll(async () => {
  await ctx.close();
});

describe('the callback Paystack is actually given', () => {
  it('returns a DEV customer to the dev storefront, not the live shop', async () => {
    const res = await createIntentFrom(DEV_STOREFRONT_ORIGIN, 'idem-dev');

    expect(res.status, 'the intent was created').toBe(201);
    /*
     * THE ASSERTION THIS FILE EXISTS FOR. Before the fix this read
     * `https://plaspool.com/checkout/complete` — the live shop — and every
     * other test in the repository still passed.
     */
    expect(provider.callbackUrls).toEqual(['https://dev.plaspool.com/checkout/complete']);
  });

  it('returns a PRODUCTION customer to the live shop', async () => {
    const res = await createIntentFrom(DEFAULT_STOREFRONT_ORIGIN, 'idem-prod');

    expect(res.status).toBe(201);
    expect(provider.callbackUrls).toEqual(['https://plaspool.com/checkout/complete']);
  });

  it('never sends the customer somewhere Paystack was told about by a header', async () => {
    /*
     * THE SAFETY PROPERTY, executed rather than argued. The origin is a KEY into
     * `STOREFRONT_ORIGINS` and never a value, so a forged header cannot aim the
     * post-payment redirect at an attacker's page — where the customer would
     * arrive believing they were still mid-checkout with us.
     *
     * `originGuard` refuses this one outright, which is the first of the two
     * layers; the second is that even if it were allow-listed, `storefrontOrigin`
     * would discard it. Both are asserted, because a later `APP_ORIGINS` entry
     * (a preview host, a second admin) would quietly retire the first.
     */
    const res = await createIntentFrom('https://evil.example', 'idem-evil');
    expect(res.status, 'refused before the router is reached').toBe(403);
    expect(provider.callbackUrls, 'no intent was created at all').toEqual([]);

    expect(paymentsCallbackUrl('https://evil.example')).toBe(
      `${DEFAULT_STOREFRONT_ORIGIN}${CHECKOUT_COMPLETE_PATH}`,
    );
    expect(paymentsCallbackUrl('https://dev.plaspool.com.evil.test')).toBe(
      `${DEFAULT_STOREFRONT_ORIGIN}${CHECKOUT_COMPLETE_PATH}`,
    );
    expect(paymentsCallbackUrl('https://not-dev.plaspool.com')).toBe(
      `${DEFAULT_STOREFRONT_ORIGIN}${CHECKOUT_COMPLETE_PATH}`,
    );
  });

  it('lets PAYMENTS_CALLBACK_URL override both, for a host not listed in code', async () => {
    /*
     * A WHOLE VALID PAYMENTS ENVIRONMENT, not just the variable under test.
     * `safeCallbackUrl` reads `paymentsEnv()`, which parses the schema as a unit
     * and THROWS when `PAYSTACK_SECRET_KEY` is absent — every other case in this
     * file therefore reaches the override through the `catch`, where the
     * variable is deliberately not consulted. Setting only `PAYMENTS_CALLBACK_URL`
     * here passed the eye and asserted nothing, because the value never got read.
     */
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_0123456789abcdefghij';
    process.env.PAYMENTS_CALLBACK_URL = 'https://preview.shop.test/checkout/complete';

    const res = await createIntentFrom(DEV_STOREFRONT_ORIGIN, 'idem-override');

    expect(res.status).toBe(201);
    expect(provider.callbackUrls).toEqual(['https://preview.shop.test/checkout/complete']);
  });

  it('falls back to production when there is no Origin to read', async () => {
    /*
     * The sweep and the cron have no request at all. They do not create intents
     * today, but the fallback is what makes passing nothing SAFE rather than
     * undefined — and an omitted `callback_url` is the regression `safeCallbackUrl`
     * was written to prevent, since Paystack then shows its own generic page.
     */
    expect(paymentsCallbackUrl()).toBe(`${DEFAULT_STOREFRONT_ORIGIN}${CHECKOUT_COMPLETE_PATH}`);
    expect(paymentsCallbackUrl('   ')).toBe(
      `${DEFAULT_STOREFRONT_ORIGIN}${CHECKOUT_COMPLETE_PATH}`,
    );
  });

  it('serves both storefronts on the same path, so the contract is one route', () => {
    /*
     * `/checkout/complete` is the storefront's route and both deployments run
     * the same code. If that ever stops being true this pins the assumption
     * rather than leaving it implied by two string literals.
     */
    for (const origin of STOREFRONT_ORIGINS) {
      expect(paymentsCallbackUrl(origin)).toBe(`${origin}${CHECKOUT_COMPLETE_PATH}`);
    }
  });
});
