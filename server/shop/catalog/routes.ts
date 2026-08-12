import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, readJsonOrEmpty, readQuery, str } from '../../middleware/errors';
import { requireAuth } from '../../middleware/session';
import { currentDb, currentUser } from '../../app-env';
import type { AppEnv } from '../../app-env';
import { NotFoundError } from '../../repo/errors';
import { money } from '../../../shared/commerce/money';
import type { DocNode } from '../../../shared/types';
import {
  archiveProduct,
  createProduct,
  getActiveProductBySlug,
  getProduct,
  publishProduct,
  restoreProduct,
  saveProduct,
  trashProduct,
  unarchiveProduct,
  unpublishProduct,
} from './products';
import { listProducts } from './query';
import { toStorefrontProduct } from './mapping';
import {
  createVariant,
  getVariant,
  listVariantsWithPrices,
  updateVariant,
} from './variants';
import { priceHistory, setPrice } from './prices';
import { adjustInventory, getInventory } from './inventory';
import type { ProductPatch } from './types';

/**
 * Catalog's HTTP surface (brief §6).
 *
 * MOUNTED UNDER `/api/shop` BY `server/shop/app.ts`, which `server/index.ts`
 * mounts in turn. Storefront routes are public; admin routes sit behind
 * `requireAuth()` (contract §10).
 *
 * `requireAuth()` IS ATTACHED PER ROUTE, NEVER AS `routes.use('*', …)`, and that
 * is measured rather than stylistic. `app.route(prefix, router)` flattens a
 * router into its parent, so a blanket `use` here would apply to every path
 * under the prefix — including ones this file has never heard of. On the blog
 * side that turned an unrouted `/api/nothing-here` into a **401 instead of a
 * 404**: the guard ran, found no session, and refused a request that had no
 * handler to reach. Per route it cannot leak, and forgetting one fails that
 * route's own "401 without a session" case.
 *
 * EVERY BODY IS PARSED WITH A `.strict()` SCHEMA, so an unknown key is a 400
 * rather than a silently ignored field. `slug` and `status` are the sharpest
 * cases: both are absent from `ProductPatch` on purpose — slugs are
 * server-authoritative and a status change must go through the lifecycle routes
 * — so a request carrying either is refused rather than accepted-and-discarded,
 * which would leave the caller believing it had set something it had not.
 *
 * EVERY STRING FIELD USES `str()`, NOT `z.string()`. A U+0000 in a `text` bind
 * is SQLSTATE 22021, which has no row in the error table and answers 500 — a
 * status the client's retry policy re-sends five times for input that can never
 * be accepted. `server/nul-bytes.test.ts` walks every registered route and fails
 * if a NUL in a path segment or a string body field produces a 5xx, so these
 * routes either inherit this or fail that suite.
 */
export const routes = new Hono<AppEnv>();

const auth = requireAuth();

// ------------------------------------------------------------------ schemas

const ProductPatchBody = z
  .object({
    title: str(),
    /*
     * `z.unknown()` rather than a recursive document schema. `validateDoc` in
     * `shared/validate.ts` is the single authority on what a document may
     * contain — allow-listed nodes and marks, href protocols, depth, node count,
     * serialised size — and it reports a `path` that becomes the 422. A second,
     * weaker Zod copy of those rules would answer 400 where the contract says
     * 422 and would drift from the real one the first time a node type is added.
     */
    description: z.unknown(),
    category: str().max(400),
    tags: z.array(str()).max(64),
    coverImageId: str().max(300).nullable(),
    imageIds: z.array(str().max(300)).max(100),
  })
  .partial()
  .strict();

type ProductPatchInput = z.infer<typeof ProductPatchBody>;

/**
 * The parsed body as a `ProductPatch`.
 *
 * The only cast is `description`, from `unknown` to `DocNode` — honest because
 * `saveProduct`/`createProduct` immediately run `validateDoc` on it and throw a
 * 422 if it is not one. The alternative, a Zod schema claiming to know what a
 * document is, would be the lie.
 */
function toPatch(body: ProductPatchInput): ProductPatch {
  const patch: ProductPatch = { ...body, description: undefined };
  if ('description' in body) patch.description = body.description as DocNode;
  else delete patch.description;
  return patch;
}

