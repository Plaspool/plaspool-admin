/**
 * Backfill `shop_products.overview_fallback` (migration 0580).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A SCRIPT AND NOT A STATEMENT IN THE MIGRATION, AND 0520 IS THE REASON.
 *
 * 0520 backfilled `seo_description` by extracting from this same jsonb column
 * with `jsonb_path_query`, and lax jsonpath silently DOUBLED every value:
 * `$.**.text` collected each text node twice, once via auto-unwrap of the
 * `content` array and once via the node itself. Every row in production read as
 * its own first paragraph concatenated with itself, and only a parity check
 * against the live API caught it. 0540 was the repair.
 *
 * The computation here is `summarise()` from `shared/doc.ts` — the SAME function
 * the write path calls, unit-tested, in a language with a test runner. There is
 * no second implementation to disagree with the first.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * IDEMPOTENT, AND SAFE TO RE-RUN. It writes every row's fallback from that row's
 * own document each time, so running it twice produces the same bytes. It is not
 * `WHERE overview_fallback IS NULL`: a document edited by a pre-0580 deploy
 * would keep a stale summary forever under that predicate.
 *
 * IT NEVER TOUCHES `overview`. The hand-written column is the owner's; this
 * script owns only the derived one.
 *
 * Run it AFTER 0580 is applied and BEFORE (or shortly after) the code deploy:
 *
 *   APP_ORIGINS="https://migration.invalid" \
 *     npx tsx --env-file=.prod.env scripts/backfill-overview-fallback.ts
 *
 * Add `--check` to report drift without writing — which is how you verify the
 * result against an independent read rather than by trusting this file.
 */
import { sql } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { summarise } from '../shared/doc';
import type { DocNode } from '../shared/types';

const CHECK = process.argv.includes('--check');

/** Same tolerance `mapping.ts` carries: jsonb arrives parsed from both drivers
 *  today, but a document silently becoming "[object Object]" is worse than a
 *  branch nobody takes. */
function asDoc(value: unknown): DocNode | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as DocNode;
    } catch {
      return null;
    }
  }
  return value as DocNode;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const db = drizzle(neon(url));

  const res = await db.execute(
    sql`SELECT id, description, overview_fallback FROM shop_products ORDER BY id`,
  );

  let changed = 0;
  let unchanged = 0;
  for (const row of res.rows) {
    const id = String(row.id);
    const want = summarise(asDoc(row.description));
    const have = row.overview_fallback == null ? null : String(row.overview_fallback);
    if (have === want) {
      unchanged += 1;
      continue;
    }
    changed += 1;
    // Truncated in the log: the point is WHICH rows move, not to paste the
    // catalogue into a terminal.
    console.log(`${CHECK ? 'DRIFT' : 'WRITE'} ${id}  ${JSON.stringify(want.slice(0, 60))}`);
    if (!CHECK) {
      await db.execute(
        sql`UPDATE shop_products SET overview_fallback = ${want} WHERE id = ${id}`,
      );
    }
  }

  console.log(
    `\n${res.rows.length} product(s): ${changed} ${CHECK ? 'drifted' : 'written'}, ${unchanged} already correct`,
  );
  /* A non-zero exit on drift makes `--check` usable as a post-deploy assertion
     rather than something a human has to read carefully. */
  if (CHECK && changed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
