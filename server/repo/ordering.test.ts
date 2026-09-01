/**
 * ONE ORDERING, AND IT IS STILL WORTH PINNING.
 *
 * `createUser` calls `assertDisplayName(a.displayName)` and only then
 * `await hashPassword(...)`. Swapping those two lines leaves every other test
 * in the suite green — the same error is thrown, with the same message, and
 * nothing observable changes except how much CPU a rejected call costs.
 *
 * What it costs is the point. scrypt at the production parameters (N=2^15,
 * r=8) is ~32 MiB and ~200 ms of blocked derivation per call, deliberately,
 * and `password.ts` admits at most two concurrently. Hash first and a rejected
 * call still buys 200 ms of the semaphore; validate first and it costs a
 * string comparison.
 *
 * THIS FILE SHRANK WHEN CLERK BECAME THE ONLY AUTH (2026-09-01), and the
 * missing half is worth naming so nobody re-adds it. It used to cover
 * `acceptInvite` too, and that was the case the property really existed for:
 * accept-invite was UNAUTHENTICATED, so anyone holding a link — or guessing at
 * one — could aim garbage at scrypt. That route is gone. `createUser` is now
 * reached from exactly one place, `claimInviteForEmail`, behind a verified
 * Clerk identity, so the flooding scenario needs a real account first.
 *
 * It also used to assert a password floor. `createUser` no longer takes a
 * password at all — it mints one nobody holds — so there is nothing left to
 * judge but the name.
 *
 * The assertion is on the CALL and not on a timing measurement: a duration
 * assertion would be flaky under load, and it is the ordering, not the
 * duration, that has to hold.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb } from '../test/harness';
import type { Db } from '../db/client';
import { hashPassword } from './password';
import { UserInputError, createUser } from './users';

// Hoisted above the imports by Vitest. The real implementation is kept — this
// counts calls, it does not replace behaviour, so the success path below still
// derives a genuine hash.
vi.mock('./password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./password')>();
  return { ...actual, hashPassword: vi.fn(actual.hashPassword) };
});

let db: Db;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  // `migratedDb`, not `freshDb`: seeding users would call the spy.
  ({ db, close } = await migratedDb());
});

afterAll(async () => {
  await close?.();
});

beforeEach(() => {
  vi.mocked(hashPassword).mockClear();
});

let seq = 0;
const email = () => `ord${++seq}.${Date.now().toString(36)}@test.local`;

describe('the display name is judged before scrypt is spent', () => {
  it('createUser rejects a blank display name without hashing anything', async () => {
    /* `'   '` and not `''`: Zod's `.min(1)` accepts the former, so this is the
       value `assertDisplayName` exists to refuse. */
    await expect(
      createUser(db, { email: email(), displayName: '   ', role: 'writer' }),
    ).rejects.toBeInstanceOf(UserInputError);
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it('but a valid one IS hashed, so the spy is wired to something real', async () => {
    // Without this the assertion above would also pass against a mock that
    // never fires.
    const user = await createUser(db, {
      email: email(),
      displayName: 'Accepted',
      role: 'writer',
    });
    expect(user.displayName).toBe('Accepted');
    expect(hashPassword).toHaveBeenCalledTimes(1);
  });

  it('and the password it mints is not one anybody supplied', async () => {
    /*
     * The invariant `createUser` losing its `password` parameter bought: no
     * call site can hand it a knowable value, so two accounts created the same
     * way do not share a hash. Cheap to assert and the only place that says so.
     */
    const a = await createUser(db, { email: email(), displayName: 'A', role: 'writer' });
    const b = await createUser(db, { email: email(), displayName: 'B', role: 'writer' });
    /* Read straight off the column: `findUserByEmail` deliberately no longer
       returns it, which is the other half of the same cleanup. */
    const rows = await db.execute(sql`
      SELECT password_hash FROM users WHERE id IN (${a.id}::uuid, ${b.id}::uuid)`);
    const hashes = rows.rows.map((r) => String(r.password_hash));
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(hashes[0]).toMatch(/^scrypt\$/);
  });
});
