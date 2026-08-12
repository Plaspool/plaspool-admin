/**
 * The DDL is APPLIED, not merely present in a file.
 *
 * Migration `0007_managed_categories.sql` is hand-written: `categories` is
 * declared in `server/repo/categories-schema.ts`, which `drizzle.config.ts` has
 * never heard of, so drizzle-kit cannot generate this table and — the half that
 * matters — will never emit DDL to undo it either. That is the rule
 * `server/db/migrations.test.ts` states for a hand-written migration, and the
 * price of being outside the model is that NOTHING TYPECHECKS THE SQL. So this
 * suite reads the shape back out of `information_schema`, `pg_constraint` and
 * `pg_indexes` on a migrated database and compares it against the declaration —
 * the same arrangement, for the same reason, as
 * `server/shop/cart/schema.test.ts`.
 *
 * Two of the assertions below are about BEHAVIOUR rather than about names,
 * because a name is not the property that matters. An index called
 * `categories_name_lower_uq` that is not unique, or that is over `name` rather
 * than `lower(name)`, would satisfy every catalogue check here and would still
 * let 'Design' and 'design' both exist — which is the free-text era's defect with
 * a table around it.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbError, uniqueViolation } from '../db/client';
import { migratedDb } from '../test/harness';
import { categories } from './categories-schema';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../db/client';

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});
afterAll(() => close());

/**
 * The database column name a drizzle column object carries.
 *
 * Read off the column rather than off the property key: the two differ by design
 * (`createdAt` is `created_at`), and comparing property keys against
 * `information_schema` would compare two different things and pass for the wrong
 * reason. `typeof value === 'object'` is doing real work — a drizzle table object
 * also carries METHODS (`enableRLS`), and a function has a `.name` too.
 */
function nameOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

async function columns(table: string): Promise<Map<string, { type: string; nullable: boolean }>> {
  const res = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table}`);
  return new Map(
    res.rows.map((row) => [
      String(row.column_name),
      { type: String(row.data_type), nullable: row.is_nullable === 'YES' },
    ]),
  );
}

/**
 * Run a statement that must be refused, and report WHY the database refused it.
 *
 * The error arrives scrubbed — `guardDb` discards the driver error and keeps
 * SQLSTATE plus the constraint name — which is exactly what these assertions
 * want: naming the constraint proves the refusal came from the constraint under
 * test rather than from a typo somewhere else in the statement.
 */
async function refused(statement: SQL): Promise<{ code: string | null; constraint: string | null }> {
  try {
    await db.execute(statement);
  } catch (err) {
    if (err instanceof DbError) return { code: err.code, constraint: err.constraint };
    throw err;
  }
  throw new Error('the statement was accepted, and it must not be');
}

const insert = (name: string): SQL =>
  sql`INSERT INTO categories (name, created_at) VALUES (${name}, 1786600000600)`;

describe('migration 0007 is applied', () => {
  it('creates the categories table', async () => {
    const res = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'categories'`);
    expect(res.rows).toHaveLength(1);
  });

  it('DECLARES exactly what the database has — categories-schema is not decoration', async () => {
    /*
     * The declaration is reachable, is used for `$inferSelect`, and is NOT what
     * creates the table — migration 0007 is. So it is exactly the kind of thing
     * that rots: correct on the day it is written, silently wrong after the first
     * migration nobody mirrors into it. This reads both sides and compares them.
     */
    const declared = Object.values(categories).map(nameOf).filter(Boolean).sort();
    expect(declared).toEqual([...(await columns('categories')).keys()].sort());
  });

  it('stores created_at as bigint epoch-ms, never timestamptz', async () => {
    /*
     * The rule `server/db/schema.ts` states, and it is not stylistic: a
     * `timestamptz` reads back as a `Date` from PGlite and as a string from Neon,
     * and `toEpochMs` — the function that closes that divergence — works on
     * neither.
     */
    expect((await columns('categories')).get('created_at')?.type).toBe('bigint');
  });

  it('defaults the id, so nothing has to mint a uuid to create a category', async () => {
    // `createCategory` inserts `(name, created_at)` and nothing else. Without the
    // default the insert is a 23502 on the very first call, and the repository
    // would have to invent an id format the database cannot generate.
    await db.execute(insert('Defaulted'));
    const row = await db.execute(sql`SELECT id FROM categories WHERE name = 'Defaulted'`);
    expect(String(row.rows[0].id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    await db.execute(sql`DELETE FROM categories WHERE name = 'Defaulted'`);
  });
});

