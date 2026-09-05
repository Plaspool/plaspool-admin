import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { storefrontRevalidateUrl } from './utils/revalidate-url';

/**
 * Pushing cache invalidations to the storefront after a catalogue write.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR. The storefront (a Cloudflare Worker) caches its product
 * fetch for 3600s. Without a push, an edit made here is invisible to shoppers
 * for up to an hour. `POST <storefront>/api/revalidate` purges it:
 *
 *     {"slug": "pla-filament"}  → that product page AND the catalogue lists
 *     {}                        → the catalogue lists only
 *
 * THE ENDPOINT ALWAYS PURGES THE LISTS, slug or not — editing one product
 * changes the grids it appears in, and those read a different cached fetch than
 * the product page does. So one request per product is the whole job; there is
 * never a second one "to also refresh the listings".
 *
 * THERE IS NO AUTHENTICATION ON IT, deliberately, and it is known debt on the
 * storefront side. Do not invent a bearer token, a shared secret or a signature
 * here: nothing checks it, and a header that looks like auth but is not is worse
 * than none — the next person reads it and stops asking. When the secret lands
 * on the storefront, it gets wired here at the same time.
 *
 * `tag` IS NOT A FIELD. The endpoint accepts `slug` and nothing else, so a
 * caller cannot purge arbitrary cache tags. Do not add one.
 *
 * NOT FOR marketing banners, the rewards programme, or reviews. Those are on
 * their own time windows on the storefront and carry no cache tag; a purge here
 * would do nothing for them.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * EVERY FAILURE IS SWALLOWED, AND THAT IS THE DESIGN, NOT LAZINESS. The
 * storefront revalidates on its own clock as a floor, so a purge that never
 * lands means "stale for a few minutes" and never a broken admin. An admin who
 * successfully saved a product must not see an error because a cache somewhere
 * else did not clear — the write is already committed and there is nothing for
 * them to do about it. What they get instead is a log line (below).
 *
 * NOTHING HERE IS AWAITED ON THE REQUEST PATH. `background()` hands the work to
 * the platform and returns synchronously, so a slow or hanging storefront
 * cannot add a millisecond to a save.
 */

/**
 * The storefront's own validation, copied so a slug that cannot be accepted
 * never becomes a request.
 *
 * A slug that fails this is not dropped on the floor — `bodiesFor` falls back to
 * the bare `{}`, which still purges the lists. The one thing lost is the
 * product's own page, and that is the honest outcome: we have no name the
 * endpoint will take for it.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * Per attempt. Short on purpose: this runs after the response is out, and a
 * socket held open to a storefront that is not answering is a function the
 * platform is still billing for.
 */
const TIMEOUT_MS = 3_000;

/** Between the one attempt and the one retry. */
const RETRY_DELAY_MS = 250;

/**
 * Above this many distinct slugs, one `{}` is sent instead of one request each.
 *
 * A write that touches more products than a person edits by hand is a batch, and
 * the storefront's own guidance for a batch is a single unscoped purge. Nothing
 * in this file's call sites passes more than two, so this is a backstop against
 * a future caller turning one save into a request storm — and it logs when it
 * fires rather than truncating quietly.
 */
const BATCH_THRESHOLD = 8;

// ------------------------------------------------------------------- logging

/**
 * ONE LINE PER SUCCESSFUL PURGE, AND IT IS NOT DEBUG NOISE.
 *
 * It is the only way to answer "did this actually run in production", which for
 * post-response work on Vercel is a real and expensive question — CLAUDE.md §2
 * is a list of times the answer was no and nothing said so. It reports `mode`
 * for exactly that reason: `waitUntil` means the platform was asked to keep the
 * instance alive, `floating` means nothing was and the purge is racing the
 * freeze.
 *
 * Affordable because these are explicit admin saves, not customer traffic —
 * tens of lines a day, not thousands. If the shop ever grows a write path at
 * customer volume, that path must not call this module (see the note on the
 * inventory route in `routes.ts`).
 */
function info(event: string, detail: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- the evidence that a purge happened
  console.info(`[shop/catalog/revalidate] ${event}`, JSON.stringify(detail));
}

