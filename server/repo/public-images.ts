import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { toEpochMs, toEpochMsOrNull } from '../db/client';
import { PUBLIC_POST_PREDICATE } from './public';
import { normalizeBlobId } from './public-projection';
import type { ImageRow } from './images';

/**
 * Public image serving (plan D5, threat T5).
 *
 * THIS FILE POINTS THE OPPOSITE WAY TO THE ORPHAN COLLECTOR, ON PURPOSE. DO NOT
 * REFACTOR THE TWO REFERENCE SETS INTO ONE FUNCTION.
 *
 * `server/repo/images.ts#REFERENCE_SET` decides which images may be DELETED, so
 * it is deliberately BROAD: it counts revisions, drafts, archived and trashed
 * posts, and it treats a document it cannot walk as referencing EVERYTHING. Its
 * failure direction is "keep a byte nobody needs", because the cost of being
 * wrong is a published post whose images 404.
 *
 * This check decides which images may be SERVED to an anonymous reader, so it is
 * deliberately NARROW: only the CURRENT content or cover of a post matching
 * `PUBLIC_POST_PREDICATE` counts. Its failure direction is "refuse a byte
 * somebody wanted", because the cost of being wrong is publishing a private one.
 *
 * Two consequences follow, and both are the reverse of the collector's:
 *
 * 1. **Revisions are not a reference.** An image cut from a published post must
 *    stop being publicly served the moment the cut is saved. The collector counts
 *    revisions precisely so history keeps the bytes alive; if this check did the
 *    same, every image ever placed in a published post would remain public
 *    forever, which is the leak T5 names.
 * 2. **A document that cannot be walked references NOTHING.** The collector's
 *    unwalkable row references every image (it cannot make a claim, so it makes
 *    no deletion). Here the same absence of a claim must mean "do not serve": a
 *    malformed document is not evidence that an image is public.
 */

/**
 * The unwalkable test, restated rather than imported.
 *
 * It is the same SQL as `images.ts#UNWALKABLE_NODE` today, and it is written out
 * again because the two files must be free to disagree: that module's copy is
 * tuned by what is safe to DELETE, this one by what is safe to SERVE. Importing
 * it would create exactly the coupling the header forbids — a future loosening
 * made for the collector's benefit would silently widen the public surface.
 */
const UNWALKABLE_NODE = sql`
        jsonb_typeof(node) <> 'object'
     OR (node -> 'content' IS NOT NULL
         AND jsonb_typeof(node -> 'content') NOT IN ('array', 'null'))`;

/**
 * `asset:<id>` / `idb:<id>` at ANY depth in the serialised document.
 *
 * Same extractor as the collector's `scheme_refs`, and for the same reason: a
 * regex over `content::text` sees ids in `attrs.src`, in `marks`, in an
 * attribute nobody has thought of yet, and at any nesting depth — where a
 * type-aware walk sees only the shapes it was told about. `shared/doc.ts`'s
 * `ASSET_SCHEME` and `IDB_SCHEME` are the two schemes it accepts.
 *
 * The id is compared as a BOUND PARAMETER against the captured group, so nothing
 * from the request reaches the pattern.
 */
const SCHEME_PATTERN = '(?:asset|idb):([A-Za-z0-9_.-]+)';

/**
 * `cover_image->>'blobId'` is stored BOTH bare and `asset:`/`idb:`-prefixed —
 * historically it is either, which is why `images.ts:539-547` reads it both
 * ways. A narrow `cover_image->>'blobId' = :id` matches the bare form and MISSES
 * the prefixed one, so a live published cover would 404. Normalised on the SQL
 * side (and on the JS side, via `normalizeBlobId`) before comparing.
 */
const COVER_PREFIX = '^(asset|idb):';

/**
 * The reference check as a boolean SQL fragment, so `isPubliclyReferencedImage`
 * and `getPublicImage` ask exactly the same question in exactly one place.
 *
 * `scope` exists for the mutation tests and DEFAULTS to the real predicate.
 * Production never passes it. `public-images.test.ts` passes `sql\`true\`` to
 * prove the corpus actually contains a draft-only image that the published scope
 * is what excludes — the same device `public.ts#predicateWithout` provides for
 * the list, and for the same reason: a test that transcribes its own weakened
 * copy of the SQL is asserting against itself.
 */
