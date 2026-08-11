import { randomBytes, randomInt } from 'node:crypto';
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

/**
 * How many attempts the write path's retry gets, and what each one does.
 *
 * THE BOUND THAT MATTERS IS NOT THE COUNT, IT IS THE DIVERSITY. Every in-flight
 * writer reads the same taken set and, given the same rule, derives the SAME
 * next candidate — so a retry that only re-derives admits exactly one writer per
 * round, and N simultaneous writers need N rounds. Measured with three attempts
 * and no diversification: N=3 all succeeded, N=10 left seven rejected with a raw
 * `23505`, which spec §8 has no row for and a route renders as a 500. The
 * random-suffix fallback below was unreachable from there — it only fires after
 * 198 COMMITTED collisions, not after three lost races.
 *
 * So the attempts are a ladder, not a repetition:
 *
 *   0. first free candidate — the only one that runs when nobody is racing, and
 *      the one that keeps `post`, `post-2`, `post-3` looking like a sequence
 *   1. first free candidate again — one more round of the cheap answer, which is
 *      what keeps two simultaneous writers at `post` and `post-2` rather than
 *      scattering them
 *   2. a RANDOM free candidate out of the next `DIVERSITY_POOL` — the round that
 *      breaks the tie for a crowd, while still yielding a numbered slug
 *   3. the random suffix — no read at all, effectively cannot collide, so this
 *      round always succeeds and the ladder is finite
 *
 * Four round trips worst case, and the last one is free.
 */
export const SLUG_ATTEMPTS = 4;

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

/**
 * The documented fallback (spec §4.5): the loop is an optimisation, the UNIQUE
 * index is the authority, and this only has to be unlikely to collide.
 */
function randomSuffix(base: string): string {
  return `${base}-${randomBytes(4).toString('hex')}`;
}

export async function uniqueSlug(
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

  const free: string[] = [];
  let candidate = base;
  let n = 2;
  while (n < MAX_SUFFIX_ATTEMPTS) {
    const owner = owners.get(candidate);
    // Free, or already ours — re-slugging a post must not walk it to `-2` on
    // every save.
    if (owner === undefined || owner === selfId) {
      if (attempt < RANDOM_CANDIDATE_AT) return candidate;
      free.push(candidate);
      if (free.length >= DIVERSITY_POOL) break;
    }
    candidate = `${base}-${n}`;
    n += 1;
  }

  // The randomised round: still a numbered slug, just not the one every other
  // writer in this crowd is about to try.
  if (free.length > 0) return free[randomInt(free.length)];

  /*
   * The loop is an optimisation; the UNIQUE index is the authority. Two writers
   * can read the same free candidate and both try it, and the loser gets a
   * `23505` the write path retries (spec §4.5). This fallback only has to be
   * unlikely to collide, not guaranteed.
   */
  return randomSuffix(base);
}
