import { PreconditionFailedError, StaleWriteError } from '../../repo/errors';
import type { Post } from '../../../shared/types';
import type { Product, Variant } from './types';

/**
 * Catalog's two conflict errors.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THESE EXIST AT ALL, GIVEN CONTRACT §3 SAYS "Commerce reuses all four".
 *
 * It does reuse them — these EXTEND them rather than replacing them, so
 * `err instanceof StaleWriteError` still holds and `server/middleware/errors.ts`
 * still maps them to the right 409 with no change to a file Catalog does not
 * own. That fallback is the safety property: a Catalog error escaping to the
 * global handler is a correct 409, not a 500.
 *
 * What could not be reused is the PAYLOAD. Both shared classes carry `post:
 * Post`, and brief §4 requires the conflict to carry "the full current product
 * from a single re-read, so a client's 'load theirs' needs no second request".
 * A `Product` is not a `Post` — different fields, different lifecycle vocabulary
 * — so the choices were to cast a lie into a shared type, to drop the payload
 * and make the storefront admin issue a second request on every conflict, or to
 * carry it in a correctly-named field of a subclass. Only the third is honest.
 * Raised as amendment A-CAT-011, which proposes the shared classes' payload
 * become generic.
 *
 * The renderer is `server/shop/app.ts`'s own `onError`, which is Catalog's file:
 * it recognises these two and emits `{ error, expected, actual, product }`,
 * falling through to `toResponse` for everything else. So the §8 error table is
 * obeyed and extended, not forked.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * `post` on the base class is deliberately left `null`.
 *
 * Setting it to a product cast as a `Post` would put the right data under the
 * wrong name, and a consumer reading `body.post.excerptSource` on a shop
 * response would get `undefined` rather than an error. Null is the honest value
 * for "there is no post here"; `product` is where the payload actually is.
 */
export class StaleProductWriteError extends StaleWriteError {
  readonly product: Product | null;

  constructor(expected: number, actual: number, product: Product | null) {
    super(expected, actual, null as Post | null);
    this.name = 'StaleProductWriteError';
    this.product = product;
  }
}

/**
 * The lifecycle op was REFUSED, not lost: the product is already in the state
 * being asked for.
 *
 * Separate from a stale write for the reason `PreconditionFailedError`'s own
 * docstring gives — the two need different words in the UI and different
 * handling in a client. "Someone else got there first, here is theirs, choose"
 * is not "there is nothing to do, it is already published", and collapsed into
 * one the refusal arrives with `expected === actual`, which no conflict banner
 * can render.
 */
export class ProductPreconditionFailedError extends PreconditionFailedError {
  readonly product: Product;

  constructor(operation: string, product: Product) {
    /*
     * The base requires a non-null `Post` and this has none. An empty object
     * cast is the one place this file cannot be fully honest, and it is
     * contained: nothing reads `.post` on a Catalog error, because the renderer
     * that handles these reads `.product`, and the global fallback renderer only
     * ever serialises it — where `{}` is a strictly better answer than a product
     * masquerading as a post.
     */
    super(operation, {} as Post);
    this.name = 'ProductPreconditionFailedError';
    this.product = product;
  }
}

/**
 * `DELETE /admin/variants/:id` refused because the variant has been ordered
 * (issue #18).
 *
 * SAME SHAPE AS `ProductPreconditionFailedError`, FOR THE SAME REASON: a
 * `shop_order_lines` row snapshots its variant, so a hard delete would tear a
 * hole in order history the moment somebody rendered that order again. This is
 * not a stale write — there is no revision the caller raced — it is a refusal
 * that will still be true on retry, which is exactly what
 * `PreconditionFailedError`'s vocabulary already says: "there is nothing to do,
 * it is already in a state (has sold) that forbids this."
 *
 * Carries the variant rather than an order id list because the UI's one job on
 * a 409 here is to say "this has been sold — archive it instead", which needs
 * the variant, not the orders. `operation` is always `'delete'` today but is
 * kept as a field rather than a constant so the renderer in `server/shop/app.ts`
 * does not need a second special case if a future refusal joins it.
 */
export class VariantPreconditionFailedError extends PreconditionFailedError {
  readonly variant: Variant;

  constructor(operation: string, variant: Variant) {
    // See `ProductPreconditionFailedError` above: the base class wants a
    // non-null `Post`, this has none, and nothing reads `.post` on a Catalog
    // error — the renderer that handles this reads `.variant`.
    super(operation, {} as Post);
    this.name = 'VariantPreconditionFailedError';
    this.variant = variant;
  }
}
