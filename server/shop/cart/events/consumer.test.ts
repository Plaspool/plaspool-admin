/**
 * Cart consumes `payment.captured`, so a paid checkout's holds become a
 * permanent decrement instead of expiring back onto the shelf.
 *
 * ═══ THE FAILURE THIS CLOSES ═══
 * Contract §5 says `commitReservation` is "called on payment capture" and names
 * no caller. Payments must not call it (§2 R4: causation is an event, not a
 * call) and Orders must not either (`shop_reservations` is Cart's under R3), so
 * Cart is the only subsystem that can — and Cart was a consumer of nothing.
 * `real-catalog.test.ts` shows the damage as an assertion: after a completed
 * checkout the stock is still `reserved`, and fifteen minutes later the sweeper
 * hands it back to somebody else. The shop resells what it has already sold.
 *
 * ═══ WHAT IS DELIBERATELY NOT CONSUMED ═══
 * `payment.failed` is NOT a release. Payments' own note in
 * `shared/commerce/ports.ts` records that `failed → captured` is a real
 * transition — Paystack lets a customer retry a failed attempt on the same
 * reference — so releasing on failure would give away stock the customer is
 * still in the middle of paying for. The 15-minute TTL is what reclaims an
 * abandoned checkout, and it is enough.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, resetShopTables, TEST_CURRENCY } from '../test/harness';
import { fakeCatalog } from '../test/fake-catalog';
import { addLine, createCart } from '../cart/repo';
import {
  listReservations,
  reserveForCheckout,
  sweepExpiredReservations,
} from '../reservations/repo';
import {
  CART_CONSUMER,
  MAX_EVENT_ATTEMPTS,
  drainCommerceEvents,
  runCartMaintenance,
} from './consumer';
import { newId } from '../ids';
import type { CartFakeCatalog } from '../test/fake-catalog';
import type { Db } from '../../../db/client';

let db: Db;
let close: () => Promise<void>;
let catalog: CartFakeCatalog;

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});
afterAll(() => close());

beforeEach(async () => {
  await resetShopTables(db);
  await db.execute(sql`TRUNCATE shop_cart_event_consumptions`);
  catalog = fakeCatalog([
    { variantId: 'var_a', price: { amount: 1999, currency: TEST_CURRENCY }, onHand: 10 },
  ]);
});

/** A cart with two units held, ready to be captured. */
async function heldCart(qty = 2): Promise<string> {
  const cart = await createCart(db, { currency: TEST_CURRENCY });
  await addLine(db, { cartId: cart.id, variantId: 'var_a', qty });
  const result = await reserveForCheckout(db, catalog, {
    cartId: cart.id,
    lines: [{ variantId: 'var_a', qty }],
  });
  if (!result.ok) throw new Error('expected holds');
  return cart.id;
}

/** Write an outbox row exactly as Payments does. */
async function emit(
  type: string,
  subjectId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = newId('event');
  await db.execute(sql`
    INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at, attempts)
    VALUES (${id}, ${type}, ${subjectId}, ${JSON.stringify(payload)}::jsonb, ${Date.now()}, 0)`);
  return id;
}

const captured = (checkoutId: string) => ({
  intentId: 'pi_1',
  checkoutId,
  amount: 3998,
  currency: TEST_CURRENCY,
  occurredAt: Date.now(),
});

async function consumption(eventId: string) {
  const res = await db.execute(sql`
    SELECT outcome, attempts, detail FROM shop_cart_event_consumptions
     WHERE consumer = ${CART_CONSUMER} AND event_id = ${eventId}`);
  const row = res.rows[0];
  return row
    ? {
        outcome: String(row.outcome),
        attempts: Number(row.attempts),
        detail: row.detail == null ? null : String(row.detail),
      }
    : null;
}

describe('payment.captured commits the checkout’s reservations', () => {
  it('turns every held reservation into a permanent decrement', async () => {
    const cartId = await heldCart(2);
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 10, reserved: 2 });
    const eventId = await emit('payment.captured', 'pi_1', captured(cartId));

    const summary = await drainCommerceEvents(db, catalog);

    expect(summary.applied).toBe(1);
    // SOLD: on-hand down, nothing left reserved.
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 8, reserved: 0 });
    expect((await listReservations(db, cartId))[0].state).toBe('committed');
    expect(await consumption(eventId)).toMatchObject({ outcome: 'applied' });
  });

  it('is idempotent — a redelivery commits nothing a second time', async () => {
    /*
     * Contract §6 rule 2: at-least-once delivery is the guarantee. Two guards
     * hold here and both are load-bearing — the consumption row stops the second
     * drain reaching the handler at all, and `commitReservation`'s own
     * `WHERE state = 'held'` would stop it decrementing even if it did.
     */
    const cartId = await heldCart(2);
    await emit('payment.captured', 'pi_1', captured(cartId));

    await drainCommerceEvents(db, catalog);
    const second = await drainCommerceEvents(db, catalog);

    expect(second.applied).toBe(0);
    expect(second.scanned).toBe(0);
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 8, reserved: 0 });
  });

  it('commits nothing for a checkout with no holds, and does not retry forever', async () => {
    const cart = await createCart(db, { currency: TEST_CURRENCY });
    const eventId = await emit('payment.captured', 'pi_1', captured(cart.id));

    const summary = await drainCommerceEvents(db, catalog);

    // `ignored`, not `applied`: nothing happened, and nothing was wrong either.
    expect(summary.ignored).toBe(1);
    expect(await consumption(eventId)).toMatchObject({ outcome: 'ignored' });
    expect((await drainCommerceEvents(db, catalog)).scanned).toBe(0);
  });
});

