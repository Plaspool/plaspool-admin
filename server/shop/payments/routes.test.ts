/**
 * The response-side CORS headers on Payments' customer-facing routes
 * (admin#26).
 *
 * `POST /api/shop/payments/intents` returning no
 * `access-control-allow-credentials` on its REAL response is exactly what the
 * issue measured against production — `400 allow-credentials ABSENT`, because
 * a validation failure is still the "real response", not the preflight. No
 * behavioural test can see this: every other Payments suite drives
 * `createIntent`/`createRefund`/etc. directly, never through HTTP, so CORS is
 * never in the path. This file goes through the REAL application
 * (`server/test/http.ts` + `createApp`) for exactly that reason.
 *
 * The intent body here is deliberately invalid (no `checkout` port is wired
 * for this suite) so the assertion is on the HEADER, not on checkout succeeding
 * — the issue's own measurement was against a 400, and `shopCors()` has to
 * answer identically on every real response, success or refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, TEST_ORIGIN } from '../../test/http';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

describe('the credentialed response headers (admin#26)', () => {
  it('are on POST /api/shop/payments/intents, a real (non-preflight) response', async () => {
    const client = httpClient(ctx.db);
    // Malformed on purpose — `idempotencyKey` missing — so this exercises the
    // 400 path the issue measured, not a successful checkout.
    const res = await client.post(
      '/api/shop/payments/intents',
      { checkoutId: 'crt_missing', email: 'buyer@example.com' },
      { headers: { Origin: TEST_ORIGIN } },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    // Exactly once — a route naming `Origin` twice in `Vary` has been this
    // repo's recurring bug, so a single writer is asserted, not just presence.
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('grants nothing to an origin outside the allow-list', async () => {
    /*
     * `originGuard` sits ABOVE this router (`server/index.ts`, on `/api/*`),
     * so a disallowed origin never reaches `shopCors()` at all — it is
     * refused with a 403 before this middleware runs, carrying no CORS
     * headers of its own. Same known limitation `cart/cors.test.ts` pins for
     * the cart router; not a gap this issue introduces or fixes.
     */
    const client = httpClient(ctx.db);
    const res = await client.post(
      '/api/shop/payments/intents',
      { checkoutId: 'crt_missing', email: 'buyer@example.com' },
      { headers: { Origin: 'https://evil.example' } },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('does not carry these headers on the owner-only /shop/admin/payments/* surface', async () => {
    const client = httpClient(ctx.db);
    await client.signIn(ctx.users.owner);
    const res = await client.get('/api/shop/admin/payments/intents/nonexistent', {
      headers: { Origin: TEST_ORIGIN },
    });
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });
});
