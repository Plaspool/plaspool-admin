/**
 * The id shape, pinned — because this is the THIRD copy of a four-line function
 * and a copy is a place two implementations drift.
 *
 * `newId` is module-private in `server/repo/posts.ts` and copied again into
 * `server/shop/orders/ids.ts`, which spec D9 puts out of reach for this
 * subsystem: marketing never imports `server/shop/**`, and a test that imported
 * the orders copy to compare against would be that dependency, written in the
 * one file nobody thinks of as production code. So the shape is asserted here
 * against the same regex the orders suite uses, written out rather than shared.
 *
 * The PREFIXES are the other half. They are the literals migration 0011 stamps
 * into nine primary keys (spec §Database), and they are the strings the returns
 * queue matches when an admin pastes an id into the search box (`q` matches an
 * exact `ret_` id, contract #4). Changing one is a data migration, not a rename,
 * so each is written out below rather than derived.
 */
import { describe, expect, it, vi } from 'vitest';
import { ID, newId } from './ids';

describe('newId', () => {
  it('is a prefix, a base-36 timestamp and 16 hex characters', () => {
    /*
     * The same shape `server/repo/posts.ts`, `server/repo/images.ts` and
     * `server/shop/orders/ids.ts` mint, so an id is indistinguishable by origin.
     * That matters here for one concrete reason: `marketing_ledger.order_id` and
     * `marketing_return_requests.customer_id` hold ids MINTED BY THE SHOP (spec
     * D10 — TEXT, no FK), and a marketing id that looked structurally different
     * would invite code that tells them apart by shape instead of by column.
     */
    for (const prefix of Object.values(ID)) {
      expect(newId(prefix)).toMatch(new RegExp(`^${prefix}[0-9a-z]{8,9}[0-9a-f]{16}$`));
    }
  });

  it('sorts by mint time, which is what the keyset pagers order on', () => {
    /*
     * Contract #4 and #17 page by `(created_at DESC, id DESC)`. The id is the
     * TIE-BREAKER, so two rows written in the same millisecond still have a
     * stable order — and a cursor that resumes mid-page cannot skip or repeat a
     * row. The base-36 time prefix is what makes that true; the 64 bits after it
     * are the uniqueness, not the ordering.
     *
     * MINTED UNDER A DRIVEN CLOCK, NOT HAND-BUILT. Two literal strings compared
     * with `<` assert a property of `Number.prototype.toString(36)` and never
     * reach `newId` at all — they stay green with the timestamp moved to the END
     * of the id, which is exactly the arrangement that destroys the ordering
     * this test is named for. So the clock moves and the real function answers.
     *
     * CONSECUTIVE MILLISECONDS, and forty of them, because the interesting case
     * is a carry: `…zz` → `…001` rolls the last base-36 digit over, and only a
     * fixed-width encoding keeps numeric order and lexicographic order the same
     * across it. A gap of a whole second would hide a dozen broken encodings.
     */
    vi.useFakeTimers();
    try {
      const base = Date.parse('2026-08-13T00:00:00.000Z');
      const minted = Array.from({ length: 40 }, (_, i) => {
        vi.setSystemTime(base + i);
        return newId(ID.ledger);
      });
      expect(minted).toEqual([...minted].sort());
      // …and the ordering is the TIME's, not the randomness's: same instant,
      // so everything up to the 64 random bits must be identical.
      vi.setSystemTime(base);
      expect(newId(ID.ledger).slice(0, -16)).toBe(newId(ID.ledger).slice(0, -16));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not repeat across a burst', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId(ID.timeline)));
    expect(ids.size).toBe(5000);
  });
});

describe('the prefixes', () => {
  it('are the seven literals migration 0011 stamps into primary keys', () => {
    // Spec §Database names each one against its table. A change here is a data
    // migration over every existing row, not a rename.
    expect(ID).toEqual({
      program: 'prg_',
      return: 'ret_',
      timeline: 'mev_',
      ledger: 'pts_',
      emailIntent: 'mmi_',
      banner: 'bnr_',
      discount: 'dsc_',
    });
  });

  it('collides with nothing the shop mints', () => {
    /*
     * WRITTEN OUT, NOT IMPORTED. Those files are the other half of this
     * comparison and importing them is exactly the coupling spec D9 forbids — so
     * the shop's set is a literal here, and this test is the thing that fails if
     * the two subsystems ever reach for the same three letters.
     *
     * ALL THREE OF THE SHOP'S MINTS, not just orders'. Orders is the module whose
     * ids marketing actually stores, but the collision this guards against is
     * with anything the shop hands out: a marketing `cus_` or `prd_` would be
     * just as unanswerable in a log line, and a list that covered one module
     * would go green for the other two.
     *
     * It is not a cosmetic worry. `marketing_ledger.order_id` stores an `ord_`
     * from another subsystem in the same row as a `pts_` of our own, and the
     * return timeline's `mev_` sits beside orders' `oev_` in log lines and in
     * support conversations. Two subsystems minting one prefix makes "which
     * table is this row in" unanswerable from the id.
     */
    const shopPrefixes = [
      // server/shop/orders/ids.ts
      'ord_', 'oln_', 'ful_', 'fll_', 'oev_', 'evt_', 'eml_',
      // server/shop/cart/ids.ts
      'cus_', 'crt_', 'crl_', 'res_', 'adr_',
      // server/shop/catalog/mapping.ts#newCatalogId
      'prd_', 'var_', 'prc_', 'prv_',
    ];
    for (const prefix of Object.values(ID)) {
      expect(shopPrefixes).not.toContain(prefix);
    }

    // The blog half mints `p_` and `r_` (too short to reach a three-letter
    // prefix) and `img_` (not). Asserted here rather than in a suite of its own
    // because the failure is the same one: two tables, one prefix.
    for (const prefix of Object.values(ID)) {
      expect(prefix).not.toBe('img_');
    }
  });

  it('is three letters and an underscore throughout, so an id reads as one word', () => {
    for (const prefix of Object.values(ID)) {
      expect(prefix).toMatch(/^[a-z]{3}_$/);
    }
  });
});
