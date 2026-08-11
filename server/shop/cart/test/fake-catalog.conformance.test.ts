/**
 * Cart's fake and Catalog's fake answer the same questions the same way.
 *
 * ═══ WHY THIS FILE EXISTS ═══
 * Two fakes of one port is two beliefs about that port, and the moment they
 * diverge Cart's reservation logic is proved against a contract Catalog does not
 * implement — a mistake that surfaces at integration, which is where every round
 * of both prior gauntlets already fails. Contract §11 puts Cart's fake in
 * `server/shop/cart/test/`; Catalog's brief makes shipping one a Catalog
 * deliverable (AMENDMENTS A-CAT-001). Rather than pick a winner while that is
 * unresolved, both exist and this table is run against both.
 *
 * ═══ THE ONE CROSS-SUBSYSTEM IMPORT IN CART, AND WHY IT IS ALLOWED ═══
 * R2 forbids importing another subsystem's REPO or ROUTE modules. A test double
 * is neither, and the import is confined to this single file so that a broken
 * Catalog tree costs Cart exactly one red test rather than a red bar. Every
 * other Cart suite uses Cart's own fake and has no Catalog import at all.
 */
import { describe, expect, it } from 'vitest';
import { fakeCatalog } from './fake-catalog';
import { fakeCatalogPort } from '../../catalog/test/fake-catalog-port';
import type { CatalogPort } from '../catalog-port';
import type { Db } from '../../../db/client';

/** Both fakes accept and ignore it, exactly as the real port's shape requires. */
const db = null as unknown as Db;

const PRICE = { amount: 1999, currency: 'GBP' };

interface Subject {
  name: string;
  build(a: { onHand: number; backorderable?: boolean; sellable?: boolean }): CatalogPort;
}

const SUBJECTS: Subject[] = [
  {
    name: "Cart's fake",
    build: (a) =>
      fakeCatalog([
        {
          variantId: 'var_x',
          productId: 'prd_x',
          sku: 'X',
          title: 'X',
          optionValues: {},
          price: PRICE,
          weightGrams: 100,
          onHand: a.onHand,
          backorderable: a.backorderable ?? false,
          sellable: a.sellable ?? true,
        },
      ]),
  },
  {
    name: "Catalog's fake",
    build: (a) =>
      fakeCatalogPort([
        {
          variantId: 'var_x',
          productId: 'prd_x',
          sku: 'X',
          title: 'X',
          optionValues: {},
          price: PRICE,
          weightGrams: 100,
          onHand: a.onHand,
          reserved: 0,
          backorderable: a.backorderable ?? false,
          sellable: a.sellable ?? true,
        },
      ]) as unknown as CatalogPort,
  },
];

const req = (over: Partial<{ reservationId: string; qty: number }> = {}) => ({
  reservationId: 'res_1',
  variantId: 'var_x',
  qty: 1,
  expiresAt: 1_700_000_000_000,
  ...over,
});

for (const subject of SUBJECTS) {
  describe(subject.name, () => {
    it('derives `available` and never exposes the stored numbers', async () => {
      const port = subject.build({ onHand: 10 });
      const quote = await port.quote(db, 'var_x');
      expect(quote?.available).toBe(10);
      expect(quote).not.toHaveProperty('onHand');
      expect(quote).not.toHaveProperty('reserved');
    });

    it('answers null for an unknown or unsellable variant', async () => {
      expect(await subject.build({ onHand: 10 }).quote(db, 'var_nope')).toBeNull();
      expect(
        await subject.build({ onHand: 10, sellable: false }).quote(db, 'var_x'),
      ).toBeNull();
    });

    it('RETURNS insufficient stock with the number rather than throwing', async () => {
      const port = subject.build({ onHand: 2 });
      const result = await port.reserve(db, req({ qty: 5 }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('insufficient');
      expect(result.available).toBe(2);
    });

    it('treats the reservation id as the idempotency key', async () => {
      const port = subject.build({ onHand: 10 });
      const first = await port.reserve(db, req({ qty: 2 }));
      const second = await port.reserve(db, req({ qty: 2 }));
      expect(first.ok && !first.replayed).toBe(true);
      expect(second.ok && second.replayed).toBe(true);
      // Held ONCE: two calls, two units, not four.
      expect((await port.quote(db, 'var_x'))?.available).toBe(8);
    });

    it('release then commit: the commit is a no-op', async () => {
      const port = subject.build({ onHand: 10 });
      await port.reserve(db, req({ qty: 2 }));
      await port.release(db, 'res_1');
      await port.commitReservation(db, 'res_1');
      // Given back, not sold.
      expect((await port.quote(db, 'var_x'))?.available).toBe(10);
    });

    it('commit then release: the release is a no-op', async () => {
      const port = subject.build({ onHand: 10 });
      await port.reserve(db, req({ qty: 2 }));
      await port.commitReservation(db, 'res_1');
      await port.release(db, 'res_1');
      // Sold, not given back — on-hand is 8 and nothing is reserved.
      expect((await port.quote(db, 'var_x'))?.available).toBe(8);
    });

    it('is safe to release or commit an id it has never seen', async () => {
      const port = subject.build({ onHand: 10 });
      await expect(port.release(db, 'res_unknown')).resolves.toBeUndefined();
      await expect(port.commitReservation(db, 'res_unknown')).resolves.toBeUndefined();
      expect((await port.quote(db, 'var_x'))?.available).toBe(10);
    });

    it('refuses a non-positive or fractional quantity as a value, not a throw', async () => {
      const port = subject.build({ onHand: 10 });
      for (const qty of [0, -1, 1.5]) {
        const result = await port.reserve(db, req({ qty, reservationId: `res_${qty}` }));
        expect(result.ok, String(qty)).toBe(false);
        if (result.ok) continue;
        expect(result.reason).toBe('invalid_qty');
      }
    });

    it('lets a backorderable variant go past available', async () => {
      const port = subject.build({ onHand: 0, backorderable: true });
      const result = await port.reserve(db, req({ qty: 3 }));
      expect(result.ok).toBe(true);
    });

    it('does NOT expire a hold by itself — the clock is Cart’s', async () => {
      // A fake that expired holds on its own would let a Cart suite pass with no
      // sweeper written at all.
      const port = subject.build({ onHand: 10 });
      await port.reserve(db, { ...req({ qty: 2 }), expiresAt: 1 });
      expect((await port.quote(db, 'var_x'))?.available).toBe(8);
    });
  });
}