const PatchBody = z
  .object({
    patch: ProductPatchBody,
    /**
     * The CAS token. Optional in the type because `saveProduct` treats its
     * absence as "no client base, do not refuse" — but every admin form sends
     * one, and without it a second tab silently overwrites the first.
     */
    baseRevision: z.number().int().min(1).optional(),
    note: str().max(400).optional(),
  })
  .strict();

const ListQueryParams = z
  .object({
    sort: z.enum(['newest', 'price_asc', 'price_desc', 'alphabetical']).default('newest'),
    category: str().optional(),
    cursor: str().optional(),
    /** `pageLimit` decides the range and answers 400 itself; this only makes a
     *  non-numeric `?limit=abc` a 400 here rather than a NaN there. */
    limit: z.coerce.number().int().optional(),
  })
  /*
   * STRICT, LIKE THE BODIES. A mistyped filter that is silently ignored is worse
   * than a refusal: `?categoryy=mugs` would quietly return the whole catalogue
   * and look like a bug in the storefront.
   */
  .strict();

const AdminListQueryParams = ListQueryParams.extend({
  status: z.enum(['draft', 'active', 'archived', 'trash']).optional(),
}).strict();

const CreateVariantBody = z
  .object({
    sku: str().min(1).max(200),
    optionValues: z.record(str().max(100), str().max(200)).optional(),
    position: z.number().int().min(0).optional(),
    weightGrams: z.number().int().min(0).max(10_000_000).nullable().optional(),
    onHand: z.number().int().min(0).max(100_000_000).optional(),
    backorderable: z.boolean().optional(),
    /** The photograph of this colour (migration 0009). */
    imageId: str().min(1).max(200).nullable().optional(),
  })
  .strict();

const UpdateVariantBody = z
  .object({
    sku: str().min(1).max(200),
    optionValues: z.record(str().max(100), str().max(200)),
    position: z.number().int().min(0),
    weightGrams: z.number().int().min(0).max(10_000_000).nullable(),
    status: z.enum(['active', 'discontinued']),
    /** `null` clears the colour photograph; a string sets it. */
    imageId: str().min(1).max(200).nullable(),
  })
  .partial()
  .strict();

/**
 * A price on the wire is minor units plus a currency code, never a decimal.
 *
 * `z.number().int()` and not `z.number()`: `19.99` is refused at the boundary
 * rather than rounded somewhere later, which is contract §10's "no floats for
 * money" made enforceable at the one place a float could enter. `money()` then
 * refuses it a second time, and the column's `CHECK` a third.
 *
 * THE CURRENCY IS SHAPE-CHECKED HERE AND NOT ONLY IN `money()`, AND THAT IS A
 * BUG FIX. `str().length(3)` alone accepts `"gbp"`, which `money()` then refuses
 * by throwing `MoneyError` — a programming-error class with no row in the error
 * table, so it fell through to a **500**. Measured: `PUT
 * /admin/variants/:id/price` with `{"currency":"gbp"}` answered 500, and a 500
 * is transient by the client's retry policy — five retries with backoff for a
 * request that can never succeed, which is the exact failure spec §8's table
 * exists to prevent. The regex makes it a 400 that names the field; `money()`
 * stays as the backstop for any caller that is not this route.
 */
const PriceBody = z
  .object({
    amount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    currency: str().regex(/^[A-Z]{3}$/, 'iso4217'),
    /**
     * WHY the price moved (migration 0009). Optional, because every price
     * already written has none and a required field would make the audit view
     * lie about them — see the migration's own note.
     *
     * A stock change has required one since it was written. A price change is
     * the other half of the same question, and "distributor raised the reel
     * price" is the difference between an audit trail somebody can act on and a
     * row saying 18,500 became 22,000 on a Tuesday.
     */
    reason: str().min(1).max(400).optional(),
  })
  .strict();

const AdjustBody = z
  .object({
    /** Signed, and never zero: an adjustment of nothing is a caller bug. */
    delta: z.number().int(),
    /** MANDATORY. An unexplained stock change is the thing you will most wish
     *  you had logged (brief §6). */
    reason: str().min(1).max(400),
  })
  .strict();