function warn(event: string, detail: Record<string, unknown>): void {
  /*
   * NAMES AND STATUSES ONLY, never a response body — the same discipline
   * `server/shop/payments/webhook.ts` follows. Nothing here is secret today (the
   * endpoint is unauthenticated and a slug is public), but the rule is cheaper
   * to keep than to reinstate.
   *
   * eslint-disable-next-line no-console -- swallowing a failed purge silently
   * would make a permanently stale storefront invisible; this line is the only
   * evidence it produces.
   */
  console.warn(`[shop/catalog/revalidate] ${event}`, JSON.stringify(detail));
}

// ------------------------------------------------------------------ endpoint

/**
 * The URL to purge against, or `null` when this process must not purge at all.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A TEST PROCESS NEVER REACHES THE REAL STOREFRONT, AND THAT GUARD IS
 * LOAD-BEARING rather than tidiness. The endpoint defaults to a value held in
 * the repository rather than the environment, so there is no
 * unset-by-default state to protect anything: without this, `npm test` would
 * fire real POSTs at the live Worker. `server/nul-bytes.test.ts` alone walks
 * EVERY registered route, and `routes.test.ts`, `lifecycle.test.ts`,
 * `categories.test.ts` and `case-fold.test.ts` each drive catalogue writes —
 * so a full run would purge production's cache dozens of times, make the suite
 * depend on the network, and put an admin's laptop one `npm test` away from
 * re-rendering every catalogue page on the shop.
 *
 * `transport !== null` IS THE ESCAPE HATCH, and it is the honest one: a suite
 * that has installed a recorder is not talking to the storefront, so it is free
 * to run the whole path. That is how `revalidate.test.ts` and
 * `revalidate-routes.test.ts` exercise this file, and it is why they are the
 * only two suites in the repository that see a purge happen.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * EVERY OTHER PROCESS PURGES, INCLUDING `npm run dev:api`. Deliberate: local dev
 * can be pointed at the production database, and a save that really did change
 * what shoppers see should really clear the cache. Pointed at a local database
 * instead, the purge is one wasted re-render and nothing worse.
 */
function endpoint(): string | null {
  if (process.env.NODE_ENV === 'test' && transport === null) return null;
  return storefrontRevalidateUrl();
}

// ----------------------------------------------------------------- transport

type Transport = typeof fetch;

let transport: Transport | null = null;

/**
 * Test-only: record the requests instead of making them.
 *
 * A SEAM RATHER THAN A GLOBAL `fetch` PATCH, following
 * `PaystackConfig.fetchImpl` — the suite drives the real routes through the real
 * `createApp()` (see `server/test/http.ts`), so the thing under test has to be
 * reachable without replacing a global that every other suite in the same
 * process also sees.
 */
export function setRevalidateTransport(impl: Transport | null): void {
  transport = impl;
}

// ---------------------------------------------------------------- scheduling

/**
 * Tasks that have been started and have not settled.
 *
 * Exists for `settleRevalidations()`, which is what makes fire-and-forget
 * testable at all: without it a route test would assert on a request that has
 * not been made yet and pass for the wrong reason. It empties itself, so it is
 * not a leak in a long-lived process.
 */
const inFlight = new Set<Promise<void>>();

type WaitUntil = (promise: Promise<unknown>) => void;

/** Whether the platform was asked to keep the instance alive for this work. */
type BackgroundMode = 'waitUntil' | 'floating';

