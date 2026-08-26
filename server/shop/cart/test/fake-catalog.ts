import { sql } from 'drizzle-orm';
import type { Db } from '../../../db/client';
import type {
  CatalogPort,
  ReservationRequest,
  ReservationResult,
  VariantQuote,
} from '../catalog-port';
import type { BulkTier } from '../catalog-port';

/**
 * Cart's own `CatalogPort` fake (contract §11 puts it exactly here).
 *
 * WHY CART KEEPS ONE WHEN CATALOG PUBLISHES ONE TOO. Catalog ships
 * `server/shop/catalog/test/fake-catalog-port.ts` — see AMENDMENTS A-CAT-001, where
 * the contract and Catalog's brief name different owners for the same file.
 * Cart keeps this one anyway, for two reasons that are not stubbornness:
 *
 * 1. **Independence.** Cart's suites must be runnable when Catalog's tree is
 *    mid-edit. Four agents share this repository and one of them breaking a file
 *    must not turn Cart's bar red for reasons Cart cannot fix.
 * 2. **The SQL-backed variant below**, which Catalog's in-memory fake cannot be.
 *
 * `fake-catalog.conformance.test.ts` runs the same scenario table against BOTH
 * fakes and asserts identical answers, so keeping two does not mean holding two
 * different beliefs about the port.
 *
 * WHAT IT IS FAITHFUL TO, because a fake that is kinder than the real thing
 * hides exactly the bugs the real thing has:
 *
 * - insufficient stock is `{ ok: false, available }`, never a throw;
 * - `reservationId` is the idempotency key — a repeat holds stock ONCE;
 * - `release` and `commitReservation` are idempotent, safe after expiry, and
 *   each guarded on the hold still being `held`, so whichever of Cart's sweeper
 *   and a capture arrives second is a no-op rather than a double decrement;
 * - `available` is DERIVED from `onHand - reserved` and never stored;
 * - `expiresAt` is recorded and never acted on. Catalog does not expire holds;
 *   Cart does. A fake that expired them by itself would let a Cart suite pass
 *   with no sweeper written at all.
 */

export interface FakeVariant {
  variantId: string;
  productId?: string;
  sku?: string;
  title?: string;
  optionValues?: Record<string, string>;
  price: { amount: number; currency: string };
  weightGrams?: number | null;
  backorderable?: boolean;
  onHand: number;
  reserved?: number;
  /** False makes `quote` answer null and `reserve` answer `not_sellable`. */
  sellable?: boolean;
  /** The resolved bulk ladder this variant's product carries (migration 0600).
   *  Absent means none, which is what every pre-existing fixture wants. */
  bulkTiers?: BulkTier[];
}

interface Held {
  variantId: string;
  qty: number;
  state: 'held' | 'released' | 'committed';
  expiresAt: number;
}

export interface CartFakeCatalog extends CatalogPort {
  seed(variant: FakeVariant): void;
  stockOf(variantId: string): { onHand: number; reserved: number } | null;
  holdOf(reservationId: string): Readonly<Held> | null;
  /** Every `reserve` this fake has been asked for, in order. Lets a test assert
   * that checkout issues exactly one reservation per line and not one per read. */
  reserveCalls(): readonly ReservationRequest[];
  reset(): void;
}

function filled(v: FakeVariant): Required<Omit<FakeVariant, 'weightGrams'>> & {
  weightGrams: number | null;
} {
  return {
    variantId: v.variantId,
    productId: v.productId ?? `prd_${v.variantId}`,
    sku: v.sku ?? v.variantId.toUpperCase(),
    title: v.title ?? 'A product',
    optionValues: v.optionValues ?? {},
    price: v.price,
    weightGrams: v.weightGrams ?? null,
    backorderable: v.backorderable ?? false,
    onHand: v.onHand,
    reserved: v.reserved ?? 0,
    sellable: v.sellable ?? true,
    bulkTiers: v.bulkTiers ?? [],
  };
}