// --------------------------------------------------------------- storefront

/**
 * Public, and deliberately so. A shop that requires a login to see what it sells
 * has no customers. `listProducts` without `includeUnpublished` applies the
 * storefront predicate — active, not trashed — inside the query rather than here.
 *
 * `toStorefrontProduct` ADDS `coverImageUrl` / `imageUrls` HERE AND NOT IN THE
 * QUERY. The URLs point at `/api/public/images/:id`, which serves an image only
 * while an ACTIVE product references it; the admin list below shares
 * `listProducts` and sees drafts, where every one of those URLs would 404. Doing
 * it in the mapper would put a guaranteed-broken link on the admin surface, so it
 * is done on the two routes where the resolution is actually true.
 */
routes.get('/products', async (c) => {
  const q = readQuery(c, ListQueryParams);
  const page = await listProducts(currentDb(c), q);
  return c.json({ ...page, items: page.items.map(toStorefrontProduct) });
});

/**
 * By slug, with variants, prices and availability in one response.
 *
 * A product page needs all four; making the client fetch variants separately
 * would put a second round trip on the critical path of every product view, and
 * would let the two halves disagree about whether the product is still on sale.
 */
routes.get('/products/:slug', async (c) => {
  const db = currentDb(c);
  const slug = pathParam(c, 'slug');
  const product = await getActiveProductBySlug(db, slug);
  if (!product) throw new NotFoundError(slug);
  const variants = await listVariantsWithPrices(db, product.id);
  return c.json({ product: { ...toStorefrontProduct(product), variants } });
});

/**
 * `GET /variants/:id/availability` — the number a "2 left" badge renders.
 *
 * DELIBERATELY NOT A PROMISE. It is `on_hand - reserved` at the instant of the
 * read, and any quantity of it can be taken before the customer clicks. The
 * authority on whether a sale may happen is `reserve`'s own predicate, and this
 * endpoint exists so a storefront can be honest about scarcity, not so it can
 * decide anything.
 */
routes.get('/variants/:id/availability', async (c) => {
  const db = currentDb(c);
  const id = pathParam(c, 'id');
  const variant = await getVariant(db, id);
  if (!variant) throw new NotFoundError(id);
  const level = await getInventory(db, id);
  return c.json({
    variantId: id,
    // Null when the variant has no inventory row at all. A shop that renders
    // "0 left" for something nobody has stocked is telling the customer
    // something different from "we do not track this".
    available: level?.available ?? null,
    backorderable: level?.backorderable ?? false,
  });
});

// -------------------------------------------------------------------- admin

routes.get('/admin/products', auth, async (c) => {
  const q = readQuery(c, AdminListQueryParams);
  return c.json(await listProducts(currentDb(c), { ...q, includeUnpublished: true }));
});

/** The admin read, which unlike the storefront one sees drafts and the trash. */
routes.get('/admin/products/:id', auth, async (c) => {
  const db = currentDb(c);
  const id = pathParam(c, 'id');
  const product = await getProduct(db, id);
  if (!product) throw new NotFoundError(id);
  const variants = await listVariantsWithPrices(db, id);
  return c.json({ product: { ...product, variants } });
});

routes.post('/admin/products', auth, async (c) => {
  const body = await readJsonOrEmpty(c, ProductPatchBody);
  const product = await createProduct(currentDb(c), currentUser(c), toPatch(body));
  return c.json({ product }, 201);
});

/**
 * A stale `baseRevision` throws `StaleProductWriteError`, which `shop/app.ts`
 * renders as a 409 carrying `expected`, `actual` AND the server's current
 * product — so an admin form's "load theirs" needs no second request (brief §4).
 */
routes.patch('/admin/products/:id', auth, async (c) => {
  const { patch, baseRevision, note } = await readJson(c, PatchBody);
  const product = await saveProduct(currentDb(c), pathParam(c, 'id'), toPatch(patch), {
    actor: currentUser(c),
    baseRevision,
    note,
  });
  return c.json({ product });
});

