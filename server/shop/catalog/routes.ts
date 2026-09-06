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
import { listTiers, replaceTiers, resolveTiers, resolveTiersFor } from './bulk-tiers';
import { toStorefrontProduct, toStorefrontVariant } from './mapping';
import {
  createVariant,
  deleteVariant,
  getVariant,
  listVariantsForProducts,
  listVariantsWithPrices,
  updateVariant,
} from './variants';
import { priceHistory, setPrice } from './prices';
import { adjustInventory, getInventory } from './inventory';
import {
  revalidateCatalog,
  revalidateProductById,
  revalidateProducts,
  revalidateVariantProduct,
} from './revalidate';
import {
  createShopCategory,
  deleteShopCategory,
  listPublicShopCategories,
  listShopCategoriesUnion,
  normaliseAccentHex,
  normaliseShopCategoryBlurb,
  normaliseShopCategoryName,
  normaliseSlug,
  updateShopCategory,
} from './categories';
import type { ShopCategoryPatch } from './categories';
import type { ProductPatch } from './types';
import { csvRoutes } from './csv';
import { addOnRoutes } from './add-ons/routes';

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
    /**
     * Migration 0440. `null` (or `''`, normalised in the repo) clears back to
     * "use the defaults". The caps are generous over the ~70/~160 characters
     * search engines render — those are UI guidance, not validity — and exist
     * because `shop_products` has no byte-ceiling machinery: no tsvector hangs
     * off it, so a route-level bound that names the field is the whole defence.
     */
    seoTitle: str().max(300).nullable(),
    seoDescription: str().max(500).nullable(),
    /**
     * Migration 0580. `null` (or `''`, normalised in the repo) clears back to
     * "derive it from the description".
     *
     * 500 is generous over the ~160 characters a card renders — that is UI
     * guidance, not validity — and the cap lives here rather than in the schema
     * because `shop_products` has no byte-ceiling machinery, so a route-level
     * bound that NAMES the field is the whole defence. Matches 0440's reasoning.
     */
    overview: str().max(500).nullable(),
    /** Migration 0600. Absent leaves it alone; there is no "clear". */
    bulkDiscountEnabled: z.boolean(),
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

/**
 * One ladder, as the admin editor PUTs it.
 *
 * WHOLE-LADDER REPLACEMENT AND NOT PER-RUNG CRUD. A ladder is read and reasoned
 * about as a table — "5% at three, 10% at five" — so editing it a rung at a time
 * would let a form submit land as three requests, two of which can fail, leaving
 * a ladder nobody chose. One PUT is one intent.
 *
 * `.max(12)` because a ladder a customer cannot hold in their head is not a
 * pricing policy, and because it bounds the statement `replaceTiers` builds.
 *
 * The BOUNDS ARE RESTATED HERE rather than left to the CHECK constraints: a
 * 23514 surfaces as a 500 naming a constraint the caller has never heard of,
 * and `minQty >= 2` needs to come back as a 400 that says so.
 */
const BulkTierBody = z
  .object({
    minQty: z.number().int().min(2).max(100_000),
    /** Basis points. 10 000 is 100%, so the 5000 ceiling is 50%. */
    percentBps: z.number().int().min(1).max(5000),
  })
  .strict();

const BulkTiersBody = z.object({ tiers: z.array(BulkTierBody).max(12) }).strict();

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
  /**
   * "Also tell me how many there are in total." A STRING enum, not z.boolean():
   * a query string carries text, and this is the `dryRun` shape from
   * server/routes/images.ts rather than a second convention. Opt-in because
   * the count is a second scan the paging is built to avoid.
   */
  withTotal: z.enum(['1', 'true', '0', 'false']).optional(),
}).strict();

