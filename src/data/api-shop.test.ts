import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MoneyShapeError,
  currencyDigits,
  formatMinor,
  moneyRefusalMessage,
  parseMajor,
  parseRefund,
  safeFormatMinor,
  shopApi,
} from './api-shop';
import { UNRENDERABLE } from './when';

/**
 * The shop client, pinned on the two things that are silent when wrong.
 *
 * THE MONEY BOUNDARY IS THE POINT OF THIS FILE. Everything on the shop screens
 * crosses the wire as an integer of minor units and is typed by a person in
 * major ones, and the whole of that conversion lives in `api-shop.ts` — so an
 * error there is an error in every price, every total and every refund at once.
 * Three of the cases below are the ones that cost real money and produce no
 * stack trace:
 *
 *  - **zero.** `£0.00` and `£0` are different strings, and only one of them is
 *    a price. A shop that prints the second on a free item looks broken.
 *  - **a trailing zero in the minor part.** `1990 / 100` is `19.9` to anything
 *    that thinks in numbers, and `£19.9` looks like a typo to a customer and
 *    like rounding to an accountant. This is the case a naive implementation
 *    always gets wrong and a screenshot never shows.
 *  - **a refund larger than what is left.** The server refuses it, but only
 *    after the operator has agreed to a confirm dialog — so the bound has to be
 *    enforced while they are still looking at the box.
 *
 * The route assertions are the second half: a path string, a method and which
 * key an amount travels under have no compiler behind them, and all three fail
 * as a 400 or a 404 a long way from their cause.
 *
 * A LOCALE IS PASSED EXPLICITLY throughout. The default is the machine's, and a
 * suite that asserts `£19.90` passes in London and fails in Berlin — which
 * would be a test about CI's environment rather than about this module.
 */

const GB = 'en-GB';

// ============================================================================
// MONEY
// ============================================================================

describe('currencyDigits', () => {
  it('knows the exponents that are not two', () => {
    expect(currencyDigits('GBP')).toBe(2);
    expect(currencyDigits('USD')).toBe(2);
    // The whole reason this is not a hardcoded 100 anywhere in `src/`.
    expect(currencyDigits('JPY')).toBe(0);
    expect(currencyDigits('KWD')).toBe(3);
  });

  it('is case-insensitive, because a route may answer either', () => {
    expect(currencyDigits('jpy')).toBe(0);
  });

  it('falls back to two for a code nothing knows', () => {
    expect(currencyDigits('ZZZ')).toBe(2);
  });
});

describe('formatMinor', () => {
  it('prints zero as a price and not as a number', () => {
    expect(formatMinor(0, 'GBP', GB)).toBe('£0.00');
  });

  it('KEEPS A TRAILING ZERO IN THE MINOR PART', () => {
    expect(formatMinor(1990, 'GBP', GB)).toBe('£19.90');
    expect(formatMinor(1900, 'GBP', GB)).toBe('£19.00');
    expect(formatMinor(10, 'GBP', GB)).toBe('£0.10');
  });

  it('pads a value smaller than one whole unit', () => {
    expect(formatMinor(5, 'GBP', GB)).toBe('£0.05');
    expect(formatMinor(99, 'GBP', GB)).toBe('£0.99');
  });

  it('groups the whole part without ever making it a double', () => {
    expect(formatMinor(123456789, 'GBP', GB)).toBe('£1,234,567.89');
    // Past 2^53 minor units the naive `amount / 100` starts losing digits.
    // 90 071 992 547 409 91 is one below `Number.MAX_SAFE_INTEGER`.
    expect(formatMinor(9007199254740991, 'GBP', GB)).toBe('£90,071,992,547,409.91');
  });

  it('signs a negative amount, including one with no whole part', () => {
    expect(formatMinor(-1990, 'GBP', GB)).toBe('-£19.90');
    /*
     * `-0n` IS `0n`, so this is the case where `Intl` has no negative to sign
     * and the minus has to be put back by hand. A refund of fifty pence
     * rendered as a charge of fifty pence is the worst bug on the order screen.
     */
    expect(formatMinor(-50, 'GBP', GB)).toBe('-£0.50');
  });

  it('gives a zero-exponent currency no decimal point at all', () => {
    const yen = formatMinor(1999, 'JPY', GB);
    expect(yen).toContain('1,999');
    expect(yen).not.toContain('.');
  });

  it('gives a three-exponent currency three places', () => {
    expect(formatMinor(1234, 'KWD', GB)).toContain('1.234');
  });

  it('refuses a float outright rather than rounding it', () => {
    // A float here is a defect upstream, and rounding it would be this module
    // deciding a price on somebody's behalf.
    expect(() => formatMinor(19.99, 'GBP', GB)).toThrow(MoneyShapeError);
  });
});

