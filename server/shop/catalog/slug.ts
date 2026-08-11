import { randomBytes, randomInt } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { SLUG_ATTEMPTS } from '../../domain/slug';

/**
 * The four-rung slug ladder, over `shop_products`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS A PORT OF `server/domain/slug.ts`, WHICH BRIEF §3 SAYS NOT TO WRITE.
 * "Reuse `server/domain/slug.ts` — including its four-rung ladder … Do not write
 * a second slug allocator." That is the right instruction and it cannot be
 * followed as written: `uniqueSlug` hardcodes `FROM posts` in its one query, so
 * calling it for a product returns the taken set of the BLOG, and a product
 * would be refused a slug because a post already has it while colliding freely
 * with other products. Raised as amendment A-CAT-010, which proposes the table
 * become a parameter defaulting to `posts` — a change to a file Catalog does not
 * own, so it is raised rather than made (contract §9).
 *
 * WHAT IS SHARED RATHER THAN COPIED, so the two cannot silently drift:
 *
 * - `SLUG_ATTEMPTS` is IMPORTED. The ladder's length is the thing a caller
 *   depends on (`withSlugRetry` bounds its loop by it), and two copies of a
 *   number that must agree is the drift that would actually bite.
 * - `server/shop/catalog/slug.test.ts` runs the SAME ladder assertions against
 *   both implementations, so a change to one that is not made to the other
 *   fails rather than diverging quietly.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY A LADDER AND NOT A RETRY (GAUNTLET II Part 2a Round 1 #2). Every in-flight
 * writer reads the same taken set and, given the same rule, derives the SAME
 * next candidate — so a retry that only re-derives admits exactly one writer per
 * round, and N simultaneous writers need N rounds. Measured on `posts` with
 * three attempts and no diversification: N=10 left seven rejected with a raw
 * `23505`, which no error table has a row for and a route renders as a 500.
 *
 *   0. first free candidate — the only rung that runs when nobody is racing, and
 *      the one that keeps `tee`, `tee-2`, `tee-3` looking like a sequence
 *   1. first free candidate again — one more round of the cheap answer
 *   2. a RANDOM free candidate out of the next `DIVERSITY_POOL` — the round that
 *      breaks the tie for a crowd, while still yielding a numbered slug
 *   3. a `randomBytes` suffix with NO READ AT ALL — cannot realistically
 *      collide, so the ladder terminates in success rather than in an exhausted
 *      counter
 */

/** The client's bound, kept: `base`, then `base-2`…`base-198`, then random. */
const MAX_SUFFIX_ATTEMPTS = 200;

/** The attempt index at which candidate selection stops being deterministic. */
const RANDOM_CANDIDATE_AT = 2;

/** The attempt index at which the random suffix is taken without a read. */
const RANDOM_SUFFIX_AT = 3;

/**
 * How many free candidates the randomised round draws from. Wide enough that a
 * realistic crowd rarely collides twice — 25 writers drawing from 128 expect
 * about two collisions, and those two land on the suffix round.
 */
const DIVERSITY_POOL = 128;

function randomSuffix(base: string): string {
  return `${base}-${randomBytes(4).toString('hex')}`;
}

export async function uniqueProductSlug(
  db: Db,
  base: string,
  selfId: string,
  attempt = 0,
): Promise<string> {
  // The last rung. No read: we are only here because two deterministic rounds
  // and a randomised one all lost, and re-reading would just produce another
  // candidate someone else is also about to try.
  if (attempt >= RANDOM_SUFFIX_AT) return randomSuffix(base);

  /*
   * ONE query, not one per candidate. Every candidate is an HTTP round trip to
   * Neon, so the literal port would cost up to 198 of them on the one path that
   * runs while an admin waits — first save with a title, first publish.
   *
   * `starts_with(slug, base || '-')` rather than `LIKE base || '%'`: LIKE would
   * count `tee-shirt` as a clash for `tee`, and its `_`/`%` would be pattern
   * metacharacters. `slugify` only emits `[a-z0-9-]`, but a predicate that is
   * only safe because of what its caller happens to pass is one refactor from
   * being wrong.
   */
  const res = await db.execute(sql`
    SELECT id, slug FROM shop_products
     WHERE slug = ${base} OR starts_with(slug, ${`${base}-`})`);

  const owners = new Map<string, string>();
  for (const row of res.rows) owners.set(String(row.slug), String(row.id));

  const free: string[] = [];
  let candidate = base;
  let n = 2;
  while (n < MAX_SUFFIX_ATTEMPTS) {
    const owner = owners.get(candidate);
    // Free, or already ours — re-slugging a product must not walk it to `-2` on
    // every save.
    if (owner === undefined || owner === selfId) {
      if (attempt < RANDOM_CANDIDATE_AT) return candidate;
      free.push(candidate);
      if (free.length >= DIVERSITY_POOL) break;
    }
    candidate = `${base}-${n}`;
    n += 1;
  }

  if (free.length > 0) return free[randomInt(free.length)];

  /*
   * The loop is an optimisation; the UNIQUE index is the authority. Two writers
   * can read the same free candidate and both try it, and the loser gets a
   * `23505` the write path retries. This fallback only has to be unlikely to
   * collide, not guaranteed.
   */
  return randomSuffix(base);
}

/** Re-exported so a caller bounds its retry loop by the ladder's real length
 *  rather than by a second copy of the number. */
export { SLUG_ATTEMPTS };
