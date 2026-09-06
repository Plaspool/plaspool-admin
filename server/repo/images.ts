import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { toEpochMs, toEpochMsOrNull } from '../db/client';
import type { Db } from '../db/client';
import { BadRequestError } from './errors';
/*
 * `normalizeBlobId` is imported rather than re-spelled because there is already
 * one JS definition of "strip the optional `asset:`/`idb:` prefix" and a second
 * would be free to drift from it — the SQL copies below are unavoidable (a regex
 * inside a statement cannot call a TypeScript function) and are quite enough
 * duplication for one rule.
 */
import { normalizeBlobId } from './public-projection';
import type { AuthUser } from '../../shared/types';

/**
 * The image store (spec §3.6, §5.4).
 *
 * ONE STATEMENT PER MUTATION, AND NEVER `db.transaction` — the same rule as
 * `server/repo/posts.ts`, for the same measured reason: the Neon HTTP driver
 * throws unconditionally on `transaction()` while PGlite supports it, so a
 * transaction here would pass every test in this repository and 500 on every
 * production call.
 *
 * EVERY PRECONDITION LIVES IN THE SQL PREDICATE, never in a TypeScript check
 * over an already-read row. An earlier round of this project was mutation-tested
 * and found that replacing each CAS guard with `true` broke none of 254 tests,
 * because every precondition case was satisfied by a JS pre-check on a stale
 * read. Nothing in this file re-checks ownership or the unclaimed state before
 * the statement that depends on it: the zero-row result IS the refusal, and a
 * follow-up read is only ever used to CLASSIFY one that has already happened.
 *
 * Image ids are not secret. They appear in `posts.content`, which every writer
 * in the deployment can read, so `owner_id = $session` is the only thing between
 * a writer and another writer's in-flight upload — including its destruction,
 * since the reject-and-delete path is reachable by anyone who can name an id.
 */

// ------------------------------------------------------------------ policy

/** Spec §5.4. Anything larger is refused before a URL is ever signed. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** The five types `sniffImageType` can identify. Declared here as the policy. */
export const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
] as const;

export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

const ALLOWED = new Set<string>(ALLOWED_CONTENT_TYPES);

/**
 * Uncommitted rows younger than `SLOT_TTL_MS`, per user.
 *
 * The cap is on OPEN slots and it bounds the wrong thing on its own — see
 * `MAX_TOTAL_BYTES`. What it does bound is the loop that never commits: without
 * it, one authenticated session mints unbounded 12 MB presigned PUTs, each of
 * which is a valid write authorisation against the bucket for five minutes.
 */
export const MAX_OPEN_SLOTS = 10;

/** Spec §3.6: "uncommitted rows older than 24h are swept". */
export const SLOT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A per-user ceiling on bytes actually stored.
 *
 * `MAX_OPEN_SLOTS` counts only UNCOMMITTED rows, so commit-then-repeat walks
 * straight past it: ten slots, ten commits, ten more slots, forever, at 12 MB a
 * time. This is the bound on the thing that costs money and cannot be undone by
 * a sweep, and it is counted from `byte_size` — which commit corrects from
 * `headObject`, so a client that declares 1 byte and uploads 12 MB is charged
 * the 12 MB from the moment it commits.
 *
 * ENFORCED TWICE, AND IT HAS TO BE. The INSERT weighs the CLIENT-DECLARED size,
 * which is a number the client chooses; `commitImage` then REPLACES that number
 * with the real one from `headObject`. Enforcing only at slot time therefore
 * bounds nothing: declare one byte on each of ten slots, PUT 12 MB into each,
 * commit all ten, and 120 MB lands against a charge of ten bytes. So the commit
 * CAS carries the same ceiling against the CORRECTED size, and that is the
 * statement that makes this comment true.
 *
 * Not in the spec, so it is a choice: 1 GiB, roughly eighty-five full-size
 * uploads per writer, which is generous for a blog and useless as an exhaustion
 * primitive.
 *
 * AND IT IS DELIBERATELY UNDER `int4`. `images.byte_size` is an `integer`, so a
 * quota of 2 GiB is not merely a bigger number — a row seeded at that size is
 * SQLSTATE 22003 on insert, and the ceiling becomes unreachable by any code path
 * that has to name it.
 */
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

/**
 * THE AGE FLOOR, anchored to `greatest(created_at, committed_at)` and NOT to
 * `created_at` (spec §5.4, plan rule 1).
 *
 * `created_at` measures when the SLOT was issued, which is the wrong interval
 * entirely: a slot minted on Monday and committed on Thursday would satisfy a
 * `created_at`-based floor the instant it was committed, i.e. during exactly the
 * window the floor exists to protect. The interval that matters is "how long has
 * this image been in a state where a document could reference it", and that
 * starts at commit.
 */
export const ORPHAN_AGE_FLOOR_MS = 24 * 60 * 60 * 1000;

/**
 * How long an image must have been continuously unreferenced before its bytes
 * are deleted (plan rule 2).
 */
export const QUARANTINE_MS = 24 * 60 * 60 * 1000;

/** Same shape as the client's `newId`, so ids are indistinguishable by origin. */
function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// ------------------------------------------------------------------- shape

export interface ImageRow {
  id: string;
  ownerId: string;
  storageKey: string;
  contentType: string;
  width: number | null;
  height: number | null;
  byteSize: number;
  checksum: string | null;
  createdAt: number;
  committedAt: number | null;
  unreferencedSince: number | null;
}

