/**
 * The inbound boundary (`inbound.ts`).
 *
 * TWO PROPERTIES, AND THE SECOND IS THE ONE THAT WILL MATTER AT INTEGRATION:
 *
 *  1. The three documented TOLERANCES work, in both spellings, so they are a decision
 *     rather than something that happens to pass today.
 *  2. **Nothing is recomputed.** A `checkout.completed` whose totals do not add up is
 *     stored verbatim, because the brief's working rule is to copy the frozen totals
 *     and a consumer that "corrected" them would disagree with the amount charged.
 */
import { describe, expect, it } from 'vitest';
import {
  parseCheckoutCompleted,
  parsePaymentCaptured,
  parsePaymentFailed,
  parsePaymentRefunded,
} from './inbound';
import {
  CHECKOUT,
  CURRENCY,
  checkoutCompleted,
  checkoutCurrencyMismatch,
  checkoutMalformed,
  checkoutWithInconsistentTotals,
  checkoutWithMoneyObjects,
  checkoutWithNestedTotals,
  paymentCaptured,
  paymentFailed,
  paymentRefunded,
} from './test/fixtures';

const ok = <T>(parsed: { ok: boolean } | { ok: true; value: T }) => {
  expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  return (parsed as { ok: true; value: T }).value;
};

describe('checkout.completed', () => {
  it('reads the canonical payload', () => {
    const event = checkoutCompleted();
    const value = ok(parseCheckoutCompleted(event.payload, event.subjectId));
    expect(value).toMatchObject({
      checkoutId: CHECKOUT,
      customerId: 'cus_aaaa',
      currency: 'USD',
      subtotal: 4500,
      shippingTotal: 500,
      taxTotal: 400,
      grandTotal: 5400,
    });
    expect(value.lines).toHaveLength(2);
    expect(value.lines[0]).toEqual({
      variantId: 'var_mug_navy',
      sku: 'MUG-NAVY',
      title: 'Enamel Mug',
      optionValues: { Colour: 'Navy' },
      qty: 2,
      unitAmount: 1500,
      lineTotal: 3000,
    });
  });

  it('STORES TOTALS THAT DO NOT ADD UP, VERBATIM', () => {
    /*
     * The load-bearing test for "never recompute a total". `1 + 1 + 1 ≠ 5400`, and this
     * subsystem is not the owner of that arithmetic — Cart is. A validator that
     * rejected this, or a consumer that recomputed `grandTotal` from the parts, would
     * turn a legitimate future adjustment line into a paid checkout that can never
     * become an order.
     */
    const event = checkoutWithInconsistentTotals();
    const value = ok(parseCheckoutCompleted(event.payload, event.subjectId));
    expect(value.subtotal).toBe(1);
    expect(value.shippingTotal).toBe(1);
    expect(value.taxTotal).toBe(1);
    expect(value.grandTotal).toBe(5400);
  });

  it('tolerance 1: amounts may arrive as contract §10 Money objects', () => {
    const event = checkoutWithMoneyObjects();
    const value = ok(parseCheckoutCompleted(event.payload, event.subjectId));
    expect(value.grandTotal).toBe(5400);
    expect(value.lines[0].unitAmount).toBe(1500);
  });

  it('tolerance 2: an absent checkoutId falls back to the row’s subjectId', () => {
    // Contract §6 defines `subjectId` as "the aggregate this is about", and for
    // `checkout.completed` that IS the checkout.
    const event = checkoutWithMoneyObjects();
    expect((event.payload as Record<string, unknown>).checkoutId).toBeUndefined();
    expect(ok(parseCheckoutCompleted(event.payload, event.subjectId)).checkoutId).toBe(CHECKOUT);
  });

  it('tolerance 3: totals may be nested or flat', () => {
    const nested = checkoutWithNestedTotals();
    expect(ok(parseCheckoutCompleted(nested.payload, nested.subjectId)).grandTotal).toBe(5400);
    const flat = checkoutCompleted();
    expect(ok(parseCheckoutCompleted(flat.payload, flat.subjectId)).grandTotal).toBe(5400);
  });

  it('a currency that disagrees with the order’s is refused, never guessed at', () => {
    const event = checkoutCurrencyMismatch();
    const parsed = parseCheckoutCompleted(event.payload, event.subjectId);
    expect(parsed.ok).toBe(false);
    expect((parsed as { ok: false; detail: string }).detail).toBe('lines.0.unitAmount.currency');
  });

  it('names the FIELD PATH and never the value', () => {
    /*
     * `zodDetail` is imported rather than re-derived precisely because Zod's own
     * messages quote the offending input for several issue codes — and one of the things
     * flowing through here is a customer's address. A `last_error` column built from a
     * Zod message is a customer record in a table nobody audited.
     */
    const event = checkoutMalformed();
    const parsed = parseCheckoutCompleted(event.payload, event.subjectId);
    expect(parsed.ok).toBe(false);
    const detail = (parsed as { ok: false; detail: string }).detail;
    expect(detail).toBe('lines');
    expect(detail).not.toContain('two things');
  });

  it.each([
    ['no lines', { lines: [] }],
    ['a zero quantity', { lines: [{ variantId: 'v', sku: 's', title: 't', qty: 0, unitAmount: 1, lineTotal: 0 }] }],
    ['a fractional amount', { lines: [{ variantId: 'v', sku: 's', title: 't', qty: 1, unitAmount: 1.5, lineTotal: 1.5 }] }],
    ['a lowercase currency', { currency: 'usd' }],
    ['an empty email', { email: '' }],
  ])('refuses %s', (_name, overrides) => {
    const event = checkoutCompleted(overrides as never);
    expect(parseCheckoutCompleted(event.payload, event.subjectId).ok).toBe(false);
  });

  it('an unknown key is IGNORED, which is the opposite of the HTTP rule', () => {
    /*
     * `server/routes/posts.ts` parses request bodies with `.strict()` so an unknown key
     * is a 400 — right there, because the sender is a client that must be told it tried
     * to set something it may not. Here the sender is a peer subsystem that contract §6
     * explicitly allows to evolve ahead of this one, so an additive field must not park
     * every event Orders receives.
     */
    const event = checkoutCompleted();
    const withExtra = { ...(event.payload as object), giftMessage: 'happy birthday' };
    expect(parseCheckoutCompleted(withExtra, event.subjectId).ok).toBe(true);
  });

  it('reads add-ons nested under totals, defaulting to none, and refuses a foreign currency on one', () => {
    const withAddOns = checkoutCompleted({
      totals: {
        subtotal: 4500, shippingTotal: 500, taxTotal: 400, grandTotal: 5550,
        addOns: [{ id: 'ado_box', title: 'Gift box', mode: 'chosen', amount: { amount: 150, currency: CURRENCY }, listPrice: { amount: 150, currency: CURRENCY } }],
        addOnTotal: { amount: 150, currency: CURRENCY },
      },
    });
    const parsed = parseCheckoutCompleted(withAddOns.payload, CHECKOUT);
    expect(parsed.ok && parsed.value.addOnTotal).toBe(150);
    /* No unitAmount/units/basis on the wire (a pre-0960 event): each defaults
       to "one unit, charged once for the order", which is what it meant. */
    expect(parsed.ok && parsed.value.addOns).toEqual([
      { id: 'ado_box', title: 'Gift box', mode: 'chosen', amount: 150, listPrice: 150, unitAmount: 150, units: 1, basis: 'order' },
    ]);

    const legacy = parseCheckoutCompleted(checkoutCompleted().payload, CHECKOUT);
    expect(legacy.ok && legacy.value.addOns).toEqual([]);
    expect(legacy.ok && legacy.value.addOnTotal).toBe(0);

    const foreign = checkoutCompleted({
      totals: { subtotal: 1, shippingTotal: 1, taxTotal: 1, grandTotal: 1, addOns: [{ id: 'ado_box', title: 'Box', mode: 'included', amount: { amount: 0, currency: 'EUR' }, listPrice: 1 }] },
    });
    expect(parseCheckoutCompleted(foreign.payload, CHECKOUT)).toEqual({ ok: false, detail: 'totals.addOns.0.amount.currency' });
  });
});