export function publicImageRefExists(
  imageId: string,
  scope: SQL = PUBLIC_POST_PREDICATE,
): SQL {
  const id = normalizeBlobId(imageId);
  return sql`EXISTS (
    WITH RECURSIVE pub AS (
      -- NO revisions in this CTE, and no draft/archived/trashed posts. That
      -- absence is the security control; see the file header.
      SELECT p.id AS post_id, p.content AS content, p.cover_image AS cover_image
        FROM posts p
       WHERE ${scope}
    ), nodes AS (
      SELECT post_id, content AS node FROM pub
      UNION ALL
      SELECT n.post_id, child
        FROM nodes n
        CROSS JOIN LATERAL jsonb_array_elements(
          -- Only so the walk does not error: jsonb_array_elements raises on a
          -- scalar or an object. What a non-array content MEANS is decided by
          -- the unwalkable CTE below.
          CASE WHEN jsonb_typeof(n.node -> 'content') = 'array'
               THEN n.node -> 'content'
               ELSE '[]'::jsonb
          END) AS child
    ), unwalkable AS (
      SELECT DISTINCT post_id FROM nodes WHERE ${UNWALKABLE_NODE}
    )
    SELECT 1
      FROM pub
     WHERE (
             -- An unwalkable document is excluded from the CONTENT half only.
             -- Its cover is a separate, typed value that the malformed body says
             -- nothing about, so it is still read below.
             pub.post_id NOT IN (SELECT post_id FROM unwalkable)
             AND EXISTS (
               SELECT 1
                 FROM regexp_matches(pub.content::text, ${SCHEME_PATTERN}, 'g') AS m(parts)
                WHERE m.parts[1] = ${id})
           )
        OR (
             jsonb_typeof(pub.cover_image -> 'blobId') = 'string'
             AND regexp_replace(pub.cover_image ->> 'blobId', ${COVER_PREFIX}, '') = ${id}
           )
     LIMIT 1)`;
}

/**
 * TRUE only if `imageId` is referenced by the CURRENT content or cover of a post
 * matching `PUBLIC_POST_PREDICATE`.
 *
 * Drafts, archived posts, trashed posts and revisions all answer FALSE.
 */
export async function isPubliclyReferencedImage(db: Db, imageId: string): Promise<boolean> {
  const res = await db.execute(sql`SELECT ${publicImageRefExists(imageId)} AS referenced`);
  return res.rows[0]?.referenced === true;
}

const PUBLIC_IMAGE_COLUMNS = sql.raw(
  [
    'id',
    'owner_id',
    'storage_key',
    'content_type',
    'width',
    'height',
    'byte_size',
    'checksum',
    'created_at',
    'committed_at',
    'unreferenced_since',
  ].join(', '),
);

/**
 * Every bigint goes through `toEpochMs` for the reason `images.ts#toImage`
 * documents: PGlite parses int8 into a number and `@neondatabase/serverless`
 * returns a string, and the harness makes PGlite behave like Neon.
 */
function toImage(row: Record<string, unknown>): ImageRow {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    storageKey: String(row.storage_key),
    contentType: String(row.content_type),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    byteSize: Number(row.byte_size),
    checksum: row.checksum == null ? null : String(row.checksum),
    createdAt: toEpochMs(row.created_at),
    committedAt: toEpochMsOrNull(row.committed_at),
    unreferencedSince: toEpochMsOrNull(row.unreferenced_since),
  };
}

/**
 * The image row, or `null`.
 *
 * ONE STATEMENT, so unknown / uncommitted / not-publicly-referenced are the same
 * `null` from the same code path and cannot be told apart upstream (threat T7).
 * A JS branch — read the row, then check the reference — would answer the three
 * cases after different amounts of work, and would also invite a caller to
 * reintroduce the distinction as a different status code.
 *
 * `committed_at IS NOT NULL` is the magic-byte check having run: an uncommitted
 * row is a presigned slot whose bytes nobody has validated.
 */
export async function getPublicImage(db: Db, imageId: string): Promise<ImageRow | null> {
  const res = await db.execute(sql`
    SELECT ${PUBLIC_IMAGE_COLUMNS}
      FROM images
     WHERE id = ${normalizeBlobId(imageId)}
       AND committed_at IS NOT NULL
       AND ${publicImageRefExists(imageId)}
     LIMIT 1`);
  const row = res.rows[0];
  return row ? toImage(row) : null;
}