const IMAGE_COLUMNS = sql.raw(
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
 * Every bigint goes through `toEpochMs`, and every integer through `Number`.
 *
 * PGlite parses int8 into a JS number while `@neondatabase/serverless` returns
 * it as a string, and the test harness configures PGlite to behave like Neon
 * (spec §9) — so a raw `row.created_at` is arithmetic in one driver and string
 * concatenation in the other.
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

// ------------------------------------------------------------------- slots

export interface SlotRequest {
  contentType: string;
  byteSize: number;
  checksum?: string | null;
}

/**
 * Issue an upload slot: one row, and nothing in R2 yet.
 *
 * THE CAPS ARE IN THE INSERT, not around it. `INSERT … SELECT … WHERE` makes
 * both limits properties of the statement, so two concurrent requests cannot
 * both read "nine open slots" and both insert a tenth — which is precisely what
 * a `SELECT count(*)` followed by an `INSERT` would allow, and precisely the
 * loop the cap exists to stop.
 *
 * Zero rows means one of the two limits refused it, and the two are told apart
 * afterwards by a read — CLASSIFYING a refusal that has already happened, never
 * deciding one. Both surface as 400 `bad_request` with the field named rather
 * than as a 500: they are permanent for this request, and spec §8's client
 * retries a 5xx five times over ~30 seconds for something that cannot succeed.
 */
export async function createSlot(
  db: Db,
  user: AuthUser,
  req: SlotRequest,
): Promise<ImageRow> {
  /*
   * The two type/size checks ARE done in TypeScript, and that is not the same
   * thing as a CAS pre-check: they are about the REQUEST, not about a row that
   * another request could be changing underneath this one. There is nothing
   * concurrent for them to be stale about.
   */
  if (!ALLOWED.has(req.contentType)) throw new BadRequestError('contentType');
  if (!Number.isSafeInteger(req.byteSize) || req.byteSize <= 0) {
    throw new BadRequestError('byteSize');
  }
  if (req.byteSize > MAX_IMAGE_BYTES) throw new BadRequestError('byteSize');

  const now = Date.now();
  const id = newId('img_');
  const storageKey = `images/${user.id}/${id}`;
  const openAfter = now - SLOT_TTL_MS;

  const res = await db.execute(sql`
    INSERT INTO images (id, owner_id, storage_key, content_type, width, height,
                        byte_size, checksum, created_at, committed_at,
                        unreferenced_since)
    SELECT ${id}, ${user.id}::uuid, ${storageKey}, ${req.contentType},
           NULL, NULL, ${req.byteSize}, ${req.checksum ?? null}, ${now}, NULL, NULL
     WHERE (SELECT count(*) FROM images
             WHERE owner_id = ${user.id}::uuid
               AND committed_at IS NULL
               AND created_at > ${openAfter}) < ${MAX_OPEN_SLOTS}
       AND (SELECT coalesce(sum(byte_size), 0) FROM images
             WHERE owner_id = ${user.id}::uuid) + ${req.byteSize} <= ${MAX_TOTAL_BYTES}
    RETURNING ${IMAGE_COLUMNS}`);

  const row = res.rows[0];
  if (row) return toImage(row);

  // Which of the two said no. A read AFTER the refusal, for the message only.
  const why = await db.execute(sql`
    SELECT (SELECT count(*) FROM images
             WHERE owner_id = ${user.id}::uuid
               AND committed_at IS NULL
               AND created_at > ${openAfter}) AS open,
           (SELECT coalesce(sum(byte_size), 0) FROM images
             WHERE owner_id = ${user.id}::uuid) AS used`);
  const open = Number(why.rows[0].open);
  throw new BadRequestError(open >= MAX_OPEN_SLOTS ? 'slots' : 'quota');
}

// ------------------------------------------------------------------ reads

/**
 * By id alone, with NO owner scope — deliberately.
 *
 * Reads are universal in this deployment (spec §6): an image referenced by any
 * post is served to every authenticated reader, so scoping this to the owner
 * would break every image in every post the moment two people write. It is also
 * why it must NOT be used as a permission gate anywhere: the commit path reads
 * through here to find the storage key, and the CAS is what decides whether the
 * caller may change anything.
 */
export async function getImage(db: Db, id: string): Promise<ImageRow | null> {
  const res = await db.execute(
    sql`SELECT ${IMAGE_COLUMNS} FROM images WHERE id = ${id}`,
  );
  const row = res.rows[0];
  return row ? toImage(row) : null;
}

/**
 * The scoped read that makes commit idempotent for the owner and a 404 for a
 * stranger.
 *
 * The commit CAS returns zero rows for BOTH "not yours" and "already
 * committed", and those two need opposite answers. This distinguishes them. It
 * is safe without a transaction because re-committing is not a state change:
 * whatever this read finds, nothing is written as a result of it.
 */
export async function getOwnedImage(
  db: Db,
  ownerId: string,
  id: string,
): Promise<ImageRow | null> {
  const res = await db.execute(sql`
    SELECT ${IMAGE_COLUMNS} FROM images
     WHERE id = ${id} AND owner_id = ${ownerId}::uuid`);
  const row = res.rows[0];
  return row ? toImage(row) : null;
}

/**
 * Which of `ids` name a COMMITTED image — the existence check a write path runs
 * before it stores an image id in a column that is not `images.id`.
 *
 * WHY IT IS NEEDED AT ALL. `shop_products.cover_image_id` and
 * `shop_products.image_ids` are plain `text`/`text[]` with no foreign key —
 * contract R3 forbids one across a subsystem boundary — so the column accepted
 * any string at all, and a typo'd or invented id was stored, served and
 * eventually rendered as a broken image with nothing anywhere reporting it.
 *
 * COMMITTED, NOT MERELY PRESENT. An uncommitted row is a presigned slot whose
 * bytes nobody has magic-byte checked and which `sweepUncommitted` removes within
 * 24 hours; referencing one stores an id that is on a countdown to not existing.
 * `getPublicImage` applies the same `committed_at IS NOT NULL` conjunct, so a
 * write that this admits is a write the public read can actually serve.
 *
 * DELIBERATELY NOT OWNER-SCOPED, for the reason `getImage` gives: reads are
 * universal in this deployment, so a product built by one writer may legitimately
 * use a photograph another writer uploaded. Scoping it would make the second
 * writer's product unsavable with no way to explain why.
 *
 * NORMALISED FIRST, so an id written `asset:img_x` is checked against `img_x` —
 * the same normalisation the reference walk above and `getPublicImage` apply. A
 * check that skipped it would refuse exactly the prefixed form the rest of the
 * system goes out of its way to accept.
 *
 * ONE STATEMENT for the whole list rather than one per id: a gallery may carry a
 * hundred ids (`routes.ts`'s `imageIds` cap), and a hundred round trips on a
 * Vercel function is the difference between a save and a timeout.
 */
export async function committedImageIds(
  db: Db,
  ids: readonly string[],
): Promise<Set<string>> {
  const wanted = [...new Set(ids.map(normalizeBlobId))].filter((id) => id !== '');
  if (wanted.length === 0) return new Set();
  const res = await db.execute(sql`
    SELECT id FROM images
     WHERE id = ANY(${sql.param(wanted)}::text[])
       AND committed_at IS NOT NULL`);
  return new Set(res.rows.map((row) => String(row.id)));
}

// ----------------------------------------------------------------- commit

export interface CommitFacts {
  /** From the object's own bytes, or `null` when the header could not be read. */
  width: number | null;
  height: number | null;
  /** From `headObject` — the real size, replacing the client's declaration. */
  byteSize: number;
}

/**
 * Claim a slot, in one CAS.
 *
 * `id AND owner_id AND committed_at IS NULL` — spec §5.4 verbatim. All three
 * halves are load-bearing and none of them is checked in TypeScript first:
 *
 * - without `owner_id`, any writer can commit another writer's in-flight
 *   upload, since ids are readable in any document;
 * - without `committed_at IS NULL`, a second commit rewrites the dimensions and
 *   the timestamp of an image that is already live — and, worse, resets nothing
 *   about the ownership question, so the idempotency branch above it stops
 *   being reached at all.
 *
 * A FOURTH HALF, ADDED LATER: the per-user byte quota, against the CORRECTED
 * size. `byte_size` is rewritten here from `headObject`, so the ceiling the
 * INSERT applied was applied to a number the client made up. Without this line
 * `MAX_TOTAL_BYTES` is a ceiling only for honest clients: ten slots declaring
 * one byte each, 12 MB PUT into each, commit — 120 MB stored, ten bytes
 * charged. It is a SQL predicate and not a TypeScript pre-check for the usual
 * reason: ten commits in flight at once would each read the same "plenty of
 * room" total and each act on it.
 *
 * The subquery excludes THIS row, because the row's declared size is already in
 * the sum and the corrected size is what is being weighed in its place.
 *
 * WHAT HAPPENS TO THE OBJECT WHEN THIS REFUSES. Nothing, deliberately, and that
 * is the whole decision: the row stays uncommitted and the bytes stay in the
 * bucket. Deleting them would destroy an upload the writer can still rescue by
 * freeing space and committing again, and this refusal is the one case where
 * the caller did nothing wrong except be full. The row is uncommitted, so
 * `sweepUncommitted` removes both within 24 hours if they never do — the bytes
 * are bounded (MAX_OPEN_SLOTS × MAX_IMAGE_BYTES over the ceiling, for a day)
 * and they are never leaked.
 *
 * `null` means the predicate matched nothing. The caller classifies it.
 */
export async function commitImage(
  db: Db,
  ownerId: string,
  id: string,
  facts: CommitFacts,
): Promise<ImageRow | null> {
  const res = await db.execute(sql`
    UPDATE images
       SET committed_at = ${Date.now()},
           width = ${facts.width},
           height = ${facts.height},
           byte_size = ${facts.byteSize},
           /*
            * A COMMITTED IMAGE STARTS WITH A CLEAN QUARANTINE CLOCK.
            *
            * Slot ids are minted here and never reused, so this is belt and
            * braces — but a stamped unreferenced_since surviving into the
            * committed state would mean an image whose clock started before it
            * existed, and the delete pass would read it as 24 hours of
            * continuous non-reference that never happened.
            */
           unreferenced_since = NULL
     WHERE id = ${id}
       AND owner_id = ${ownerId}::uuid
       AND committed_at IS NULL
       AND (SELECT coalesce(sum(other.byte_size), 0) FROM images other
             WHERE other.owner_id = ${ownerId}::uuid
               AND other.id <> ${id}) + ${facts.byteSize} <= ${MAX_TOTAL_BYTES}
    RETURNING ${IMAGE_COLUMNS}`);
  const row = res.rows[0];
  return row ? toImage(row) : null;
}

/**
 * The reject-and-delete path, carrying THE IDENTICAL PREDICATE to the commit
 * above.
 *
 * This is the destructive half of the same decision and it is reachable by
 * anyone who can name an id — i.e. by anyone who can read a document. Scoped
 * with anything weaker, "these bytes are not a JPEG" becomes a primitive for
 * destroying another writer's upload: name their id, and the server deletes
 * their row and their object on your behalf.
 *
 * Returns the storage key when a row was actually removed, so the caller knows
 * whether it is entitled to delete the OBJECT too — a stranger's rejected
 * commit must leave both the row and the bytes exactly where they were.
 */
export async function deleteUnclaimedImage(
  db: Db,
  ownerId: string,
  id: string,
): Promise<string | null> {
  const res = await db.execute(sql`
    DELETE FROM images
     WHERE id = ${id}
       AND owner_id = ${ownerId}::uuid
       AND committed_at IS NULL
    RETURNING storage_key`);
  const row = res.rows[0];
  return row ? String(row.storage_key) : null;
}

// ------------------------------------------------------- abandoned uploads

export interface SweptObject {
  id: string;
  storageKey: string;
}

/**
 * Rows for uploads that were authorised and never confirmed (spec §3.6).
 *
 * NOT the same thing as orphan collection and deliberately kept apart: these
 * rows are unreferenced by definition — no document can name an image the
 * client never finished uploading — so putting them through the reference walk
 * would only add a 24-hour quarantine to a decision that needs none. The age
 * check is the whole precondition, and it is `created_at` here rather than
 * `greatest(created_at, committed_at)` because `committed_at` is NULL by
 * construction on every row this can touch.
 */
export async function sweepUncommitted(
  db: Db,
  now: number = Date.now(),
): Promise<SweptObject[]> {
  const res = await db.execute(sql`
    DELETE FROM images
     WHERE committed_at IS NULL
       AND created_at < ${now - SLOT_TTL_MS}
    RETURNING id, storage_key`);
  return res.rows.map((row) => ({
    id: String(row.id),
    storageKey: String(row.storage_key),
  }));
}

// --------------------------------------------------------- orphan collection

/**
 * THE REFERENCE SET, and every rule the plan makes non-negotiable about it.
 *
 * This fragment is shared verbatim by the mark pass and the delete pass, so the
 * two cannot drift into disagreeing about what "referenced" means — a delete
 * pass with a narrower notion of reference than the mark pass would delete
 * exactly the images the mark pass had decided to keep.
 *
 * **`docs` covers posts AND revisions, and does NOT filter `deleted_at`**
 * (rule 4). A trashed post is a post somebody can restore, and restoring one
 * whose images were collected while it sat in the bin yields a document full of
 * dangling references — the trash is reversible, byte deletion is not. A
 * revision is history nobody can re-upload, so it counts too.
 *
 * **`nodes` walks the document with `WITH RECURSIVE`, and `unwalkable` is
 * evaluated AT EVERY NODE** (rule 3). This is the `occupied` idiom from
 * `sweepBlankDrafts`, and the reason it is per-node rather than per-column is
 * measured: `posts.content` is always a jsonb OBJECT, so a top-level
 * `jsonb_typeof(content) <> 'array'` test matches every healthy row in the
 * table and means nothing; meanwhile a document that is fine at the top but
 * carries `{"type":"weird","content":"oops"}` five levels down truncates the
 * descent at that node, because `jsonb_array_elements` cannot be handed a
 * string and the `CASE` substitutes an empty array. Everything below it becomes
 * invisible, and invisible reads as unreferenced, and unreferenced reads as
 * deletable. This project has ALREADY destroyed a writer's draft by making "we
 * could not parse this" look like "this is empty"; here the same mistake costs
 * bytes that cannot be recovered from anywhere.
 *
 * So an unwalkable node anywhere in the store marks EVERY image referenced, for
 * this run. Collection stops until somebody fixes the document. That is the
 * safe direction to fail: the cost is disk, and the alternative cost is a
 * published post whose images 404.
 *
 * **`scheme_refs` extracts by SCHEME from the serialised document, at any
 * depth** (rule 5) — never from nodes whose `type` is `image`. A node type
 * added later, an id parked in a mark, an id in an attribute nobody thought of:
 * all of them keep their image. The trade is that an `asset:` id written in
 * ordinary prose also counts as a reference, which errs towards keeping bytes
 * that are not needed rather than deleting bytes that are.
 *
 * Note what this means about the walk: `nodes` is here for the malformed-node
 * verdict and NOT for the extraction, because extracting from the root's own
 * `::text` already covers every string at every depth — including `attrs` and
 * `marks`, which the walk deliberately does not descend into. Two mechanisms,
 * two jobs; merging them would make the extractor inherit the walk's blind
 * spots.
 *
 * **`cover_refs` is a SEPARATE extractor for a BARE id** (rule 5, second half).
 * `cover_image->>'blobId'` carries no scheme at all, so the scheme regex cannot
 * see it and a merged extractor would have to drop the scheme requirement for
 * everything — which would turn every short string in every document into a
 * candidate id. The stripped form is unioned in as well, so a cover image
 * written as `asset:img_x` by a future client is matched either way.
 *
 * **`product_refs` walks `shop_products`, AND IT IS A BUG FIX RATHER THAN AN
 * EXTENSION** (HANDOFF §1.10). `shop_products.cover_image_id` and
 * `shop_products.image_ids` name rows of this same `images` table, and until this
 * CTE existed the walk covered posts and revisions only — so an image uploaded
 * for a product and placed nowhere else was "unreferenced" from the moment it was
 * committed, and the delete pass destroyed its bytes 24 hours later while a live
 * product page still pointed at it. The condition was live in production with no
 * signal: `{collected: n}` looks the same whether the n rows were abandoned
 * uploads or a shop's entire catalogue photography.
 *
 * It reads BOTH the bare and the stripped form for the same reason `cover_refs`
 * does — the column is a plain `text` that has never been normalised on write, so
 * a client is free to store `asset:img_x` in it and one already may have — and it
 * DOES NOT FILTER `deleted_at` OR `status`, which is rule 4 applied to the shop:
 * a trashed product is a product somebody can restore (`restoreProduct` exists
 * precisely for that), and restoring one whose photographs were collected while
 * it sat in the bin yields a product page full of dangling images. Being broad
 * here costs disk; being narrow costs bytes nobody can re-upload.
 *
 * Note the DIRECTION this points, against `server/repo/public-images.ts`, which
 * asks the opposite question about the same two columns and must stay narrow.
 * Its header explains the split at length; do not unify the two.
 */
/**
 * WHAT COUNTS AS "WE CANNOT READ THIS NODE" — one definition, two call sites.
 *
 * The walk uses it to decide whether to keep every image (rule 3); the
 * diagnostic below uses it to tell the owner WHICH row to fix. They must be the
 * same test, or the report names rows the walk is happy with and stays silent
 * about the one that is actually blocking collection.
 *
 * `'null'` IS WALKABLE, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT.
 * `{"type":"paragraph","content":null}` is not a document we failed to parse:
 * jsonb null is a TYPED, unambiguous value that says "no children", exactly what
 * the ABSENT key says, and this walk already treats an absent `content` as an
 * ordinary leaf (every empty paragraph in the store is one). The old test was
 * `node -> 'content' IS NOT NULL`, which is SQL-NULL and therefore TRUE for a
 * JSON null — so one `"content": null` anywhere in any post or revision made
 * every image referenced and halted ALL collection, permanently and with no
 * signal. Nothing is being loosened here: a JSON null carries no children to
 * lose, so reading it as a leaf cannot hide a reference the way `"content":
 * "oops"` can. Anything that is neither an array nor null still stops the sweep
 * dead.
 */
const UNWALKABLE_NODE = sql`
        jsonb_typeof(node) <> 'object'
     OR (node -> 'content' IS NOT NULL
         AND jsonb_typeof(node -> 'content') NOT IN ('array', 'null'))`;

const REFERENCE_SET = sql`
  RECURSIVE docs AS (
    SELECT content FROM posts
    UNION ALL
    SELECT content FROM revisions
  ), nodes AS (
    SELECT content AS node FROM docs
    UNION ALL
    SELECT child
      FROM nodes n
      CROSS JOIN LATERAL jsonb_array_elements(
        -- Only so the walk does not error: jsonb_array_elements raises on a
        -- scalar or an object. What a non-array content MEANS is decided in
        -- the unwalkable CTE below, which counts it as "we cannot read this row".
        CASE WHEN jsonb_typeof(n.node -> 'content') = 'array'
             THEN n.node -> 'content'
             ELSE '[]'::jsonb
        END) AS child
  ), unwalkable AS (
    SELECT 1
      FROM nodes
     WHERE ${UNWALKABLE_NODE}
     LIMIT 1
  ), scheme_refs AS (
    SELECT DISTINCT m.parts[1] AS id
      FROM docs
      CROSS JOIN LATERAL regexp_matches(
        docs.content::text, '(?:asset|idb):([A-Za-z0-9_.-]+)', 'g') AS m(parts)
     WHERE m.parts[1] <> ''
  ), cover_refs AS (
    SELECT DISTINCT cover_image ->> 'blobId' AS id
      FROM posts
     WHERE jsonb_typeof(cover_image -> 'blobId') = 'string'
       AND cover_image ->> 'blobId' <> ''
    UNION
    SELECT DISTINCT regexp_replace(cover_image ->> 'blobId', '^(asset|idb):', '')
      FROM posts
     WHERE jsonb_typeof(cover_image -> 'blobId') = 'string'
       AND cover_image ->> 'blobId' <> ''
  ), product_refs AS (
    -- The product cover, both as stored and with the optional scheme stripped.
    -- No deleted_at filter and no status filter: a trashed or draft product is
    -- one somebody can publish, and its photographs must survive the wait.
    SELECT DISTINCT cover_image_id AS id
      FROM shop_products
     WHERE cover_image_id IS NOT NULL AND cover_image_id <> ''
    UNION
    SELECT DISTINCT regexp_replace(cover_image_id, '^(asset|idb):', '')
      FROM shop_products
     WHERE cover_image_id IS NOT NULL AND cover_image_id <> ''
    UNION
    -- The gallery. unnest over an empty array yields no rows, so a product with
    -- no gallery contributes nothing rather than a NULL that would have to be
    -- filtered out of the referenced CTE afterwards.
    SELECT DISTINCT g.ref
      FROM shop_products
      CROSS JOIN LATERAL unnest(image_ids) AS g(ref)
     WHERE g.ref IS NOT NULL AND g.ref <> ''
    UNION
    SELECT DISTINCT regexp_replace(g.ref, '^(asset|idb):', '')
      FROM shop_products
      CROSS JOIN LATERAL unnest(image_ids) AS g(ref)
     WHERE g.ref IS NOT NULL AND g.ref <> ''
    UNION
    -- THE VARIANT'S OWN IMAGE (migration 0009), and it is the same bug fix as
    -- the product columns above rather than a new idea: the options in this
    -- store are colours, each colour now carries its own photograph, and an
    -- image referenced ONLY from shop_variants.image_id would be unreferenced
    -- by definition the moment it was committed. No status filter, for the
    -- reason the product block gives -- a discontinued variant is one somebody
    -- can reactivate.
    SELECT DISTINCT image_id AS id
      FROM shop_variants
     WHERE image_id IS NOT NULL AND image_id <> ''
    UNION
    SELECT DISTINCT regexp_replace(image_id, '^(asset|idb):', '')
      FROM shop_variants
     WHERE image_id IS NOT NULL AND image_id <> ''
    UNION
    -- THE ADD-ON'S PICTURE (migration 0940), for the reason the variant image
    -- is here: an image referenced only from shop_add_ons.image_id would be
    -- unreferenced by definition the moment it was committed. No status
    -- filter: a draft add-on is one somebody can switch on.
    SELECT DISTINCT image_id AS id
      FROM shop_add_ons
     WHERE image_id IS NOT NULL AND image_id <> ''
    UNION
    SELECT DISTINCT regexp_replace(image_id, '^(asset|idb):', '')
      FROM shop_add_ons
     WHERE image_id IS NOT NULL AND image_id <> ''
  ), referenced AS (
    SELECT id FROM scheme_refs WHERE id IS NOT NULL
    UNION
    SELECT id FROM cover_refs WHERE id IS NOT NULL
    UNION
    SELECT id FROM product_refs WHERE id IS NOT NULL
    UNION
    -- An unwalkable row references EVERYTHING. Not "the ids we managed to see
    -- in it" — everything, because what we could not read is exactly what we
    -- cannot make a claim about.
    SELECT id FROM images WHERE EXISTS (SELECT 1 FROM unwalkable)
  )`;

export interface MarkResult {
  /** Images the walk did NOT reach, after this pass. */
  unreferenced: number;
  /** Images whose clock this pass cleared because the walk reached them. */
  cleared: number;
  /** Rows this pass actually wrote. Zero on a store in a steady state. */
  changed: number;
  /**
   * TRUE when some node in some document could not be walked, i.e. when
   * `referenced` is "every image" and NOTHING can be collected on this run.
   *
   * Reported rather than inferred, because the two states are otherwise
   * identical on the wire: a healthy store with nothing to collect and a store
   * where one malformed row has silently halted collection for months both
   * answer `{collected: 0}`. The fail-safe direction is right; being unable to
   * SEE it is what made it a defect.
   */
  blocked: boolean;
}

/** One document the walk could not read, named well enough to go and fix it. */
export interface UnwalkableDoc {
  /** `post` or `revision` — the table, so the id is unambiguous. */
  source: string;
  id: string;
}

/**
 * WHICH rows are blocking collection. Called ONLY when a pass reported
 * `blocked`, and that is deliberate: it is a second descent over every document
 * and it exists to answer a question nobody can ask on a healthy store.
 *
 * `LIMIT` rather than the whole list: an import that wrote one bad shape wrote
 * it a thousand times, and the owner needs a row to open, not a census.
 */
export const UNWALKABLE_REPORT_LIMIT = 10;

export async function findUnwalkableDocs(
  db: Db,
  limit: number = UNWALKABLE_REPORT_LIMIT,
): Promise<UnwalkableDoc[]> {
  const res = await db.execute(sql`
    WITH RECURSIVE docs AS (
      SELECT 'post'::text AS source, id::text AS doc_id, content FROM posts
      UNION ALL
      SELECT 'revision'::text, id::text, content FROM revisions
    ), nodes AS (
      SELECT source, doc_id, content AS node FROM docs
      UNION ALL
      SELECT n.source, n.doc_id, child
        FROM nodes n
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(n.node -> 'content') = 'array'
               THEN n.node -> 'content'
               ELSE '[]'::jsonb
          END) AS child
    )
    SELECT DISTINCT source, doc_id FROM nodes
     WHERE ${UNWALKABLE_NODE}
     ORDER BY source, doc_id
     LIMIT ${limit}`);
  return res.rows.map((row) => ({
    source: String(row.source),
    id: String(row.doc_id),
  }));
}

/**
 * PASS ONE. Stamp `unreferenced_since` on what the walk did not reach, and
 * CLEAR it on what it did.
 *
 * `coalesce(unreferenced_since, now)` and not `now`: the clock must keep
 * running across passes, or an image that has been unreferenced for a week has
 * its timer reset by the very pass that is supposed to be counting it, and
 * nothing is ever collected.
 *
 * The clearing half is not symmetry for its own sake — it is rule 2. Cutting an
 * image out of one post to paste it into another leaves it unreferenced for one
 * autosave debounce; if that instant is remembered forever, the image is
 * deleted 24 hours later while a live post points straight at it.
 *
 * THE UPDATE HAS A WHERE CLAUSE, AND IT IS THE XOR OF THE TWO STATES. Without
 * one this statement rewrote EVERY images row on every call — a dead tuple per
 * image per sweep, on a route the dashboard button calls — to give the
 * overwhelming majority of them the value they already had. The predicate
 * `(referenced) <> (unreferenced_since IS NULL)` is exactly "this row's stored
 * state disagrees with what this pass concluded": a referenced row carrying a
 * clock (clear it) or an unreferenced row carrying none (stamp it). Every other
 * row is a no-op — note especially that an ALREADY-stamped unreferenced row is
 * skipped, which is the same thing `coalesce` was doing and is what keeps the
 * clock running across passes.
 *
 * The counts are therefore NOT taken from `RETURNING` any more — that would now
 * count only the rows that changed. They are derived from `referenced`, which
 * is the post-state answer by construction: the outer SELECT cannot see the
 * CTE's writes, but it does not need to.
 */
export async function markUnreferenced(
  db: Db,
  now: number = Date.now(),
): Promise<MarkResult> {
  const res = await db.execute(sql`
    WITH ${REFERENCE_SET}, marked AS (
      UPDATE images
         SET unreferenced_since = CASE
               WHEN images.id IN (SELECT id FROM referenced) THEN NULL
               ELSE coalesce(images.unreferenced_since, ${now})
             END
       WHERE (images.id IN (SELECT id FROM referenced))
             <> (images.unreferenced_since IS NULL)
      RETURNING 1 AS touched
    )
    SELECT (SELECT count(*) FROM images
             WHERE id NOT IN (SELECT id FROM referenced))::int AS unreferenced,
           (SELECT count(*) FROM images
             WHERE id IN (SELECT id FROM referenced))::int AS cleared,
           (SELECT count(*) FROM marked)::int AS changed,
           EXISTS (SELECT 1 FROM unwalkable) AS blocked`);
  const row = res.rows[0];
  return {
    unreferenced: Number(row.unreferenced),
    cleared: Number(row.cleared),
    changed: Number(row.changed),
    blocked: row.blocked === true || row.blocked === 't',
  };
}

/**
 * PASS TWO. Delete only what has been unreferenced CONTINUOUSLY for the
 * quarantine window, is still unreferenced on this run, and is old enough.
 *
 * Three independent predicates, and each one is the whole of a different rule:
 *
 * - `unreferenced_since <= now - QUARANTINE_MS` — rule 2. It is the mark pass's
 *   memory, and the only thing that distinguishes "nobody has pointed at this
 *   for a day" from "nobody is pointing at this during a debounce".
 * - `id NOT IN referenced` — rule 2's second half. The mark may be minutes or
 *   hours old; this run re-derives the reference set and refuses to delete
 *   anything a document has picked up since. It is also what makes an unwalkable
 *   document stop collection outright, because `referenced` becomes every image.
 * - `greatest(created_at, coalesce(committed_at, created_at))` — rule 1, the age
 *   floor, on the interval since the image became referenceable rather than
 *   since its slot was minted.
 *
 * Returns the storage keys rather than deleting objects itself: R2 deletion is
 * best-effort and happens AFTER the row is gone (rule 6). A leaked byte costs
 * money; a row deleted after a failed object delete costs an image that is
 * still in a post.
 *
 * BOUNDED AND RESUMABLE. `COLLECT_BATCH` caps how many rows one call removes and
 * `more` says whether another call has work left. The walk this sits on top of
 * descends every `posts.content` AND every `revisions.content` and regexps each
 * document's full `::text`; on a store with real revision history that is close
 * enough to the Vercel function ceiling that an unbounded R2 delete loop behind
 * it is what tips it over — and a timeout is a 500, which spec §8's client
 * retries five times, each retry redoing the entire walk. A bounded pass that
 * says "call me again" finishes; an unbounded one that times out never does.
 *
 * The three predicates live in `doomed` and are unchanged. In particular the
 * delete pass still RE-DERIVES `referenced` on this run rather than trusting the
 * mark — that is what stops a stale mark outvoting a live reference, and no
 * amount of batching may move it.
 */
export const COLLECT_BATCH = 200;

export interface CollectedImage extends SweptObject {
  ownerId: string;
  byteSize: number;
  unreferencedSince: number | null;
}

export interface CollectResult {
  collected: CollectedImage[];
  /** More rows met the predicate than this batch removed: call again. */
  more: boolean;
}

/**
 * The rows the delete pass may take, at most `limit + 1` of them.
 *
 * Shared verbatim by `collectOrphans` and `previewOrphans` so a dry run cannot
 * describe a different set from the one the real run deletes — a preview that
 * disagrees with the deletion is worse than no preview. The extra row is how
 * `more` is answered without a second count over the same predicate.
 */
function doomed(now: number, limit: number) {
  return sql`doomed AS (
      SELECT id, owner_id, storage_key, byte_size, unreferenced_since
        FROM images
       WHERE unreferenced_since IS NOT NULL
         AND unreferenced_since <= ${now - QUARANTINE_MS}
         AND greatest(created_at, coalesce(committed_at, created_at))
             < ${now - ORPHAN_AGE_FLOOR_MS}
         AND id NOT IN (SELECT id FROM referenced)
       ORDER BY unreferenced_since, id
       LIMIT ${limit + 1}
    )`;
}

function toCollected(row: Record<string, unknown>): CollectedImage {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    storageKey: String(row.storage_key),
    byteSize: Number(row.byte_size),
    unreferencedSince: toEpochMsOrNull(row.unreferenced_since),
  };
}

