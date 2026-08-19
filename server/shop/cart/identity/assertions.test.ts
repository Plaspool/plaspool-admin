import { describe, expect, it } from 'vitest';
import { spendAssertion } from './assertions';
import { migratedDb } from '../test/harness';

describe('spendAssertion', () => {
  it('spends an unseen key once', async () => {
    const { db } = await migratedDb();
    expect(await spendAssertion(db, 'jti-one')).toBe(true);
  });

  it('refuses the second spend of the same key', async () => {
    const { db } = await migratedDb();
    expect(await spendAssertion(db, 'jti-two')).toBe(true);
    expect(await spendAssertion(db, 'jti-two')).toBe(false);
  });

  it('lets two different keys through', async () => {
    const { db } = await migratedDb();
    expect(await spendAssertion(db, 'jti-a')).toBe(true);
    expect(await spendAssertion(db, 'jti-b')).toBe(true);
  });

  it('survives a concurrent double spend, granting exactly one', async () => {
    const { db } = await migratedDb();
    const both = await Promise.all([
      spendAssertion(db, 'jti-race'),
      spendAssertion(db, 'jti-race'),
    ]);
    expect(both.filter(Boolean)).toHaveLength(1);
  });
});