describe('payment.*', () => {
  it('reads a capture, keyed on checkoutId', () => {
    const value = ok(parsePaymentCaptured(paymentCaptured().payload));
    expect(value.checkoutId).toBe(CHECKOUT);
    expect(value.amount).toBe(5400);
  });

  it('reads a failure with an enumerable reason', () => {
    expect(ok(parsePaymentFailed(paymentFailed({ reason: 'declined' }).payload)).reason).toBe(
      'declined',
    );
    // Free text is refused: a consumer switching on prose breaks on a copy edit.
    expect(parsePaymentFailed(paymentFailed({ reason: 'card said no' }).payload).ok).toBe(false);
  });

  it('reads a refund, carrying the CUMULATIVE total', () => {
    const value = ok(
      parsePaymentRefunded(paymentRefunded({ refundedAmount: 1000, refundedTotal: 2500 }).payload),
    );
    expect(value.refundedAmount).toBe(1000);
    expect(value.refundedTotal).toBe(2500);
  });

  it('refuses a payment payload with no checkoutId — there would be no order to find', () => {
    const { checkoutId: _dropped, ...rest } = paymentCaptured().payload as Record<string, unknown>;
    expect(parsePaymentCaptured(rest).ok).toBe(false);
  });

  it.each([
    ['null', null],
    ['a string', 'captured'],
    ['a number', 42],
    ['an array', []],
  ])('refuses a payload that is %s', (_name, payload) => {
    expect(parsePaymentCaptured(payload).ok).toBe(false);
  });
});
