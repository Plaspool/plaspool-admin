/**
 * The driver-error leak, and the seam that closes it.
 *
 * Drizzle wraps a failed statement in a `DrizzleQueryError` whose own message
 * is `Failed query: INSERT INTO users (...)\nparams: alice@example.com,scrypt$…`
 * — the interpolated parameters verbatim, in the message and in the stack. On
 * the users table those parameters are an account email and a freshly derived
 * password hash, so one ordinary `console.error(err)` writes an
 * offline-crackable hash to the log. The reaching path is not exotic: the owner
 * invites an address that already has an account, the invitee accepts,
 * `users_email_unique` fires, 500.
 *
 * These tests assert on `message` AND `stack`, because `Error.captureStackTrace`
 * puts the message at the top of the stack string — scrubbing one and not the
 * other closes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb } from '../test/harness';
import { DbError, toEpochMs, toEpochMsOrNull, uniqueViolation } from './client';
import type { Db } from './client';
import {
  DuplicateEmailError,
  acceptInvite,
  createInvite,
  createUser,
} from '../repo/users';

let db: Db;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});

afterAll(async () => {
  await close?.();
});

const PASSWORD = 'CorrectHorseBatteryStaple';
const SECOND_PASSWORD = 'AnotherSecretEntirely9';

/** Everything an error is allowed to be inspected through, flattened. */
function surface(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let hops = 0; hops < 8 && cur != null; hops += 1) {
    const e = cur as { message?: unknown; stack?: unknown; cause?: unknown };
    parts.push(String(e.message ?? ''), String(e.stack ?? ''));
    cur = e.cause;
  }
  // A logger that does not know the shape reaches for these two.
  parts.push(String(err));
  try {
    parts.push(JSON.stringify(err, Object.getOwnPropertyNames(Object(err))));
  } catch {
    /* an unserialisable error is not a leak */
  }
  return parts.join('\n');
}

const HASH_PATTERN = /scrypt\$\d+\$/;

describe('driver errors carry no values', () => {
  it('a duplicate email escapes createUser with neither the hash nor the address', async () => {
    const email = 'alice@example.com';
    await createUser(db, {
      email,
      password: PASSWORD,
      displayName: 'Alice',
      role: 'owner',
    });

    const err = await createUser(db, {
      // Different case on purpose: the collision is on the lowercased value, so
      // the leaked parameter is the STORED address, not the one supplied.
      email: 'Alice@Example.com',
      password: SECOND_PASSWORD,
      displayName: 'Mallory',
      role: 'writer',
    }).then(
      () => {
        throw new Error('expected the duplicate insert to be rejected');
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(DuplicateEmailError);
    const text = surface(err);
    expect(text).not.toMatch(HASH_PATTERN);
    expect(text.toLowerCase()).not.toContain('alice@example');
    expect(text).not.toContain('Mallory');
    expect(text).not.toContain('INSERT INTO users');
  });

  it('the same holds through acceptInvite, which rethrows what createUser threw', async () => {
    const inviter = await createUser(db, {
      email: 'owner-inv@example.com',
      password: PASSWORD,
      displayName: 'Owner',
      role: 'owner',
    });
    const taken = 'bob@example.com';
    await createUser(db, {
      email: taken,
      password: PASSWORD,
      displayName: 'Bob',
      role: 'writer',
    });

    const { token } = await createInvite(db, {
      email: taken,
      role: 'writer',
      invitedBy: inviter.id,
    });

    const err = await acceptInvite(db, {
      token,
      password: SECOND_PASSWORD,
      displayName: 'Impostor',
    }).then(
      () => {
        throw new Error('expected accepting an invite for a taken email to fail');
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(DuplicateEmailError);
    const text = surface(err);
    expect(text).not.toMatch(HASH_PATTERN);
    expect(text.toLowerCase()).not.toContain('bob@example');
  });

  it('a raw db.execute failure loses its query and its parameters', async () => {
    // Not via a repo: this pins `guardDb` itself, so a later task writing raw
    // SQL inherits the scrub without doing anything.
    const author = await createUser(db, {
      email: 'author-raw@example.com',
      password: PASSWORD,
      displayName: 'Author',
      role: 'writer',
    });
    const secret = 'not-for-the-log-9f3a';
    const insert = (id: string) => db.execute(sql`
      INSERT INTO posts (id, title, subtitle, slug, excerpt, excerpt_source, content,
                         content_text, cover_image, category, tags, status,
                         created_at, updated_at, published_at, deleted_at,
                         word_count, reading_time, author_id, revision)
      VALUES (${id}, ${secret}, '', 'taken-slug-once', '', 'derived',
              ${'{"type":"doc","content":[]}'}::jsonb, '', NULL, '',
              ${sql.param([])}, 'draft', ${Date.now()}, ${Date.now()},
              NULL, NULL, 0, 0, ${author.id}, 1)`);

    await insert('p_leak_1');
    const err = await insert('p_leak_2').then(
      () => {
        throw new Error('expected the duplicate slug to be rejected');
      },
      (e: unknown) => e,
    );

    const text = surface(err);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('taken-slug-once');
    expect(text).not.toContain('INSERT INTO posts');
    expect(text).not.toContain('Failed query');
  });

  it('keeps the SQLSTATE and the constraint, so a log still identifies the failure', async () => {
    const err = await db
      .execute(sql`INSERT INTO users (email, password_hash, display_name, role, created_at)
                   VALUES ('alice@example.com', 'x', 'Dup', 'owner', ${Date.now()})`)
      .then(
        () => {
          throw new Error('expected the duplicate insert to be rejected');
        },
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(DbError);
    const dbErr = err as DbError;
    expect(dbErr.code).toBe('23505');
    expect(dbErr.constraint).toBe('users_email_unique');
    expect(dbErr.message).toContain('23505');
    expect(dbErr.message).toContain('users_email_unique');
    // The chain is cut deliberately: an attached `cause` is one `console.error`
    // away from putting the parameters back in the log.
    expect((dbErr as { cause?: unknown }).cause).toBeUndefined();
    expect(uniqueViolation(err)).toBe('users_email_unique');
  });

  it('leaves a non-driver error alone', async () => {
    // A bug in a repo must not be reshaped into a DbError, or the stack that
    // points at the bug is gone.
    const boom = new TypeError('x is not a function');
    await expect(
      db.execute(sql`SELECT 1`).then(() => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(uniqueViolation(boom)).toBeNull();
  });
});

describe('bigint parity between the test driver and production', () => {
  it('returns int8 as a string, exactly as @neondatabase/serverless does', async () => {
    // PGlite parses int8 into a JS number by default. Left that way, every
    // bigint read is right here and wrong on Neon — `expires_at <= now` becomes
    // a string comparison and `created_at + TTL` becomes concatenation. The
    // harness overrides the parser so the suite runs against the stricter of
    // the two drivers.
    const res = await db.execute(sql`SELECT created_at FROM users LIMIT 1`);
    expect(typeof res.rows[0].created_at).toBe('string');
  });

  it('toEpochMs coerces both driver shapes, and the nullable form keeps NULL', () => {
    expect(toEpochMs('1786416150595')).toBe(1786416150595);
    expect(toEpochMs(1786416150595)).toBe(1786416150595);
    expect(toEpochMsOrNull(null)).toBeNull();
    expect(toEpochMsOrNull(undefined)).toBeNull();
    expect(toEpochMsOrNull('17')).toBe(17);
  });
});
