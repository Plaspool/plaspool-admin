import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';

/**
 * The four shop screens, asserted on what a screenshot cannot show.
 *
 * FOUR CLASSES OF DEFECT ARE WHAT THIS FILE IS FOR:
 *
 *  - **Money rendered from the wrong units.** Every amount arrives as an
 *    integer of minor units. A screen that prints `1990` — or `£19.9`, or
 *    `£1,990.00` — is wrong in a way that reads as a design choice until a
 *    customer complains, so the assertions below go through the same
 *    `formatMinor` the screens do and would fail on any of the three.
 *  - **State that is not in the URL.** Filters, tabs, the open record and the
 *    page cursor all live in `?…`, which is the whole reason back-from-a-detail
 *    returns to the list somebody had. A `useState` version of any of them
 *    passes every visual check and fails the moment anyone navigates.
 *  - **Owner-only controls rendered to writers.** `cancel` and `refunds` are
 *    `requireOwner()`, so drawing them for a writer is a confirm dialog in front
 *    of a 403 — the same defect the dashboard's Empty-trash button had.
 *  - **A screen implying something the deployment does not do.** `payment: null`
 *    is what every order answers while `registerOrdersDeps` has no production
 *    caller, and a blank panel there reads as "not paid".
 *
 * `fetch` IS MOCKED, NOT `../data/api-shop`. The path a request goes to, the
 * method it uses and the query it carries are three of the things most likely
 * to be silently wrong, and a mocked module asserts none of them. An
 * unregistered path answers 404 in the shape the real error envelope has, which
 * is also how the screens' "this deployment has no such route yet" arms get
 * exercised.
 */

const fixture = vi.hoisted(() => ({
  session: {
    status: 'authed',
    user: {
      id: 'u_owner',
      email: 'o@test.local',
      displayName: 'An Owner',
      role: 'owner' as 'owner' | 'writer',
    },
  },
}));

vi.mock('../data/session', () => ({
  getSession: () => fixture.session,
  subscribe: () => () => {},
  initSession: vi.fn(),
  logout: vi.fn(),
}));

// `RequireAuth` pulls this in for `AppShell`'s revalidation, which no screen
// under test mounts. Mocked so the suite does not drag the whole sync layer in.
vi.mock('../data/sync', () => ({ revalidate: vi.fn() }));

import { ToastProvider } from '../components/Toast';
import { formatMinor } from '../data/api-shop';
import { UNRENDERABLE } from '../data/when';
import Shop from './Shop';
import ShopProducts from './ShopProducts';
import ShopOrders from './ShopOrders';
import ShopCustomers from './ShopCustomers';
import ShopAudit from './ShopAudit';

// --------------------------------------------------------------- the server

type Responder = (url: URL, init: RequestInit) => { status?: number; body: unknown };

/**
 * What jsdom does not implement and Radix's Select needs the moment its popup
 * opens — the same block `Emails.test.tsx:55` and `Dashboard.test.tsx:122` use.
 *
 * ADDED WHEN THE ORDERS STATUS FILTER BECAME A SELECT. This file used to state
 * that it asserted Selects "through the URL and the trigger's own label, NOT by
 * opening the popup", because an unhandled `hasPointerCapture is not a function`
 * from inside a React handler is reported as a whole-file error rather than a
 * failing assertion. That was a workaround for a missing polyfill, not a
 * property worth preserving: the behaviour that matters is that choosing an
 * option writes the URL, and the only honest way to test it is to choose one.
 */
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const handlers = new Map<string, Responder>();
let requests: string[] = [];

/** Register a route. Anything not registered answers 404 `gone`, like the app. */
function when(pathname: string, body: unknown | Responder, status = 200): void {
  handlers.set(
    pathname,
    typeof body === 'function' ? (body as Responder) : () => ({ status, body }),
  );
}

/** Every path+query asked for, in order. The query is the assertion target. */
function asked(fragment: string): string | undefined {
  return requests.find((r) => r.includes(fragment));
}

beforeEach(() => {
  handlers.clear();
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const url = new URL(String(input), 'https://studio.test');
      requests.push(url.pathname + url.search);
      const handler = handlers.get(url.pathname);
      const answer = handler
        ? handler(url, init)
        : { status: 404, body: { error: 'gone', requestId: 'req_test' } };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  fixture.session.user.role = 'owner';
});

/** Shows the router's current URL, so a test can assert what a click wrote. */
function Address() {
  const location = useLocation();
  return <output data-testid="address">{location.pathname + location.search}</output>;
}

function mount(element: React.ReactElement, at: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[at]}>
        {element}
        <Address />
      </MemoryRouter>
    </ToastProvider>,
  );
}

const address = () => screen.getByTestId('address').textContent ?? '';

// ------------------------------------------------------------------ fixtures

const ORDER = {
  id: 'o_1',
  orderNumber: 'PS-4821-K',
  customerId: null,
  email: 'buyer@test.local',
  currency: 'GBP',
  subtotal: 1990,
  shippingTotal: 350,
  taxTotal: 0,
  grandTotal: 2340,
  refundedTotal: 0,
  status: 'paid',
  shippingAddress: { name: 'A Buyer', line1: '1 Test Street', city: 'Leeds' },
  billingAddress: {},
  placedAt: 1_786_600_000_000,
  paidAt: 1_786_600_000_000,
  fulfilledAt: null,
  cancelledAt: null,
  revision: 1,
  checkoutId: 'c_1',
  paymentIntentId: 'pi_1',
};

/**
 * `server/shop/admin/stats.ts`'s real shape, including the two things a
 * dashboard would assume wrongly: the totals are GROUPED BY CURRENCY (two
 * ISO-4217 codes cannot be added) and a status with no orders has NO ROW.
 */
const STATS = {
  generatedAt: 1_786_600_000_000,
  ordersByStatus: [
    { status: 'pending', currency: 'GBP', count: 2, total: 4000 },
    { status: 'paid', currency: 'GBP', count: 5, total: 25050 },
  ],
  revenue: [
    {
      currency: 'GBP',
      last24h: { sales: 1990, discounts: 0, delivery: 0, tax: 0, charged: 1990, refunded: 0, net: 1990 },
      last7d: {
        sales: 418250,
        discounts: 0,
        delivery: 0,
        tax: 0,
        charged: 418250,
        refunded: 0,
        net: 418250,
      },
      last30d: {
        sales: 900000,
        discounts: 0,
        delivery: 0,
        tax: 0,
        charged: 900000,
        refunded: 0,
        net: 900000,
      },
    },
  ],
  lowStockThreshold: 5,
  lowStock: [
    {
      variantId: 'v_1',
      sku: 'MUG-BLUE',
      optionValues: { Colour: 'Blue' },
      variantStatus: 'active',
      productId: 'p_1',
      productTitle: 'Enamel mug',
      productStatus: 'active',
      onHand: 2,
      reserved: 0,
      available: 2,
      backorderable: false,
      updatedAt: 1_786_600_000_000,
    },
  ],
  lowStockMore: false,
  emails: { pending: 3, stuck: 0, sent: 12 },
  latestOrders: [
    {
      id: 'o_1',
      orderNumber: 'PS-4821-K',
      email: 'buyer@test.local',
      status: 'paid',
      currency: 'GBP',
      grandTotal: 2340,
      placedAt: 1_786_600_000_000,
    },
  ],
};

