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
import Shop from './Shop';
import ShopProducts from './ShopProducts';
import ShopOrders from './ShopOrders';
import ShopCustomers from './ShopCustomers';

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
  revenue: [{ currency: 'GBP', last24h: 1990, last7d: 418250, last30d: 900000 }],
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
};

const ORDER_DETAIL = {
  order: ORDER,
  lines: [
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
  ],
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

  it('seeds a price box in major units, trailing zero and all', async () => {
    when('/api/shop/admin/products/p_1', {
      product: { ...PRODUCT, variants: [VARIANT] },
    });
    mount(<ShopProducts />, '/shop/products?id=p_1');

    const price = (await screen.findByLabelText('Price')) as HTMLInputElement;
    // 1990 minor units. `19.9` is the value a division produces and the one an
    // operator would have to notice was missing a digit.
    expect(price.value).toBe('19.90');
  });

  it('sends a typed price as integer minor units', async () => {
    when('/api/shop/admin/products/p_1', {
      product: { ...PRODUCT, variants: [VARIANT] },
    });
    when('/api/shop/admin/variants/v_1/price', { price: { amount: 2500, currency: 'GBP' } });
    mount(<ShopProducts />, '/shop/products?id=p_1');

    const price = await screen.findByLabelText('Price');
    await userEvent.clear(price);
    await userEvent.type(price, '25.00');
    await userEvent.click(screen.getByRole('button', { name: 'Set' }));

    await waitFor(() => expect(asked('/api/shop/admin/variants/v_1/price')).toBeTruthy());
    const call = (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit][] } })
      .mock.calls;
    const put = call.find((c) => c[1]?.method === 'PUT');
    expect(JSON.parse(String(put![1].body))).toEqual({ amount: 2500, currency: 'GBP' });
  });

  it('refuses to enable Set for more decimals than the currency has', async () => {
    when('/api/shop/admin/products/p_1', {
      product: { ...PRODUCT, variants: [VARIANT] },
    });
    mount(<ShopProducts />, '/shop/products?id=p_1');

    const price = await screen.findByLabelText('Price');
    await userEvent.clear(price);
    await userEvent.type(price, '19.999');

    await waitFor(() => expect(screen.getByText(/2 decimal places/)).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Set' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('will not adjust stock without a reason, because the route will not either', async () => {
    when('/api/shop/admin/products/p_1', {
      product: { ...PRODUCT, variants: [VARIANT] },
    });
    mount(<ShopProducts />, '/shop/products?id=p_1');

    const delta = await screen.findByLabelText('Stock');
    await userEvent.type(delta, '10');
    const adjust = screen.getByRole('button', { name: 'Adjust' }) as HTMLButtonElement;
    expect(adjust.disabled).toBe(true);

    /*
     * THE REASON IS NOW A PICKER, and that is the point of it: a mandatory free
     * text box collects "fix" and "x", which satisfies the server and tells the
     * next reader nothing. Six presets plus "Something else" means the common
     * answer is one click and the audit trail is still readable a year later.
     */
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Why the stock changed' }));
    await user.click(await screen.findByRole('option', { name: 'Stocktake recount' }));
    await waitFor(() => expect(adjust.disabled).toBe(false));
  });
});

// ============================================================================
// ORDERS
// ============================================================================

