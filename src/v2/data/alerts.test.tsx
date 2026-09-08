import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The bell's read state, pinned on its one rule (the debt ledger's alerts
 * item): each alert is a standing FACT whose id names the fact and whose
 * `signature` encodes its current magnitude, and "read" is stored per
 * signature — so a read alert whose signature changes counts as unread
 * again. Three MORE stuck emails is news even if two were yesterday; store
 * "read" against the id alone and the bell goes quiet forever after the
 * first glance, which for the stuck-email alert means nobody is ever told
 * the pile grew.
 *
 * PLUS THE SCOPED-ROLE RULE (2026-08-31): stats sit in the analytics domain,
 * which a content writer does not hold, so `/shop/admin/stats` answers their
 * bell with a 403 BY DESIGN. `fetchAlerts` must swallow exactly that refusal
 * into an empty list — a writer's bell is quiet, not broken — while every
 * other failure still throws so a real outage keeps looking like one. The
 * second describe below stubs `fetch` to drive that path; the read-state
 * tests still never touch the network.
 *
 * PLUS THE PER-ORDER RULE (2026-09-08): a paid order gets a row of its own,
 * built out of `stats.latestOrders` — a field that had been in this payload
 * since the dashboard strip and was read by nothing. Its signature is the
 * OPPOSITE of every aggregate's: STABLE, because one order is one fact that
 * never grows, so dismissing it has to dismiss it for good. The third describe
 * below pins that, and pins the arithmetic that stops the same order being
 * counted twice — five named rows above "9 paid orders" reads as fourteen.
 *
 * NAMED `.test.tsx` DELIBERATELY, though it contains no JSX: `alerts.ts`
 * reads `window.localStorage`, so this file needs the `ui` project's jsdom
 * (the `client` node project has no `window`, under which every alert would
 * read as unread and the assertion below that marking works would fail).
 */

import { fetchAlerts, isOrderAlert, isUnread, markRead, type OpsAlert } from './alerts';

/** The stuck-email fact at a given magnitude — same id, moving signature. */
const stuckEmails = (signature: string): OpsAlert => ({
  id: 'emails-stuck',
  source: 'Emails',
  title: `${signature} emails will never send`,
  body: 'Out of retry attempts — nothing resends these without you.',
  at: 1_756_000_000_000,
  to: '/emails',
  tone: 'critical',
  signature,
});

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const STATS = '/api/shop/admin/stats';

/**
 * One row of `stats.latestOrders`.
 *
 * SPELLED OUT RATHER THAN IMPORTED FROM A FIXTURE MODULE, because the whole
 * point of stubbing `fetch` instead of the api module is that this is the
 * SERVER'S shape crossing the wire: a field renamed on the other side has to
 * show up here as a broken assertion, and a shared fixture typed against the
 * client's own interface would rename itself along with it.
 */
const order = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1',
  orderNumber: '2026-000123-A',
  email: 'buyer@example.com',
  status: 'paid',
  currency: 'NGN',
  // ₦12,500.00 — minor units at 100 per naira.
  grandTotal: 1_250_000,
  placedAt: 1_756_000_000_000,
  ...over,
});

/** A stats payload with everything the bell reads, so a default that is
 *  missing rather than empty cannot pass unnoticed. */
const statsBody = (over: Record<string, unknown> = {}) => ({
  generatedAt: 1_756_000_100_000,
  ordersByStatus: [],
  revenue: [],
  lowStockThreshold: 3,
  lowStock: [],
  lowStockMore: false,
  emails: { pending: 0, stuck: 0, sent: 0 },
  latestOrders: [],
  ...over,
});

/** Answer every route with one JSON verdict — the 403 tests need no routing
 *  table, because the refusal under test is the same for both endpoints. */