const PRODUCT = {
  id: 'p_1',
  slug: 'enamel-mug',
  title: 'Enamel mug',
  description: { type: 'doc', content: [{ type: 'paragraph' }] },
  status: 'draft',
  category: 'Kitchenware',
  tags: ['enamel'],
  coverImageId: null,
  imageIds: [],
  createdAt: 1_786_000_000_000,
  updatedAt: 1_786_600_000_000,
  publishedAt: null,
  deletedAt: null,
  authorId: 'u_owner',
  revision: 4,
};

const VARIANT = {
  id: 'v_1',
  productId: 'p_1',
  sku: 'MUG-BLUE',
  optionValues: { Colour: 'Blue' },
  position: 0,
  weightGrams: null,
  status: 'active',
  createdAt: 1_786_000_000_000,
  updatedAt: 1_786_000_000_000,
  // £19.90 — the amount whose trailing zero a naive implementation loses.
  price: { amount: 1990, currency: 'GBP' },
  available: 2,
  backorderable: false,
  imageId: null as string | null,
  colorHex: null as string | null,
};

const ORDER_LINES = [
  {
    id: 'ol_1',
    lineNo: 1,
    variantId: 'v_1',
    sku: 'MUG-BLUE',
    title: 'Enamel mug',
    optionValues: { Colour: 'Blue' },
    qty: 1,
    unitAmount: 1990,
    lineTotal: 1990,
    fulfilledQty: 0,
  },
];