/**
 * NO `baseRevision` IN THE BODY, AND THAT IS THE CONTRACT, NOT AN OMISSION.
 * These are server-derived: there is no human decision to surface, so the
 * repository re-reads, re-derives and re-CASes up to three times, pinning the
 * `lifecycle_generation` it first saw. A concurrent ordinary save therefore does
 * not refuse a publish (the retry wins and re-derives), and any concurrent
 * LIFECYCLE change by anyone does (the pin cannot match) — which is the only way
 * a `trash` that lost to a deliberate `restore` fails instead of silently
 * re-trashing a product somebody had just rescued.
 *
 * EACH RETURNS THE NEW PRODUCT so a form can adopt the bumped revision without a
 * second request. Without that, the next save would carry a `baseRevision` the
 * server has already passed and 409 against itself — the exact bug GAUNTLET
 * Round 2 found on the blog, where clicking Publish and continuing to type lost
 * everything typed next.
 */
const TRANSITIONS = {
  publish: publishProduct,
  unpublish: unpublishProduct,
  archive: archiveProduct,
  unarchive: unarchiveProduct,
  restore: restoreProduct,
} as const;

for (const [name, run] of Object.entries(TRANSITIONS)) {
  routes.post(`/admin/products/:id/${name}`, auth, async (c) =>
    c.json({ product: await run(currentDb(c), pathParam(c, 'id'), currentUser(c)) }),
  );
}

/**
 * SOFT DELETE — to the trash, never destroyed (brief §6).
 *
 * `DELETE` is the method a REST client expects, and `trashProduct` is what it
 * does. There is deliberately no hard-delete route: a product referenced by an
 * order line that snapshots its price must not be able to vanish, and the only
 * way to be sure of that without a foreign key across a subsystem boundary
 * (which R3 forbids) is not to offer the operation.
 */
routes.delete('/admin/products/:id', auth, async (c) =>
  c.json({ product: await trashProduct(currentDb(c), pathParam(c, 'id'), currentUser(c)) }),
);

routes.post('/admin/products/:id/variants', auth, async (c) => {
  const body = await readJson(c, CreateVariantBody);
  const variant = await createVariant(
    currentDb(c),
    pathParam(c, 'id'),
    body,
    currentUser(c),
  );
  return c.json({ variant }, 201);
});

routes.patch('/admin/variants/:id', auth, async (c) => {
  const body = await readJson(c, UpdateVariantBody);
  return c.json({ variant: await updateVariant(currentDb(c), pathParam(c, 'id'), body) });
});

/**
 * `PUT`, not `POST`: setting the price is idempotent in intent — "the price is
 * now X" — even though it appends a row. The row is the history, not the
 * resource.
 */
routes.put('/admin/variants/:id/price', auth, async (c) => {
  const body = await readJson(c, PriceBody);
  // `money()` is the one constructor, and it refuses a non-integer amount and a
  // malformed currency code before either reaches a column.
  const price = money(body.amount, body.currency);
  return c.json({
    price: await setPrice(currentDb(c), pathParam(c, 'id'), price, body.reason ?? null),
  });
});

/**
 * The price history, newest first.
 *
 * NOT IN BRIEF §6'S LIST, AND ADDED ANYWAY. §2 justifies effective-dated price
 * ROWS rather than a column on exactly one ground: "the catalog still needs to
 * answer 'what did this cost on Tuesday' for reconciliation, and a column
 * cannot". Storing the history and exposing no way to read it would leave the
 * design's whole justification as a table nobody can query without psql — the
 * "mechanism wired to no caller" shape both prior gauntlets kept finding.
 *
 * Admin-only: what a product used to cost is commercial information, and the
 * storefront has no use for anything but the current price.
 */
routes.get('/admin/variants/:id/prices', auth, async (c) => {
  const db = currentDb(c);
  const id = pathParam(c, 'id');
  const variant = await getVariant(db, id);
  if (!variant) throw new NotFoundError(id);
  return c.json({ prices: await priceHistory(db, id) });
});

routes.post('/admin/inventory/:variantId/adjust', auth, async (c) => {
  const { delta, reason } = await readJson(c, AdjustBody);
  const level = await adjustInventory(
    currentDb(c),
    pathParam(c, 'variantId'),
    delta,
    reason,
    currentUser(c),
  );
  return c.json({ inventory: level });
});