describe('the order list', () => {
  it('reads its status from the URL and sends it as a filter', async () => {
    when('/api/shop/admin/orders', { items: [ORDER], nextCursor: null });
    mount(<ShopOrders />, '/shop/orders?status=paid');

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
    mount(<ShopOrders />, '/shop/orders?q=someone%40test.local');

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
    when('/api/shop/admin/orders', { items: [ORDER], nextCursor: 'cur_2' });
    mount(<ShopOrders />, '/shop/orders?cursor=cur_9');

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
    when('/api/shop/admin/orders', { items: [ORDER], nextCursor: 'cur_2' });
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

describe('setting up variants', () => {
  it('asks whether it varies, instead of demanding a SKU', async () => {
    when('/api/shop/admin/products/p_1', { product: { ...PRODUCT, variants: [] } });
    mount(<ShopProducts />, '/shop/products?id=p_1');

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
    mount(<ShopProducts />, '/shop/products?id=p_1');

    await userEvent.click(await screen.findByRole('button', { name: /single item/i }));

    await waitFor(() => expect(asked('/api/shop/admin/products/p_1/variants')).toBeTruthy());
    const calls = (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit][] } })
      .mock.calls;
    const post = calls.find((c) => c[1]?.method === 'POST');
    // No `sku` on the wire at all — the server derives it.
    expect(JSON.parse(String(post![1].body))).toEqual({});
  });

  it('turns two axes into their combinations, one POST each', async () => {
    const user = userEvent.setup();
    when('/api/shop/admin/products/p_1', { product: { ...PRODUCT, variants: [] } });
    when('/api/shop/admin/products/p_1/variants', { variant: VARIANT });
    mount(<ShopProducts />, '/shop/products?id=p_1');

    await user.click(await screen.findByRole('button', { name: /set up options/i }));

    // Colour: Black, Red
    const colour = screen.getByLabelText('Add a Colour');
    await user.type(colour, 'Black{Enter}');
    await user.type(colour, 'Red{Enter}');

    // ...and a second axis.
    await user.click(screen.getByRole('button', { name: 'Size' }));
    const size = screen.getByLabelText('Add a Size');
    await user.type(size, 'S{Enter}');

    // 2 colours x 1 size. The count is promised before the click.
    expect(screen.getByText(/This makes 2 variants/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /^Create 2$/ }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit][] } })
        .mock.calls;
      const posts = calls.filter((c) => c[1]?.method === 'POST');
      expect(posts).toHaveLength(2);
      expect(posts.map((c) => JSON.parse(String(c[1].body)).optionValues)).toEqual([
        { Colour: 'Black', Size: 'S' },
        { Colour: 'Red', Size: 'S' },
      ]);
    });
  });

  it('refuses the same value twice, whatever the casing', async () => {
    const user = userEvent.setup();
    when('/api/shop/admin/products/p_1', { product: { ...PRODUCT, variants: [] } });
    mount(<ShopProducts />, '/shop/products?id=p_1');

    await user.click(await screen.findByRole('button', { name: /set up options/i }));
    const colour = screen.getByLabelText('Add a Colour');
    await user.type(colour, 'Black{Enter}');
    // "black" is the same colour, and a second variant for it is a SKU
    // collision somebody would have to explain later.
    await user.type(colour, 'black{Enter}');

    expect(screen.getByText(/This makes 1 variant/)).toBeTruthy();
  });
});

describe('a variant carries its own picture', () => {
  it('offers to add one when the variant has none', async () => {
    when('/api/shop/admin/products/p_1', { product: { ...PRODUCT, variants: [VARIANT] } });
    mount(<ShopProducts />, '/shop/products?id=p_1');

    // The option's own name is in the label, so a rail of eight colours does
    // not present eight controls called "Add an image".
    expect(await screen.findByRole('button', { name: /Add an image/i })).toBeTruthy();
  });

  it('shows the picture, and offers to replace it, once one is set', async () => {
    when('/api/shop/admin/products/p_1', {
      product: { ...PRODUCT, variants: [{ ...VARIANT, imageId: 'img_blue' }] },
    });
    mount(<ShopProducts />, '/shop/products?id=p_1');

    const button = await screen.findByRole('button', { name: /Replace this image/i });
    const img = button.querySelector('img');
    /*
     * THE ADMIN URL, not the public one. This screen shows drafts, and
     * `/api/public/images/:id` serves only what an ACTIVE product references —
     * so a draft's swatches would all be 404s against the public route.
     */
    expect(img?.getAttribute('src')).toContain('/api/images/img_blue');
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
