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
import { eq, sql } from 'drizzle-orm';
import { migratedDb } from '../test/harness';
import { DbError, EpochShapeError, toEpochMs, toEpochMsOrNull, uniqueViolation } from './client';
import type { Db } from './client';
import { posts, users } from './schema';
import {
  DuplicateEmailError,
  claimInviteForEmail,
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
      displayName: 'Alice',
      role: 'owner',
    });

    const err = await createUser(db, {
      // Different case on purpose: the collision is on the lowercased value, so
      // the leaked parameter is the STORED address, not the one supplied.
      email: 'Alice@Example.com',
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

  it('the same holds through claimInviteForEmail, which rethrows what createUser threw', async () => {
    /*
     * Was `acceptInvite` until Clerk became the only auth. The claim moved to
     * the Clerk exchange and keys on the address instead of a token, but the
     * property is unchanged and is the reason this case exists: the rethrow
     * used to be the shortest route from a unique violation to a password hash
     * in a log.
     */
    const inviter = await createUser(db, {
      email: 'owner-inv@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    const taken = 'bob@example.com';
    await createUser(db, { email: taken, displayName: 'Bob', role: 'writer' });

    await createInvite(db, { email: taken, role: 'writer', invitedBy: inviter.id });

    const err = await claimInviteForEmail(db, {
      email: taken,
      displayName: 'Impostor',
    }).then(
      () => {
        throw new Error('expected claiming an invite for a taken email to fail');
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

/**
 * ONE CASE PER DRIVER-REACHING API.
 *
 * The guard used to be `if (prop !== 'execute') return value`, and every test
 * above goes through `db.execute` — so `db.select`, `db.insert`, `db.update`,
 * `db.delete`, `db.query.*` and `db.transaction` all handed the raw
 * `DrizzleQueryError` to the caller, with the bound parameters in `message`, in
 * `stack`, on `cause`, in `String(err)` and in
 * `JSON.stringify(err, Object.getOwnPropertyNames(err))`. On `users` those
 * parameters are an account email and a live scrypt hash. It was latent only
 * because no production call site used the query builder yet, while `Db` is
 * typed as the full `PgDatabase` and the docstring on `guardDb` promised the
 * next ten repo modules that they were covered.
 *
 * These are deliberately one test per entry point rather than a loop: a loop
 * that stops matching the guard's method list degrades silently, and the point
 * of this block is that removing any single name from `GUARDED_METHODS` names
 * itself in the failure output.
 */
describe('every driver-reaching API is guarded, not just execute', () => {
  /** Run something that must fail, and assert nothing survived the scrub. */
  async function scrubbed(run: () => Promise<unknown>, values: string[]) {
    const err = await run().then(
      () => {
        throw new Error('expected the statement to be rejected, but it succeeded');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DbError);
    const text = surface(err);
    for (const value of values) expect(text).not.toContain(value);
    expect(text).not.toMatch(HASH_PATTERN);
    // Drizzle's own wrapper always opens with this, so its absence proves the
    // original error was discarded rather than reworded.
    expect(text).not.toContain('Failed query');
    return err as DbError;
  }

  /**
   * A live-looking hash, not a real one: these statements must fail on the
   * constraint, and paying for scrypt in six tests to prove a proxy forwards a
   * rejection would buy nothing. The value is what `HASH_PATTERN` looks for.
   */
  const DECOY_HASH = 'scrypt$32768$8$1$c2FsdA$TGl2ZUhhc2hIZXJl';

  let seq = 0;
  const addr = () => `guard${++seq}.${Date.now().toString(36)}@example.com`;

  async function mkUser(email: string): Promise<string> {
    const rows = await db
      .insert(users)
      .values({
        email,
        passwordHash: DECOY_HASH,
        displayName: 'Guarded',
        role: 'writer',
        createdAt: Date.now(),
      })
      .returning({ id: users.id });
    return rows[0].id;
  }

  it('insert', async () => {
    const email = addr();
    await mkUser(email);
    const err = await scrubbed(
      () =>
        db.insert(users).values({
          email,
          passwordHash: DECOY_HASH,
          displayName: 'Attacker',
          role: 'writer',
          createdAt: Date.now(),
        }),
      [email],
    );
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('users_email_unique');
  });

  it('update', async () => {
    const taken = addr();
    await mkUser(taken);
    const moverId = await mkUser(addr());
    const err = await scrubbed(
      () => db.update(users).set({ email: taken }).where(eq(users.id, moverId)),
      [taken],
    );
    expect(err.code).toBe('23505');
  });

  it('delete', async () => {
    // A user with a post cannot be deleted — `posts_author_id_users_id_fk` is
    // NO ACTION — and the address in the WHERE clause is a bound parameter.
    const email = addr();
    const authorId = await mkUser(email);
    const now = Date.now();
    await db.insert(posts).values({
      id: `p_guard_${seq}`,
      title: '',
      subtitle: '',
      slug: null,
      excerpt: '',
      excerptSource: 'derived',
      content: { type: 'doc', content: [] },
      contentText: '',
      coverImage: null,
      category: '',
      tags: [],
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
      deletedAt: null,
      wordCount: 0,
      readingTime: 0,
      authorId,
      revision: 1,
    });

    const err = await scrubbed(
      () => db.delete(users).where(eq(users.email, email)),
      [email],
    );
    expect(err.code).toBe('23503');
  });

  it('select', async () => {
    // `users.id` is uuid, so the driver reports `invalid input syntax for type
    // uuid: "..."` — a message that quotes the offending value verbatim. This
    // is the case a `SELECT`-only leak looks like: no write, no constraint,
    // still a parameter in the log.
    const probe = 'not-a-uuid-secret-9f3a';
    const err = await scrubbed(
      () => db.select().from(users).where(eq(users.id, probe)),
      [probe],
    );
    expect(err.code).toBe('22P02');
  });

  it('query.<table>', async () => {
    // Reached through a getter, not a method call, so it needs its own branch
    // in the proxy — and `findFirst` is two hops down from `db`.
    const probe = 'not-a-uuid-secret-7c11';
    await scrubbed(
      () => db.query.users.findFirst({ where: eq(users.id, probe) }),
      [probe],
    );
  });

  it('transaction, whose handle arrives as a callback argument', async () => {
    // Spec §4.3a forbids `transaction` on the hot path — the Neon HTTP driver
    // rejects it outright — but it works on PGlite, so an unguarded transacted
    // handle would leak in the test suite.
    const email = addr();
    await mkUser(email);
    await scrubbed(
      () =>
        db.transaction(async (tx) => {
          await tx.insert(users).values({
            email,
            passwordHash: DECOY_HASH,
            displayName: 'In A Transaction',
            role: 'writer',
            createdAt: Date.now(),
          });
        }),
      [email],
    );
  });

  it('and through .catch(), which delegates to the raw then()', async () => {
    // `QueryPromise.catch` calls `this.then(undefined, onRejected)` on the RAW
    // builder, so intercepting `then` alone leaves this path unscrubbed.
    const email = addr();
    await mkUser(email);
    const err = await db
      .insert(users)
      .values({
        email,
        passwordHash: DECOY_HASH,
        displayName: 'Caught',
        role: 'writer',
        createdAt: Date.now(),
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(surface(err)).not.toContain(email);
  });

  /**
   * The other half of the fix, and the one a naive implementation breaks.
   *
   * `db.insert(t)` returns a `PgInsertBuilder` with no `.then` at all, so
   * `Promise.resolve(...)` around it yields a promise wrapping the builder and
   * `.values()` is gone. The thenable builders are still chainable after the
   * fact, so resolving `db.select().from(t)` executes it immediately and loses
   * `.where`/`.orderBy`/`.limit`. Without this test the guard could be
   * "fixed" into something that scrubs perfectly and cannot run a query.
   */
  it('preserves lazy builder chaining on every API', async () => {
    const email = addr();
    const id = await mkUser(email);

    const selected = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, id))
      .orderBy(users.createdAt)
      .limit(1);
    expect(selected).toEqual([{ id, email }]);

    const updated = await db
      .update(users)
      .set({ displayName: 'Renamed' })
      .where(eq(users.id, id))
      .returning({ displayName: users.displayName });
    expect(updated).toEqual([{ displayName: 'Renamed' }]);

    const found = await db.query.users.findFirst({ where: eq(users.id, id) });
    expect(found?.email).toBe(email);
    expect(await db.query.users.findMany({ limit: 1 })).toHaveLength(1);

    const deleted = await db
      .delete(users)
      .where(eq(users.id, id))
      .returning({ id: users.id });
    expect(deleted).toEqual([{ id }]);

    // A resolved value is handed back untouched — not re-wrapped in a proxy —
    // so `.rows` is the same array it always was.
    const raw = await db.execute(sql`SELECT 1 AS n`);
    expect(Array.isArray(raw.rows)).toBe(true);
    expect(raw.rows[0].n).toBe(1);
  });

  it('still leaves a non-driver error alone on the builder path', async () => {
    // The scrub sits on the same `then` every successful query goes through, so
    // a bug in a repo must come back out with its own stack intact.
    const boom = new TypeError('x is not a function');
    await expect(
      db
        .select()
        .from(users)
        .limit(1)
        .then(() => {
          throw boom;
        }),
    ).rejects.toBe(boom);
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

  /*
   * A DROPPED COLUMN USED TO BE INDISTINGUISHABLE FROM DATA.
   *
   * `Number(undefined)` is `NaN`, `NaN` is a `number`, and `JSON.stringify`
   * turns it into `null` — so a column renamed, aliased, or forgotten in a
   * hand-written `sql` fragment produced a row that satisfied every type in
   * this codebase and arrived at the client looking exactly like a legitimately
   * NULL timestamp. Nobody was holding the fault: the server had no complaint
   * to make and the screen had nothing to distinguish.
   *
   * It refuses here, where a throw is a 500 with a stack seen by the people who
   * can fix the query. `src/data/when.ts` makes the opposite choice for the
   * opposite reason — on a screen there is no one further down the line to tell,
   * so a broken timestamp is downgraded to a placeholder rather than an error
   * page. The two guards are complements, not duplicates.
   */
  it('toEpochMs refuses a column that is not there, rather than returning NaN', () => {
    expect(() => toEpochMs(undefined)).toThrow(EpochShapeError);
    expect(() => toEpochMs('not-a-number')).toThrow(EpochShapeError);

    // THE TWO THAT A `NaN` CHECK ALONE WOULD HAVE MISSED, and the reason the
    // shape is tested before the coercion: `Number(null)` and `Number('')` are
    // both `0` — finite, valid, and 1 January 1970 on somebody's screen.
    expect(() => toEpochMs(null)).toThrow(EpochShapeError);
    expect(() => toEpochMs('')).toThrow(EpochShapeError);
    expect(() => toEpochMs('   ')).toThrow(EpochShapeError);
    // Neither `NaN` nor a timestamp, and `new Date()` of it is the same
    // `RangeError` a missing column would have caused downstream.
    expect(() => toEpochMs('1e400')).toThrow(EpochShapeError);

    // The message names the shape, because the row it came from will not be in
    // the stack — the caller that logs this needs the query, not the value.
    expect(() => toEpochMs(undefined)).toThrow(/epoch in ms/);
  });

  /*
   * AND IT DESCRIBES THE VALUE WITHOUT QUOTING IT, which is this file's subject
   * one function across. The way a timestamp field receives a string at all is a
   * SELECT whose columns do not line up with what the mapper reads — and on
   * `users` the column next to a timestamp is `password_hash`. An error that
   * interpolated its input would put a crackable hash in the log by exactly the
   * route every test above closes, while reporting a bug about dates.
   */
  it('the refusal describes the value without quoting it', () => {
    const hash = 'scrypt$32768$8$1$deadbeefdeadbeefdeadbeefdeadbeef';
    const err = (() => {
      try {
        toEpochMs(hash);
        throw new Error('expected a hash-shaped column to be refused');
      } catch (e: unknown) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(EpochShapeError);
    const text = surface(err);
    expect(text).not.toContain(hash);
    expect(text).not.toMatch(HASH_PATTERN);
    // Still diagnosable: the type and the length are what tell the cases apart.
    expect((err as Error).message).toContain(`a string of length ${hash.length}`);
  });

  it('toEpochMs accepts epoch zero, which is falsy and is a real timestamp', () => {
    expect(toEpochMs(0)).toBe(0);
    expect(toEpochMs('0')).toBe(0);
    expect(toEpochMsOrNull(0)).toBe(0);
  });

  /*
   * `toEpochMsOrNull(undefined)` STAYS `null` AND IS NOT TIGHTENED TO MATCH.
   * A nullable column read off a row that does not carry it is genuinely
   * indistinguishable from one that is NULL without knowing the SELECT, and
   * that information is not in this function. The line above pins the looser
   * contract deliberately so nobody "fixes" it into a false positive.
   */
  it('the nullable form still refuses a value that is present and unusable', () => {
    expect(() => toEpochMsOrNull('not-a-number')).toThrow(EpochShapeError);
    expect(toEpochMsOrNull(undefined)).toBeNull();
  });
});
