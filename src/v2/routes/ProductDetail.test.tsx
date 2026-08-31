import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * The product editor, asserted on the seven things it can get wrong quietly —
 * the exact list its old `TODO(tests)` block carried:
 *
 *  - **A CAS loss that overwrites anyway.** The save carries `baseRevision`
 *    and a 409 has to become the conflict banner with the operator's entry
 *    still in the box — not a toast, not a reload, and never a second PATCH.
 *  - **Archived→active as one hop.** It is genuinely two transitions —
 *    unarchive lands on draft, then publish — and the ORDER is the contract,
 *    so the request log is asserted as a sequence.
 *  - **Delete offered on a variant that has sold.** `everOrdered` is what
 *    decides whether the ⋯ menu offers Delete at all; the server answers 409
 *    to the request this screen exists to never make.
 *  - **A description clobbered by an editor that never spoke.** `null` state
 *    means the editor never produced a doc, and the PATCH must omit the key
 *    so the stored description is left alone (v1's own rule).
 *  - **SEO clears that do not clear.** `''` is the wire form of "clear it";
 *    an untouched box restates the stored text. The absent-key-keeps half is
 *    the SERVER's rule and is tested in `server/shop/catalog/routes.test.ts`
 *    — this screen's discipline is that the key always travels.
 *  - **A money refusal that does not say which box.** Compare-at and cost
 *    share a parser, so each refusal must name its own field.
 *  - **`backorderable` riding every PATCH.** The flag lands on the inventory
 *    row, and a no-op write would still bump that row's clock — so it
 *    travels only when it moved.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-shop`, for the reason the rewards
 * suite gives: the path, the method and the body are the three things most
 * likely to be silently wrong against a backend written in another session,
 * and a mocked module asserts none of them.
 *
 * NO `vi.mock` AT ALL: unlike the marketing screens this tree never imports
 * `src/data/session` (nothing here is role-gated client-side), and the only
 * other side-effectful import — `src/data/images` via `StoredImg` — is never
 * exercised because every fixture carries `imageId: null` and empty media.
 */

vi.setConfig({ testTimeout: 20_000 });

import { ToastHost } from '../ui/Toast';
import type { ShopCategory, ShopProductDetail, ShopVariant } from '../../data/api-shop';
import ProductDetail from './ProductDetail';

/**
 * What jsdom does not implement and this tree touches — the same block the
 * rewards suite carries. TableScroll needs ResizeObserver on mount; the rest
 * cost nothing and keep the harness identical across the ui suites.
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
const dialogProto = Object.getPrototypeOf(document.createElement('dialog'));
dialogProto.showModal = function (this: HTMLDialogElement) {
  this.open = true;
};
dialogProto.close = function (this: HTMLDialogElement) {
  this.open = false;
};

// --------------------------------------------------------------- the server

type Responder = (url: URL, init: RequestInit) => { status?: number; body: unknown };

const handlers = new Map<string, Responder>();
let calls: { path: string; init: RequestInit }[] = [];

/** Register a route. Anything unregistered answers 404 `gone`, like the app. */
function when(pathname: string, respond: Responder): void;
function when(pathname: string, body: unknown, status?: number): void;
function when(pathname: string, body: unknown, status = 200): void {
  handlers.set(
    pathname,
    typeof body === 'function' ? (body as Responder) : () => ({ status, body }),
  );
}

/** GETs of exactly this path — the product and its writes share a prefix. */
const reads = (pathname: string): number =>
  calls.filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === 'GET')
    .length;

/** Every write that has gone anywhere, in arrival order — the sequence tests. */
const writes = (): string[] =>
  calls.filter((c) => (c.init.method ?? 'GET') !== 'GET').map((c) => c.path.split('?')[0]);

/** The body of the last request to a path with this method. */
function sent(pathname: string, method: string): Record<string, unknown> {
  const call = [...calls]
    .reverse()
    .find((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method);
  if (call === undefined) throw new Error(`no ${method} to ${pathname}`);
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

beforeEach(() => {
  handlers.clear();
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const url = new URL(String(input), 'https://studio.test');
      calls.push({ path: url.pathname + url.search, init });
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
  vi.restoreAllMocks();
});

// -------------------------------------------------------------- the fixtures

const NOW = Date.UTC(2026, 7, 26, 9, 30);
const DAY = 86_400_000;

/** Minor units at 100 per naira: ₦23,000 is 2 300 000, ₦15,000 is 1 500 000. */
const PRICE_MINOR = 2_300_000;
const COST_MINOR = 1_500_000;

const orderedVariant: ShopVariant = {
  id: 'var_sold',
  productId: 'prod_spool',
  sku: 'SPL-RED-1KG',
  optionValues: { Colour: 'Red' },
  position: 1,
  weightGrams: 1000,
  status: 'active',
  createdAt: NOW - 40 * DAY,
  updatedAt: NOW - 2 * DAY,
  imageId: null,
  colorHex: '#aa2222',
  compareAtMinor: null,
  costMinor: null,
  price: { amount: PRICE_MINOR, currency: 'NGN' },
  available: 12,
  backorderable: false,
  /* The row the delete rule exists for. */
  everOrdered: true,
};

const freshVariant: ShopVariant = {
  id: 'var_fresh',
  productId: 'prod_spool',
  sku: 'SPL-BLU-1KG',
  optionValues: { Colour: 'Blue' },
  position: 2,
  weightGrams: 1000,
  status: 'active',
  createdAt: NOW - 10 * DAY,
  updatedAt: NOW - DAY,
  imageId: null,
  colorHex: '#2244aa',
  compareAtMinor: null,
  costMinor: COST_MINOR,
  price: { amount: PRICE_MINOR, currency: 'NGN' },
  available: 5,
  backorderable: false,
  everOrdered: false,
};

/** Stored description NULL — the editor mounts empty and never speaks. */
const spool: ShopProductDetail = {
  id: 'prod_spool',
  slug: 'recycled-petg-spool',
  title: 'Recycled Spool',
  description: null,
  status: 'active',
  category: 'Filament',
  tags: ['petg'],
  coverImageId: null,
  imageIds: [],
  createdAt: NOW - 60 * DAY,
  updatedAt: NOW - DAY,
  publishedAt: NOW - 50 * DAY,
  deletedAt: null,
  seoTitle: 'Stored SEO title',
  seoDescription: 'Stored SEO description',
  /* Migration 0580: no hand-written overview, so the box is EMPTY and the
     derived text is its placeholder. Migration 0600: on, like every product. */
  overview: null,
  overviewFallback: 'Wound from recycled PETG, a kilogram to the reel.',
  bulkDiscountEnabled: true,
  authorId: 'u_owner',
  revision: 3,
  variants: [orderedVariant, freshVariant],
};

/** A stored ProseMirror doc — the same nodes the schema hydrates. */
const DOC = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Wound from recycled PETG, a kilogram to the reel.' }],
    },
  ],
};

const described: ShopProductDetail = {
  ...spool,
  id: 'prod_desc',
  slug: 'described-spool',
  title: 'Described Spool',
  description: DOC,
  revision: 5,
  variants: [],
};

const shelved: ShopProductDetail = {
  ...spool,
  id: 'prod_shelved',
  slug: 'shelved-spool',
  title: 'Shelved Spool',
  status: 'archived',
  revision: 6,
  variants: [],
};

const categories: ShopCategory[] = [
  {
    id: 'cat_fil',
    slug: 'filament',
    name: 'Filament',
    blurb: '',
    accentHex: null,
    position: 1,
    count: 2,
    managed: true,
  },
];

// -------------------------------------------------------------- the harness

const productPath = (id: string) => `/api/shop/admin/products/${id}`;
const variantPath = (id: string) => `/api/shop/admin/variants/${id}`;

/** The server row: a product write answers `ShopProduct`, never the variants. */
function productRow(detail: ShopProductDetail): Omit<ShopProductDetail, 'variants'> {
  const { variants: _variants, ...row } = detail;
  void _variants;
  return row;
}

/** A successful CAS save: the patch applied over the row, revision bumped. */
const patchOk =
  (row: ShopProductDetail): Responder =>
  (_url, init) => {
    const body = JSON.parse(String(init.body)) as { patch: Record<string, unknown> };
    return { body: { product: { ...productRow(row), ...body.patch, revision: row.revision + 1 } } };
  };

/** The detail route plus the three reads the screen fires alongside it. */
function withProduct(row: ShopProductDetail, write?: Responder): void {
  when(productPath(row.id), (url, init) =>
    (init.method ?? 'GET') === 'GET'
      ? { body: { product: row } }
      : (write ?? patchOk(row))(url, init),
  );
  when('/api/shop/admin/categories', { items: categories });
  when('/api/shop/admin/tags', { items: [{ name: 'petg', count: 2 }] });
  when('/api/shop/admin/audit', { items: [], nextCursor: null });
  /* Migration 0600's two reads. Registered by default and overridable per test,
     because an unregistered path answers 404 and the screen would silently fall
     back to "inheriting" — which is a real branch, and not the one under test. */
  if (!handlers.has('/api/shop/admin/bulk-tiers')) {
    when('/api/shop/admin/bulk-tiers', { tiers: DEFAULT_LADDER });
  }
  if (!handlers.has(`${productPath(row.id)}/bulk-tiers`)) {
    when(`${productPath(row.id)}/bulk-tiers`, {
      tiers: [],
      inherited: true,
      effective: DEFAULT_LADDER,
    });
  }
}

/** The discount migration 0600 seeds: 5% at three, 10% at five, 15% at ten. */
const DEFAULT_LADDER = [
  { minQty: 3, percentBps: 500 },
  { minQty: 5, percentBps: 1000 },
  { minQty: 10, percentBps: 1500 },
];

/** Mounted the way `src/v2/main.tsx` mounts it: ToastHost, router, `:id`. */
function mountAt(id: string) {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={[`/products/${id}`]}>
        <Routes>
          <Route path="/products/:id" element={<ProductDetail />} />
          <Route path="/products" element={<p>the list</p>} />
        </Routes>
      </MemoryRouter>
    </ToastHost>,
  );
}

const retype = async (
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  value: string,
): Promise<void> => {
  const input = screen.getByLabelText(label);
  await user.clear(input);
  if (value !== '') await user.type(input, value);
};

/** Open the ⋯ menu of one variant row and hand back the portalled panel. */
async function openRowMenu(
  user: ReturnType<typeof userEvent.setup>,
  sku: string,
): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: `Actions for ${sku}` }));
  return await screen.findByRole('menu');
}

/** What an untouched edit of the fresh variant puts on the wire — the fixed
 *  half of both variant-PATCH assertions. NOTE what is absent: `sku` (equal to
 *  the row's), `status`, and `backorderable` (it did not move). */
const FRESH_PATCH_BASE = {
  optionValues: { Colour: 'Blue' },
  weightGrams: 1000,
  colorHex: '#2244aa',
  imageId: null,
  compareAtMinor: null,
  costMinor: COST_MINOR,
};

// ============================================================================

describe('the product editor', () => {
  it('raises the conflict banner on a stale save instead of silently overwriting', async () => {
    const user = userEvent.setup();
    /* The envelope `server/shop/app.ts` really sends on a lost CAS — code
       `stale_write`, both revisions, and the winner's product. */
    withProduct(spool, () => ({
      status: 409,
      body: {
        error: 'stale_write',
        expected: 3,
        actual: 9,
        product: { ...productRow(spool), title: 'Theirs', revision: 9 },
        requestId: 'req_stale',
      },
    }));
    mountAt(spool.id);
    await screen.findByDisplayValue('Recycled Spool');

    await retype(user, 'Title', 'Premium Recycled Spool');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('This product changed somewhere else')).toBeTruthy();

    /* The PATCH carried the CAS token the form was loaded under, and the
       whole patch — asserted key by key, with `description` ABSENT because
       the stored one is null and the editor never produced a doc. */
    expect(sent(productPath(spool.id), 'PATCH')).toEqual({
      baseRevision: 3,
      patch: {
        title: 'Premium Recycled Spool',
        category: 'Filament',
        tags: ['petg'],
        coverImageId: null,
        imageIds: [],
        seoTitle: 'Stored SEO title',
        seoDescription: 'Stored SEO description',
        /* Untouched boxes restate what was stored — the same discipline the
           SEO pair follows, so an absent key never means "unchanged". The
           fixture stores no overview, so '' is the honest restatement. */
        overview: '',
        bulkDiscountEnabled: true,
      },
    });

    /* Not silent, and not an overwrite: the operator's entry is still in the
       box, exactly one PATCH went, and nothing re-read the product over their
       edits — Reload is offered, never performed. */
    expect(screen.getByLabelText('Title')).toHaveProperty('value', 'Premium Recycled Spool');
    expect(writes()).toEqual([productPath(spool.id)]);
    expect(reads(productPath(spool.id))).toBe(1);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('runs archived→active as unarchive then publish, in that order', async () => {
    const user = userEvent.setup();
    withProduct(shelved);
    /* Two transitions, each answering the NEW product: unarchive lands on
       draft, publish on active. */
    when(`${productPath(shelved.id)}/unarchive`, {
      product: { ...productRow(shelved), status: 'draft', revision: 7 },
    });
    when(`${productPath(shelved.id)}/publish`, {
      product: { ...productRow(shelved), status: 'active', revision: 8 },
    });
    mountAt(shelved.id);
    await screen.findByDisplayValue('Shelved Spool');

    await user.click(screen.getByRole('button', { name: 'Product status' }));
    await user.click(await screen.findByRole('option', { name: /^Active/ }));

    /* The toast is built from the LAST response adopted, so it doubles as
       proof the second transition's product won. */
    await screen.findByText('Now active');

    /* The order IS the assertion — and `toEqual` over every write also pins
       that status moved through the lifecycle ops alone, never a PATCH. */
    expect(writes()).toEqual([
      `${productPath(shelved.id)}/unarchive`,
      `${productPath(shelved.id)}/publish`,
    ]);
  });

  it('offers no Delete in the row menu of a variant that has ever been ordered', async () => {
    const user = userEvent.setup();
    withProduct(spool);
    mountAt(spool.id);
    await screen.findByDisplayValue('Recycled Spool');

    /* The sold variant's menu still works — edit and discontinue are there —
       so the missing item is the rule, not a broken menu. */
    const soldMenu = await openRowMenu(user, orderedVariant.sku);
    expect(within(soldMenu).getByRole('menuitem', { name: 'Edit version…' })).toBeTruthy();
    expect(within(soldMenu).getByRole('menuitem', { name: 'Discontinue' })).toBeTruthy();
    expect(within(soldMenu).queryByRole('menuitem', { name: 'Delete version…' })).toBeNull();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    /* The never-ordered twin proves the control exists and is being withheld,
       not merely unimplemented. */
    const freshMenu = await openRowMenu(user, freshVariant.sku);
    expect(within(freshMenu).getByRole('menuitem', { name: 'Delete version…' })).toBeTruthy();
  });

  it('omits the description key while the editor never produced a doc, and carries a stored one', async () => {
    const user = userEvent.setup();
    withProduct(spool, patchOk(spool));
    mountAt(spool.id);
    await screen.findByDisplayValue('Recycled Spool');

    await retype(user, 'Title', 'Premium Recycled Spool');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent(productPath(spool.id), 'PATCH')).toBeTruthy());
    const bare = sent(productPath(spool.id), 'PATCH').patch as Record<string, unknown>;
    /* The EXACT key set, so an absent `description` cannot be confused with
       `description: undefined` — this body crossed JSON, absent is absent.
       Omitting the key is what leaves the stored description alone. */
    expect(Object.keys(bare).sort()).toEqual([
      /* Migration 0600. A boolean has no "clear" spelling, so it always
         travels — absence is the server's "leave it alone". */
      'bulkDiscountEnabled',
      'category',
      'coverImageId',
      'imageIds',
      /* Migration 0580. Travels for the same reason the SEO pair does: '' is
         the wire form of "go back to deriving it", so an emptied box must be
         distinguishable from an untouched one. */
      'overview',
      'seoDescription',
      'seoTitle',
      'tags',
      'title',
    ]);

    cleanup();
    handlers.clear();
    calls = [];

    /* The counter-case: a product WITH a stored doc hydrates the editor, and
       the same save carries that doc — so the omission above is the null
       state's, not a key this screen never sends. */
    withProduct(described, patchOk(described));
    mountAt(described.id);
    await screen.findByDisplayValue('Described Spool');

    await retype(user, 'Title', 'Described Spool, renamed');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent(productPath(described.id), 'PATCH')).toBeTruthy());
    const body = sent(productPath(described.id), 'PATCH');
    expect(body.baseRevision).toBe(5);
    expect((body.patch as Record<string, unknown>).description).toEqual(DOC);
  });

  it('clears an SEO field with an explicit empty string while an untouched one restates the stored text', async () => {
    const user = userEvent.setup();
    withProduct(spool, patchOk(spool));
    mountAt(spool.id);
    await screen.findByDisplayValue('Recycled Spool');

    /* The editors live behind the card's pencil since the Shopify-style
       rebuild — the collapsed default shows the facsimile alone. */
    await user.click(screen.getByRole('button', { name: 'Edit search engine listing' }));
    await user.clear(screen.getByLabelText('Page title'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent(productPath(spool.id), 'PATCH')).toBeTruthy());
    const patch = sent(productPath(spool.id), 'PATCH').patch as Record<string, unknown>;
    /* `''` PRESENT is the wire form of "clear it" — the key dropped instead
       would mean "keep", and clearing would be unreachable from this screen.
       The server half (`''`→NULL, absent→keep) is routes.test.ts's. */
    expect(Object.hasOwn(patch, 'seoTitle')).toBe(true);
    expect(patch.seoTitle).toBe('');
    /* The box nobody touched restates the stored text — never dropped, and
       never blanked by association with its cleared neighbour. */
    expect(patch.seoDescription).toBe('Stored SEO description');
  });

  it('names the field in the variant modal’s compare-at and cost refusals', async () => {
    const user = userEvent.setup();
    withProduct(spool);
    mountAt(spool.id);
    await screen.findByDisplayValue('Recycled Spool');

    const menu = await openRowMenu(user, freshVariant.sku);
    await user.click(within(menu).getByRole('menuitem', { name: 'Edit version…' }));
    await screen.findByRole('dialog', { name: 'Edit SPL-BLU-1KG' });

    await retype(user, 'Original price', 'abc');
    await user.click(screen.getByRole('button', { name: 'Save version' }));

    /* One shared parser, two boxes — the refusal has to say WHICH. */
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Original price: That is not an amount — digits and one decimal point only.',
    );

    await user.clear(screen.getByLabelText('Original price'));
    await retype(user, 'Cost per item', 'abc');
    await user.click(screen.getByRole('button', { name: 'Save version' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Cost per item: That is not an amount — digits and one decimal point only.',
    );
    expect(screen.queryByText(/^Original price:/)).toBeNull();

    /* Both refusals happened HERE: nothing reached the wire. */
    expect(writes()).toEqual([]);
  });

  it('sends backorderable on the variant PATCH only when it actually moved', async () => {
    const user = userEvent.setup();
    withProduct(spool);
    /* Variant writes answer `ShopVariantBase` — the page re-reads the product
       rather than adopting this, so the echo can stay minimal. */
    when(variantPath(freshVariant.id), { variant: { id: freshVariant.id, sku: freshVariant.sku } });
    mountAt(spool.id);
    await screen.findByDisplayValue('Recycled Spool');

    /* Saved untouched: the flag did not move, so it does not travel — a no-op
       `backorderable` would still bump the inventory row's clock. */
    const first = await openRowMenu(user, freshVariant.sku);
    await user.click(within(first).getByRole('menuitem', { name: 'Edit version…' }));
    await screen.findByRole('dialog', { name: 'Edit SPL-BLU-1KG' });
    await user.click(screen.getByRole('button', { name: 'Save version' }));

    await waitFor(() => expect(sent(variantPath(freshVariant.id), 'PATCH')).toBeTruthy());
    expect(sent(variantPath(freshVariant.id), 'PATCH')).toEqual(FRESH_PATCH_BASE);

    /* The modal closed and the page re-read; open it again and flip the flag. */
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const second = await openRowMenu(user, freshVariant.sku);
    await user.click(within(second).getByRole('menuitem', { name: 'Edit version…' }));
    await screen.findByRole('dialog', { name: 'Edit SPL-BLU-1KG' });
    await user.click(screen.getByRole('checkbox', { name: /Backorderable/ }));
    await user.click(screen.getByRole('button', { name: 'Save version' }));

    await waitFor(() =>
      expect(sent(variantPath(freshVariant.id), 'PATCH')).toEqual({
        ...FRESH_PATCH_BASE,
        backorderable: true,
      }),
    );
  });
});

// -------------------------------------------- the search engine listing card

describe('the search engine listing card', () => {
  /** The card, scoped — money and product names render in three other places
   *  on this screen, so every facsimile assertion stays inside it. */
  function serpCard(): HTMLElement {
    return screen
      .getByRole('heading', { name: 'Search engine listing' })
      .closest('section') as HTMLElement;
  }

  it('collapses to a Google facsimile: site, breadcrumb slug, the SEO title winning, and the price', async () => {
    withProduct(spool);
    mountAt(spool.id);
    await screen.findByDisplayValue('Recycled Spool');

    const card = serpCard();
    /* Site line is the brand; the breadcrumb is the STOREFRONT origin with the
       slug — plaspool.com per PR #85, never this admin's own host. */
    expect(within(card).getByText('PlaSpool')).toBeTruthy();
    expect(
      within(card).getByText('https://plaspool.com › products › recycled-petg-spool'),
    ).toBeTruthy();
    /* The stored SEO title beats the product title on the blue line. */
    expect(within(card).getByText('Stored SEO title')).toBeTruthy();
    expect(within(card).queryByText('Recycled Spool')).toBeNull();
    expect(within(card).getByText('Stored SEO description')).toBeTruthy();
    /* ₦23,000.00 off the variant fixture, carrying the currency code the way
       the reference draws the line. Digits and code asserted apart, because
       the symbol between them is the locale's ("₦" or "NGN"). */
    const price = within(card).getByText(/23,000\.00/);
    expect(price.textContent).toMatch(/NGN/);
    /* Collapsed means collapsed: no editors until the pencil. */
    expect(within(card).queryByLabelText('Page title')).toBeNull();
    expect(within(card).queryByLabelText('Search description')).toBeNull();
  });

  it('opens on the pencil with counters that follow the typing, past the ceiling included', async () => {
    const user = userEvent.setup();
    withProduct(spool);
    mountAt(spool.id);
    await screen.findByDisplayValue('Recycled Spool');

    await user.click(screen.getByRole('button', { name: 'Edit search engine listing' }));

    const pageTitle = screen.getByLabelText('Page title');
    expect(pageTitle).toHaveProperty('value', 'Stored SEO title');
    /* 'Stored SEO title' is 16 characters; 'Stored SEO description' is 22. */
    expect(screen.getByText('16 of 70 characters used')).toBeTruthy();
    expect(screen.getByText('22 of 160 characters used')).toBeTruthy();

    await user.type(pageTitle, '!');
    expect(screen.getByText('17 of 70 characters used')).toBeTruthy();

    /* Past the ceiling it KEEPS counting — "80 of 70" is the actionable fact,
       and a counter that clamps hides exactly the state it exists to flag. */
    await user.clear(pageTitle);
    await user.paste('x'.repeat(80));
    expect(screen.getByText('80 of 70 characters used')).toBeTruthy();

    /* The pencil is a toggle: clicking it again collapses the editors. */
    await user.click(screen.getByRole('button', { name: 'Edit search engine listing' }));
    expect(screen.queryByLabelText('Page title')).toBeNull();
  });

  it('shows the link name read-only under the shop path, never as an editor', async () => {
    const user = userEvent.setup();
    withProduct(spool);
    mountAt(spool.id);
    await screen.findByDisplayValue('Recycled Spool');

    await user.click(screen.getByRole('button', { name: 'Edit search engine listing' }));

    const handle = screen.getByLabelText('Link name') as HTMLInputElement;
    expect(handle.value).toBe('recycled-petg-spool');
    expect(handle.readOnly).toBe(true);
    expect(screen.getByText('plaspool.com/products/')).toBeTruthy();
    /* The sentence that explains WHY there is no editor here. */
    expect(screen.getByText(/It never changes after that, so links people saved keep working/)).toBeTruthy();
  });
});

// --------------------------------------------------- the bulk discounts (0600)

describe('the bulk quantity discounts', () => {
  it('shows the inherited shop default, and says that is what it is', async () => {
    withProduct(spool);
    mountAt(spool.id);

    expect(await screen.findByText('Shop default')).toBeTruthy();
    // The three seeded rows, rendered as percentages rather than basis points.
    expect(screen.getByText('3 or more')).toBeTruthy();
    expect(screen.getByText('5% off')).toBeTruthy();
    expect(screen.getByText('10% off')).toBeTruthy();
    expect(screen.getByText('15% off')).toBeTruthy();
    // Inherited means no editing controls at all.
    expect(screen.queryByLabelText('Smallest quantity for row 1')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save discounts' })).toBeNull();
  });

  it('prices each row off the CHEAPEST variant, rounded the way the engine rounds', async () => {
    withProduct(spool);
    mountAt(spool.id);
    await screen.findByText('Shop default');
    // Both variants are 2 300 000 minor. 10% off is 2 070 000 — round the UNIT
    // and then multiply, exactly as `computeTotals` does, so the preview and the
    // charge cannot disagree.
    expect(screen.getByText(/20,700/)).toBeTruthy();
  });

  it('seeds an override FROM the default rather than from an empty table', async () => {
    // "Set different discounts" almost always means "the usual ones, adjusted";
    // an empty table with an Add button makes the common case the most work.
    const user = userEvent.setup();
    withProduct(spool);
    mountAt(spool.id);

    await user.click(await screen.findByRole('button', { name: 'Set different discounts for this product' }));
    expect(screen.getByText('This product only')).toBeTruthy();
    expect((screen.getByLabelText('Smallest quantity for row 1') as HTMLInputElement).value).toBe(
      '3',
    );
    expect((screen.getByLabelText('Discount for row 2') as HTMLInputElement).value).toBe('10');
  });

  it('PUTs basis points, not percent, on its own endpoint', async () => {
    const user = userEvent.setup();
    withProduct(spool);
    when(productPath(spool.id) + '/bulk-tiers', (_url, init) =>
      (init.method ?? 'GET') === 'GET'
        ? { body: { tiers: [], inherited: true, effective: DEFAULT_LADDER } }
        : {
            body: {
              tiers: [{ minQty: 4, percentBps: 1250 }],
              inherited: false,
              effective: [{ minQty: 4, percentBps: 1250 }],
            },
          },
    );
    mountAt(spool.id);

    await user.click(await screen.findByRole('button', { name: 'Set different discounts for this product' }));
    // Rows 3 and 2 go first, so the assertion is about one row and not three.
    await user.click(screen.getByRole('button', { name: 'Remove row 3' }));
    await user.click(screen.getByRole('button', { name: 'Remove row 2' }));
    await retype(user, 'Smallest quantity for row 1', '4');
    await retype(user, 'Discount for row 1', '12.5');
    await user.click(screen.getByRole('button', { name: 'Save discounts' }));

    await waitFor(() =>
      expect(sent(productPath(spool.id) + '/bulk-tiers', 'PUT')).toEqual({
        // 12.5% is 1250 bps. Holding percent in state would have lost the .5.
        tiers: [{ minQty: 4, percentBps: 1250 }],
      }),
    );
    // A LADDER SAVE IS NOT A PRODUCT SAVE — separate record, separate endpoint.
    expect(writes()).not.toContain(productPath(spool.id));
  });

  it('refuses a row below 2 in the screen, naming the rule rather than the field path', async () => {
    // The route answers 400 `tiers.0.minQty`, which is not a sentence anybody
    // can act on. The refusal happens here and nothing is sent.
    const user = userEvent.setup();
    withProduct(spool);
    mountAt(spool.id);

    await user.click(await screen.findByRole('button', { name: 'Set different discounts for this product' }));
    await retype(user, 'Smallest quantity for row 1', '1');
    await user.click(screen.getByRole('button', { name: 'Save discounts' }));

    expect(await screen.findByText(/quantity of 2 or more/)).toBeTruthy();
    expect(writes()).not.toContain(productPath(spool.id) + '/bulk-tiers');
  });

  it('refuses two rows at the same quantity, and says which one', async () => {
    const user = userEvent.setup();
    withProduct(spool);
    mountAt(spool.id);

    await user.click(await screen.findByRole('button', { name: 'Set different discounts for this product' }));
    await retype(user, 'Smallest quantity for row 2', '3');
    await user.click(screen.getByRole('button', { name: 'Save discounts' }));

    expect(await screen.findByText(/Two rows both start at 3/)).toBeTruthy();
    expect(writes()).not.toContain(productPath(spool.id) + '/bulk-tiers');
  });

  it('resets with an EMPTY put — the one spelling that means "inherit again"', async () => {
    const user = userEvent.setup();
    withProduct(spool);
    when(productPath(spool.id) + '/bulk-tiers', (_url, init) =>
      (init.method ?? 'GET') === 'GET'
        ? {
            body: {
              tiers: [{ minQty: 6, percentBps: 800 }],
              inherited: false,
              effective: [{ minQty: 6, percentBps: 800 }],
            },
          }
        : { body: { tiers: [], inherited: true, effective: DEFAULT_LADDER } },
    );
    mountAt(spool.id);

    // It arrives OVERRIDING, because the server said `inherited: false`.
    expect(await screen.findByText('This product only')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Use the shop default' }));

    await waitFor(() =>
      expect(sent(productPath(spool.id) + '/bulk-tiers', 'PUT')).toEqual({ tiers: [] }),
    );
    expect(await screen.findByText('Shop default')).toBeTruthy();
  });

  it('hides the whole table when the product has bulk discounts switched off', async () => {
    const user = userEvent.setup();
    withProduct(spool);
    mountAt(spool.id);

    await screen.findByText('Shop default');
    await user.click(screen.getByRole('checkbox', { name: /quantity discount on this product/ }));
    expect(screen.queryByText('Shop default')).toBeNull();
    expect(screen.queryByText('3 or more')).toBeNull();
  });
});