describe('an event Cart does not consume', () => {
  it('IGNORES an unknown type rather than throwing (contract §6 rule 4)', async () => {
    /*
     * "A consumer receiving an unknown `type` ignores it and logs; it does not
     * throw. That is what lets subsystem 3 ship an event type before subsystem 4
     * knows about it — which is the entire point of building these in parallel."
     */
    const eventId = await emit('something.invented.later', 'x', { anything: true });

    const summary = await drainCommerceEvents(db, catalog);

    expect(summary.ignored).toBe(1);
    expect(summary.parked).toBe(0);
    expect(await consumption(eventId)).toMatchObject({ outcome: 'ignored' });
  });

  it('ignores payment.failed — a failed attempt can still be paid', async () => {
    /*
     * NOT A RELEASE, and this is a decision rather than an omission. Payments
     * records that `failed → captured` is a real transition because a customer
     * can retry on the same reference. Releasing here would hand the last unit
     * to somebody else while the first customer is still typing their card
     * number. The TTL reclaims an abandoned checkout; that is enough.
     */
    const cartId = await heldCart(2);
    await emit('payment.failed', 'pi_1', { ...captured(cartId), reason: 'declined' });

    const summary = await drainCommerceEvents(db, catalog);

    expect(summary.ignored).toBe(1);
    // Still held. Nothing was given back and nothing was sold.
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 10, reserved: 2 });
    expect((await listReservations(db, cartId))[0].state).toBe('held');
  });

  it('ignores Cart’s own checkout.completed rather than looping on it', async () => {
    const cartId = await heldCart(1);
    await emit('checkout.completed', cartId, { checkoutId: cartId });
    expect((await drainCommerceEvents(db, catalog)).ignored).toBe(1);
  });
});

describe('a payload Cart cannot read', () => {
  it('PARKS it for a redeploy rather than discarding it', async () => {
    /*
     * The realistic cause during a parallel build is that Cart's schema is
     * wrong, and the fix is a redeploy — after which the row must still be
     * there. `ignored` would be a decision that the event does not matter;
     * `parked` says "cannot read this yet" and keeps it in the candidate set.
     */
    const eventId = await emit('payment.captured', 'pi_1', { intentId: 'pi_1' });

    const summary = await drainCommerceEvents(db, catalog);

    expect(summary.parked).toBe(1);
    const row = await consumption(eventId);
    expect(row?.outcome).toBe('parked');
    // The detail names a FIELD PATH and never a value — a `lastError` built from
    // a raw parser message is one edit away from holding a customer's address.
    expect(row?.detail).toBe('checkoutId');
    // Still a candidate on the next drain.
    expect((await drainCommerceEvents(db, catalog)).scanned).toBe(1);
  });

  it('ABANDONS it after a bounded number of attempts, loudly', async () => {
    // Contract §6 rule 3: a failed consumer does not retry in a tight loop.
    // GAUNTLET I Round 1 #2 is what an unbounded retry costs.
    const eventId = await emit('payment.captured', 'pi_1', { intentId: 'pi_1' });

    for (let i = 0; i < MAX_EVENT_ATTEMPTS; i += 1) await drainCommerceEvents(db, catalog);

    expect(await consumption(eventId)).toMatchObject({
      outcome: 'abandoned',
      attempts: MAX_EVENT_ATTEMPTS,
    });
    // Out of the candidate set: it needs a human, not another attempt.
    expect((await drainCommerceEvents(db, catalog)).scanned).toBe(0);
    // And it is REPORTED, because an abandoned capture is stock held for a sale
    // that already happened.
    const summary = await drainCommerceEvents(db, catalog);
    expect(summary.abandoned).toBe(0);
  });
});

