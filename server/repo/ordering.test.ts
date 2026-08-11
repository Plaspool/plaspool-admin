/**
 * ONE ORDERING, AND IT IS A SECURITY PROPERTY.
 *
 * `createUser` calls `assertCredentials(a)` and only then `await
 * hashPassword(a.password)`. Swapping those two lines leaves every other test
 * in the suite green — the same error is thrown, with the same message, and
 * nothing observable changes except how much CPU a rejected request costs.
 *
 * What it costs is the point. scrypt at the production parameters (N=2^15,
 * r=8) is ~32 MiB and ~200 ms of blocked derivation per call, deliberately, and
 * `password.ts` admits at most two concurrently. Accept-invite is
 * UNAUTHENTICATED: anyone holding a link, or guessing at one, can post to it.
 * Hash first and a one-character password — rejected in microseconds by the
 * length check — instead buys 200 ms of the semaphore, and a few hundred
 * requests per second of garbage saturate it. Validate first and the same
 * traffic costs a string comparison.
 *
 * This is why the assertion is on the call and not on a timing measurement: a
 * duration assertion would be flaky under load, and it is the ordering, not the
 * duration, that has to hold.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migratedDb } from '../test/harness';
import type { Db } from '../db/client';
import { hashPassword } from './password';
import {
  UserInputError,
  acceptInvite,
  createInvite,
  createUser,
} from './users';

// Hoisted above the imports by Vitest. The real implementation is kept — this
// counts calls, it does not replace behaviour, so the success paths below still
// derive a genuine hash.
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

describe('credentials are judged before scrypt is spent on them', () => {
  it('createUser rejects a too-short password without hashing it', async () => {
    await expect(
      createUser(db, {
        email: email(),
        password: 'nine-char',
        displayName: 'Rejected',
        role: 'writer',
      }),
    ).rejects.toBeInstanceOf(UserInputError);
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it('createUser rejects a blank display name without hashing either', async () => {
    // The display-name branch is on the far side of the length check, so it is
    // the one that catches a swap moved only partway.
    await expect(
      createUser(db, {
        email: email(),
        password: 'a-long-enough-one',
        displayName: '   ',
        role: 'writer',
      }),
    ).rejects.toBeInstanceOf(UserInputError);
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it('acceptInvite refuses before it claims the invite or hashes anything', async () => {
    // The unauthenticated path, and the one the property exists for.
    const inviter = await createUser(db, {
      email: email(),
      password: 'pw-owner-strong',
      displayName: 'Owner',
      role: 'owner',
    });
    vi.mocked(hashPassword).mockClear();

    const { token } = await createInvite(db, {
      email: email(),
      role: 'writer',
      invitedBy: inviter.id,
    });

    await expect(
      acceptInvite(db, { token, password: '', displayName: 'Flood' }),
    ).rejects.toBeInstanceOf(UserInputError);
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it('but a valid password IS hashed, so the spy is wired to something real', async () => {
    // Without this the three assertions above would also pass against a mock
    // that never fires.
    const user = await createUser(db, {
      email: email(),
      password: 'a-long-enough-one',
      displayName: 'Accepted',
      role: 'writer',
    });
    expect(user.displayName).toBe('Accepted');
    expect(hashPassword).toHaveBeenCalledTimes(1);
  });
});