function stubAnswers(answer: (pathname: string) => { status: number; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'https://studio.test');
      const { status, body } = answer(url.pathname);
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

// ============================================================================

describe('the bell’s read state', () => {
  it('an alert whose signature changes reads as unread again', () => {
    const three = stuckEmails('3');
    // Never seen: unread.
    expect(isUnread(three)).toBe(true);

    // Seen at this magnitude: settled.
    markRead(three);
    expect(isUnread(three)).toBe(false);

    // Same fact, new magnitude: news again — the signature is what was read,
    // not the id.
    const six = stuckEmails('6');
    expect(isUnread(six)).toBe(true);

    // And acknowledging the new magnitude settles it at that level.
    markRead(six);
    expect(isUnread(six)).toBe(false);
  });
});

describe('a scoped role’s bell', () => {
  it('swallows the stats 403 into an empty list — quiet, not broken', async () => {
    /* A content writer: no analytics domain, so stats refuses — and their
       role holds no marketing either, so reviews refuses too. Both refusals
       together must resolve to [], never reject. */
    stubAnswers(() => ({
      status: 403,
      body: { error: 'forbidden', requestId: 'req_test' },
    }));

    await expect(fetchAlerts()).resolves.toEqual([]);
  });

  it('still lets the reviews alert ride when only stats is refused', async () => {
    /* A role that may moderate but not read analytics: the stats-fed alerts
       simply do not exist for them, while the reviews fact still shows. */
    stubAnswers((pathname) =>
      pathname === '/api/shop/reviews'
        ? {
            status: 200,
            body: {
              items: [{ id: 'rev_1', createdAt: 1_756_000_000_000 }],
              nextCursor: null,
            },
          }
        : { status: 403, body: { error: 'forbidden', requestId: 'req_test' } },
    );

    const alerts = await fetchAlerts();
    expect(alerts.map((a) => a.id)).toEqual(['reviews-pending']);
    expect(alerts[0]!.title).toBe('1 review awaiting moderation');
  });

  it('a real outage still throws — only the 403 is the system working', async () => {
    stubAnswers(() => ({ status: 500, body: { error: 'internal', requestId: 'req_test' } }));
    await expect(fetchAlerts()).rejects.toThrow();
  });
});

describe('a paid order in the bell', () => {
  /** Stats as given, no reviews — the reviews alert is not what is under test
   *  and an empty page keeps it out of every `map` below. */
  function withStats(stats: Record<string, unknown>) {
    stubAnswers((pathname) =>
      pathname === STATS
        ? { status: 200, body: stats }
        : { status: 200, body: { items: [], nextCursor: null } },
    );
  }

  it('names the order, its total and the customer, and points at that order', async () => {
    withStats(
      statsBody({
        latestOrders: [order(), order({ id: 'ord_2', status: 'pending' })],
        ordersByStatus: [{ status: 'paid', currency: 'NGN', count: 1, total: 1_250_000 }],
      }),
    );

    const alerts = await fetchAlerts();
    // The pending order is not an alert: nobody owes anything on an order
    // whose money has not landed.
    expect(alerts.map((a) => a.id)).toEqual(['order-ord_1']);

    const row = alerts[0]!;
    expect(row.source).toBe('Orders');
    // Minor units at 100 per naira, through the app's own formatter.
    expect(row.title).toBe('Order 2026-000123-A — ₦12,500.00');
    expect(row.body).toBe('buyer@example.com paid. Nothing sent out yet.');
    // The bell has to land on THE order, not on the list.
    expect(row.to).toBe('/orders/ord_1');
    // When it was placed, not when the stats were taken.
    expect(row.at).toBe(1_756_000_000_000);
    expect(isOrderAlert(row)).toBe(true);
  });

  it('the aggregate counts only the orders the rows did not name', async () => {
    withStats(
      statsBody({
        latestOrders: [order(), order({ id: 'ord_2', orderNumber: '2026-000124-B' })],
        ordersByStatus: [{ status: 'paid', currency: 'NGN', count: 9, total: 9_000_000 }],
      }),
    );

    const alerts = await fetchAlerts();
    expect(alerts.map((a) => a.id)).toEqual(['order-ord_1', 'order-ord_2', 'orders-paid']);
    // Nine paid, two named above: seven left, and the word that makes the
    // arithmetic legible rather than "9" sitting under two rows.
    const aggregate = alerts.find((a) => a.id === 'orders-paid')!;
    expect(aggregate.title).toBe('7 more paid orders to send out');
    expect(aggregate.signature).toBe('7');
  });

  it('drops the aggregate entirely once every paid order is named', async () => {
    withStats(
      statsBody({
        latestOrders: [order()],
        ordersByStatus: [{ status: 'paid', currency: 'NGN', count: 1, total: 1_250_000 }],
      }),
    );
    expect((await fetchAlerts()).map((a) => a.id)).toEqual(['order-ord_1']);
  });

  it('says it plainly when the newest five hold no paid order at all', async () => {
    /* A busy shop: every one of the five newest has already been sent out, so
       nothing is named and the pile is all the bell has to report. */
    withStats(
      statsBody({
        latestOrders: [order({ status: 'fulfilled' })],
        ordersByStatus: [{ status: 'paid', currency: 'NGN', count: 9, total: 9_000_000 }],
      }),
    );

    const alerts = await fetchAlerts();
    expect(alerts.map((a) => a.id)).toEqual(['orders-paid']);
    // "9 MORE" would be a lie with nothing above it to be more than.
    expect(alerts[0]!.title).toBe('9 paid orders to send out');
  });

  it('a dismissed order stays dismissed, while the aggregate rings again as the pile grows', async () => {
    // Five paid, one of them named: the aggregate stands at four.
    withStats(
      statsBody({
        latestOrders: [order()],
        ordersByStatus: [{ status: 'paid', currency: 'NGN', count: 5, total: 6_250_000 }],
      }),
    );

    const first = await fetchAlerts();
    for (const alert of first) markRead(alert);
    expect(first.every((a) => !isUnread(a))).toBe(true);

    /* Three more orders arrive, one of them inside the newest five. Eight
       paid, two named: the aggregate stands at six. */
    withStats(
      statsBody({
        latestOrders: [order({ id: 'ord_2', orderNumber: '2026-000124-B' }), order()],
        ordersByStatus: [{ status: 'paid', currency: 'NGN', count: 8, total: 10_000_000 }],
      }),
    );

    const second = await fetchAlerts();
    /* THE TWO RULES IN ONE ASSERTION. The new order rings. The pile rings,
       because its signature is a count and the count moved from 4 to 6. The
       order that was already dismissed does NOT — which is what a count-shaped
       signature on a per-order alert would break, re-ringing every order
       already dealt with every time any other order arrived. */
    expect(second.filter(isUnread).map((a) => a.id)).toEqual(['order-ord_2', 'orders-paid']);
    const older = second.find((a) => a.id === 'order-ord_1');
    expect(older).toBeDefined();
    expect(isUnread(older!)).toBe(false);
  });

  it('one unrenderable total costs its own price, not the whole bell', async () => {
    /* `shopFetch<T>` is an unchecked assertion, so a total the server got
       wrong arrives typed as a number and is not one. `formatMinor` throws
       `MoneyShapeError` on it; the SAFE formatter is what keeps that from
       becoming the shell's error boundary with no alerts on screen at all. */
    withStats(
      statsBody({
        latestOrders: [order({ grandTotal: 12.5 })],
        ordersByStatus: [{ status: 'paid', currency: 'NGN', count: 1, total: 0 }],
      }),
    );

    const alerts = await fetchAlerts();
    expect(alerts.map((a) => a.id)).toEqual(['order-ord_1']);
    expect(alerts[0]!.title).toBe('Order 2026-000123-A — ––');
  });
});
