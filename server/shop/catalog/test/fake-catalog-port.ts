/**
 * An in-memory `CatalogPort`, for the three subsystems that consume Catalog.
 *
 * WHY THIS SHIPS IN CATALOG'S FIRST COMMIT (brief §1). Cart is blocked on the
 * SIGNATURE, not on the implementation — and the only way that stays true is if
 * the signature arrives with something Cart can actually call. A fake written by
 * the consumer proves the consumer against its own understanding of the port; a
 * fake written by the implementer and used by the consumer is the closest thing
 * to a contract test the two get before they are wired together.
 *
 * WHERE IT LIVES, AND THE DISAGREEMENT THAT PUT IT HERE. Contract §11 says the
 * Cart fake lives in `server/shop/cart/test/`; brief §8 makes "a documented
 * in-memory fake exported for the other three agents" a Catalog deliverable.
 * The contract wins (§0) and the disagreement is raised as amendment A-001, so
 * this file is offered rather than imposed: Cart may import it or keep its own.
 * It is under `server/shop/catalog/`, which Catalog owns exclusively, so
 * offering it breaks no ownership rule either way.
 *
 * WHAT IT IS FAITHFUL TO, deliberately, because a fake that is easier than the
 * real thing hides the bugs the real thing has:
 *
 * - **Insufficient stock is `{ ok: false }`, never a throw** (brief §5).
 * - **`reservationId` is the idempotency key.** A repeat call holds stock once
 *   and comes back `replayed: true`.
 * - **`release` and `commitReservation` are idempotent and safe after expiry.**
 *   Whichever of Cart's sweeper and Payments' capture arrives second is a no-op
 *   rather than a double decrement — the interleaving brief §5 names.
 * - **`available` is derived**, never stored. `onHand` and `reserved` are the
 *   only two numbers here, as in the real table.
 * - **`expiresAt` is recorded and never acted on.** Catalog does not expire
 *   holds; Cart sweeps them and calls `release`. A fake that expired them by
 *   itself would let a Cart suite pass without ever writing its sweeper.
 *
 * It does NOT model the CAS, the trigger, or SQL-level atomicity. Those are
 * database properties and are proved against PGlite in Catalog's own suites —
 * this is for consumers who need a `CatalogPort` that answers, not for anyone
 * testing Catalog.
 */
import type { Db } from '../../../db/client';
/*
 * Imported from `catalog-port` rather than from `ports`, deliberately.
 * `shared/commerce/ports.ts` re-exports it, and that re-export is a line four
 * agents have repeatedly clobbered (A-CAT-009). Catalog's own modules depend on
 * the file Catalog owns so that a clobbered re-export breaks the consumers who
 * need to know about it and not the implementation itself.
 */
import type {
  CatalogPort,
  ReservationRequest,
  BulkTier,
  ReservationResult,
  VariantQuote,
} from '../../../../shared/commerce/catalog-port';

/** One variant's worth of world, as the fake holds it. */
export interface FakeVariant extends Omit<VariantQuote, 'available' | 'bulkTiers'> {
  onHand: number;
  reserved: number;
  /** False makes `quote` return null and `reserve` answer `not_sellable`. */
  sellable?: boolean;
  /**
   * OPTIONAL HERE THOUGH REQUIRED ON `VariantQuote`, which is why it is pulled
   * out of the `Omit` above rather than inherited.
   *
   * Every fixture written before migration 0600 describes a world with no bulk
   * ladder, and making them all name an empty array would be churn that asserts
   * nothing. `quote` substitutes `[]`, which is exactly what those fixtures mean.
   */
  bulkTiers?: BulkTier[];
}

interface Hold {
  variantId: string;
  qty: number;
  state: 'held' | 'released' | 'committed';
  expiresAt: number;
}

export interface FakeCatalog extends CatalogPort<Db> {
  /** Add or replace a variant. Returns the same object for chaining in a setup. */
  seed(variant: FakeVariant): FakeVariant;
  /** The two stored numbers, for an assertion. `null` if unknown. */
  stockOf(variantId: string): { onHand: number; reserved: number } | null;
  /** The hold, for asserting idempotency and the release/commit race. */
  holdOf(reservationId: string): Readonly<Hold> | null;
  reset(): void;
}

/**
 * `db` is accepted and ignored on every method, matching the real port's shape
 * exactly. A consumer written against the fake therefore threads its handle
 * through in the same places, and swapping in the real implementation is an
 * injection change and nothing else.
 */
export function fakeCatalogPort(seedWith: readonly FakeVariant[] = []): FakeCatalog {
  const variants = new Map<string, FakeVariant>();
  const holds = new Map<string, Hold>();

  const seed = (variant: FakeVariant): FakeVariant => {
    variants.set(variant.variantId, { sellable: true, ...variant });
    return variant;
  };
  for (const variant of seedWith) seed(variant);

  const availableOf = (v: FakeVariant): number => v.onHand - v.reserved;

  return {
    seed,

    stockOf: (variantId) => {
      const v = variants.get(variantId);
      return v ? { onHand: v.onHand, reserved: v.reserved } : null;
    },

    holdOf: (reservationId) => holds.get(reservationId) ?? null,

    reset: () => {
      variants.clear();
      holds.clear();
    },

    quote: (_db: Db, variantId: string): Promise<VariantQuote | null> => {
      const v = variants.get(variantId);
      if (!v || v.sellable === false) return Promise.resolve(null);
      const { onHand: _onHand, reserved: _reserved, sellable: _sellable, ...rest } = v;
      return Promise.resolve({
        ...rest,
        available: availableOf(v),
        // `?? []` — the port promises an array, and an absent ladder is none.
        bulkTiers: v.bulkTiers ?? [],
      });
    },

    reserve: (_db: Db, req: ReservationRequest): Promise<ReservationResult> => {
      if (!Number.isInteger(req.qty) || req.qty <= 0) {
        return Promise.resolve({ ok: false, reason: 'invalid_qty', available: 0 });
      }

      // Idempotency FIRST, and by the stored row rather than by a scan: a repeat
      // of a hold that has since been released or committed must not re-reserve
      // stock, so `replayed` is answered from the hold's existence and not from
      // its state.
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
      if (v.sellable === false) {
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
      // Only a hold that is still HELD returns stock. Releasing a committed hold
      // would hand back units that have already been sold and shipped.
      if (!hold || hold.state !== 'held') return Promise.resolve();
      const v = variants.get(hold.variantId);
      if (v) v.reserved -= hold.qty;
      hold.state = 'released';
      return Promise.resolve();
    },

    commitReservation: (_db: Db, reservationId: string): Promise<void> => {
      const hold = holds.get(reservationId);
      // Same guard, same reason in the mirror: committing a released hold would
      // decrement on-hand for stock that was already given back.
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