const CreateVariantBody = z
  .object({
    /** OPTIONAL — the server derives one from the title and the options when
     *  it is absent. See `server/shop/catalog/sku.ts`. */
    sku: str().min(1).max(200).optional(),
    optionValues: z.record(str().max(100), str().max(200)).optional(),
    position: z.number().int().min(0).optional(),
    weightGrams: z.number().int().min(0).max(10_000_000).nullable().optional(),
    onHand: z.number().int().min(0).max(100_000_000).optional(),
    backorderable: z.boolean().optional(),
    /** The photograph of this colour (migration 0009). */
    imageId: str().min(1).max(200).nullable().optional(),
    /**
     * The colour code of this option (migration 0010). Case-tolerant here —
     * `#AB12CD` is a colour somebody copied from a design tool, not a mistake —
     * and lowercased in the repository, because the column's CHECK is
     * lowercase-only.
     */
    colorHex: str().regex(/^#[0-9a-fA-F]{6}$/, 'hex').nullable().optional(),
    /**
     * Minor units (migrations 0400/0420). `.max(2_147_483_647)` IS THE COLUMN'S
     * CEILING, not a style choice: both are `integer` (int4), and a value past
     * it would be a 22003 the error table has no row for — a 500 retried five
     * times for input that can never be accepted. `PriceBody.amount` now
     * carries the same ceiling for the same int4 column.
     */
    compareAtMinor: z.number().int().min(0).max(2_147_483_647).nullable().optional(),
    costMinor: z.number().int().min(0).max(2_147_483_647).nullable().optional(),
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
    /** `null` clears the colour code; shape-checked as on create. */
    colorHex: str().regex(/^#[0-9a-fA-F]{6}$/, 'hex').nullable(),
    /** `null` clears — "no longer on sale". Bounds as on create (int4 ceiling). */
    compareAtMinor: z.number().int().min(0).max(2_147_483_647).nullable(),
    /** `null` clears. Admin-only on the wire — the storefront mapper strips it. */
    costMinor: z.number().int().min(0).max(2_147_483_647).nullable(),
    /**
     * The inventory-policy flip the edit modal was missing (owner's queue,
     * 2026-08-25). Lands on `shop_inventory` inside `updateVariant`'s one
     * statement; a patch carrying ONLY this key is still a valid patch.
     */
    backorderable: z.boolean(),
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
    /**
     * `.max` IS THE COLUMN'S CEILING. `shop_prices.amount` is `integer`
     * (int4), and this said MAX_SAFE_INTEGER until 2026-08-25 — so 2^31
     * passed Zod and `money()` alike and died at the column with SQLSTATE
     * 22003, which has no row in the error table and answered 500: the exact
     * lowercase-currency failure documented above, one field over.
     */
    amount: z.number().int().min(0).max(2_147_483_647),
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
    /**
     * OPTIONAL since 2026-09-03, on the owner's instruction — it was mandatory
     * from the day it was written.
     *
     * The audit argument has not changed and the ledger is still kept: an
     * unexplained stock change is the thing you will most wish you had logged
     * (brief §6). What changed is the judgement about what a REQUIRED field
     * actually buys. A count nobody can correct without composing a sentence is
     * a count that stays wrong, and "stock" typed to get past the form is a
     * worse record than no reason at all, because it reads like one.
     *
     * `.min(1)` SURVIVES INSIDE THE `.optional()`, deliberately. Omitting the
     * key is "nobody said"; an empty STRING is a client that built the field and
     * sent nothing in it, which is a caller bug worth naming. Both end up as
     * NULL in the event either way — see `adjustInventory`.
     */
    reason: str().min(1).max(400).optional(),
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
/**
 * VARIANTS ARE INCLUDED, and that is what makes one request enough.
 *
 * Without them a storefront had to read this list and then fetch one detail
 * response per product to learn any price, because `price` lives on a variant.
 * The consumer is Next.js on Cloudflare Workers, where a request has a
 * 50-subrequest cap on the free plan and a CPU budget that
 * plaspool-storefront#9 was only just brought inside — so a fifty-product
 * catalogue would have failed at the platform level rather than merely rendered
 * slowly. `listVariantsForProducts` moves that fan-out into one SQL statement.
 *
 * ADDITIVE, so nothing that read this shape before has to change: `items` keeps
 * every field it had and gains `variants`, exactly as the detail route already
 * spells it.
 */
routes.get('/products', async (c) => {
  const db = currentDb(c);
  const q = readQuery(c, ListQueryParams);
  const page = await listProducts(db, q);
  const ids = page.items.map((p) => p.id);
  /* Both fan-outs in ONE statement each, not one per card: a fifty-product
     catalogue on Cloudflare Workers has a 50-subrequest ceiling, which is the
     same reason `listVariantsForProducts` exists. */
  const [variants, tiers] = await Promise.all([
    listVariantsForProducts(db, ids),
    resolveTiers(db, ids),
  ]);
  return c.json({
    ...page,
    items: page.items.map((p) => ({
      ...toStorefrontProduct(p, { bulkTiers: tiers.get(p.id) ?? [] }),
      /* `?? []` and not the map's absence: a JSON response cannot have a
         `Map#get` miss, and a product with no variants is a real state that
         reads as an empty list on the wire. */
      variants: (variants.get(p.id) ?? []).map(toStorefrontVariant),
    })),
  });
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
  const [variants, bulkTiers] = await Promise.all([
    listVariantsWithPrices(db, product.id),
    resolveTiersFor(db, product.id),
  ]);
  return c.json({
    product: {
      ...toStorefrontProduct(product, { bulkTiers }),
      variants: variants.map(toStorefrontVariant),
    },
  });
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

/**
 * `GET /categories` — the storefront's category list (migration 0200).
 *
 * PUBLIC, beside `/products` rather than in a `/public/*` router, because it is
 * catalogue data and `/products` is the surface it is read with. The reviews
 * public router exists in its own file for a reason that does not apply here:
 * it is mounted ABOVE `sessionMiddleware` so `Cache-Control: public` is safe by
 * construction. Nothing here sets a cache header — the storefront's own ISR sits
 * in front, exactly as it does for `/products` — so there is no shared-cache
 * hazard to design against.
 *
 * MANAGED ROWS ONLY, and `listPublicShopCategories` sets out why: an unmanaged
 * category has no slug, and `/store/<slug>` has nothing to route to.
 */
routes.get('/categories', async (c) => {
  readQuery(c, NoCategoryParams);
  return c.json({ items: await listPublicShopCategories(currentDb(c)) });
});

// -------------------------------------------------------------------- admin

/**
 * The managed-category surface (migration 0200).
 *
 * THE WRITES ARE HERE AND NOT IN `server/shop/admin/routes.ts`, which states in
 * its own header that "nothing in this directory writes anything" and derives
 * its blanket `requireAuth()` decision from that. Catalogue writes live in this
 * file; putting three mutations in a documented read-only directory would break
 * an invariant somebody relied on when they chose that permission.
 *
 * `requireAuth()` AND NOT `requireOwner()`, matching `/admin/products`: a writer
 * who may create and publish a product may name the category it goes in. The
 * standing gap this file's header records — that the catalog has no owner-only
 * route at all — is unchanged by that and is still not closed here.
 */
/** Both category reads take nothing, and say so — the `/admin/tags` rule. */
const NoCategoryParams = z.object({}).strict();

const CategoryBody = z
  .object({
    name: str().min(1),
    blurb: str().optional(),
    /** `null` is "no tint", which is a real choice and not the same as absent. */
    accentHex: str().nullable().optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict();

const CategoryPatchBody = z
  .object({
    name: str().min(1).optional(),
    /**
     * Moving the URL, which is deliberate and separate from a rename — the rule
     * `ProductPatch` states. A rename alone never touches it.
     */
    slug: str().min(1).optional(),
    blurb: str().optional(),
    accentHex: str().nullable().optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict();

const CategoryDeleteQuery = z.object({ reassign: str().max(400).optional() }).strict();

/**
 * `-` MEANS UNCATEGORISED — the marker `server/routes/categories.ts` established
 * for the blog, adopted verbatim rather than reinvented.
 *
 * A query parameter cannot carry "the empty string" in a way every layer agrees
 * about: `URL.searchParams` and the client's own `url()` helper both drop an
 * empty value entirely, so "move them to no category at all" needs a spelling
 * that survives the round trip. The cost is that a category literally named `-`
 * cannot be a reassignment target, which is the cheapest thing on the table to
 * give up.
 *
 * `undefined` (the parameter absent) is NOT the same as `-`: absent means "only
 * delete if nothing uses it", which is the refusal path.
 *
 * A QUERY PARAMETER RATHER THAN A BODY, also following the blog. A DELETE with a
 * body is under-specified across HTTP clients and caches, and this one has
 * exactly one scalar to carry.
 */
const UNCATEGORISED_MARKER = '-';

function reassignTarget(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (raw === UNCATEGORISED_MARKER || raw.trim() === '') return '';
  return normaliseShopCategoryName(raw, 'reassign');
}

// ------------------------------------------------------- storefront freshness

/**
 * EVERY ADMIN WRITE BELOW ENDS BY PUSHING A CACHE PURGE TO THE STOREFRONT, and
 * the rules are the same at all twelve of them:
 *
 * - **After the write, not before.** The call sits between the awaited
 *   repository function and the `c.json(...)`, so a write that threw never
 *   purges — a 409 from a stale `baseRevision` changed nothing and must not
 *   cost the storefront a re-render of every catalogue page.
 * - **Never awaited, never able to fail.** `revalidate*` schedules and returns
 *   synchronously, and swallows everything. A save's status code does not
 *   depend on a cache somewhere else. See `revalidate.ts`.
 * - **A product-scoped write sends the product's slug**; a write that is not
 *   scoped to one product sends nothing and purges the lists only. The endpoint
 *   purges the lists either way, so the slug form is never followed by a second
 *   unscoped call.
 *
 * WHY THERE IS NO DEBOUNCE HERE. Every route below is an explicit save: the
 * shop admin has a Save button (`src/routes/ShopProducts.tsx`) and no draft
 * autosave loop — unlike the blog editor, which fires `PATCH /api/posts/:id` on
 * a keystroke timer through `src/editor/useAutosave.ts`. If shop products ever
 * grow an autosave, it must not reach these routes on the timer, because each
 * purge costs the storefront a full re-render of every catalogue page.
 */

/** The union of the managed table and the values actually in use. */
routes.get('/admin/categories', auth, async (c) => {
  readQuery(c, NoCategoryParams);
  return c.json({ items: await listShopCategoriesUnion(currentDb(c)) });
});

routes.post('/admin/categories', auth, async (c) => {
  const body = await readJson(c, CategoryBody);
  const category = await createShopCategory(currentDb(c), {
    name: normaliseShopCategoryName(body.name, 'name'),
    blurb: normaliseShopCategoryBlurb(body.blurb ?? '', 'blurb'),
    accentHex: normaliseAccentHex(body.accentHex ?? null, 'accentHex'),
    position: body.position ?? 0,
  });
  // Not scoped to one product: the lists only.
  revalidateCatalog();
  return c.json({ category }, 201);
});

/**
 * A rename rewrites every product carrying the old value, in one statement, and
 * reports how many moved. Renaming onto another MANAGED name is refused with a
 * 409 carrying the row that already holds it — merging two managed rows is a
 * different operation with a different confirmation.
 */
routes.patch('/admin/categories/:id', auth, async (c) => {
  const body = await readJson(c, CategoryPatchBody);
  const patch: ShopCategoryPatch = {};
  if (body.name !== undefined) patch.name = normaliseShopCategoryName(body.name, 'name');
  if (body.slug !== undefined) patch.slug = normaliseSlug(body.slug);
  if (body.blurb !== undefined) patch.blurb = normaliseShopCategoryBlurb(body.blurb, 'blurb');
  if ('accentHex' in body) patch.accentHex = normaliseAccentHex(body.accentHex ?? null, 'accentHex');
  if (body.position !== undefined) patch.position = body.position;

  const result = await updateShopCategory(currentDb(c), pathParam(c, 'id'), patch);
  /*
   * A rename rewrites every product carrying the old value — an unknown number
   * of them, and `result` reports the count rather than the slugs. That is the
   * definition of a write that is not scoped to one product, so it is one
   * unscoped purge rather than `moved` of them.
   */
  revalidateCatalog();
  return c.json(result);
});

/**
 * Refused with a 409 while products still carry the name, unless `?reassign=`
 * names where they should go (`-` for uncategorised).
 */
routes.delete('/admin/categories/:id', auth, async (c) => {
  const { reassign } = readQuery(c, CategoryDeleteQuery);
  const result = await deleteShopCategory(
    currentDb(c),
    pathParam(c, 'id'),
    reassignTarget(reassign),
  );
  // Same as a rename: `?reassign=` moves an unknown set of products.
  revalidateCatalog();
  return c.json(result);
});

routes.get('/admin/products', auth, async (c) => {
  const { withTotal, ...q } = readQuery(c, AdminListQueryParams);
  return c.json(
    await listProducts(currentDb(c), {
      ...q,
      includeUnpublished: true,
      withTotal: withTotal === '1' || withTotal === 'true',
    }),
  );
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
  /*
   * A product is created as a draft, so nothing a shopper can see has changed
   * yet and this purge buys nothing. It is here anyway because the alternative
   * is a status check at every call site that has to stay in step with what
   * `getActiveProductBySlug` filters on, and creation is a once-per-product
   * event — the cost is one re-render, not a stream of them. If catalogue
   * re-renders ever become expensive enough to matter, gate the whole set of
   * these on `product.status === 'active'` in ONE place, not here.
   */
  revalidateProducts(product.slug);
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
  /*
   * ONE SLUG, AND THE BRIEF'S "SEND THE OLD ONE TOO" CASE CANNOT ARISE HERE.
   * `saveProduct` assigns a slug once — when a product that has none first gets
   * a title — and never rewrites a non-null one (`products.ts`: `if (!slug &&
   * next.title)`). So the slug before this write is either the same string or
   * `null`, and neither is a page cached under a name that is now wrong. The
   * day a slug becomes editable, read the old one before the save and pass
   * `revalidateProducts(before, product.slug)`; the helper is variadic and
   * de-duplicates for exactly that.
   */
  revalidateProducts(product.slug);
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
  routes.post(`/admin/products/:id/${name}`, auth, async (c) => {
    const product = await run(currentDb(c), pathParam(c, 'id'), currentUser(c));
    /*
     * The clearest case in the file: every one of these is a change to or from
     * `active`, which is precisely what decides whether the storefront serves
     * the product at all. An unpublish that leaves a stale page cached for an
     * hour is a shopper adding a withdrawn product to a cart.
     */
    revalidateProducts(product.slug);
    return c.json({ product });
  });
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
routes.delete('/admin/products/:id', auth, async (c) => {
  const product = await trashProduct(currentDb(c), pathParam(c, 'id'), currentUser(c));
  // Soft delete, but the storefront stops serving it — same urgency as unpublish.
  revalidateProducts(product.slug);
  return c.json({ product });
});

routes.post('/admin/products/:id/variants', auth, async (c) => {
  // Body first, exactly as before: a malformed one is a 400 and must stay a 400
  // rather than becoming whatever `currentDb(c)` answers on a deployment with no
  // `DATABASE_URL`. The handle is only hoisted into a local so the purge below
  // can share it.
  const body = await readJson(c, CreateVariantBody);
  const db = currentDb(c);
  const productId = pathParam(c, 'id');
  const variant = await createVariant(db, productId, body, currentUser(c));
  // A new colour or weight option is a change to the product page and to the
  // "from ₦x" the grids show. The slug is read in the background, not here.
  revalidateProductById(db, productId);
  return c.json({ variant }, 201);
});

routes.patch('/admin/variants/:id', auth, async (c) => {
  const body = await readJson(c, UpdateVariantBody);
  const db = currentDb(c);
  const variant = await updateVariant(db, pathParam(c, 'id'), body);
  // Colour, weight, swatch, photograph, status — all of it is on the page.
  // `variant.productId` is already in hand, so this needs no variant join.
  revalidateProductById(db, variant.productId);
  return c.json({ variant });
});

/**
 * HARD DELETE — unlike `DELETE /admin/products/:id`, this one really removes
 * the row (issue #18). A product always has the trash to fall back to; a
 * variant that has never been ordered has no history to protect, and archive
 * (`PATCH .../status`) already covers the reversible case.
 *
 * `deleteVariant` throws `VariantPreconditionFailedError` — rendered as a 409
 * by `server/shop/app.ts`'s `onError`, the same conflict-error vocabulary as
 * the product/category routes — when the variant has ever been ordered.
 */
routes.delete('/admin/variants/:id', auth, async (c) => {
  const db = currentDb(c);
  const variant = await deleteVariant(db, pathParam(c, 'id'));
  /*
   * BY PRODUCT ID, NOT BY VARIANT ID. This is a hard delete: the row is gone, so
   * `revalidateVariantProduct` — which joins through `shop_variants` — would
   * find nothing by the time the background task ran and fall back to purging
   * the lists, leaving the product's own page cached with a colour that no
   * longer exists. The deleted row is returned, so its `productId` is free.
   */
  revalidateProductById(db, variant.productId);
  return c.json({ variant });
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
  const db = currentDb(c);
  const variantId = pathParam(c, 'id');
  const written = await setPrice(db, variantId, price, body.reason ?? null);
  /*
   * The one purge on this page that a customer would notice most: a price the
   * storefront serves for another hour is a price we have to honour, or an
   * argument at checkout. `setPrice` returns the price row, not the variant, so
   * the product is reached through the variant.
   */
  revalidateVariantProduct(db, variantId);
  return c.json({ price: written });
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
  const db = currentDb(c);
  const variantId = pathParam(c, 'variantId');
  const level = await adjustInventory(db, variantId, delta, reason, currentUser(c));
  /*
   * ONLY THIS ROUTE, AND NOT THE RESERVATION PATH. `adjustInventory` is an
   * operator restocking or writing off — a deliberate, low-frequency admin act.
   * The `reserved` column also moves on every add-to-cart and every checkout
   * freeze, which happen at customer volume and are Cart's, not this file's; a
   * purge wired there would re-render every catalogue page per basket.
   */
  revalidateVariantProduct(db, variantId);
  return c.json({ inventory: level });
});

// ------------------------------------------------------------- bulk discounts

/**
 * The STORE-WIDE default ladder (migration 0600) — the one every product
 * inherits unless it carries an override.
 *
 * `requireAuth()` AND NOT `requireOwner()`, matching `/admin/products`: whoever
 * may publish a product and set its price may set the quantity ladder it sells
 * on. Making this owner-only would put the shop's pricing behind a person who
 * is often not the one running the shop that day.
 */
routes.get('/admin/bulk-tiers', auth, async (c) => {
  readQuery(c, NoCategoryParams);
  return c.json({ tiers: await listTiers(currentDb(c), null) });
});

routes.put('/admin/bulk-tiers', auth, async (c) => {
  const body = await readJson(c, BulkTiersBody);
  const tiers = await replaceTiers(currentDb(c), null, body.tiers, Date.now());
  return c.json({ tiers });
});

/**
 * ONE PRODUCT's override.
 *
 * READS THE STORED ROWS, NOT THE RESOLVED LADDER, and the difference is the
 * whole reason this is not `resolveTiers`: the editor has to distinguish "this
 * product has no rows and inherits the default" from "this product has rows that
 * happen to equal the default", and a resolved ladder collapses both into the
 * same answer. `inherited` says which it is, so the UI can grey the table and
 * offer Override rather than guessing.
 */
routes.get('/admin/products/:id/bulk-tiers', auth, async (c) => {
  readQuery(c, NoCategoryParams);
  const db = currentDb(c);
  const id = pathParam(c, 'id');
  const own = await listTiers(db, id);
  return c.json({
    tiers: own,
    inherited: own.length === 0,
    /* The ladder that would apply either way, so the editor can render the
       greyed inherited table without a second request. */
    effective: await resolveTiersFor(db, id),
  });
});

/**
 * PUT the override. AN EMPTY `tiers` IS THE RESET — it deletes the product's own
 * rows and returns it to inheriting the default, which is why this is not a
 * DELETE route: "no ladder of my own" and "no ladder at all" are different
 * states and only the first is expressible here.
 */
routes.put('/admin/products/:id/bulk-tiers', auth, async (c) => {
  const db = currentDb(c);
  const id = pathParam(c, 'id');
  const body = await readJson(c, BulkTiersBody);
  /* The product must exist before rows referencing it are written: the FK would
     refuse anyway, but as a 23503 rather than as the 404 this deserves. */
  const product = await getProduct(db, id);
  if (!product) throw new NotFoundError(id);
  await replaceTiers(db, id, body.tiers, Date.now());
  return c.json({
    tiers: await listTiers(db, id),
    inherited: body.tiers.length === 0,
    effective: await resolveTiersFor(db, id),
  });
});

// --------------------------------------------------------------- CSV export/import

/**
 * CSV export, its tokened download, and import (migration 0720) — in csv.ts,
 * mounted here so the composition root (server/shop/app.ts) stays a one-line
 * mount per subsystem. None of its paths collides with a route above: the
 * export/import POSTs and the download GET all differ from every registered
 * pattern in method or segment count.
 */
routes.route('/', csvRoutes);

// ----------------------------------------------------------------- add-ons

/**
 * Checkout add-ons (migration 0940) — `/admin/add-ons`, mounted the same way
 * as `csvRoutes` above: a subsystem of its own file, registered here so the
 * composition root stays a one-line mount per subsystem.
 */
routes.route('/', addOnRoutes);
