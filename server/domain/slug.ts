import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';

/**
 * Slugs are server-authoritative (spec §4.5). `PostPatch` has no `slug` key at
 * all, so this is the only thing that ever assigns one.
 */

/**
 * The client's bound, kept: `base`, then `base-2`…`base-198`, then a random
 * suffix. A slug colliding that many times means something else is wrong.
 * (`src/data/posts.ts:158-168` — the loop runs while `n < 200` and increments
 * after building the candidate, so `base-198` is the last one it tries.)
 */
const MAX_SUFFIX_ATTEMPTS = 200;

export async function uniqueSlug(db: Db, base: string, selfId: string): Promise<string> {
  /*
   * ONE query, not one per candidate.
   *
   * The client version asks the store per candidate because a Dexie lookup is a
   * function call. Here every candidate is an HTTP round trip to Neon, so the
   * literal port would cost up to 198 of them on the one path that runs while a
   * writer waits — first publish, first save with a title.
   *
   * `starts_with(slug, base || '-')` rather than `LIKE base || '%'`: LIKE would
   * count `posting` as a clash for `post`, and its `_`/`%` would be pattern
   * metacharacters. `slugify` only emits `[a-z0-9-]`, but a predicate that is
   * only safe because of what its caller happens to pass is one refactor from
   * being wrong.
   */
  const res = await db.execute(sql`
    SELECT id, slug FROM posts
     WHERE slug = ${base} OR starts_with(slug, ${`${base}-`})`);

  const owners = new Map<string, string>();
  for (const row of res.rows) owners.set(String(row.slug), String(row.id));

  let candidate = base;
  let n = 2;
  while (n < MAX_SUFFIX_ATTEMPTS) {
    const owner = owners.get(candidate);
    // Free, or already ours — re-slugging a post must not walk it to `-2` on
    // every save.
    if (owner === undefined || owner === selfId) return candidate;
    candidate = `${base}-${n}`;
    n += 1;
  }

  /*
   * The loop is an optimisation; the UNIQUE index is the authority. Two writers
   * can read the same free candidate and both try it, and the loser gets a
   * `23505` the write path retries (spec §4.5). This fallback only has to be
   * unlikely to collide, not guaranteed.
   */
  return `${base}-${randomBytes(4).toString('hex')}`;
}
