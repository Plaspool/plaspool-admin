import { httpClient, type HttpClient } from '../../../test/http';
import { registerOrdersDeps, resetOrdersDeps, type OrdersDeps, type ShopCustomer } from '../ports';
import type { Db } from '../../../db/client';

/**
 * The route suite's client, driving **the real application**.
 *
 * NOTHING IS COMPOSED HERE ANY MORE, and that is the point: `server/index.ts` mounts
 * `shopApp()` at `/api/shop`, `server/shop/app.ts` mounts `orders` into it, and
 * `httpClient(db)` builds the genuine `createApp()`. So every route test below runs
 * through exactly the stack production runs — origin guard, session middleware, §8
 * error mapping, request id — and `server/nul-bytes.test.ts`, which walks
 * `app.routes` so a route added later inherits the boundary checks, now covers these
 * routes too.
 *
 * WHAT IS INJECTED, AND WHY IT HAS TO BE A REGISTRY. `server/shop/app.ts` composes
 * routers with no arguments (contract §11 asks each subsystem for "two lines" there),
 * and Hono resolves two routers claiming one path by registration order — so a second,
 * injected copy mounted alongside would never be reached. `registerOrdersDeps` is
 * therefore the seam, and it is read PER REQUEST so registration order cannot matter.
 * See `server/shop/orders/ports.ts` for why this is not the module-scope singleton
 * `createApp` warns against.
 */
export interface OrdersClient extends HttpClient {
  /** Act as this customer on subsequent requests, or `null` for nobody. */
  asCustomer(customer: ShopCustomer | null): void;
}

/** The header the fake customer resolver reads. See `ordersClient`. */
export const CUSTOMER_HEADER = 'x-test-shop-customer';

/**
 * A FAKE `CustomerResolver`, which is what contract §11 asks for: code against a fake
 * and swap in the real one when its owner lands. Contract §7 gives the customer session
 * — table, cookie and middleware — to Cart.
 *
 * IT READS A HEADER RATHER THAN A COOKIE ON PURPOSE. A fake cookie would imply this
 * subsystem knows the cookie's name and format, which is exactly the coupling the port
 * exists to avoid: `__Host-shop_session` is Cart's to define.
 *
 * **Call `resetOrdersDeps()` in `beforeEach`.** The registry is module state, so a suite
 * that registered a fake and did not clear it would leak into the next file in the same
 * worker.
 */
export function ordersClient(db: Db, deps: OrdersDeps = {}): OrdersClient {
  let current: ShopCustomer | null = null;

  registerOrdersDeps({
    customer: (c) => {
      const header = c.req.header(CUSTOMER_HEADER);
      // The header wins when present, so one client can act as two customers in a test.
      return Promise.resolve(header ? { id: header } : current);
    },
    ...deps,
  });

  const client = httpClient(db);
  return Object.assign(client, {
    asCustomer(customer: ShopCustomer | null) {
      current = customer;
    },
  });
}

export { resetOrdersDeps };