/**
 * ONE ROW OF `GET /shop/admin/orders`, AND IT IS THE WRAPPER THE SERVER SENDS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS CONSTANT IS THE WHOLE POINT. Until it existed the list was mocked as
 * `{ items: [ORDER] }` — a FLAT order — while `listOrders` in
 * `server/shop/orders/repo/orders.ts` has always returned
 * `{ items: [{ order, lines }] }`. Eleven tests in this file passed against
 * that fixture while the real screen threw `RangeError: Invalid time value` on
 * every load in production, because every field it read was `undefined`.
 *
 * The fixture, not the code, was the defect that hid the defect. So the list
 * row is now DERIVED from the same `order` and `lines` the detail uses, and
 * `ORDER_DETAIL` is spread from it — one object, and the two endpoints cannot
 * drift apart in this file again. `orders-live.json` (captured from the
 * deployed API) is asserted against this shape in `ShopOrders.test.tsx`, so a
 * server that changes shape breaks a test rather than a screen.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const ORDER_ROW = { order: ORDER, lines: ORDER_LINES };

const ORDER_DETAIL = {
  ...ORDER_ROW,
  fulfillments: [],
  timeline: [
    { id: 't_1', type: 'order.placed', message: 'Order placed', occurredAt: 1_786_600_000_000, actorId: null },
  ],
  emails: [
    {
      id: 'em_1',
      orderId: 'o_1',
      kind: 'order_confirmation',
      to: 'buyer@test.local',
      subject: 'Your order PS-4821-K',
      body: '…',
      createdAt: 1_786_600_000_000,
      sentAt: null,
      attempts: 3,
      lastError: 'connect ETIMEDOUT',
    },
  ],
  payment: null as unknown,
};

// ============================================================================
// OVERVIEW
// ============================================================================

describe('the overview', () => {
  it('renders every amount in major units from the minor ones on the wire', async () => {
    when('/api/shop/admin/stats', STATS);
    mount(<Shop />, '/shop');

    // 1990 minor units. NOT "1990", and not "£19.9".
    await waitFor(() => expect(screen.getByText(formatMinor(1990, 'GBP'))).toBeTruthy());
    expect(screen.getByText(new RegExp(escape(formatMinor(418250, 'GBP'))))).toBeTruthy();
    expect(screen.getByText(formatMinor(25050, 'GBP'))).toBeTruthy();
    // The order row uses the ORDER's currency, not the store's.
    expect(screen.getByText(formatMinor(2340, 'GBP'))).toBeTruthy();
  });

  it('says the unsent email is waiting for a sweep nothing schedules', async () => {
    when('/api/shop/admin/stats', STATS);
    mount(<Shop />, '/shop');

    // The number alone would imply a queue being worked through. It is not:
    // the outbox is drained only by an owner calling the sweep by hand.
    await waitFor(() => expect(screen.getByText(/Nothing schedules one yet/)).toBeTruthy());
  });

  it('calls the revenue window 24 hours, because that is what it is', async () => {
    when('/api/shop/admin/stats', STATS);
    mount(<Shop />, '/shop');

    // The window is measured back from `generatedAt`, so at 9 a.m. it holds
    // most of yesterday. Labelling it "today" would be a different number.
    await waitFor(() => expect(screen.getByText(/Revenue, 24 hours/)).toBeTruthy());
    expect(screen.queryByText(/Revenue today/)).toBeNull();
  });

  it('says when email has run out of attempts, which is worse than waiting', async () => {
    when('/api/shop/admin/stats', {
      ...STATS,
      emails: { pending: 1, stuck: 2, sent: 12 },
    });
    mount(<Shop />, '/shop');

    // `stuck` intents are past the eight-attempt budget: nothing retries them,
    // ever, without somebody resetting the counter by hand. A tile that folded
    // them into "waiting" would be describing a queue that is not moving.
    await waitFor(() => expect(screen.getByText(/2 ran out of attempts/)).toBeTruthy());
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('names the low-stock threshold rather than just counting', async () => {
    when('/api/shop/admin/stats', STATS);
    mount(<Shop />, '/shop');
    await waitFor(() => expect(screen.getByText(/at or below 5 available/)).toBeTruthy());
  });

  it('tells a 404 from a broken shop', async () => {
    // The route is being written by another agent as this screen is written,
    // and "not deployed yet" is a different problem from "the shop is broken".
    mount(<Shop />, '/shop');
    await waitFor(() =>
      expect(screen.getByText(/no shop statistics route yet/)).toBeTruthy(),
    );
  });
});

// ============================================================================
// PRODUCTS
// ============================================================================

describe('the catalogue', () => {
  it('takes its status filter from the URL and sends it to the server', async () => {
    when('/api/shop/admin/products', { items: [PRODUCT], nextCursor: null });
    when('/api/shop/admin/categories', { items: [{ name: 'Kitchenware', count: 1 }] });
    mount(<ShopProducts />, '/shop/products?status=draft');

    await waitFor(() => expect(screen.getByText('Enamel mug')).toBeTruthy());
    expect(asked('/api/shop/admin/products?status=draft')).toBeTruthy();
  });

  /**
   * The category filter is asserted through the URL and the trigger's own
   * label, NOT by opening the popup. Radix Select's pointer handling calls
   * `target.hasPointerCapture`, which jsdom does not implement — a test that
   * clicked it would be asserting a polyfill rather than this screen, and the
   * thing worth pinning is that the option list comes from the ADMIN route
   * (drafts included) rather than the public one.
   */
  it('labels the category filter from the admin list, drafts included', async () => {
    when('/api/shop/admin/products', { items: [PRODUCT], nextCursor: null });
    when('/api/shop/admin/categories', {
      items: [{ name: 'Kitchenware', count: 1 }, { name: 'Prints', count: 0 }],
    });
    mount(<ShopProducts />, '/shop/products?category=Kitchenware');

    await waitFor(() => expect(asked('category=Kitchenware')).toBeTruthy());
    const trigger = screen.getByLabelText('Filter by category');
    // The count comes from the admin route, so a category whose only product
    // is a draft still has a number beside it here.
    await waitFor(() => expect(trigger.textContent).toContain('Kitchenware (1)'));
  });

  it('writes the search box into the URL rather than holding it in state', async () => {
    when('/api/shop/admin/products', {
      items: [PRODUCT, { ...PRODUCT, id: 'p_2', title: 'Linen tea towel', tags: [] }],
      nextCursor: null,
    });
    when('/api/shop/admin/categories', { items: [] });
    mount(<ShopProducts />, '/shop/products');

    await waitFor(() => expect(screen.getByText('Linen tea towel')).toBeTruthy());
    await userEvent.type(screen.getByLabelText('Filter products'), 'linen');

    await waitFor(() => expect(address()).toContain('q=linen'));
    await waitFor(() => expect(screen.queryByText('Enamel mug')).toBeNull());
    expect(screen.getByText('Linen tea towel')).toBeTruthy();
  });

  it('opens one product on ?id= and keeps the filters underneath it', async () => {
    when('/api/shop/admin/products', { items: [PRODUCT], nextCursor: null });
    when('/api/shop/admin/categories', { items: [] });
    when('/api/shop/admin/products/p_1', {
      product: { ...PRODUCT, variants: [VARIANT] },
    });
    mount(<ShopProducts />, '/shop/products?status=draft&id=p_1');

    await waitFor(() =>
      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Enamel mug'),
    );
    // Back to the catalogue keeps `status=draft` and drops only `id`.
    const back = screen.getByRole('link', { name: /Catalogue/ });
    expect(back.getAttribute('href')).toContain('status=draft');
    expect(back.getAttribute('href')).not.toContain('id=');
  });

  it('reads first: the current price and stock are shown, not editable in place', async () => {
    when('/api/shop/admin/products/p_1', {
      product: { ...PRODUCT, variants: [VARIANT] },
    });
    mount(<ShopProducts />, '/shop/products?id=p_1&tab=variants');

    /*
     * LOOKING IS NOT CHANGING. Selecting a variant shows its facts — the price
     * with its trailing zero intact, what is available — and each change is
     * behind its own deliberate button. No input holds a live number.
     */
    const card = (await screen.findByRole('button', { name: 'Adjust price' })).closest(
      '.vdetail',
    )!;
    expect(card.textContent).toContain(formatMinor(1990, 'GBP'));
    expect(card.textContent).toContain('2 available');
    // The History link carries where it was opened from, which is the only way
    // that page can offer a way back to this product.
    const history = screen.getByRole('link', { name: /history/i });
    expect(history.getAttribute('href')).toContain('variant=v_1');
    expect(history.getAttribute('href')).toContain('from=p_1');
    expect(screen.getByRole('button', { name: 'Adjust stock' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add photo/ })).toBeTruthy();
  });

  it('sends a typed price as integer minor units, with its reason', async () => {
    const user = userEvent.setup();
    when('/api/shop/admin/products/p_1', {
      product: { ...PRODUCT, variants: [VARIANT] },
    });
    when('/api/shop/admin/variants/v_1/price', { price: { amount: 2500, currency: 'GBP' } });
    mount(<ShopProducts />, '/shop/products?id=p_1&tab=variants');

    await user.click(await screen.findByRole('button', { name: 'Adjust price' }));
    const price = await screen.findByLabelText('New price (GBP)');
    await user.type(price, '25.00');

    /*
     * THE WHY NO LONGER GATES THE BUTTON. It never gated the WIRE — the route
     * has tolerated its absence since migration 0009, for the price rows written
     * before that column existed — and this screen was the last thing still
     * demanding it. Aligned 2026-09-03 with the owner's instruction that every
     * reason field be optional. What is asserted here is that a reason PICKED
     * still travels, key for key.
     */
    const set = screen.getByRole('button', { name: 'Set price' }) as HTMLButtonElement;
    expect(set.disabled).toBe(false);
    await user.click(
      screen.getByRole('combobox', { name: 'Why did the price change? (optional)' }),
    );
    await user.click(await screen.findByRole('option', { name: 'New supplier invoice' }));
    await user.click(set);

    await waitFor(() => expect(asked('/api/shop/admin/variants/v_1/price')).toBeTruthy());
    const call = (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit][] } })
      .mock.calls;
    const put = call.find((c) => c[1]?.method === 'PUT');
    expect(JSON.parse(String(put![1].body))).toEqual({
      amount: 2500,
      currency: 'GBP',
      reason: 'New supplier invoice',
    });
  });

  it('refuses to enable Set for more decimals than the currency has', async () => {
    const user = userEvent.setup();
    when('/api/shop/admin/products/p_1', {
      product: { ...PRODUCT, variants: [VARIANT] },
    });
    mount(<ShopProducts />, '/shop/products?id=p_1&tab=variants');

    await user.click(await screen.findByRole('button', { name: 'Adjust price' }));
    await user.type(await screen.findByLabelText('New price (GBP)'), '19.999');
    await user.click(
      screen.getByRole('combobox', { name: 'Why did the price change? (optional)' }),
    );
    await user.click(await screen.findByRole('option', { name: 'New supplier invoice' }));

    await waitFor(() => expect(screen.getByText(/2 decimal places/)).toBeTruthy());
    expect(
      (screen.getByRole('button', { name: 'Set price' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  /*
   * WAS 'will not adjust stock without a reason, …'. Reasons went optional on
   * the owner's instruction, 2026-09-03, so the button is live on the number
   * alone. The DOM-ORDER half of this test is untouched and is the half worth
   * keeping.
   */
  it('adjusts stock on the number alone, and the question is ABOVE its picker', async () => {
    const user = userEvent.setup();
    when('/api/shop/admin/products/p_1', {
      product: { ...PRODUCT, variants: [VARIANT] },
    });
    mount(<ShopProducts />, '/shop/products?id=p_1&tab=variants');

    await user.click(await screen.findByRole('button', { name: 'Adjust stock' }));
    await user.type(await screen.findByLabelText('Change by'), '10');
    const adjust = screen.getByRole('button', { name: 'Adjust stock' }) as HTMLButtonElement;
    // A number is now the whole gate — no reason has been picked yet.
    await waitFor(() => expect(adjust.disabled).toBe(false));

    /*
     * THE QUESTION IS A VISIBLE LABEL RENDERED BEFORE THE CONTROL — a bare
     * dropdown reading "Why…" beside a number box was the one field on the
     * old panel whose meaning you could only learn by opening it. DOM order is
     * asserted, not just presence: a label after the dropdown fails this.
     */
    const picker = screen.getByRole('combobox', {
      name: 'Why did the stock change? (optional)',
    });
    const label = screen.getByText('Why did the stock change? (optional)', {
      selector: 'span.label',
    });
    expect(
      label.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    /*
     * A PICKER, and that is why it survived the field becoming optional: a free
     * text box collects "fix" and "x", which tells the next reader nothing. Six
     * presets plus "Something else" means the common answer is one click and the
     * audit trail is still readable a year later — which is worth more when
     * nothing forces an answer at all.
     */
    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: 'Stocktake recount' }));
    await waitFor(() => expect(adjust.disabled).toBe(false));

    /*
     * THE ARITHMETIC IS PREVIEWED BEFORE IT HAPPENS, and the number it will
     * BECOME is the emphasised one — "what will it be" is the question in
     * front of somebody whose finger is over the button. Stock arriving is
     * the good tone; the class is asserted because the colour is the emphasis
     * and a preview that leads with the old value defeats the point.
     */
    const preview = document.querySelector('.vpreview')!;
    expect(preview.textContent).toContain('2 available');
    expect(preview.querySelector('.vpreview__now--good')?.textContent).toBe('12');
  });

  it('steps both numbers a unit at a time, and stops the minus at the floor', async () => {
    const user = userEvent.setup();
    when('/api/shop/admin/products/p_1', {
      product: { ...PRODUCT, variants: [VARIANT] },
    });
    mount(<ShopProducts />, '/shop/products?id=p_1&tab=variants');

    // Stock: two available, so minus stops after two presses.
    await user.click(await screen.findByRole('button', { name: 'Adjust stock' }));
    const delta = (await screen.findByLabelText('Change by')) as HTMLInputElement;
    await user.click(screen.getByRole('button', { name: 'Increase stock change' }));
    await user.click(screen.getByRole('button', { name: 'Increase stock change' }));
    expect(delta.value).toBe('+2');
    const down = screen.getByRole('button', { name: 'Decrease stock change' });
    for (let i = 0; i < 4; i += 1) await user.click(down);
    // −2 is the floor: it empties the shelf and cannot go past it.
    expect(delta.value).toBe('-2');
    await waitFor(() => expect((down as HTMLButtonElement).disabled).toBe(true));

    // Price: one MAJOR unit a step, from the price it already has (£19.90),
    // and the arithmetic is exact rather than a float's best effort.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Adjust price' }));
    const price = (await screen.findByLabelText('New price (GBP)')) as HTMLInputElement;
    await user.click(screen.getByRole('button', { name: 'Increase price' }));
    expect(price.value).toBe('20.90');
    await user.click(screen.getByRole('button', { name: 'Decrease price' }));
    await user.click(screen.getByRole('button', { name: 'Decrease price' }));
    expect(price.value).toBe('18.90');

    // …and the same before → after emphasis, coloured the way the history
    // page colours a price fall.
    const preview = document.querySelector('.vpreview')!;
    expect(preview.textContent).toContain(formatMinor(1990, 'GBP'));
    expect(preview.querySelector('.vpreview__now--good')?.textContent).toBe(
      formatMinor(1890, 'GBP'),
    );
    expect(preview.textContent).toContain('Decrease');
  });

  it('refuses to promise a negative count the server is built to bounce', async () => {
    const user = userEvent.setup();
    when('/api/shop/admin/products/p_1', {
      product: { ...PRODUCT, variants: [VARIANT] },
    });
    mount(<ShopProducts />, '/shop/products?id=p_1&tab=variants');

    await user.click(await screen.findByRole('button', { name: 'Adjust stock' }));
    const box = await screen.findByLabelText('Change by');
    // Two available; writing off three would violate shop_inventory_on_hand_ck
    // and come back as a 400 — so the form refuses BEFORE the promise, with
    // the reason where the arithmetic line would be.
    await user.type(box, '-3');
    await user.click(
      screen.getByRole('combobox', { name: 'Why did the stock change? (optional)' }),
    );
    await user.click(await screen.findByRole('option', { name: 'Damaged or faulty — written off' }));

    expect(screen.getByText(/can’t write off more than there is/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Adjust stock' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // Writing off exactly what is there is fine.
    await user.clear(box);
    await user.type(box, '-2');
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Adjust stock' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it('keeps the section in the URL, so a reload lands where you were', async () => {
    const user = userEvent.setup();
    when('/api/shop/admin/products/p_1', {
      product: { ...PRODUCT, variants: [VARIANT] },
    });
    mount(<ShopProducts />, '/shop/products?id=p_1');

    // Details is the default and stays out of the query entirely.
    expect(await screen.findByLabelText('Title')).toBeTruthy();
    expect(address()).not.toContain('tab=');

    await user.click(screen.getByRole('link', { name: /^Images/ }));
    await waitFor(() => expect(address()).toContain('tab=images'));
    expect(screen.getByText(/^Cover$/)).toBeTruthy();

    await user.click(screen.getByRole('link', { name: /^Variants/ }));
    await waitFor(() => expect(address()).toContain('tab=variants'));
    expect(await screen.findByRole('button', { name: 'Adjust price' })).toBeTruthy();
    // Save is reachable from every tab — the fields are one PATCH.
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();

    // The open section is THIS product's state: it must not ride the back
    // link into the catalogue and silently decide the next product's tab.
    const back = screen.getByRole('link', { name: /Catalogue/ });
    expect(back.getAttribute('href')).not.toContain('tab=');
  });

  it('offers existing tags while typing, and adopts their spelling', async () => {
    const user = userEvent.setup();
    when('/api/shop/admin/products/p_1', { product: { ...PRODUCT, variants: [] } });
    when('/api/shop/admin/tags', { items: [{ name: 'PLA', count: 7 }, { name: 'wood-fill', count: 2 }] });
    mount(<ShopProducts />, '/shop/products?id=p_1');

    const box = await screen.findByLabelText('Add a tag');
    await user.type(box, 'pl');
    // The vocabulary appears with its count — "7 products already spell it PLA".
    const offer = await screen.findByRole('button', { name: /PLA\s*7/ });
    await user.click(offer);
    expect(screen.getByRole('button', { name: 'Remove tag PLA' })).toBeTruthy();

    // Typing the fold-twin of an existing tag adopts the stored spelling too —
    // `pla` typed, `PLA` kept, and no second chip for the same tag.
    await user.type(screen.getByLabelText('Add a tag'), 'pla{Enter}');
    expect(screen.queryByRole('button', { name: 'Remove tag pla' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Remove tag PLA' })).toHaveLength(1);
  });
});

// ============================================================================
// ORDERS
// ============================================================================

describe('the order list', () => {
  it('reads its status from the URL and sends it as a filter', async () => {
    when('/api/shop/admin/orders', { items: [ORDER_ROW], nextCursor: null });
    mount(<ShopOrders />, '/shop/orders?view=table&status=paid');

    await waitFor(() => expect(screen.getByText('PS-4821-K')).toBeTruthy());
    expect(asked('/api/shop/admin/orders?status=paid')).toBeTruthy();
    // The control SHOWS the filter that is in the URL. A dropdown whose label
    // disagreed with the list under it would be worse than no label at all.
    expect(screen.getByRole('combobox', { name: 'Status' }).textContent).toContain('Paid');
  });

  it('changes the status through the dropdown, keeping the search', async () => {
    /*
     * WAS A TAB STRIP OF SEVEN LINKS. An order has seven states, most of them
     * empty most of the time, so the strip spent a row on six things nobody was
     * looking for and wrapped on a narrow screen — and it read as navigation
     * while behaving as a filter. What has to survive the change is that the
     * filter is still in the URL and still leaves every other param alone.
     */
    const user = userEvent.setup();
    when('/api/shop/admin/orders', { items: [], nextCursor: null });
    mount(<ShopOrders />, '/shop/orders?view=table&q=someone%40test.local');

    await user.click(await screen.findByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Fulfilled' }));

    await waitFor(() => expect(address()).toContain('status=fulfilled'));
    expect(address()).toContain('q=someone');
  });

  it('debounces the search box into ?q= and searches the server', async () => {
    when('/api/shop/admin/orders', { items: [], nextCursor: null });
    mount(<ShopOrders />, '/shop/orders');

    await userEvent.type(screen.getByLabelText('Search orders'), 'a@b.c');
    await waitFor(() => expect(address()).toContain('q=a%40b.c'));
    await waitFor(() => expect(asked('search=a%40b.c')).toBeTruthy());
  });

  it('drops the page cursor whenever the filter changes', async () => {
    when('/api/shop/admin/orders', { items: [ORDER_ROW], nextCursor: 'cur_2' });
    mount(<ShopOrders />, '/shop/orders?view=table&cursor=cur_9');

    // A keyset cursor is a position in ONE ordering of ONE filter. Carried
    // across a new search it means page two of the old list, which reads as a
    // search that found nothing.
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Paid' }));
    await waitFor(() => expect(address()).toContain('status=paid'));
    expect(address()).not.toContain('cursor=');

    await userEvent.type(screen.getByLabelText('Search orders'), 'x');
    await waitFor(() => expect(address()).toContain('q=x'));
    expect(address()).not.toContain('cursor=');
  });

  it('pages forward through the URL', async () => {
    when('/api/shop/admin/orders', { items: [ORDER_ROW], nextCursor: 'cur_2' });
    mount(<ShopOrders />, '/shop/orders');

    await waitFor(() => expect(screen.getByText('PS-4821-K')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => expect(address()).toContain('cursor=cur_2'));
    await waitFor(() => expect(asked('cursor=cur_2')).toBeTruthy());
  });
});

describe('one order', () => {
  it('shows the lines, the frozen totals and the history', async () => {
    when('/api/shop/admin/orders/o_1', ORDER_DETAIL);
    mount(<ShopOrders />, '/shop/orders?id=o_1');

    await waitFor(() => expect(screen.getByText('Order placed')).toBeTruthy());
    expect(screen.getAllByText(formatMinor(1990, 'GBP')).length).toBeGreaterThan(0);
    expect(screen.getByText(formatMinor(350, 'GBP'))).toBeTruthy();
    expect(screen.getByText(formatMinor(2340, 'GBP'))).toBeTruthy();
  });

  it('shows a failed email as failed, with the error', async () => {
    when('/api/shop/admin/orders/o_1', ORDER_DETAIL);
    mount(<ShopOrders />, '/shop/orders?id=o_1');

    await waitFor(() => expect(screen.getByText(/3 failed attempts/)).toBeTruthy());
    expect(screen.getByText('connect ETIMEDOUT')).toBeTruthy();
    // "Handed to the mailer" is not "delivered", and the default mailer sends
    // nothing at all. The panel has to say so.
    expect(screen.getByText(/is not the same as delivered/)).toBeTruthy();
  });

  it('explains a null payment panel instead of leaving it blank', async () => {
    when('/api/shop/admin/orders/o_1', ORDER_DETAIL);
    mount(<ShopOrders />, '/shop/orders?id=o_1');

    // `payment: null` is what EVERY order answers while `registerOrdersDeps`
    // has no production caller. A blank panel reads as "not paid".
    await waitFor(() =>
      expect(screen.getByText(/It is not a statement about this order/)).toBeTruthy(),
    );
  });

  it('bounds the refund box by what the PAYMENT says is left', async () => {
    when('/api/shop/admin/orders/o_1', {
      ...ORDER_DETAIL,
      payment: {
        intentId: 'pi_1',
        checkoutId: 'c_1',
        status: 'captured',
        amount: 2340,
        currency: 'GBP',
        refundedTotal: 340,
        createdAt: 1,
        updatedAt: 2,
      },
    });
    mount(<ShopOrders />, '/shop/orders?id=o_1');

    const box = await screen.findByLabelText('Refund amount in GBP');
    const button = screen.getByRole('button', { name: 'Refund' }) as HTMLButtonElement;

    // £20.00 is exactly what is left (2340 − 340).
    await userEvent.type(box, '20.00');
    await waitFor(() => expect(button.disabled).toBe(false));

    await userEvent.clear(box);
    await userEvent.type(box, '20.01');
    await waitFor(() => expect(button.disabled).toBe(true));
    // The refusal quotes the real bound rather than saying "too much".
    const refusal = screen.getByText(/more than the .* left to refund/);
    expect(refusal.textContent).toContain(formatMinor(2000, 'GBP'));
  });

  it('hides the owner-only actions from a writer', async () => {
    fixture.session.user.role = 'writer';
    when('/api/shop/admin/orders/o_1', ORDER_DETAIL);
    mount(<ShopOrders />, '/shop/orders?id=o_1');

    await waitFor(() => expect(screen.getByText('Order placed')).toBeTruthy());
    // `cancel` and `refunds` are both `requireOwner()`. Rendering them for a
    // writer would be a confirmation dialog in front of a 403.
    expect(screen.queryByText('Owner actions')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel this order' })).toBeNull();
  });

  it('offers only the outstanding quantity to ship', async () => {
    when('/api/shop/admin/orders/o_1', {
      ...ORDER_DETAIL,
      lines: [{ ...ORDER_DETAIL.lines[0], qty: 5, fulfilledQty: 3, lineTotal: 9950 }],
    });
    mount(<ShopOrders />, '/shop/orders?id=o_1');

    const qty = (await screen.findByLabelText(
      'Quantity to ship of Enamel mug',
    )) as HTMLInputElement;
    // Five ordered, three already sent: the form starts at the two that are
    // left, because a partial shipment is the ordinary case, not an edge one.
    // Waited for rather than read once — the seeding happens in an effect, so
    // the input exists for one commit before it holds anything.
    await waitFor(() => expect(qty.value).toBe('2'));
    expect(screen.getByText(/2 outstanding/)).toBeTruthy();
  });
});

// ============================================================================
// CUSTOMERS
// ============================================================================

describe('the buyer list', () => {
  const BUYERS = {
    items: [
      {
        email: 'guest@test.local',
        customerId: null,
        displayName: null,
        orderCount: 1,
        paidCount: 1,
        totalSpent: 2340,
        currency: 'GBP',
        lastOrderAt: 1_786_600_000_000,
        lastOrderId: 'o_1',
        lastOrderNumber: 'PS-4821-K',
        lastOrderStatus: 'paid',
      },
      {
        email: 'member@test.local',
        customerId: 'sc_1',
        displayName: 'A Member',
        orderCount: 4,
        // One of the four was never paid for, which is why the money column
        // and the order count are different numbers.
        paidCount: 3,
        totalSpent: 129900,
        currency: 'GBP',
        lastOrderAt: 1_786_600_000_000,
        lastOrderId: 'o_2',
        lastOrderNumber: 'PS-4822-M',
        lastOrderStatus: 'pending',
      },
    ],
    nextCursor: 'cur_2',
  };

  it('says which buyers have an account, because most will not', async () => {
    when('/api/shop/admin/customers', BUYERS);
    mount(<ShopCustomers />, '/shop/customers');

    await waitFor(() => expect(screen.getByText('guest@test.local')).toBeTruthy());
    expect(screen.getByText(/guest checkout/)).toBeTruthy();
    expect(screen.getByText(/has an account/)).toBeTruthy();
    expect(screen.getByText(formatMinor(129900, 'GBP'))).toBeTruthy();
  });

  it('shows the paid count when it differs, so the money column adds up', async () => {
    when('/api/shop/admin/customers', BUYERS);
    mount(<ShopCustomers />, '/shop/customers');

    // Four orders, three paid for: without the second number the row invites
    // the arithmetic "four orders, that total — the sum is wrong".
    await waitFor(() => expect(screen.getByText('3 paid')).toBeTruthy());
    expect(screen.getAllByText('after refunds').length).toBe(2);
  });

  it('pages by keyset through the URL, so Back walks the pages', async () => {
    when('/api/shop/admin/customers', BUYERS);
    mount(<ShopCustomers />, '/shop/customers');

    await waitFor(() => expect(screen.getByText('A Member')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => expect(address()).toContain('cursor=cur_2'));
    await waitFor(() => expect(asked('cursor=cur_2')).toBeTruthy());
  });

  it('reads its cursor from the URL on a cold load', async () => {
    when('/api/shop/admin/customers', BUYERS);
    mount(<ShopCustomers />, '/shop/customers?cursor=cur_9');

    await waitFor(() => expect(asked('cursor=cur_9')).toBeTruthy());
    // A pasted page is a real page, so "back a page" is offered from it.
    const back = await screen.findByRole('button', { name: 'Back a page' });
    expect((back as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not claim nobody has bought anything when a page is simply past the end', async () => {
    when('/api/shop/admin/customers', { items: [], nextCursor: null });
    mount(<ShopCustomers />, '/shop/customers?cursor=cur_end');

    await waitFor(() => expect(screen.getByText('Nothing further')).toBeTruthy());
    expect(screen.queryByText('No buyers yet')).toBeNull();
  });
});

// -------------------------------------------------------------------- shared

const AUDIT_STOCK = {
  id: 'evt_1',
  kind: 'stock' as const,
  occurredAt: 1_786_000_000_000,
  variantId: 'v_1',
  sku: 'MUG-BLUE',
  productId: 'p_1',
  productTitle: 'Enamel mug',
  optionValues: { Colour: 'Blue' },
  reason: 'Delivery arrived from the distributor',
  actor: 'Nathaniel',
  delta: 12,
  onHand: 47,
  amount: null,
  previousAmount: null,
  currency: null,
};

const AUDIT_PRICE = {
  ...AUDIT_STOCK,
  id: 'prc_1',
  kind: 'price' as const,
  occurredAt: 1_786_000_100_000,
  reason: 'Distributor raised the price',
  // No actor: `shop_prices` has no such column, and the view must not invent one.
  actor: null,
  delta: null,
  onHand: null,
  amount: 2_200_000,
  previousAmount: 1_850_000,
  currency: 'NGN',
};

describe('the history', () => {
  it('leads with the difference, not the current value', async () => {
    when('/api/shop/admin/audit', { items: [AUDIT_PRICE], nextCursor: null });
    mount(<ShopAudit />, '/shop/audit');

    /*
     * THE QUESTION THIS PAGE ANSWERS is "why is this number what it is", asked
     * in front of the number — so the row has to carry what it WAS, which is
     * the one figure that appears nowhere else in the app.
     */
    const row = await screen.findByText(/Distributor raised the price/);
    const entry = row.closest('li')!;
    // MAJOR units on screen, minor on the wire: 1,850,000 kobo is ₦18,500.00.
    // The old figure is here because it is the one that appears nowhere else.
    expect(entry.textContent).toContain('18,500.00');
    expect(entry.textContent).toContain('22,000.00');
    expect(entry.textContent).toContain('increase');
  });

  it('shows a stock move as the delta and what it left behind', async () => {
    when('/api/shop/admin/audit', { items: [AUDIT_STOCK], nextCursor: null });
    mount(<ShopAudit />, '/shop/audit');

    const entry = (await screen.findByText(/Delivery arrived/)).closest('li')!;
    expect(entry.textContent).toContain('+12');
    expect(entry.textContent).toContain('47');
    // Who did it, when it is known.
    expect(entry.textContent).toContain('Nathaniel');
  });

  it('says a reason was not recorded rather than leaving a gap', async () => {
    // Every price written before migration 0009 has none. A blank there reads
    // like a loading bug; the absence is a fact and is stated.
    when('/api/shop/admin/audit', {
      items: [{ ...AUDIT_PRICE, reason: null }],
      nextCursor: null,
    });
    mount(<ShopAudit />, '/shop/audit');

    expect(await screen.findByText('No reason recorded')).toBeTruthy();
  });

  it('asks the server for the kind the URL names', async () => {
    when('/api/shop/admin/audit', { items: [AUDIT_STOCK], nextCursor: null });
    mount(<ShopAudit />, '/shop/audit?kind=stock');

    await waitFor(() => expect(asked('kind=stock')).toBeTruthy());
  });

  it('scopes to one variant, and offers a way back out', async () => {
    when('/api/shop/admin/audit', { items: [AUDIT_STOCK], nextCursor: null });
    mount(<ShopAudit />, '/shop/audit?variant=v_1');

    await waitFor(() => expect(asked('variantId=v_1')).toBeTruthy());
    // A filtered audit page that does not say it is filtered is the worst kind
    // of wrong on this screen.
    expect(screen.getByRole('button', { name: /show the whole shop/i })).toBeTruthy();
  });

  it('offers the way back to the product it was opened from', async () => {
    when('/api/shop/admin/audit', { items: [AUDIT_STOCK], nextCursor: null });
    mount(<ShopAudit />, '/shop/audit?variant=v_1&from=p_1');

    /*
     * "Why is this number what it is" is asked in front of the number, so the
     * answer has to lead back to it. Without this the only exit was the
     * sidebar, which lands on the catalogue rather than the product — and the
     * variants tab specifically, because that is the pane you left.
     */
    const back = await screen.findByRole('link', { name: /back to the product/i });
    expect(back.getAttribute('href')).toContain('id=p_1');
    expect(back.getAttribute('href')).toContain('tab=variants');
  });

  it('finds the way back from the entries when the URL does not carry it', async () => {
    // A bookmarked or hand-trimmed URL has no `from`; the first entry knows
    // which product it belongs to, so the exit survives either way.
    when('/api/shop/admin/audit', { items: [AUDIT_STOCK], nextCursor: null });
    mount(<ShopAudit />, '/shop/audit?variant=v_1');

    const back = await screen.findByRole('link', { name: /back to the product/i });
    expect(back.getAttribute('href')).toContain('id=p_1');
  });

  it('appends earlier changes rather than replacing what you were reading', async () => {
    when('/api/shop/admin/audit', { items: [AUDIT_PRICE], nextCursor: 'cur_2' });
    mount(<ShopAudit />, '/shop/audit');

    await screen.findByText(/Distributor raised the price/);
    when('/api/shop/admin/audit', { items: [AUDIT_STOCK], nextCursor: null });
    await userEvent.click(screen.getByRole('button', { name: /show earlier changes/i }));

    await waitFor(() => expect(screen.getByText(/Delivery arrived/)).toBeTruthy());
    // The first page is still on screen.
    expect(screen.getByText(/Distributor raised the price/)).toBeTruthy();
  });
});

describe('setting up variants', () => {
  it('asks whether it varies, instead of demanding a SKU', async () => {
    when('/api/shop/admin/products/p_1', { product: { ...PRODUCT, variants: [] } });
    mount(<ShopProducts />, '/shop/products?id=p_1&tab=variants');

    /*
     * THE WHOLE POINT. The old panel opened with a text box wanting
     * `WOOD-175-EBY-1KG` before it would accept anything a shopkeeper knows.
     */
    expect(await screen.findByText('Does this come in variations?')).toBeTruthy();
    expect(screen.getByRole('button', { name: /single item/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /set up options/i })).toBeTruthy();
  });

  it('creates one variant with no SKU and no options for a single item', async () => {
    when('/api/shop/admin/products/p_1', { product: { ...PRODUCT, variants: [] } });
    when('/api/shop/admin/products/p_1/variants', { variant: VARIANT });
    mount(<ShopProducts />, '/shop/products?id=p_1&tab=variants');

    await userEvent.click(await screen.findByRole('button', { name: /single item/i }));

    await waitFor(() => expect(asked('/api/shop/admin/products/p_1/variants')).toBeTruthy());
    const calls = (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit][] } })
      .mock.calls;
    const post = calls.find((c) => c[1]?.method === 'POST');
    // No `sku` on the wire at all — the server derives it.
    expect(JSON.parse(String(post![1].body))).toEqual({});
  });

  it('turns checked colours and a typed size into combinations, code and all', async () => {
    const user = userEvent.setup();
    when('/api/shop/admin/products/p_1', { product: { ...PRODUCT, variants: [] } });
    when('/api/shop/admin/products/p_1/variants', { variant: VARIANT });
    mount(<ShopProducts />, '/shop/products?id=p_1&tab=variants');

    await user.click(await screen.findByRole('button', { name: /set up options/i }));

    /*
     * A COLOUR IS A CHECKBOX, NOT A SPELLING TEST: checking "Black" names the
     * value and records its swatch in one click, which is where the colour
     * code on the wire below comes from.
     */
    await user.click(screen.getByRole('checkbox', { name: 'Black' }));
    await user.click(screen.getByRole('checkbox', { name: 'Red' }));

    // ...and a second axis, whose values are ALSO one click: every axis kind
    // has a vocabulary, not just colour.
    await user.click(screen.getByRole('button', { name: 'Size' }));
    await user.click(screen.getByRole('checkbox', { name: 'S' }));

    // 2 colours x 1 size. The count is promised before the click.
    expect(screen.getByText(/This makes 2 variants/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /^Create 2$/ }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit][] } })
        .mock.calls;
      const posts = calls.filter((c) => c[1]?.method === 'POST');
      expect(posts).toHaveLength(2);
      expect(posts.map((c) => JSON.parse(String(c[1].body)))).toEqual([
        { optionValues: { Colour: 'Black', Size: 'S' }, colorHex: '#111111' },
        { optionValues: { Colour: 'Red', Size: 'S' }, colorHex: '#c62828' },
      ]);
    });
  });

  it('refuses the same value twice, whatever the casing', async () => {
    const user = userEvent.setup();
    when('/api/shop/admin/products/p_1', { product: { ...PRODUCT, variants: [] } });
    mount(<ShopProducts />, '/shop/products?id=p_1&tab=variants');

    await user.click(await screen.findByRole('button', { name: /set up options/i }));
    // "Black" is checked as a preset; "black" typed into the custom row is the
    // same colour, and a second variant for it is a SKU collision somebody
    // would have to explain later.
    await user.click(screen.getByRole('checkbox', { name: 'Black' }));
    await user.type(screen.getByLabelText('Custom colour name'), 'black{Enter}');

    expect(screen.getByText(/This makes 1 variant/)).toBeTruthy();

    // The same guard on a non-colour axis, preset against typed.
    await user.click(screen.getByRole('button', { name: 'Size' }));
    await user.click(screen.getByRole('checkbox', { name: 'M' }));
    await user.type(screen.getByLabelText('Add a Size'), 'm{Enter}');
    expect(screen.getByText(/This makes 1 variant/)).toBeTruthy();
    // And it says where the swallowed entry went rather than just eating it.
    expect(screen.getByText(/“m” is already picked/)).toBeTruthy();
  });

  it('offers a vocabulary for every axis kind, not just colour', async () => {
    const user = userEvent.setup();
    when('/api/shop/admin/products/p_1', { product: { ...PRODUCT, variants: [] } });
    when('/api/shop/admin/products/p_1/variants', { variant: VARIANT });
    mount(<ShopProducts />, '/shop/products?id=p_1&tab=variants');

    await user.click(await screen.findByRole('button', { name: /set up options/i }));

    /*
     * THE HALF-FEATURE THIS CLOSES. Presets were colour-only, so setting up
     * sizes or spool weights meant typing every value — which is where the
     * near-miss spellings (`1kg` / `1 kg` / `1KG`) come from.
     */
    for (const [axis, value] of [
      ['Weight', '750 g'],
      ['Material', 'PETG'],
      ['Finish', 'Matte'],
      ['Diameter', '1.75 mm'],
    ] as const) {
      await user.click(screen.getByRole('button', { name: axis }));
      expect(screen.getByRole('checkbox', { name: value })).toBeTruthy();
    }

    // An axis nobody has a list for still works — it just gets the box. The
    // first axis is the Colour one, so renaming it must take the colour
    // vocabulary AND the hex controls with it.
    const name = screen.getAllByLabelText('What varies')[0];
    await user.clear(name);
    await user.type(name, 'Nozzle');
    expect(screen.getByLabelText('Add a Nozzle')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Natural' })).toBeNull();
    expect(screen.queryByLabelText('Custom colour code')).toBeNull();
  });
});

describe('a variant carries its own picture', () => {
  it('offers to add one when the variant has none', async () => {
    when('/api/shop/admin/products/p_1', { product: { ...PRODUCT, variants: [VARIANT] } });
    mount(<ShopProducts />, '/shop/products?id=p_1&tab=variants');

    // Its own deliberate act, beside the two audited ones — not a field
    // hiding between them, because a photo needs no reason.
    expect(await screen.findByRole('button', { name: 'Add photo' })).toBeTruthy();
  });

  it('shows the picture, and offers to replace it, once one is set', async () => {
    const user = userEvent.setup();
    when('/api/shop/admin/products/p_1', {
      product: { ...PRODUCT, variants: [{ ...VARIANT, imageId: 'img_blue' }] },
    });
    mount(<ShopProducts />, '/shop/products?id=p_1&tab=variants');

    await user.click(await screen.findByRole('button', { name: 'Change photo' }));
    expect(await screen.findByRole('button', { name: 'Replace photo' })).toBeTruthy();
    // Removing is offered too — and only once a photo exists to remove.
    expect(screen.getByRole('button', { name: 'Remove photo' })).toBeTruthy();

    const img = document.querySelector('.vthumb--lg img');
    /*
     * THE ADMIN URL, not the public one. This screen shows drafts, and
     * `/api/public/images/:id` serves only what an ACTIVE product references —
     * so a draft's swatches would all be 404s against the public route.
     */
    expect(img?.getAttribute('src')).toContain('/api/images/img_blue');
  });

  it('draws the colour code as the stand-in until a photo exists', async () => {
    when('/api/shop/admin/products/p_1', {
      product: { ...PRODUCT, variants: [{ ...VARIANT, colorHex: '#1565c0' }] },
    });
    mount(<ShopProducts />, '/shop/products?id=p_1&tab=variants');

    await screen.findByRole('button', { name: 'Adjust price' });
    // Both the rail thumb and the card thumb paint the swatch — a colour is
    // exactly the thing a solid block can stand in for.
    const fills = document.querySelectorAll('.vthumb__fill');
    expect(fills.length).toBeGreaterThanOrEqual(2);
    expect((fills[0] as HTMLElement).style.backgroundColor).toBe('rgb(21, 101, 192)');
  });
});

/*
 * THE "shop nav" TEST LIVED HERE AND HAS MOVED, rather than been dropped.
 *
 * It asserted that the in-page `Shop sections` row marked the screen you were
 * on. That row is gone from all four shop screens: the sidebar shows the pages
 * of whichever section you are in, so there is one navigation instead of two.
 * The same property is pinned in `src/components/Sidebar.test.tsx` — "marks the
 * page you are on inside the section" — against the component that now draws it.
 *
 * Deleted here instead of rewritten because these screens no longer render any
 * section navigation at all; a test mounting one of them could only assert the
 * absence, which `Sidebar.test.tsx` already covers from the other side.
 */

/** A currency symbol is a regex metacharacter in more locales than not. */
function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ------------------------------------------------- one broken value, one cell

/**
 * THE THREE SCREENS THAT READ THE SAME FIELDS `/shop/orders` DIED ON.
 *
 * The overview's recent-orders list renders `order.placedAt` and
 * `order.grandTotal` — the very two values that took the orders screen to its
 * error boundary — off a DIFFERENT endpoint (`/stats`, not `/orders`) with its
 * own client type and its own chance of disagreeing with the server. The buyer
 * list and the history read their own equivalents the same way.
 *
 * NONE OF THESE IS A LIVE BUG. Every column behind them is NOT NULL, and the
 * audit at the time of this sweep confirmed it. That is not the reassurance it
 * sounds like: `placedAt` was NOT NULL too. What reached the formatter was a
 * `shopFetch<T>` naming a shape the server does not send — an assertion no
 * column constraint is in a position to contradict. So what is pinned below is
 * the DOWNGRADE, not the data: whatever arrives, the operator keeps the screen.
 *
 * Each case breaks ONE field of ONE row and then asserts the rest of the screen
 * is untouched, because "renders a placeholder" and "renders placeholders
 * everywhere" are different outcomes and only the first is the repair.
 */
describe('a value the screen cannot render', () => {
  it('costs the overview one cell, not the dashboard', async () => {
    when('/api/shop/admin/stats', {
      ...STATS,
      latestOrders: [{ ...STATS.latestOrders[0], placedAt: undefined }],
    });
    mount(<Shop />, '/shop');

    // The order is still listed, still linked, and still shows its money.
    await waitFor(() => expect(screen.getByText('PS-4821-K')).toBeTruthy());
    expect(screen.getByText(formatMinor(2340, 'GBP'))).toBeTruthy();
    expect(screen.getByText(UNRENDERABLE)).toBeTruthy();

    // And the rest of the dashboard — the stats above the list — is intact.
    expect(screen.getByText(formatMinor(25050, 'GBP'))).toBeTruthy();
  });

  /*
   * A CURRENCY IS THE OTHER HALF OF AN AMOUNT. Guarding the number alone would
   * leave the screen exactly as reachable, through `formatMinor`'s second
   * `Intl.NumberFormat` — the one with `style: 'currency'`, which throws
   * `RangeError: Invalid currency code` on its own.
   */
  it('costs the overview one total when the currency is the broken half', async () => {
    when('/api/shop/admin/stats', {
      ...STATS,
      latestOrders: [{ ...STATS.latestOrders[0], currency: undefined }],
    });
    mount(<Shop />, '/shop');

    await waitFor(() => expect(screen.getByText('PS-4821-K')).toBeTruthy());
    expect(screen.getByText(UNRENDERABLE)).toBeTruthy();
    // The revenue tiles carry their OWN currency and are unaffected by this row.
    expect(screen.getByText(formatMinor(1990, 'GBP'))).toBeTruthy();
  });

  it('costs the buyer list the date and keeps the money beside it', async () => {
    when('/api/shop/admin/customers', {
      items: [
        {
          email: 'guest@test.local',
          customerId: null,
          displayName: null,
          orderCount: 1,
          paidCount: 1,
          totalSpent: 2340,
          currency: 'GBP',
          lastOrderAt: Number.NaN,
          lastOrderId: 'o_1',
          lastOrderNumber: 'PS-4821-K',
          lastOrderStatus: 'paid',
        },
      ],
      nextCursor: null,
    });
    mount(<ShopCustomers />, '/shop/customers');

    await waitFor(() => expect(screen.getByText('guest@test.local')).toBeTruthy());
    // The link to the order is the row's whole reason for existing, and a
    // broken date is not a reason to withhold it.
    expect(screen.getByText('PS-4821-K')).toBeTruthy();
    expect(screen.getByText(formatMinor(2340, 'GBP'))).toBeTruthy();
    expect(screen.getByText(new RegExp(UNRENDERABLE))).toBeTruthy();
  });

  it('costs the history its timestamp and still says what changed', async () => {
    when('/api/shop/admin/audit', {
      items: [{ ...AUDIT_PRICE, occurredAt: undefined }],
      nextCursor: null,
    });
    mount(<ShopAudit />, '/shop/audit');

    // The price change — the old figure is the one that appears nowhere else
    // in the app — survives the timestamp beside it. Compared on the digits,
    // like every other money assertion here: the symbol and the amount are
    // separate elements, so `getByText` on the whole string never matches.
    const entry = (await screen.findByText(/Distributor raised the price/)).closest('li')!;
    expect(entry.textContent).toContain('18,500.00');
    expect(entry.textContent).toContain('22,000.00');

    // `new Date(undefined).toISOString()` throws the same `RangeError` the
    // visible formatter does, so the attribute had to be downgraded too — and
    // omitted rather than emptied, since `datetime=""` parses to nothing.
    const time = document.querySelector('time.auditrow__when');
    expect(time?.textContent).toBe(UNRENDERABLE);
    expect(time?.hasAttribute('datetime')).toBe(false);
  });

  it('costs the history one amount when a price row carries no currency', async () => {
    when('/api/shop/admin/audit', {
      items: [{ ...AUDIT_PRICE, currency: 'not-a-code' }],
      nextCursor: null,
    });
    mount(<ShopAudit />, '/shop/audit');

    // Both figures downgrade — they share the bad code — but the row still
    // says which product changed and why, which is what sends somebody looking.
    const entry = (await screen.findByText(/Distributor raised the price/)).closest('li')!;
    expect(entry.textContent).toContain('Enamel mug');
    expect(entry.textContent).toContain(UNRENDERABLE);
    // The digits are GONE rather than shown against the wrong symbol, which
    // would be the one outcome here worse than the placeholder.
    expect(entry.textContent).not.toContain('18,500.00');
  });
});