describe('the name is unique case-insensitively', () => {
  it('applies a UNIQUE index over lower(name), not over name', async () => {
    const res = await db.execute(sql`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'categories_name_lower_uq'`);
    expect(res.rows).toHaveLength(1);
    const def = String(res.rows[0].indexdef);
    expect(def).toContain('UNIQUE');
    expect(def).toContain('lower(name)');
  });

  it('REFUSES a second casing — the property the index name only claims', async () => {
    await db.execute(insert('Design'));
    const err = await refused(insert('design'));
    expect(err.code).toBe('23505');
    // Named, because `server/repo/categories.ts` translates exactly this
    // constraint into a 409 and re-throws anything else. A rename of the index
    // would turn a duplicate name into a 500 with nothing failing here.
    expect(err.constraint).toBe('categories_name_lower_uq');
    // And through the helper the repository actually calls.
    let seen: string | null = null;
    try {
      await db.execute(insert('DESIGN'));
    } catch (caught) {
      seen = uniqueViolation(caught);
    }
    expect(seen).toBe('categories_name_lower_uq');
    await db.execute(sql`DELETE FROM categories WHERE lower(name) = 'design'`);
  });
});

describe('the name checks are in the database, not only in the route', () => {
  it("refuses '' — the absence of a category is not a category", async () => {
    const err = await refused(insert(''));
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('categories_name_ck');
  });

  it('refuses an untrimmed name, which the case-insensitive index cannot see', async () => {
    // ' Design' and 'Design' have different `lower()` values, so the unique index
    // would happily hold both — two entries that look identical in every picker.
    const err = await refused(insert(' Design'));
    expect(err.constraint).toBe('categories_name_ck');
  });

  it('refuses a name over MAX_CATEGORY_BYTES, measured in bytes', async () => {
    /*
     * 200 four-byte characters is 800 bytes and 200 `length()` characters, so a
     * `length(name) <= 400` check would accept it — and the rename would then
     * fail SQLSTATE 54000 halfway through a bulk UPDATE of `posts.category`,
     * which feeds the `search` tsvector.
     */
    const err = await refused(insert('𝍄'.repeat(200)));
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('categories_name_bytes_ck');
    // The control: 400 bytes exactly is accepted.
    await db.execute(insert('a'.repeat(400)));
    await db.execute(sql`DELETE FROM categories`);
  });
});

describe('posts are not chained to the managed list', () => {
  it('has NO foreign key in either direction between posts and categories', async () => {
    /*
     * Asserted rather than remembered, because "add the FK" is the obvious
     * cleanup and it is wrong twice over: it would make every category typed as
     * free text before 0007 unstorable, and it would turn
     * `DELETE /api/categories/:id` from a 409 the route explains into a raw 23503
     * it cannot. The managed list NAMES values; it is not the authority for which
     * values may exist.
     */
    const res = await db.execute(sql`
      SELECT c.conname, cl.relname AS child, pr.relname AS parent
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_class pr ON pr.oid = c.confrelid
       WHERE c.contype = 'f'
         AND (cl.relname IN ('posts', 'categories') OR pr.relname = 'categories')`);
    expect(res.rows.filter((row) => String(row.parent) === 'categories')).toEqual([]);
    expect(res.rows.filter((row) => String(row.child) === 'categories')).toEqual([]);
  });

  it('indexes lower(category) on posts, which posts_category_idx cannot serve', async () => {
    // Every read on this surface matches on `lower(p.category)`. Without this
    // index the union, the rename and the delete's refusal check are each a
    // sequential scan of every post in the blog, trash included.
    const res = await db.execute(sql`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'posts_category_lower_idx'`);
    expect(res.rows).toHaveLength(1);
    expect(String(res.rows[0].indexdef)).toContain('lower(category)');
  });
});
