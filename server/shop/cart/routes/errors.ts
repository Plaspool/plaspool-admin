import type { Handler } from 'hono';
import { CartPreconditionError, CartStaleWriteError, NotImplementedError } from '../errors';
import type { ShopEnv } from '../shop-env';

/**
 * The shop's three extra error rows, applied by WRAPPING EACH HANDLER.
 *
 * ═══ WHY NOT A MIDDLEWARE, AND WHY NOT `onError` ═══
 *
 * Both were tried and both are inert here. Measured, not reasoned:
 *
 * - **`app.onError` on the sub-app is never called.** `app.route(path, subApp)`
 *   copies the sub-app's ROUTES into the parent; its `onError` and `notFound`
 *   stay behind. A handler installed there would be silently dead the moment
 *   Catalog mounts this app for real — a mechanism wired to no caller, which is
 *   the single most common finding in GAUNTLET.md.
 *
 * - **A `use('*')` middleware with a `try`/`catch` never enters its `catch`.**
 *   This is the one that cost an hour and it is worth writing down. Hono's
 *   `compose` wraps EVERY dispatch level in its own try/catch and, when an
 *   `onError` is registered on the app, calls it right there at the frame that
 *   threw. So the error never propagates back up through the outer middleware's
 *   `await next()`: that call resolves normally, `c.res` is already the parent's
 *   500, and the middleware's catch is unreachable. Executed with a three-line
 *   Hono app before this file was rewritten — a `use('*')` catcher plus a parent
 *   `onError` produced a 500 in every variant, including setting `c.res`
 *   directly rather than returning.
 *
 * So the mapping has to run INSIDE the handler's own frame, which is what this
 * wrapper does. `routes.test.ts` walks every registered route and fails if one
 * is not wrapped, so "remember to wrap it" is a mechanical check rather than a
 * convention — the difference between this and the guards GAUNTLET keeps finding
 * on one surface and not its twin.
 *
 * ═══ WHY NOT EXTEND `server/middleware/errors.ts` ═══
 * That file is not this subsystem's to edit (contract §2 R1) and three other
 * agents depend on it. Anything this wrapper does not recognise is RETHROWN, so
 * `toResponse` still maps the four shared errors, still logs a 500 with its
 * `requestId`, and still never leaks a stack. This ADDS rows to the table; it
 * does not replace it.
 */

const MAPPED = Symbol('shop-error-mapped');

/** True when `fn` will translate this subsystem's errors. Used by the guard test. */
export function mapsShopErrors(fn: unknown): boolean {
  return (
    typeof fn === 'function' &&
    (fn as unknown as Record<symbol, unknown>)[MAPPED] === true
  );
}

export function shopRoute(handler: Handler<ShopEnv>): Handler<ShopEnv> {
  const wrapped: Handler<ShopEnv> = async (c, next) => {
    try {
      return await handler(c, next);
    } catch (err) {
      const mapped = map(err);
      if (!mapped) throw err;
      // `requestId` in the body, matching every other response this app
      // produces — it is the only thread between what the caller saw and what
      // the log holds (spec §8).
      return c.json({ ...mapped.body, requestId: c.get('requestId') ?? '' }, mapped.status);
    }
  };
  Object.defineProperty(wrapped, MAPPED, { value: true });
  return wrapped;
}

interface Mapped {
  status: 409 | 501;
  body: Record<string, unknown>;
}

function map(err: unknown): Mapped | null {
  if (err instanceof CartStaleWriteError) {
    return {
      status: 409,
      body: {
        // The SAME `error` key the post path uses, so a client that already
        // knows how to render a conflict needs no new branch — only a new
        // subject. Spec §8's retry policy stops on 409 either way.
        error: 'stale_write',
        expected: err.expected,
        actual: err.actual,
        cart: err.cart,
      },
    };
  }
  if (err instanceof CartPreconditionError) {
    return {
      status: 409,
      body: { error: 'precondition_failed', operation: err.operation, cart: err.cart },
    };
  }
  if (err instanceof NotImplementedError) {
    return { status: 501, body: { error: 'not_implemented', feature: err.feature } };
  }
  return null;
}
