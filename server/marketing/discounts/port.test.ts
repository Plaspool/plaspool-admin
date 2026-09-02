/**
 * The discount-code seam, exercised directly over real tables (admin#100 Part B).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE PROPERTIES WORTH BREAKING A BUILD OVER:
 *
 * 1. **Every refusal is NAMED.** storefront#113 asks for a specific reason —
 *    expired / not found / disabled / not yet started / wrong currency — because
 *    a shopper told "something went wrong" retries, and retrying cannot fix any
 *    of them. There is one test per reason, and each sets up exactly the row
 *    that produces it.
 * 2. **A replay is never a second use.** `redeemed_count` is a bare counter and
 *    the capture path replays: Paystack redelivers, webhooks retry, and the
 *    sweep drains to a fixed point. `marketing_discount_redemptions` keys on
 *    `order_id` so the second pass is a no-op BY INDEX, not by a check that two
 *    concurrent passes could both clear.
 * 3. **`redeem()` never throws and never refuses.** It runs after the order is
 *    paid. A code disabled or capped since the freeze still counts the use that
 *    was made of it — the alternative is an event parked against a sale that has
 *    already happened.
 *
 * The window's END IS EXCLUSIVE, matching the banner window's convention, which
 * `repo.ts` chose so the two surfaces do not disagree about the last minute of a
 * campaign. `at exactly ends_at` below is the assertion that pins it.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import { createDiscount, getDiscount, patchDiscount } from './repo';
import { discountPort } from './port';
import type { Db } from '../../db/client';
import type { TestCtx } from '../../test/harness';
import type { DiscountDraft } from './repo';

let ctx: TestCtx;
let db: Db;
/** The seeded owner. `created_by` is cast `::uuid`, so a made-up id is a 22P02. */
let actorId: string;
const NOW = 1_800_000_000_000;
const CURRENCY = 'NGN';

async function make(draft: DiscountDraft, now = NOW) {
  return createDiscount(db, draft, { actorId, now });
}

const port = () => discountPort(db);

beforeAll(async () => {
  ctx = await freshDb();
  db = ctx.db;
  actorId = ctx.users.owner.id;
});
afterAll(() => ctx.close());

beforeEach(async () => {
  await db.execute(sql`TRUNCATE marketing_discount_codes, marketing_discount_redemptions CASCADE`);
});

