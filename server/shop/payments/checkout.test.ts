import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fakeCheckoutPort } from './checkout';
import type { Db } from '../../db/client';

/**
 * The drift guard on the `CheckoutPort` shim.
 *
 * Payments consumes a port Cart owns (contract §5) and Cart has not landed, so
 * `checkout.ts` declares the narrowest structural subset Payments actually
 * reads. That is what contract §11 asks for — "code against a fake
 * `CheckoutPort`… if you find yourself blocked on another agent, you have
 * coupled to an implementation instead of a port" — but a shim with no expiry
 * is how a codebase ends up with two definitions of one thing forever.
 *
 * So the shim has an expiry, and it is executable: the moment a real
 * `CheckoutPort` appears in `shared/commerce/ports.ts`, this test fails and
 * says what to do about it. That is the same shape as the "a mechanism wired to
 * no caller" findings both gauntlets kept producing, turned into something that
 * cannot be forgotten.
 */

const SHARED_PORTS = 'shared/commerce/ports.ts';

describe('the CheckoutPort shim has expired, and the real port is wired', () => {
  it('Cart exports CheckoutPort, which is why the shim is gone', () => {
    /*
     * THIS ASSERTION IS INVERTED FROM WHAT IT WAS, and the reason is kept
     * rather than swapped out. It used to read `.toBe(false)` and fail the
     * moment a real `CheckoutPort` appeared, with instructions to delete
     * `FrozenTotalsSubset`/`CheckoutPortSubset` from `checkout.ts`. It fired
     * within the session, Cart's port landed, and the shim was deleted.
     *
     * It now asserts the opposite direction: the real port must still be there.
     * If Cart's block is ever lost to another wholesale overwrite of this shared
     * file (A-CAT-009 records three in one afternoon), this fails and names it,
     * rather than `checkout.ts` failing to compile with a less obvious cause.
     */
    const source = readFileSync(SHARED_PORTS, 'utf8');
    expect(
      /export interface CheckoutPort\b/.test(source),
      `${SHARED_PORTS} no longer exports CheckoutPort — Cart's block has been ` +
        `lost. server/shop/payments/checkout.ts imports it directly.`,
    ).toBe(true);
    expect(/export interface FrozenTotals\b/.test(source)).toBe(true);
  });

  it('the fake satisfies the REAL interface, so it cannot drift from it', async () => {
    /*
     * The fake returns a genuine `FrozenTotals` — typed as one, so a change to
     * Cart's shape is a compile error here rather than a surprise at wiring
     * time. Payments reads exactly one field of it, and reads it as `Money`:
     * the amount and the currency travel together, which is contract §10's
     * "no `number` amounts without an accompanying currency".
     */
    const port = fakeCheckoutPort({ crt_1: { total: 40_333, currency: 'NGN' } });
    const totals = await port.totals(null as unknown as Db, 'crt_1');
    expect(totals.grandTotal).toEqual({ amount: 40_333, currency: 'NGN' });
    expect(totals.currency).toBe('NGN');
    // Internally consistent rather than arbitrary, so a Payments bug that read
    // the wrong field surfaces as a wrong number rather than a plausible one.
    expect(totals.subtotal).toEqual(totals.grandTotal);
    expect(totals.taxTotal).toEqual({ amount: 0, currency: 'NGN' });
  });

  it('THROWS for a checkout that is not payable, exactly as the real port does', async () => {
    /*
     * The shim returned `null` and `createIntent` turned that into a 404
     * itself. Cart's port throws `NotFoundError` instead — same status, same
     * permanent stop under §8's retry policy, different control flow. The fake
     * matches the real behaviour so that a Payments bug in the absent case
     * cannot pass here and fail against Cart.
     */
    const port = fakeCheckoutPort({});
    await expect(port.totals(null as unknown as Db, 'crt_missing')).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });
});