/**
 * THE DISPLAY TWIN, AND THE CONTRAST IS THE TEST.
 *
 * Two formatters exist because a broken amount has two right answers depending
 * on which way it is travelling: on a cell, a placeholder and four other orders
 * the operator can still read; on a refund form, a refusal, because a write path
 * that renders a placeholder and submits anyway reaches somebody's card. So
 * every case below asserts BOTH halves — what `safeFormatMinor` returns and that
 * `formatMinor` still refuses the same input. Either half passing alone is the
 * state this pair was built to leave behind.
 */
describe('safeFormatMinor', () => {
  it('formats a good amount exactly as the throwing one does', () => {
    // Total does not mean lenient: nothing about a renderable value changes.
    expect(safeFormatMinor(1990, 'GBP', GB)).toBe(formatMinor(1990, 'GBP', GB));
    expect(safeFormatMinor(-50, 'GBP', GB)).toBe(formatMinor(-50, 'GBP', GB));
    expect(safeFormatMinor(0, 'GBP', GB)).toBe(formatMinor(0, 'GBP', GB));
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a float', 19.99],
    ['a numeric string', '1990'],
    ['beyond the safe integer range', Number.MAX_SAFE_INTEGER + 2],
  ])('downgrades %s to the placeholder while `formatMinor` throws', (_label, amount) => {
    expect(safeFormatMinor(amount, 'GBP', GB)).toBe(UNRENDERABLE);
    expect(() => formatMinor(amount as number, 'GBP', GB)).toThrow(MoneyShapeError);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['four letters', 'GBPX'],
    ['digits', '826'],
  ])('downgrades a currency of %s, which `Intl` would throw on', (_label, currency) => {
    /*
     * THE HALF A NUMERIC GUARD ALONE WOULD MISS. The amount here is perfect.
     * `currencyDigits` swallows a code `Intl` refuses and answers 2, so the
     * failure surfaces one line later, out of the `style: 'currency'` formatter,
     * as a `RangeError` rather than a `MoneyShapeError` — a different exception
     * from a different constructor, and the same dead screen.
     */
    expect(safeFormatMinor(1990, currency, GB)).toBe(UNRENDERABLE);
    expect(() => formatMinor(1990, currency as string, GB)).toThrow();
  });

  it('accepts a lower-case code, because a payload is not a style guide', () => {
    expect(safeFormatMinor(1990, 'gbp', GB)).toBe(formatMinor(1990, 'gbp', GB));
  });
});

describe('parseMajor', () => {
  it('reads zero', () => {
    expect(parseMajor('0', 'GBP')).toEqual({ ok: true, minor: 0 });
    expect(parseMajor('0.00', 'GBP')).toEqual({ ok: true, minor: 0 });
  });

  it('reads a trailing zero and a missing one to the same number', () => {
    expect(parseMajor('19.90', 'GBP')).toEqual({ ok: true, minor: 1990 });
    expect(parseMajor('19.9', 'GBP')).toEqual({ ok: true, minor: 1990 });
  });

  it('reads an amount with no whole part', () => {
    expect(parseMajor('.5', 'GBP')).toEqual({ ok: true, minor: 50 });
    expect(parseMajor('0.05', 'GBP')).toEqual({ ok: true, minor: 5 });
  });

  it('strips what a spreadsheet pastes', () => {
    expect(parseMajor('1,234.56', 'GBP')).toEqual({ ok: true, minor: 123456 });
    expect(parseMajor(' 19.99 ', 'GBP')).toEqual({ ok: true, minor: 1999 });
  });

  it('refuses more places than the currency has, rather than rounding', () => {
    expect(parseMajor('19.999', 'GBP')).toEqual({ ok: false, reason: 'precision' });
    expect(parseMajor('19.5', 'JPY')).toEqual({ ok: false, reason: 'precision' });
  });

  it('reads a zero-exponent currency as whole units', () => {
    expect(parseMajor('1999', 'JPY')).toEqual({ ok: true, minor: 1999 });
  });

  it('names each way of not being an amount', () => {
    expect(parseMajor('', 'GBP')).toEqual({ ok: false, reason: 'empty' });
    expect(parseMajor('   ', 'GBP')).toEqual({ ok: false, reason: 'empty' });
    expect(parseMajor('.', 'GBP')).toEqual({ ok: false, reason: 'shape' });
    expect(parseMajor('abc', 'GBP')).toEqual({ ok: false, reason: 'shape' });
    expect(parseMajor('1.2.3', 'GBP')).toEqual({ ok: false, reason: 'shape' });
    expect(parseMajor('-1.00', 'GBP')).toEqual({ ok: false, reason: 'negative' });
  });

  it('refuses an amount past the point arithmetic stops being exact', () => {
    expect(parseMajor('99999999999999999', 'GBP')).toEqual({ ok: false, reason: 'range' });
  });

  /**
   * The round trip, which is what the price boxes actually do: a stored amount
   * is rendered into the input, edited or not, and parsed back. Any drift here
   * is a price that changes by being looked at.
   */
  it('round-trips every awkward amount through the display and back', () => {
    for (const amount of [0, 1, 5, 10, 99, 100, 1900, 1990, 1999, 100000, 123456789]) {
      const digits = formatMinor(amount, 'GBP', GB).replace(/[^\d.]/g, '');
      expect(parseMajor(digits, 'GBP')).toEqual({ ok: true, minor: amount });
    }
  });
});