describe('two consumers, one event (contract §6 rule 2)', () => {
  it('Orders having handled an event does not stop Cart handling it', async () => {
    /*
     * A-005: `commerce_events` carries ONE `processed_at`, so the first consumer
     * to finish would hide the row from the second. Cart's candidate set is an
     * ANTI-JOIN against Cart's own consumption table — never `processed_at IS
     * NULL` — which is the same choice Orders made, for the same reason.
     */
    const cartId = await heldCart(2);
    const eventId = await emit('payment.captured', 'pi_1', captured(cartId));
    // Exactly what Orders' consumer does when it applies one.
    await db.execute(sql`
      UPDATE commerce_events SET processed_at = ${Date.now()} WHERE id = ${eventId}`);

    expect((await drainCommerceEvents(db, catalog)).applied).toBe(1);
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 8, reserved: 0 });
  });

  it('and Cart never writes `processed_at`, because it is not Cart’s to claim', async () => {
    const cartId = await heldCart(1);
    const eventId = await emit('payment.captured', 'pi_1', captured(cartId));

    await drainCommerceEvents(db, catalog);

    const res = await db.execute(
      sql`SELECT processed_at, attempts, last_error FROM commerce_events WHERE id = ${eventId}`,
    );
    expect(res.rows[0].processed_at).toBeNull();
    // Nor the shared `attempts`/`last_error`: two consumers bumping one counter
    // makes it mean nothing.
    expect(Number(res.rows[0].attempts)).toBe(0);
    expect(res.rows[0].last_error).toBeNull();
  });
});

describe('the capture beats the sweeper', () => {
  it('a captured checkout is committed even when its holds have expired', async () => {
    /*
     * THE WHOLE POINT, and the reason maintenance drains BEFORE it sweeps.
     *
     * A capture that arrives after the TTL has elapsed must still sell the
     * stock: the customer has paid. Draining first means the holds are
     * `committed` by the time the sweeper looks, and its `WHERE state = 'held'`
     * finds nothing.
     */
    const cartId = await heldCart(2);
    await emit('payment.captured', 'pi_1', captured(cartId));
    await db.execute(sql`UPDATE shop_reservations SET expires_at = ${Date.now() - 1}`);

    const summary = await runCartMaintenance(db, catalog);

    expect(summary.drain.applied).toBe(1);
    expect(summary.sweep.released).toBe(0);
    // Sold, not handed back to somebody else.
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 8, reserved: 0 });
    expect((await listReservations(db, cartId))[0].state).toBe('committed');
  });

  it('A BACKLOG BIGGER THAN THE DRAIN BATCH DOES NOT LOSE THE REST', async () => {
    /*
     * THE BUG THIS TEST WAS WRITTEN FOR, AND IT WAS A REAL ONE.
     *
     * "Drain before sweep" was originally the whole guarantee, and it is not
     * enough, because the drain is BOUNDED. With more pending captures than one
     * batch, the sweeper reached holds whose captures were still queued behind
     * it. Measured before the fix — ten paid checkouts, drain batch of three:
     *
     *     drain {"scanned":3,"applied":3}  sweep {"released":3}
     *     states [{"committed":3},{"expired":3},{"held":4}]
     *
     * Three paid units handed back to somebody else. The same "resells what it
     * has already sold" failure the consumer exists to prevent, reintroduced by
     * the bound that keeps the drain cheap.
     *
     * The fix is in the sweeper's own predicate rather than in the ordering: it
     * refuses to expire a hold whose cart has a `payment.captured` in the
     * outbox. The ordering is now an optimisation, and a caller that sweeps
     * without draining is safe too.
     */
    const carts: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const cartId = await heldCart(1);
      carts.push(cartId);
      await emit('payment.captured', `pi_${i}`, { intentId: `pi_${i}`, checkoutId: cartId });
    }
    await db.execute(sql`UPDATE shop_reservations SET expires_at = ${Date.now() - 1}`);

    const summary = await runCartMaintenance(db, catalog, { limit: 3 });

    // The drain only got to three of them, which is the whole point.
    expect(summary.drain.applied).toBe(3);
    // NOT ONE of the other seven was expired.
    expect(summary.sweep.released).toBe(0);
    const states = await db.execute(sql`
      SELECT state, count(*)::int AS n FROM shop_reservations GROUP BY state ORDER BY state`);
    expect(states.rows.map((r) => [String(r.state), Number(r.n)])).toEqual([
      ['committed', 3],
      ['held', 7],
    ]);

    // And successive runs drain the rest without ever losing one.
    await runCartMaintenance(db, catalog, { limit: 3 });
    await runCartMaintenance(db, catalog, { limit: 3 });
    await runCartMaintenance(db, catalog, { limit: 3 });
    const after = await db.execute(sql`
      SELECT count(*)::int AS n FROM shop_reservations WHERE state = 'committed'`);
    expect(Number(after.rows[0].n)).toBe(10);
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 0, reserved: 0 });
  });

  it('sweeping WITHOUT draining first is now safe too', async () => {
    // The ordering is an optimisation, not the guarantee. A future caller that
    // gets it wrong — or a direct call from an admin script — cannot resell a
    // paid unit.
    const cartId = await heldCart(2);
    await emit('payment.captured', 'pi_1', captured(cartId));
    await db.execute(sql`UPDATE shop_reservations SET expires_at = ${Date.now() - 1}`);

    expect((await sweepExpiredReservations(db, catalog)).released).toBe(0);
    expect((await listReservations(db, cartId))[0].state).toBe('held');
  });

  it('and an uncaptured expired checkout is still swept', async () => {
    // The ordering must not have disabled the sweeper.
    const cartId = await heldCart(2);
    await db.execute(sql`UPDATE shop_reservations SET expires_at = ${Date.now() - 1}`);

    const summary = await runCartMaintenance(db, catalog);

    expect(summary.drain.applied).toBe(0);
    expect(summary.sweep.released).toBe(1);
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 10, reserved: 0 });
    expect((await listReservations(db, cartId))[0].state).toBe('expired');
  });
});

