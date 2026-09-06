import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb } from '../../../test/harness';
import type { RawCtx } from '../../../test/harness';
import { NotFoundError } from '../../../repo/errors';
import { StaleAddOnWriteError } from '../errors';
import { createAddOn, getAddOn, listAddOns, updateAddOn } from './repo';
import { RulesSchema } from './rules-schema';
import type { AddOnRule } from '../../../../shared/commerce/add-ons';

let ctx: RawCtx;
const NOW = 1_800_000_000_000;

beforeAll(async () => {
  ctx = await migratedDb();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM shop_add_ons`);
});

/*
 * Typed explicitly rather than `as const`: the fixture is reused both as a
 * loose value (`RulesSchema.safeParse`, which takes `unknown`) and as
 * `AddOnInput.rules` (mutable `AddOnRule[]`). `as const` would narrow the
 * literals correctly but make every nested array `readonly`, which
 * `AddOnRule`'s mutable `when: AddOnCondition[]` then refuses to accept —
 * the annotation gives the same literal narrowing through contextual typing
 * without that mismatch.
 */
const RULES: AddOnRule[] = [
  { when: [{ attribute: 'item_count', op: 'between', min: 1, max: 4 }], then: 'ask' },
  { when: [{ attribute: 'item_count', op: 'gte', value: 5 }], then: 'include', amountMinor: 0 },
];

const box = () =>
  createAddOn(
    ctx.db,
    { title: 'Gift box', description: 'Boxed.', priceMinor: 150_000, currency: 'NGN', rules: [...RULES] },
    NOW,
  );

describe('the rules schema', () => {
  it('accepts the demo rules and refuses the shapes the evaluator cannot read', () => {
    expect(RulesSchema.safeParse(RULES).success).toBe(true);
    expect(RulesSchema.safeParse([]).success).toBe(false);
    expect(RulesSchema.safeParse([{ when: [], then: 'maybe' }]).success).toBe(false);
    expect(RulesSchema.safeParse([{ when: [{ attribute: 'item_count', op: 'between', min: 5, max: 1 }], then: 'ask' }]).success).toBe(false);
    expect(RulesSchema.safeParse([{ when: [{ attribute: 'tag', op: 'gte', value: 1 }], then: 'ask' }]).success).toBe(false);
    expect(RulesSchema.safeParse([{ when: [{ attribute: 'tag', op: 'any_in', values: [] }], then: 'ask' }]).success).toBe(false);
    expect(RulesSchema.safeParse([{ when: [{ attribute: 'signed_in', op: 'is', value: true }], then: 'include', amountMinor: null }]).success).toBe(true);
    expect(RulesSchema.safeParse([{ when: [], then: 'ask', extra: 1 }]).success).toBe(false);
  });
});

describe('the repository', () => {
  it('creates a draft with an ado_ id and reads it back with its rules', async () => {
    const created = await box();
    expect(created.id).toMatch(/^ado_/);
    expect(created.status).toBe('draft');
    expect(created.revision).toBe(1);
    expect(created.currency).toBe('NGN');
    expect(await getAddOn(ctx.db, created.id)).toEqual(created);
    expect(created.rules).toEqual(RULES);
  });

  it('lists by position then creation, and filters by status', async () => {
    const a = await box();
    const b = await createAddOn(ctx.db, { title: 'Note', priceMinor: 0, currency: 'NGN', rules: [RULES[0]], position: -1, status: 'active' }, NOW + 1);
    expect((await listAddOns(ctx.db)).map((x) => x.id)).toEqual([b.id, a.id]);
    expect((await listAddOns(ctx.db, 'active')).map((x) => x.id)).toEqual([b.id]);
  });

  it('updates under CAS: a stale revision refuses with the current row', async () => {
    const created = await box();
    const saved = await updateAddOn(ctx.db, created.id, 1, { title: 'Gift box (large)', description: null }, NOW + 5);
    expect(saved.title).toBe('Gift box (large)');
    expect(saved.description).toBeNull();
    expect(saved.revision).toBe(2);
    expect(saved.updatedAt).toBe(NOW + 5);
    await expect(updateAddOn(ctx.db, created.id, 1, { title: 'x' }, NOW + 6)).rejects.toBeInstanceOf(StaleAddOnWriteError);
    await expect(updateAddOn(ctx.db, 'ado_nope', 1, { title: 'x' }, NOW + 6)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('an absent field leaves the column alone', async () => {
    const created = await box();
    const saved = await updateAddOn(ctx.db, created.id, 1, { status: 'active' }, NOW + 5);
    expect(saved.title).toBe('Gift box');
    expect(saved.rules).toEqual(RULES);
    expect(saved.status).toBe('active');
  });
});