describe('parseRefund', () => {
  it('accepts an amount inside what is left', () => {
    expect(parseRefund('5.00', 'GBP', 1999)).toEqual({ ok: true, minor: 500 });
  });

  it('accepts exactly what is left', () => {
    expect(parseRefund('19.99', 'GBP', 1999)).toEqual({ ok: true, minor: 1999 });
  });

  it('REFUSES A REFUND LARGER THAN WHAT IS LEFT, by one minor unit', () => {
    expect(parseRefund('20.00', 'GBP', 1999)).toEqual({ ok: false, reason: 'exceeds' });
    // One penny over. The case a `>=`/`>` slip produces and a demo never finds.
    expect(parseRefund('19.999', 'GBP', 1999)).toEqual({ ok: false, reason: 'precision' });
    expect(parseRefund('20', 'GBP', 1999)).toEqual({ ok: false, reason: 'exceeds' });
  });

  it('refuses a refund of nothing, which the route also refuses', () => {
    expect(parseRefund('0', 'GBP', 1999)).toEqual({ ok: false, reason: 'zero' });
    expect(parseRefund('0.00', 'GBP', 1999)).toEqual({ ok: false, reason: 'zero' });
  });

  it('refuses everything when there is nothing left', () => {
    expect(parseRefund('0.01', 'GBP', 0)).toEqual({ ok: false, reason: 'exceeds' });
  });
});

describe('moneyRefusalMessage', () => {
  it('quotes the real bound rather than saying "too much"', () => {
    expect(moneyRefusalMessage('exceeds', 'GBP', 1999)).toContain('£19.99');
  });

  it('names the currency’s real number of places', () => {
    expect(moneyRefusalMessage('precision', 'GBP')).toContain('2 decimal places');
    expect(moneyRefusalMessage('precision', 'JPY')).toContain('no decimal places');
  });
});

// ============================================================================
// ROUTES
// ============================================================================