describe('one maintenance run clears the whole backlog', () => {
  it('drains 120 captures in ONE invocation, not one batch of them', async () => {
    /*
     * WHY THE SCHEDULE WAS THE WRONG THING TO ARGUE ABOUT. With a fixed batch of
     * 50 this was measured at: one invocation applies 50, leaves 70 — three days
     * to clear a single busy day on a daily cron, while more arrive. The job
     * falls behind at exactly the rate the shop succeeds.
     *
     * Draining until empty makes one run a real backstop, whatever the schedule.
     */
    const carts: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      const cart = await createCart(db, { currency: TEST_CURRENCY });
      carts.push(cart.id);
      await emit('payment.captured', `pi_${i}`, { intentId: `pi_${i}`, checkoutId: cart.id });
    }

    const summary = await runCartMaintenance(db, catalog, { limit: 50, untilEmpty: true });

    expect(summary.drain.scanned).toBe(120);
    expect(summary.passes).toBeGreaterThan(1);
    expect(summary.exhausted).toBe(false);
    const left = await db.execute(sql`
      SELECT count(*)::int AS n FROM commerce_events e
       WHERE NOT EXISTS (SELECT 1 FROM shop_cart_event_consumptions c
                          WHERE c.consumer = ${CART_CONSUMER} AND c.event_id = e.id)`);
    expect(Number(left.rows[0].n)).toBe(0);
  });

  it('stops at the pass ceiling and SAYS it is still behind', async () => {
    // `exhausted` is the signal that one invocation was not enough. A cron that
    // reports it every night is a cron that is falling behind, and nothing else
    // in the system would say so.
    for (let i = 0; i < 30; i += 1) await emit('x.unknown', `s_${i}`, {});

    const summary = await runCartMaintenance(db, catalog, {
      limit: 5,
      untilEmpty: true,
      maxPasses: 2,
    });

    expect(summary.passes).toBe(2);
    expect(summary.drain.scanned).toBe(10);
    expect(summary.exhausted).toBe(true);
  });

  it('the LAZY path still takes exactly one small pass', async () => {
    // A shopper's page load is not the place to clear a backlog.
    for (let i = 0; i < 30; i += 1) await emit('x.unknown', `s_${i}`, {});

    const summary = await runCartMaintenance(db, catalog, { limit: 5 });

    expect(summary.passes).toBe(1);
    expect(summary.drain.scanned).toBe(5);
    expect(summary.exhausted).toBe(false);
  });

  it('terminates even when every event is PARKED and stays a candidate', async () => {
    /*
     * A parked event is deliberately still a candidate, so a pass that finds only
     * parked events finds them again on the next one. They drop out after
     * MAX_EVENT_ATTEMPTS, but the loop must not depend on that to terminate —
     * hence the pass ceiling.
     */
    for (let i = 0; i < 3; i += 1) await emit('payment.captured', `pi_${i}`, { intentId: 'x' });

    const summary = await runCartMaintenance(db, catalog, { limit: 10, untilEmpty: true });

    expect(summary.passes).toBeLessThanOrEqual(MAX_EVENT_ATTEMPTS + 1);
    expect(summary.drain.abandoned).toBe(3);
  });
});

describe('the drain is bounded', () => {
  it('takes at most `limit` events per run, oldest first', async () => {
    // Unbounded, this runs on a cart read as well as on the cron route, and its
    // cost would be set by how long the cron had been broken — paid by whichever
    // shopper happened to load a basket next.
    for (let i = 0; i < 5; i += 1) await emit('something.unknown', `s_${i}`, {});

    expect((await drainCommerceEvents(db, catalog, { limit: 2 })).scanned).toBe(2);
    expect((await drainCommerceEvents(db, catalog, { limit: 2 })).scanned).toBe(2);
    expect((await drainCommerceEvents(db, catalog, { limit: 2 })).scanned).toBe(1);
  });
});
