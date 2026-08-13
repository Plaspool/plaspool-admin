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
import { describe, expect, it } from 'vitest';
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
     */
    const early = `${ID.ledger}${(1_700_000_000_000).toString(36)}0000000000000000`;
    const late = `${ID.ledger}${(1_800_000_000_000).toString(36)}0000000000000000`;
    expect(early < late).toBe(true);
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
     * WRITTEN OUT, NOT IMPORTED. `server/shop/orders/ids.ts` is the other half of
     * this comparison and importing it is exactly the coupling spec D9 forbids —
     * so the shop's set is a literal here, and this test is the thing that fails
     * if the two subsystems ever reach for the same three letters.
     *
     * It is not a cosmetic worry. `marketing_ledger.order_id` stores an `ord_`
     * from another subsystem in the same row as a `pts_` of our own, and the
     * return timeline's `mev_` sits beside orders' `oev_` in log lines and in
     * support conversations. Two subsystems minting one prefix makes "which
     * table is this row in" unanswerable from the id.
     */
    const shopPrefixes = ['ord_', 'oln_', 'ful_', 'fll_', 'oev_', 'evt_', 'eml_'];
    for (const prefix of Object.values(ID)) {
      expect(shopPrefixes).not.toContain(prefix);
    }
  });

  it('is three letters and an underscore throughout, so an id reads as one word', () => {
    for (const prefix of Object.values(ID)) {
      expect(prefix).toMatch(/^[a-z]{3}_$/);
    }
  });
});