function reply(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Every wrapper key any shop route answers with, so one body satisfies them all. */
const ANY_BODY = {
  ok: true,
  items: [],
  nextCursor: null,
  product: { id: 'p_1', revision: 2 },
  variant: { id: 'v_1' },
  price: { amount: 1999, currency: 'GBP' },
  inventory: { variantId: 'v_1', onHand: 3, reserved: 0, available: 3 },
  order: { id: 'o_1' },
  fulfillment: { id: 'f_1' },
  refund: { id: 'rf_1' },
};

/** The last request's `[url, init]`. */
function lastCall(): [string, RequestInit] {
  return fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(String(lastCall()[1].body)) as Record<string, unknown>;
}

beforeEach(() => {
  // A FRESH `Response` PER CALL: a body can be read once, and handing the same
  // instance to two requests makes the second reject inside `res.text()` with
  // an error that has nothing to do with the case under test.
  fetchMock = vi.fn(() => Promise.resolve(reply(200, ANY_BODY)));
  vi.stubGlobal('fetch', fetchMock);
});

describe('paths and methods', () => {
  it('reads the one aggregate the overview draws', async () => {
    await shopApi.stats();
    expect(lastCall()[0]).toBe('/api/shop/admin/stats');
    expect(lastCall()[1].method).toBe('GET');
  });

  it('sends the session cookie on every request', async () => {
    await shopApi.stats();
    // Without this the browser sends nothing, every route answers 401, and the
    // app looks logged out while the `__Host-` cookie sits in the jar.
    expect(lastCall()[1].credentials).toBe('include');
  });

  it('omits an empty filter rather than sending a blank one', async () => {
    await shopApi.listProducts({ status: 'draft', category: '', limit: 100 });
    expect(lastCall()[0]).toBe('/api/shop/admin/products?status=draft&limit=100');
  });

  it('puts the price, because the route is a PUT', async () => {
    await shopApi.setVariantPrice('v_1', 1999, 'gbp');
    expect(lastCall()[0]).toBe('/api/shop/admin/variants/v_1/price');
    expect(lastCall()[1].method).toBe('PUT');
    // Minor units and an uppercase ISO-4217 code. `str().regex(/^[A-Z]{3}$/)`
    // on the route answers 400 for "gbp", and `money()` throws for it — which
    // used to be a 500, i.e. a permanent failure the client would retry.
    expect(sentBody()).toEqual({ amount: 1999, currency: 'GBP' });
  });

  it('refuses to put a float on the wire at all', async () => {
    await expect(shopApi.setVariantPrice('v_1', 19.99, 'GBP')).rejects.toThrow(MoneyShapeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('carries the CAS token on a product save', async () => {
    await shopApi.saveProduct('p_1', { title: 'Mug' }, { baseRevision: 7 });
    expect(lastCall()[1].method).toBe('PATCH');
    expect(sentBody()).toEqual({ patch: { title: 'Mug' }, baseRevision: 7, note: undefined });
  });

  it('sends no baseRevision on a lifecycle transition', async () => {
    await shopApi.transitionProduct('p_1', 'publish');
    expect(lastCall()[0]).toBe('/api/shop/admin/products/p_1/publish');
    expect(lastCall()[1].method).toBe('POST');
    // The transitions re-read, re-derive and re-CAS server-side. A client
    // `baseRevision` here would make a concurrent ordinary save refuse a
    // publish, which is exactly what the server's retry exists to avoid.
    expect(lastCall()[1].body).toBeUndefined();
  });

  it('escapes an id that would otherwise change the path', async () => {
    await shopApi.getProduct('p/../../admin');
    expect(lastCall()[0]).toBe('/api/shop/admin/products/p%2F..%2F..%2Fadmin');
  });

  it('sends the caller’s idempotency key on a refund, unchanged', async () => {
    await shopApi.refundPayment('pi_1', { amount: 500, idempotencyKey: 'refund-o_1-5.00-abc' });
    expect(lastCall()[0]).toBe('/api/shop/admin/payments/intents/pi_1/refunds');
    // Minted per typed amount by the caller and NOT here: a key generated
    // inside this function would be a new key on every retry, which is the
    // double-refund mechanism switched off while looking like it is on.
    expect(sentBody()).toEqual({ amount: 500, idempotencyKey: 'refund-o_1-5.00-abc' });
  });

  it('refuses a float refund before it can reach the provider', async () => {
    await expect(
      shopApi.refundPayment('pi_1', { amount: 5.5, idempotencyKey: 'k'.repeat(8) }),
    ).rejects.toThrow(MoneyShapeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('searches orders on the one parameter the route accepts', async () => {
    await shopApi.listOrders({ status: 'paid', search: 'a@b.c' });
    expect(lastCall()[0]).toBe('/api/shop/admin/orders?status=paid&search=a%40b.c');
  });

  it('pages the buyer list by keyset', async () => {
    await shopApi.listCustomers({ cursor: 'c_9', limit: 50 });
    expect(lastCall()[0]).toBe('/api/shop/admin/customers?cursor=c_9&limit=50');
  });
});

describe('categories', () => {
  it('reads the admin list from `items`, which includes drafts', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(reply(200, { items: [{ name: 'Mugs', count: 3 }] })),
    );
    expect(await shopApi.listCategories()).toEqual([{ name: 'Mugs', count: 3 }]);
    // NO QUERY AT ALL. The route's schema is an empty `.strict()` object, so a
    // stray `?limit=` would be a 400 rather than a page of a list that does not
    // paginate.
    expect(lastCall()[0]).toBe('/api/shop/admin/categories');
  });
});

describe('inventory', () => {
  it('spells belowOnly as the two literals the route accepts', async () => {
    await shopApi.listInventory({ belowOnly: true, threshold: 2 });
    expect(lastCall()[0]).toBe('/api/shop/admin/inventory?belowOnly=1&threshold=2');
  });

  it('sends 0 rather than "false" when the filter is off', async () => {
    // `?belowOnly=false` is a string, and every truthiness test in JavaScript
    // says it is true — a filter that reads as applied, is not, and reports
    // nothing. The route's `z.enum(['0','1'])` is what makes that a 400.
    await shopApi.listInventory({ belowOnly: false });
    expect(lastCall()[0]).toBe('/api/shop/admin/inventory?belowOnly=0');
  });

  it('omits it entirely when it was never asked for', async () => {
    await shopApi.listInventory();
    expect(lastCall()[0]).toBe('/api/shop/admin/inventory');
  });
});
