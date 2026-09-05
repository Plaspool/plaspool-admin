/**
 * Restore a product's description from `shop_product_revisions`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: a CSV round trip flattened two live products (2026-09-04).
 *
 * The export wrote `description_text` — the derived PLAIN TEXT — into the one
 * `Description` column, and the import wrapped that text in a single paragraph
 * (`paragraphDoc`). Headings, bullet lists and bold were gone from the live
 * catalogue. `shop_product_revisions.description` is `jsonb NOT NULL` and
 * stores the WHOLE document on every save, so the rich copy survived the
 * accident even though the product row did not.
 *
 * The import path is being made lossless separately; this is the repair, and
 * it stays because the class of accident (any authoritative overwrite) is not
 * unique to CSV.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOT AN UPDATE STATEMENT, deliberately. It goes through `saveProduct`, which
 *   - re-derives `description_text` and `overview_fallback` from the document,
 *     so the search text and the card summary cannot disagree with the body;
 *   - writes a NEW revision rather than rewinding the counter, so the flattened
 *     state stays in history and this repair is itself undoable;
 *   - validates the document, so a hand-edited revision row cannot be laundered
 *     into the products table by this script.
 *
 * IDEMPOTENT: a product whose description already equals the target revision's
 * is reported and skipped, so re-running writes nothing.
 *
 *   APP_ORIGINS="https://migration.invalid" \
 *     npx tsx --env-file=.prod.env scripts/restore-description-revision.ts \
 *     --check pla-silk=14 pla-basic=34
 *
 * Drop `--check` to write. `--check` reads the same rows and prints the same
 * decisions, which is how you confirm the targets before touching production.
 */
import { sql } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '../server/db/schema';
import type { Db } from '../server/db/client';
import { saveProduct } from '../server/shop/catalog/products';
import type { AuthUser, DocNode } from '../shared/types';

const CHECK = process.argv.includes('--check');

interface Target {
  slug: string;
  revision: number;
}

/** `pla-silk=14` → `{ slug: 'pla-silk', revision: 14 }`. Anything else is a
 *  usage error worth dying on: a typo here writes the wrong document. */
function parseTargets(argv: string[]): Target[] {
  const targets: Target[] = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) continue;
    const at = arg.lastIndexOf('=');
    const slug = at === -1 ? '' : arg.slice(0, at);
    const revision = Number(arg.slice(at + 1));
    if (!slug || !Number.isInteger(revision) || revision < 1) {
      throw new Error(`expected <slug>=<revision>, got ${JSON.stringify(arg)}`);
    }
    targets.push({ slug, revision });
  }
  if (targets.length === 0) throw new Error('no targets — pass <slug>=<revision>');
  return targets;
}

/** Both drivers hand jsonb back parsed today; the string branch is the same
 *  tolerance `mapping.ts` and the 0580 backfill carry. */
function asDoc(value: unknown): DocNode {
  if (typeof value === 'string') return JSON.parse(value) as DocNode;
  return value as DocNode;
}

/** Blocks and marks — enough to say "this is the rich one" in a log line
 *  without pasting a document into a terminal. */
function shape(doc: DocNode): string {
  const blocks = Array.isArray(doc?.content) ? doc.content : [];
  let marks = 0;
  const walk = (node: { marks?: unknown[]; content?: unknown[] }): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.marks)) marks += node.marks.length;
    for (const child of node.content ?? []) walk(child as { marks?: unknown[]; content?: unknown[] });
  };
  for (const block of blocks) walk(block as { marks?: unknown[]; content?: unknown[] });
  return `${blocks.length} block(s), ${marks} mark(s)`;
}

async function main(): Promise<void> {
  const targets = parseTargets(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const db = drizzle(neon(url), { schema }) as unknown as Db;

  /* The revision row's own author, so history reads as the person whose words
   * these are rather than as whoever happened to run the repair. Only `.id`
   * reaches the insert; the rest satisfies the type. */
  let written = 0;
  let skipped = 0;

  for (const { slug, revision } of targets) {
    const found = await db.execute(sql`
      SELECT id, title, description, revision FROM shop_products
       WHERE slug = ${slug} AND deleted_at IS NULL`);
    const product = found.rows[0];
    if (!product) throw new Error(`no live product with slug ${slug}`);

    const target = await db.execute(sql`
      SELECT r.description, r.created_at, r.author_id, u.email, u.display_name, u.role
        FROM shop_product_revisions r JOIN users u ON u.id = r.author_id
       WHERE r.product_id = ${String(product.id)} AND r.revision = ${revision}`);
    const row = target.rows[0];
    if (!row) throw new Error(`${slug} has no revision ${revision}`);

    const want = asDoc(row.description);
    const have = asDoc(product.description);
    const title = String(product.title);

    if (JSON.stringify(want) === JSON.stringify(have)) {
      skipped += 1;
      console.log(`SKIP  ${title} — already at revision ${revision}'s document`);
      continue;
    }

    console.log(
      `${CHECK ? 'WOULD' : 'WRITE'} ${title}\n` +
        `        now: ${shape(have)}  (product revision ${String(product.revision)})\n` +
        `        ->   ${shape(want)}  (from revision ${revision}, ` +
        `${new Date(Number(row.created_at)).toISOString()})`,
    );

    if (!CHECK) {
      const actor: AuthUser = {
        id: String(row.author_id),
        email: String(row.email),
        displayName: String(row.display_name),
        role: String(row.role) as AuthUser['role'],
      };
      await saveProduct(
        db,
        String(product.id),
        { description: want },
        { actor, note: `Restored description from revision ${revision}` },
      );
      written += 1;
    }
  }

  console.log(
    `\n${targets.length} target(s): ${CHECK ? `${targets.length - skipped} would change` : `${written} written`}, ${skipped} already correct`,
  );
}

await main();