describe('a code that applies', () => {
  it('answers the percent rule the totals engine reads', async () => {
    const created = await make({ code: 'WELCOME10', kind: 'percent', percentBps: 1000 });

    const result = await port().validate({ code: 'WELCOME10', currency: CURRENCY, now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toBe(created.id);
    expect(result.discount).toEqual({
      code: 'WELCOME10',
      label: '10% off',
      kind: 'percent',
      percentBps: 1000,
    });
  });

  it('answers the fixed rule with its own currency, not the cart’s', async () => {
    await make({ code: 'SAVE500', kind: 'fixed_amount', amountMinor: 50_000, currency: CURRENCY });

    const result = await port().validate({ code: 'SAVE500', currency: CURRENCY, now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.discount).toMatchObject({
      kind: 'fixed_amount',
      amount: { amount: 50_000, currency: CURRENCY },
    });
  });

  it('is found however the shopper typed it', async () => {
    await make({ code: 'WELCOME10', kind: 'percent', percentBps: 1000 });

    // The model stores codes uppercase; a shopper types what is on the flyer.
    // Normalising in the port rather than in the route means every caller gets
    // it, including the freeze's re-validation.
    for (const typed of ['welcome10', ' WeLcOmE10 ', 'Welcome10']) {
      const result = await port().validate({ code: typed, currency: CURRENCY, now: NOW });
      expect(result.ok, typed).toBe(true);
    }
  });

  it('applies on the first millisecond of its window', async () => {
    await make({ code: 'SUMMER', kind: 'percent', percentBps: 500, startsAt: NOW });

    expect((await port().validate({ code: 'SUMMER', currency: CURRENCY, now: NOW })).ok).toBe(true);
  });
});

describe('every refusal is named', () => {
  it('not_found — a code nobody created', async () => {
    const result = await port().validate({ code: 'NOPE', currency: CURRENCY, now: NOW });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('disabled — the campaign was switched off', async () => {
    const made = await make({ code: 'OFF', kind: 'percent', percentBps: 500 });
    await patchDiscount(db, made.id, { status: 'disabled' }, {
      actorId,
      now: NOW,
      expectedRevision: made.revision,
    });

    const result = await port().validate({ code: 'OFF', currency: CURRENCY, now: NOW });
    expect(result).toEqual({ ok: false, reason: 'disabled' });
  });

  it('not_started — the campaign opens next week', async () => {
    await make({ code: 'SOON', kind: 'percent', percentBps: 500, startsAt: NOW + 60_000 });

    const result = await port().validate({ code: 'SOON', currency: CURRENCY, now: NOW });
    expect(result).toEqual({ ok: false, reason: 'not_started' });
  });

  it('expired — at exactly ends_at, because the window END IS EXCLUSIVE', async () => {
    await make({ code: 'GONE', kind: 'percent', percentBps: 500, endsAt: NOW });

    // Not "one millisecond after". `repo.ts` documents the end as exclusive so
    // the banner window and this one agree about a campaign's last minute; a
    // half-open test would pass under either convention and pin neither.
    const result = await port().validate({ code: 'GONE', currency: CURRENCY, now: NOW });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('currency_mismatch — a fixed code priced in another currency', async () => {
    await make({ code: 'USD5', kind: 'fixed_amount', amountMinor: 500, currency: 'USD' });

    const result = await port().validate({ code: 'USD5', currency: CURRENCY, now: NOW });
    expect(result).toEqual({ ok: false, reason: 'currency_mismatch' });
  });

  it('a PERCENT code has no currency to disagree about', async () => {
    await make({ code: 'ANY10', kind: 'percent', percentBps: 1000 });

    // A percentage is a percentage of whatever the cart is in. Refusing one on
    // currency grounds would make every percent code single-currency for no
    // reason the shopper could see.
    expect((await port().validate({ code: 'ANY10', currency: 'USD', now: NOW })).ok).toBe(true);
  });

  it('limit_reached — max_redemptions is spent', async () => {
    const made = await make({ code: 'FIRST2', kind: 'percent', percentBps: 500, maxRedemptions: 2 });

    await port().redeem({
      orderId: 'ord_1',
      orderNumber: '2026-000001-D',
      code: 'FIRST2',
      amountMinor: 100,
      currency: CURRENCY,
      now: NOW,
    });
    expect((await port().validate({ code: 'FIRST2', currency: CURRENCY, now: NOW })).ok).toBe(true);

    await port().redeem({
      orderId: 'ord_2',
      orderNumber: '2026-000002-D',
      code: 'FIRST2',
      amountMinor: 100,
      currency: CURRENCY,
      now: NOW,
    });

    const result = await port().validate({ code: 'FIRST2', currency: CURRENCY, now: NOW });
    expect(result).toEqual({ ok: false, reason: 'limit_reached' });
    expect((await getDiscount(db, made.id))?.redeemedCount).toBe(2);
  });

  it('an uncapped code is never limit_reached', async () => {
    await make({ code: 'FOREVER', kind: 'percent', percentBps: 500 });
    for (let i = 0; i < 3; i++) {
      await port().redeem({
        orderId: `ord_${i}`,
        orderNumber: `2026-00000${i}-D`,
        code: 'FOREVER',
        amountMinor: 100,
        currency: CURRENCY,
        now: NOW,
      });
    }

    expect((await port().validate({ code: 'FOREVER', currency: CURRENCY, now: NOW })).ok).toBe(true);
  });
});

describe('counting a use', () => {
  it('increments the count and records what the code actually took off', async () => {
    const made = await make({ code: 'TEN', kind: 'percent', percentBps: 1000 });

    const anomaly = await port().redeem({
      orderId: 'ord_1',
      orderNumber: '2026-000001-D',
      code: 'TEN',
      amountMinor: 12_345,
      currency: CURRENCY,
      now: NOW,
    });

    expect(anomaly).toBeNull();
    expect((await getDiscount(db, made.id))?.redeemedCount).toBe(1);
    const row = await db.execute(sql`
      SELECT discount_id, code, order_number, amount_minor, currency, redeemed_at
        FROM marketing_discount_redemptions WHERE order_id = 'ord_1'`);
    expect(row.rows[0]).toMatchObject({
      discount_id: made.id,
      code: 'TEN',
      order_number: '2026-000001-D',
      amount_minor: 12_345,
      currency: CURRENCY,
    });
  });

  it('is IDEMPOTENT per order — a redelivered webhook counts once', async () => {
    const made = await make({ code: 'TEN', kind: 'percent', percentBps: 1000 });
    const once = () =>
      port().redeem({
        orderId: 'ord_1',
        orderNumber: '2026-000001-D',
        code: 'TEN',
        amountMinor: 100,
        currency: CURRENCY,
        now: NOW,
      });

    await once();
    await once();
    await once();

    // Paystack redelivers and the sweep drains to a fixed point. A counter that
    // moved on every pass would refuse a code that still had uses left.
    expect((await getDiscount(db, made.id))?.redeemedCount).toBe(1);
  });

  it('counts a use of a code that has SINCE been disabled', async () => {
    const made = await make({ code: 'TEN', kind: 'percent', percentBps: 1000 });
    await patchDiscount(db, made.id, { status: 'disabled' }, {
      actorId,
      now: NOW,
      expectedRevision: made.revision,
    });

    // The sale happened, at a price that included this discount. Refusing to
    // record it would leave the campaign's cost understated and the order's own
    // history unable to explain its total.
    const anomaly = await port().redeem({
      orderId: 'ord_1',
      orderNumber: '2026-000001-D',
      code: 'TEN',
      amountMinor: 100,
      currency: CURRENCY,
      now: NOW,
    });

    expect(anomaly).toBeNull();
    expect((await getDiscount(db, made.id))?.redeemedCount).toBe(1);
  });

  it('reports an anomaly rather than throwing when the code has vanished', async () => {
    // Runs after the order is paid, so there is nothing useful to fail. The
    // consumer writes this line onto the order's history and moves on.
    const anomaly = await port().redeem({
      orderId: 'ord_1',
      orderNumber: '2026-000001-D',
      code: 'GHOST',
      amountMinor: 100,
      currency: CURRENCY,
      now: NOW,
    });

    expect(anomaly).toContain('GHOST');
  });
});