/**
 * The platform's "do not freeze me yet" hook, if there is one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS THE PART THAT IS EASY TO GET WRONG HERE, AND CLAUDE.md §2 RECORDS
 * WHAT IT COSTS. Vercel freezes the function once the response is sent, so a
 * promise merely left floating does NOT reliably run — that is exactly how
 * `shop_payment_events.processed_at` stayed `null` in production while every
 * test passed, and why the sweep cron exists at all.
 *
 * `waitUntil` is the platform's answer to precisely that: it keeps the instance
 * alive until the promise settles. It is read off the request context Vercel
 * publishes on `globalThis` — the same value `@vercel/functions` reads — rather
 * than by adding that package, because this repository does not take a
 * dependency for something the runtime already exposes (`server/mail/resend.ts`
 * and `server/shop/payments/provider/paystack.ts` both say so at length).
 *
 * THE TRADE IS DELIBERATE AND IT IS NOT FREE: this is a symbol Vercel documents
 * for tracing rather than a package export, so a rename upstream would take the
 * hook away silently. Two things make that acceptable. The fallback below is a
 * floating promise, which on a warm Fluid instance usually still completes; and
 * a purge that never lands costs staleness until the storefront's own 3600s
 * floor, never money and never a broken admin. If that trade stops being worth
 * it, `npm i @vercel/functions` and replace this function's body with
 * `return waitUntil` — nothing else in this file changes.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function platformWaitUntil(): WaitUntil | null {
  const store = (globalThis as Record<symbol, unknown>)[
    Symbol.for('@vercel/request-context')
  ] as { get?: () => { waitUntil?: unknown } | undefined } | undefined;
  if (typeof store?.get !== 'function') return null;
  try {
    const waitUntil = store.get()?.waitUntil;
    return typeof waitUntil === 'function' ? (waitUntil as WaitUntil) : null;
  } catch {
    return null;
  }
}

/**
 * Start work and return immediately.
 *
 * `.catch(() => {})` BEFORE THE PROMISE IS STORED, so nothing this schedules can
 * ever surface as an unhandled rejection — which on Node is a process-level
 * event, i.e. a cache purge could take the function down. Every real failure has
 * already been logged inside `send()`; this is the backstop for a bug in it.
 */
function background(work: (mode: BackgroundMode) => Promise<void>): void {
  /*
   * READ SYNCHRONOUSLY, BEFORE ANY `await`. The hook lives in an AsyncLocalStorage
   * scope that belongs to the request; looking for it later — from inside the
   * task, or when the log line is written — finds nothing and would report
   * `floating` on a deployment where `waitUntil` is working perfectly well.
   */
  const hook = platformWaitUntil();
  let task: Promise<void>;
  try {
    task = work(hook ? 'waitUntil' : 'floating').catch(() => {});
  } catch {
    // A synchronous throw before the first await. Same treatment.
    return;
  }
  inFlight.add(task);
  void task.finally(() => inFlight.delete(task));
  hook?.(task);
}

/**
 * Test-only: wait for every scheduled purge to settle.
 *
 * A LOOP, not one `Promise.all`: a task that resolves a slug from the database
 * before it posts adds nothing to the set until it gets there, so a single pass
 * can return while work it started is still pending.
 */