export async function collectOrphans(
  db: Db,
  now: number = Date.now(),
  limit: number = COLLECT_BATCH,
): Promise<CollectResult> {
  const res = await db.execute(sql`
    WITH ${REFERENCE_SET}, ${doomed(now, limit)}, gone AS (
      DELETE FROM images
       WHERE id IN (SELECT id FROM doomed ORDER BY unreferenced_since, id
                     LIMIT ${limit})
      RETURNING id, owner_id, storage_key, byte_size, unreferenced_since
    )
    SELECT (SELECT count(*) FROM doomed)::int AS pending,
           coalesce((SELECT jsonb_agg(to_jsonb(g)) FROM gone g), '[]'::jsonb) AS gone`);
  const row = res.rows[0];
  const rows = (typeof row.gone === 'string' ? JSON.parse(row.gone) : row.gone) as
    Record<string, unknown>[];
  return {
    collected: rows.map(toCollected),
    more: Number(row.pending) > limit,
  };
}

export interface PreviewResult {
  /** What a real run would delete right now, in the order it would take them. */
  collected: CollectedImage[];
  /** EITHER list was truncated at `limit`: a real run has more than one pass of work. */
  more: boolean;
  /** What `sweepUncommitted` would remove: abandoned slots, no quarantine. Bounded. */
  swept: SweptObject[];
  /** What the mark pass would conclude, WITHOUT writing it. */
  unreferenced: number;
  blocked: boolean;
}