export function fakeCatalog(seedWith: readonly FakeVariant[] = []): CartFakeCatalog {
  const variants = new Map<string, ReturnType<typeof filled>>();
  const holds = new Map<string, Held>();
  const calls: ReservationRequest[] = [];

  const seed = (v: FakeVariant): void => {
    variants.set(v.variantId, filled(v));
  };
  for (const v of seedWith) seed(v);

  const availableOf = (v: ReturnType<typeof filled>): number => v.onHand - v.reserved;

  return {
    seed,
    stockOf: (variantId) => {
      const v = variants.get(variantId);
      return v ? { onHand: v.onHand, reserved: v.reserved } : null;
    },
    holdOf: (reservationId) => holds.get(reservationId) ?? null,
    reserveCalls: () => calls,
    reset: () => {
      variants.clear();
      holds.clear();
      calls.length = 0;
    },

    quote: (_db: Db, variantId: string): Promise<VariantQuote | null> => {
      const v = variants.get(variantId);
      if (!v || !v.sellable) return Promise.resolve(null);
      return Promise.resolve({
        variantId: v.variantId,
        productId: v.productId,
        sku: v.sku,
        title: v.title,
        optionValues: v.optionValues,
        price: v.price,
        weightGrams: v.weightGrams,
        available: availableOf(v),
        backorderable: v.backorderable,
        /* Seedable, so a cart test can drive the bulk ladder through the fake
           without standing up Catalog. Defaults to none. */
        bulkTiers: v.bulkTiers,
      });
    },

    reserve: (_db: Db, req: ReservationRequest): Promise<ReservationResult> => {
      calls.push(req);
      if (!Number.isInteger(req.qty) || req.qty <= 0) {
        return Promise.resolve({ ok: false, reason: 'invalid_qty', available: 0 });
      }
      // Idempotency FIRST and from the stored hold's EXISTENCE, not its state: a
      // repeat of a hold that has since been released must not re-reserve stock.
      const existing = holds.get(req.reservationId);
      if (existing) {
        const v = variants.get(existing.variantId);
        return Promise.resolve({
          ok: true,
          reservationId: req.reservationId,
          variantId: existing.variantId,
          qty: existing.qty,
          available: v ? availableOf(v) : 0,
          replayed: true,
        });
      }
      const v = variants.get(req.variantId);
      if (!v) return Promise.resolve({ ok: false, reason: 'unknown_variant', available: 0 });
      if (!v.sellable) {
        return Promise.resolve({ ok: false, reason: 'not_sellable', available: availableOf(v) });
      }
      if (!v.backorderable && availableOf(v) < req.qty) {
        return Promise.resolve({ ok: false, reason: 'insufficient', available: availableOf(v) });
      }
      v.reserved += req.qty;
      holds.set(req.reservationId, {
        variantId: req.variantId,
        qty: req.qty,
        state: 'held',
        expiresAt: req.expiresAt,
      });
      return Promise.resolve({
        ok: true,
        reservationId: req.reservationId,
        variantId: req.variantId,
        qty: req.qty,
        available: availableOf(v),
        replayed: false,
      });
    },

    release: (_db: Db, reservationId: string): Promise<void> => {
      const hold = holds.get(reservationId);
      // Only a hold that is still HELD gives stock back. Releasing a committed
      // hold would return units that have already been sold and shipped.
      if (!hold || hold.state !== 'held') return Promise.resolve();
      const v = variants.get(hold.variantId);
      if (v) v.reserved -= hold.qty;
      hold.state = 'released';
      return Promise.resolve();
    },

    commitReservation: (_db: Db, reservationId: string): Promise<void> => {
      const hold = holds.get(reservationId);
      // The mirror of the same guard: committing a released hold would decrement
      // on-hand for stock that has already been given back.
      if (!hold || hold.state !== 'held') return Promise.resolve();
      const v = variants.get(hold.variantId);
      if (v) {
        v.onHand -= hold.qty;
        v.reserved -= hold.qty;
      }
      hold.state = 'committed';
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * The same port, backed by a real Postgres table.
 *
 * WHY THIS EXISTS AND THE IN-MEMORY ONE IS NOT ENOUGH. Brief §8 requires that
 * "N≥50 concurrent checkouts against 10 units yield exactly 10 holds". Against
 * an in-memory fake that property is guaranteed by JavaScript rather than by
 * anything Cart or Catalog wrote: a synchronous `if` and `-=` between two
 * `await`s cannot interleave on a single-threaded event loop, so the test would
 * pass identically against a counter with no guard at all. That is a test that
 * proves the runtime, not the code.
 *
 * Backed by a conditional `UPDATE … WHERE available >= qty RETURNING`, the same
 * fifty calls exercise the predicate Postgres actually evaluates, and removing
 * the guard makes it fail. `reservation-concurrency.test.ts` does exactly that.
 *
 * THE TABLE IS NOT `shop_inventory`. That table belongs to Catalog and contract
 * §2 R3 makes ownership exclusive, so this creates its own —
 * `cart_test_inventory`, created by the test and dropped with the database. It
 * is an executable statement of what Cart needs the port to guarantee, not a
 * second implementation of Catalog.
 */
export interface SqlFakeCatalog extends CatalogPort {
  install(): Promise<void>;
  seed(variant: FakeVariant): Promise<void>;
  stockOf(variantId: string): Promise<{ onHand: number; reserved: number } | null>;
}

export function sqlFakeCatalog(db: Db): SqlFakeCatalog {
  return {
    install: async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS cart_test_inventory (
          variant_id text PRIMARY KEY,
          on_hand integer NOT NULL,
          reserved integer NOT NULL DEFAULT 0,
          price_minor integer NOT NULL,
          currency text NOT NULL,
          backorderable boolean NOT NULL DEFAULT false,
          sellable boolean NOT NULL DEFAULT true
        )`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS cart_test_holds (
          reservation_id text PRIMARY KEY,
          variant_id text NOT NULL,
          qty integer NOT NULL,
          state text NOT NULL,
          expires_at bigint NOT NULL
        )`);
      await db.execute(sql`TRUNCATE cart_test_inventory, cart_test_holds`);
    },

    seed: async (v: FakeVariant) => {
      await db.execute(sql`
        INSERT INTO cart_test_inventory
          (variant_id, on_hand, reserved, price_minor, currency, backorderable, sellable)
        VALUES (${v.variantId}, ${v.onHand}, ${v.reserved ?? 0}, ${v.price.amount},
                ${v.price.currency}, ${v.backorderable ?? false}, ${v.sellable ?? true})
        ON CONFLICT (variant_id) DO UPDATE
          SET on_hand = EXCLUDED.on_hand, reserved = EXCLUDED.reserved`);
    },

    stockOf: async (variantId: string) => {
      const res = await db.execute(sql`
        SELECT on_hand, reserved FROM cart_test_inventory WHERE variant_id = ${variantId}`);
      const row = res.rows[0];
      return row ? { onHand: Number(row.on_hand), reserved: Number(row.reserved) } : null;
    },

    quote: async (handle: Db, variantId: string) => {
      const res = await handle.execute(sql`
        SELECT * FROM cart_test_inventory WHERE variant_id = ${variantId} AND sellable`);
      const row = res.rows[0];
      if (!row) return null;
      return {
        variantId,
        productId: `prd_${variantId}`,
        sku: variantId.toUpperCase(),
        title: 'A product',
        optionValues: {},
        price: { amount: Number(row.price_minor), currency: String(row.currency) },
        weightGrams: null,
        available: Number(row.on_hand) - Number(row.reserved),
        backorderable: Boolean(row.backorderable),
        /* The SQL-backed fake models inventory, not pricing policy. Bulk-ladder
           behaviour is covered by `compute.test.ts` against the engine directly
           and by the catalog suites against the real `resolveTiers`. */
        bulkTiers: [],
      };
    },

    reserve: async (handle: Db, req: ReservationRequest): Promise<ReservationResult> => {
      if (!Number.isInteger(req.qty) || req.qty <= 0) {
        return { ok: false, reason: 'invalid_qty', available: 0 };
      }
      /*
       * ONE STATEMENT. The hold row is inserted by `SELECT … FROM taken`, so a
       * decrement that matches nothing inserts nothing — the same construction
       * `server/repo/posts.ts` uses to get atomicity without `db.transaction`
       * (which the Neon HTTP driver rejects unconditionally).
       *
       * `ON CONFLICT DO NOTHING` on the hold is the idempotency key: a repeat
       * with the same reservation id cannot take stock twice, and the caller is
       * told `replayed` from the row that already existed.
       */
      const existing = await handle.execute(sql`
        SELECT variant_id, qty FROM cart_test_holds WHERE reservation_id = ${req.reservationId}`);
      if (existing.rows[0]) {
        const stock = await handle.execute(sql`
          SELECT on_hand - reserved AS available FROM cart_test_inventory
           WHERE variant_id = ${String(existing.rows[0].variant_id)}`);
        return {
          ok: true,
          reservationId: req.reservationId,
          variantId: String(existing.rows[0].variant_id),
          qty: Number(existing.rows[0].qty),
          available: Number(stock.rows[0]?.available ?? 0),
          replayed: true,
        };
      }

      const res = await handle.execute(sql`
        WITH taken AS (
          UPDATE cart_test_inventory
             SET reserved = reserved + ${req.qty}
           WHERE variant_id = ${req.variantId}
             AND sellable
             AND (backorderable OR on_hand - reserved >= ${req.qty})
          RETURNING variant_id, on_hand - reserved AS available
        ), held AS (
          INSERT INTO cart_test_holds (reservation_id, variant_id, qty, state, expires_at)
          SELECT ${req.reservationId}, taken.variant_id, ${req.qty}, 'held', ${req.expiresAt}
            FROM taken
          ON CONFLICT (reservation_id) DO NOTHING
          RETURNING reservation_id
        )
        SELECT available FROM taken`);

      if (res.rows.length === 0) {
        const state = await handle.execute(sql`
          SELECT sellable, on_hand - reserved AS available FROM cart_test_inventory
           WHERE variant_id = ${req.variantId}`);
        const row = state.rows[0];
        if (!row) return { ok: false, reason: 'unknown_variant', available: 0 };
        if (!row.sellable) return { ok: false, reason: 'not_sellable', available: Number(row.available) };
        return { ok: false, reason: 'insufficient', available: Number(row.available) };
      }

      return {
        ok: true,
        reservationId: req.reservationId,
        variantId: req.variantId,
        qty: req.qty,
        available: Number(res.rows[0].available),
        replayed: false,
      };
    },

    release: async (handle: Db, reservationId: string) => {
      // Guarded on `state = 'held'`, exactly as Cart's own ledger is, so a
      // release racing a commit gives stock back at most once.
      await handle.execute(sql`
        WITH freed AS (
          UPDATE cart_test_holds SET state = 'released'
           WHERE reservation_id = ${reservationId} AND state = 'held'
          RETURNING variant_id, qty
        )
        UPDATE cart_test_inventory i
           SET reserved = i.reserved - freed.qty
          FROM freed WHERE i.variant_id = freed.variant_id`);
    },

    commitReservation: async (handle: Db, reservationId: string) => {
      await handle.execute(sql`
        WITH done AS (
          UPDATE cart_test_holds SET state = 'committed'
           WHERE reservation_id = ${reservationId} AND state = 'held'
          RETURNING variant_id, qty
        )
        UPDATE cart_test_inventory i
           SET on_hand = i.on_hand - done.qty, reserved = i.reserved - done.qty
          FROM done WHERE i.variant_id = done.variant_id`);
    },
  };
}