export async function settleRevalidations(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

// -------------------------------------------------------------------- bodies

function isPurgeableSlug(slug: string | null | undefined): slug is string {
  return typeof slug === 'string' && SLUG_PATTERN.test(slug);
}

/**
 * The request bodies for one write.
 *
 * ONE PER DISTINCT PURGEABLE SLUG, or a single `{}` when there is none — which
 * covers a product that has no slug yet (a draft nobody has titled), a category
 * rename that moved an unknown number of products, and a slug the endpoint would
 * refuse anyway. In every one of those the lists still changed, so the unscoped
 * purge is the right answer rather than no request at all.
 *
 * A SLUG CHANGE IS TWO SLUGS, old and new, because the old page is cached under
 * the old tag. No route in `routes.ts` can produce one today —
 * `saveProduct` assigns a slug once, when a product first gets a title, and
 * never rewrites a non-null one — so every call site passes a single slug. The
 * shape is a list anyway so that the day slug editing is added, the caller
 * passes `[before, after]` and this needs no change.
 */
function bodiesFor(slugs: readonly (string | null | undefined)[]): string[] {
  const distinct = [...new Set(slugs.filter(isPurgeableSlug))];
  if (distinct.length === 0) return [JSON.stringify({})];
  if (distinct.length > BATCH_THRESHOLD) {
    warn('too many products for one write; purging the lists only', {
      slugs: distinct.length,
      threshold: BATCH_THRESHOLD,
    });
    return [JSON.stringify({})];
  }
  return distinct.map((slug) => JSON.stringify({ slug }));
}

// -------------------------------------------------------------------- sending

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Attempt = { ok: true } | { ok: false; retryable: boolean; detail: Record<string, unknown> };

async function attempt(url: string, body: string): Promise<Attempt> {
  let res: Response;
  try {
    res = await (transport ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: unknown) {
    // A name, never a message: `err.message` on a fetch failure quotes the URL.
    const name = err instanceof Error ? err.name : typeof err;
    return { ok: false, retryable: true, detail: { error: name } };
  }
  if (res.ok) return { ok: true };
  /*
   * 4xx IS NOT RETRYABLE. The only 4xx this endpoint documents is a 400 for a
   * malformed slug, and re-sending the same malformed slug produces the same
   * 400 — a retry there is the storm the brief rules out, not resilience.
   */
  return { ok: false, retryable: res.status >= 500, detail: { status: res.status } };
}

/**
 * One purge: one attempt, and at most one retry. Never a loop.
 *
 * The retry exists for the transient cases only — a dropped socket, a timeout, a
 * Worker cold-start 5xx — and there is exactly one of them because the cost of
 * giving up is bounded and small: the storefront's own timer revalidates
 * regardless.
 */
async function send(url: string, body: string, mode: BackgroundMode): Promise<void> {
  const first = await attempt(url, body);
  if (first.ok) return info('purged', { body, mode });
  if (!first.retryable) {
    warn('the storefront refused a purge', { ...first.detail, body });
    return;
  }
  await delay(RETRY_DELAY_MS);
  const second = await attempt(url, body);
  if (second.ok) return info('purged', { body, mode, attempts: 2 });
  warn('a purge did not reach the storefront', { ...second.detail, body });
}

async function purge(
  slugs: readonly (string | null | undefined)[],
  mode: BackgroundMode,
): Promise<void> {
  const url = endpoint();
  if (!url) return;
  for (const body of bodiesFor(slugs)) await send(url, body, mode);
}

// ----------------------------------------------------------------- call sites

/**
 * Purge one product's page and the catalogue lists. Returns immediately.
 *
 * Pass every slug the write touched. `null` is fine and means "no page to purge"
 * — the lists are still refreshed.
 */
export function revalidateProducts(...slugs: (string | null | undefined)[]): void {
  background((mode) => purge(slugs, mode));
}

/**
 * Purge the catalogue lists only. Returns immediately.
 *
 * For a write that is not scoped to one product: a category created, renamed or
 * deleted, or any batch that touched many rows. ONE call at the end of a batch,
 * never one per row.
 */
export function revalidateCatalog(): void {
  background((mode) => purge([], mode));
}

/**
 * Purge the product with this id, resolving its slug first. Returns immediately.
 *
 * THE READ HAPPENS IN THE BACKGROUND TASK, not on the request path, which is why
 * this takes a `Db` rather than a slug: the variant, price and inventory routes
 * do not have the parent product's slug in hand, and buying it would cost the
 * save an extra Neon round trip for a cache somewhere else's benefit.
 *
 * Safe after the response: the Neon HTTP driver holds no per-request connection
 * state, so the handle is still usable once the route has returned.
 *
 * A read that finds nothing, or fails, still purges the lists — something
 * changed, and the unscoped purge is the correct fallback.
 */
export function revalidateProductById(db: Db, productId: string): void {
  background(async (mode) => purge([await slugOf(db, productId)], mode));
}

/** As `revalidateProductById`, for a route that only knows the variant. */
export function revalidateVariantProduct(db: Db, variantId: string): void {
  background(async (mode) => purge([await slugOfVariantProduct(db, variantId)], mode));
}

// ------------------------------------------------------------------- lookups

async function slugOf(db: Db, productId: string): Promise<string | null> {
  try {
    const res = await db.execute(sql`SELECT slug FROM shop_products WHERE id = ${productId}`);
    const slug = res.rows[0]?.slug;
    return typeof slug === 'string' ? slug : null;
  } catch (err: unknown) {
    warn('could not read the slug to purge', {
      error: err instanceof Error ? err.name : typeof err,
    });
    return null;
  }
}

/**
 * `LEFT JOIN`-free and deliberately: a variant with no product is not a state
 * this schema permits, so an inner join that returns nothing means the variant
 * is gone — which is exactly what a hard delete leaves behind, and why
 * `DELETE /admin/variants/:id` passes the product id it already has instead of
 * calling this.
 */
async function slugOfVariantProduct(db: Db, variantId: string): Promise<string | null> {
  try {
    const res = await db.execute(sql`
      SELECT p.slug
        FROM shop_variants v
        JOIN shop_products p ON p.id = v.product_id
       WHERE v.id = ${variantId}`);
    const slug = res.rows[0]?.slug;
    return typeof slug === 'string' ? slug : null;
  } catch (err: unknown) {
    warn('could not read the slug to purge', {
      error: err instanceof Error ? err.name : typeof err,
    });
    return null;
  }
}