/**
 * The same question, asked without answering it.
 *
 * WHY THIS EXISTS AT ALL: `collect-orphans` destroys committed media belonging
 * to every writer in the deployment and used to report two integers. A writer
 * who committed an image and never placed it in a document lost the bytes 48
 * hours later with no way to learn what had gone — no ids, no preview, no
 * record. Ghost never has to answer "what did that delete" only because Ghost
 * never deletes anything; this route does, so it owes an answer.
 *
 * NOT A MARK PASS. A dry run writes NOTHING — no `unreferenced_since`, no
 * clocks started — because a preview that stamps the quarantine clock is a
 * preview that brings deletion 24 hours closer every time somebody looks. It
 * reads the STORED clocks and re-derives the live reference set, which is
 * exactly the pair the real delete pass acts on.
 */
export async function previewOrphans(
  db: Db,
  now: number = Date.now(),
  limit: number = COLLECT_BATCH,
): Promise<PreviewResult> {
  const res = await db.execute(sql`
    WITH ${REFERENCE_SET}, ${doomed(now, limit)}
    SELECT (SELECT count(*) FROM doomed)::int AS pending,
           coalesce((SELECT jsonb_agg(to_jsonb(d))
                       FROM (SELECT * FROM doomed
                              ORDER BY unreferenced_since, id
                              LIMIT ${limit}) d), '[]'::jsonb) AS gone,
           (SELECT count(*) FROM images
             WHERE id NOT IN (SELECT id FROM referenced))::int AS unreferenced,
           EXISTS (SELECT 1 FROM unwalkable) AS blocked`);
  const row = res.rows[0];
  const rows = (typeof row.gone === 'string' ? JSON.parse(row.gone) : row.gone) as
    Record<string, unknown>[];

  /*
   * BOUNDED LIKE THE OTHER HALF. The delete pass is capped at `COLLECT_BATCH`
   * because this route lives under the Vercel function ceiling; a dry run that
   * serialised every abandoned slot in a store with tens of thousands of them
   * into one JSON body would blow the same ceiling on the route whose whole
   * justification for batching is that ceiling. `+ 1` answers `more` for the
   * combined preview without a second count.
   */
  const stale = await db.execute(sql`
    SELECT id, storage_key, count(*) OVER ()::int AS total FROM images
     WHERE committed_at IS NULL AND created_at < ${now - SLOT_TTL_MS}
     ORDER BY created_at, id
     LIMIT ${limit}`);

  return {
    collected: rows.map(toCollected),
    more:
      Number(row.pending) > limit ||
      Number(stale.rows[0]?.total ?? 0) > limit,
    /*
     * The trimming is the SQL `LIMIT` and NOT a `.slice()` here, deliberately:
     * a JS slice bounds the JSON body and leaves the driver carrying every row
     * across the wire, which is the cost this bound exists to avoid. `count(*)
     * OVER ()` is evaluated before the LIMIT, so the full match count still
     * comes back — one scan, bounded transfer.
     */
    swept: stale.rows.map((r) => ({
      id: String(r.id),
      storageKey: String(r.storage_key),
    })),
    unreferenced: Number(row.unreferenced),
    blocked: row.blocked === true || row.blocked === 't',
  };
}
