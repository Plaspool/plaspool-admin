import { sql } from 'drizzle-orm';
import { toEpochMs, toEpochMsOrNull } from '../../db/client';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { StaleMarketingWriteError } from '../errors';
import { ID, newId } from '../ids';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';

/**
 * Banners — the only rows in this subsystem the public internet reads (spec D8).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE THING THIS FILE EXISTS TO PROTECT: the admin screen's answer to "is
 * this showing?" and the storefront's answer must be the SAME answer.
 *
 * There is no cron to flip a status — both of the deployment's daily slots are
 * spent (spec D6) and a banner told to start at 09:00 has to start at 09:00 —
 * so visibility is decided at READ TIME, in a WHERE clause, every time. That
 * rule therefore exists twice: here as SQL, and in
 * `shared/marketing/banners.ts#deriveBannerStatus` as the pure function the
 * admin list renders its status chip from.
 *
 * Two implementations of one rule is normally a smell. It is unavoidable here —
 * the client cannot run the SQL and Postgres cannot run the TypeScript — so what
 * makes it safe is that the predicate is a BUILDER rather than a query, and
 * `public.test.ts` feeds the same fixture rows to both halves and asserts they
 * agree row for row. When they disagree the failure is the worst kind available:
 * the admin screen says Live, the site shows nothing, and nobody can tell which
 * one is lying.
 *
 * `now` IS ALWAYS AN ARGUMENT AND NEVER `now()` IN THE SQL. A predicate that
 * reads the database's clock cannot be tested at its boundaries at all, and it
 * would be a SECOND clock — the one the storefront's cache and the admin's
 * `deriveBannerStatus` are not reading.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type BannerPlacement = 'top_bar' | 'popup' | 'section';
/** The STORED intent. The derived status the UI chips render is this crossed
 *  with the clock — `deriveBannerStatus`, not a column. */
export type BannerStatus = 'draft' | 'live' | 'archived';

/** Contract §Types `Banner`, and the frozen wire shape of #21-23. */
export interface Banner {
  id: string;
  title: string;
  body: string;
  ctaText: string | null;
  ctaUrl: string | null;
  placement: BannerPlacement;
  status: BannerStatus;
  /** Epoch ms. Null means "from the moment it is live". */
  startsAt: number | null;
  /** Epoch ms, EXCLUSIVE. Null means "until someone turns it off". */
  endsAt: number | null;
  /** Highest wins within a placement. */
  priority: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** Contract #22's body. NOTE WHAT IS ABSENT: `status`. Every banner is created
 *  a draft and switched on by #23, so there is no way to publish something to
 *  the storefront in one call from a form that has not been previewed. */
export interface BannerDraft {
  title: string;
  body?: string;
  ctaText?: string | null;
  ctaUrl?: string | null;
  placement: BannerPlacement;
  startsAt?: number | null;
  endsAt?: number | null;
  priority?: number;
}

/**
 * Contract #23's body minus `expectedRevision`.
 *
 * FOUR FIELDS ARE NULLABLE HERE AND OPTIONAL IN THE DRAFT, which is not the
 * same thing said twice: `undefined` means "leave it alone" and `null` means
 * "clear it". Both are ordinary editor operations — removing an end date is how
 * a campaign is extended indefinitely, and removing a CTA is how a banner stops
 * being a button — and a patch that could only ever SET them would leave the
 * only way out of a schedule being a banner nobody can turn off.
 */
export interface BannerPatch {
  title?: string;
  body?: string;
  ctaText?: string | null;
  ctaUrl?: string | null;
  placement?: BannerPlacement;
  status?: BannerStatus;
  startsAt?: number | null;
  endsAt?: number | null;
  priority?: number;
}

/**
 * Contract #29's row — what the storefront gets, and nothing else.
 *
 * NO `status`, NO `revision`, NO WINDOW. Those are the columns the ADMIN
 * decides visibility with, and this answer has already applied them: shipping
 * them would invite the storefront to re-implement the decision and get a
 * third opinion into the argument this file's header is about. What is left is
 * exactly what a page renders.
 */
export interface PublicBanner {
  id: string;
  title: string;
  body: string;
  ctaText: string | null;
  ctaUrl: string | null;
  placement: BannerPlacement;
  priority: number;
}

export interface WriteOptions {
  /** The signed-in staff member. Recorded as `created_by`. */
  actorId: string;
  /** ONE clock reading per write, passed in rather than taken here, so a row's
   *  `created_at` and `updated_at` cannot differ by a millisecond of scheduling. */
  now: number;
}

/** Bare names, so one list serves a `SELECT` and a `RETURNING`. */
const BANNER_COLUMNS = sql.raw(
  `id, title, body, cta_text, cta_url, placement, status,
   starts_at, ends_at, priority, revision, created_at, updated_at`,
);

function rowToBanner(row: Record<string, unknown>): Banner {
  return {
    id: String(row.id),
    title: String(row.title),
    body: String(row.body),
    ctaText: row.cta_text == null ? null : String(row.cta_text),
    ctaUrl: row.cta_url == null ? null : String(row.cta_url),
    placement: row.placement as BannerPlacement,
    status: row.status as BannerStatus,
    // `toEpochMsOrNull` and not `Number`: these are `bigint` columns, which the
    // Neon driver hands back as STRINGS and PGlite is configured to imitate. A
    // `"1786600001000" > now` comparison in the client is a string comparison.
    startsAt: toEpochMsOrNull(row.starts_at),
    endsAt: toEpochMsOrNull(row.ends_at),
    // `integer`, which both drivers agree about.
    priority: Number(row.priority),
    revision: Number(row.revision),
    createdAt: toEpochMs(row.created_at),
    updatedAt: toEpochMs(row.updated_at),
  };
}

// ------------------------------------------------------------- the two rules

/** The fields the two cross-field rules are about, on a MERGED row. */
interface Coherent {
  ctaText: string | null;
  ctaUrl: string | null;
  startsAt: number | null;
  endsAt: number | null;
}

/**
 * The pair rule and the window rule, judged on the row as it WILL BE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOT IN THE ZOD SCHEMA, AND THAT IS THE WHOLE REASON THIS FUNCTION EXISTS.
 *
 * Both rules are about two fields, and on a PATCH only one of them is usually
 * in the body: setting `endsAt` on a banner whose `startsAt` has been stored
 * since last week is the ordinary edit, and a schema can only ever see half of
 * it. Written as a `superRefine` on the create body it would be correct for
 * creates and absent for patches — which is where `marketing_banners_window_ck`
 * catches it as SQLSTATE 23514, a 500 the client retries five times for a date
 * that can never be accepted. Written twice it is two implementations of one
 * rule, which is precisely the drift `deriveBannerStatus` exists to prevent.
 *
 * So the schemas check SHAPES (a string, a URL that is not `javascript:`, an
 * integer in range) and this checks the ROW. `settings/repo.ts#refusesZeroRate`
 * reached the same arrangement from the same problem.
 *
 * THE DETAIL NAMES THE FIELD THAT HAS TO CHANGE, not the one that was sent. A
 * URL with no label is `ctaText` — the empty input — and a label with no URL is
 * `ctaUrl`, because the catalogue's `bad_request` treatment focuses the input
 * named in `detail` and focusing the field that is already filled in tells an
 * admin their correct value is wrong.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function assertCoherent(merged: Coherent): void {
  if (merged.ctaUrl !== null && merged.ctaText === null) throw new BadRequestError('ctaText');
  if (merged.ctaText !== null && merged.ctaUrl === null) throw new BadRequestError('ctaUrl');

  /*
   * A HALF-OPEN WINDOW, so `endsAt === startsAt` is refused rather than stored
   * as a banner that can never show: the predicate below is `starts_at <= now
   * AND ends_at > now`, which no instant satisfies when the two are equal.
   * `marketing_banners_window_ck` says the same thing in the database.
   */
  if (
    merged.startsAt !== null &&
    merged.endsAt !== null &&
    merged.endsAt <= merged.startsAt
  ) {
    throw new BadRequestError('endsAt');
  }
}

/** `undefined` leaves the stored value alone; `null` clears it. */
function merge<T>(patched: T | undefined, current: T): T {
  return patched === undefined ? current : patched;
}

// -------------------------------------------------------------------- reads

/**
 * Contract #21 — every banner, whatever its status, newest first.
 *
 * ALL THREE STATUSES IN ONE ANSWER, and the client derives the chip. The screen
 * groups archived rows under their own heading rather than hiding them (spec
 * §UI Banners: there is no delete anywhere, because a banner that ran is a
 * record of what the shop said in public), so a status filter here would be a
 * second request for the same page.
 *
 * NEWEST FIRST BY CREATION — not `updated_at DESC`, which reshuffles the list
 * under the reader every time somebody saves, and not `priority DESC`, which
 * only means anything WITHIN a placement and would interleave three unrelated
 * ladders into one that reads as noise. Creation order never moves.
 *
 * NOT PAGINATED, matching contract #21's `{ banners }` and unlike the queue's
 * keyset page. A shop runs banners in single figures; a pager over a list that
 * short is a control that never appears and a cursor nothing ever spends.
 */
export async function listBanners(db: Db): Promise<Banner[]> {
  const res = await db.execute(sql`
    SELECT ${BANNER_COLUMNS} FROM marketing_banners
     ORDER BY created_at DESC, id DESC`);
  return res.rows.map(rowToBanner);
}

export async function getBanner(db: Db, id: string): Promise<Banner | null> {
  const res = await db.execute(sql`
    SELECT ${BANNER_COLUMNS} FROM marketing_banners WHERE id = ${id}`);
  return res.rows[0] ? rowToBanner(res.rows[0]) : null;
}

/**
 * THE READ-TIME SCHEDULE, as a fragment (spec D8).
 *
 * A BUILDER RATHER THAN A QUERY, for two reasons that are both about honesty.
 * The public route below is one caller; `public.test.ts` is the other, and it
 * feeds the rows this predicate selects and the rows `deriveBannerStatus` calls
 * `'live'` to the same assertion — which is only possible if the predicate is a
 * value something else can hold.
 *
 * THE BOUNDARIES ARE THE SHARED FUNCTION'S, EXACTLY: `starts_at <= now` (a
 * banner scheduled for 09:00 is showing AT 09:00) and `ends_at > now` (the
 * window is half-open, so a back-to-back pair never both show, and neither
 * shows nothing). `<` for one and `<=` for the other in either half is a
 * one-millisecond disagreement that no manual test will ever see.
 *
 * `status = 'live'` COMES FIRST because it is the whole of the intent half:
 * archived and draft rows are invisible whatever their dates say, which is the
 * same precedence the shared function encodes by testing them before the clock.
 */
export function showingAt(now: number): SQL {
  return sql`status = 'live'
             AND (starts_at IS NULL OR starts_at <= ${now})
             AND (ends_at IS NULL OR ends_at > ${now})`;
}

/**
 * Contract #29 — what the storefront asks for, and the only query in this
 * subsystem an anonymous caller can reach.
 *
 * ORDERED `priority DESC, created_at DESC` per the contract, with the id as a
 * final tie-break: two banners created in the same millisecond at the same
 * priority would otherwise come back in whatever order the scan produced, and a
 * storefront that renders `banners[0]` would flicker between them across cache
 * fills.
 *
 * THE PLACEMENT FILTER IS OPTIONAL, because a page that renders three regions
 * fetches once and sorts them out itself, while a page that renders one asks for
 * one. Both are cached separately at the edge, which is why it is a query
 * parameter rather than something the client does after the fact.
 */
export async function listPublicBanners(
  db: Db,
  opts: { now: number; placement?: BannerPlacement },
): Promise<PublicBanner[]> {
  const placement = opts.placement
    ? sql` AND placement = ${opts.placement}`
    : sql``;

  const res = await db.execute(sql`
    SELECT id, title, body, cta_text, cta_url, placement, priority
      FROM marketing_banners
     WHERE ${showingAt(opts.now)}${placement}
     ORDER BY priority DESC, created_at DESC, id DESC`);

  return res.rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    body: String(row.body),
    ctaText: row.cta_text == null ? null : String(row.cta_text),
    ctaUrl: row.cta_url == null ? null : String(row.cta_url),
    placement: row.placement as BannerPlacement,
    priority: Number(row.priority),
  }));
}

// ------------------------------------------------------------------- writes

/**
 * Contract #22.
 *
 * `status` AND `revision` ARE ABSENT FROM THE COLUMN LIST ON PURPOSE — each
 * takes its column default. `status` is the sharp one: a create that could name
 * it would let a form publish to the storefront in one call, and the editor's
 * whole shape (write it, preview it, then flip the Switch) assumes it cannot.
 */
export async function createBanner(
  db: Db,
  draft: BannerDraft,
  opts: WriteOptions,
): Promise<Banner> {
  const ctaText = draft.ctaText ?? null;
  const ctaUrl = draft.ctaUrl ?? null;
  const startsAt = draft.startsAt ?? null;
  const endsAt = draft.endsAt ?? null;
  assertCoherent({ ctaText, ctaUrl, startsAt, endsAt });

  const id = newId(ID.banner);
  const res = await db.execute(sql`
    INSERT INTO marketing_banners
      (id, title, body, cta_text, cta_url, placement, starts_at, ends_at,
       priority, created_at, updated_at, created_by)
    VALUES (${id}, ${draft.title}, ${draft.body ?? ''}, ${ctaText}, ${ctaUrl},
            ${draft.placement}, ${startsAt}, ${endsAt}, ${draft.priority ?? 0},
            ${opts.now}, ${opts.now}, ${opts.actorId}::uuid)
    RETURNING ${BANNER_COLUMNS}`);
  return rowToBanner(res.rows[0]);
}

/**
 * The patchable columns, as a map from wire field to column name.
 *
 * THE COLUMN NAMES COME FROM HERE AND NEVER FROM THE REQUEST. The SET clause is
 * built by walking this table and asking whether the patch carries the key, so
 * the identifier that reaches SQL is a literal written in this file — the rule
 * `emitEvent` states for the one thing that cannot be a bound parameter. Every
 * VALUE still is one.
 *
 * `revision`, `createdAt` and `createdBy` are not in it. There is no way to
 * edit who made a banner or when, and the revision is the CAS token rather than
 * a field.
 */
const PATCHABLE = {
  title: 'title',
  body: 'body',
  ctaText: 'cta_text',
  ctaUrl: 'cta_url',
  placement: 'placement',
  status: 'status',
  startsAt: 'starts_at',
  endsAt: 'ends_at',
  priority: 'priority',
} as const satisfies Record<keyof BannerPatch, string>;

/**
 * Contract #23 — CAS, and the archive action too.
 *
 * ARCHIVING IS `status: 'archived'` THROUGH THIS ROUTE, not a DELETE anywhere.
 * The row is what the shop said in public, and the public predicate above stops
 * selecting it the moment the status moves — so "take it down" and "take it
 * down and keep the record" are the same write.
 *
 * THE `WHERE revision = $expected` IS THE ONLY AUTHORITY ON WHO WON. The read
 * above it exists to answer 404 and to know the stored halves of the two merged
 * rules; it never decides whether the write may proceed, because a precondition
 * judged in TypeScript is judged against a row that has already been read —
 * exactly the stale value a CAS exists to distrust (`programs/repo.ts` and
 * `server/shop/catalog/products.ts` both measured what that costs).
 */
export async function patchBanner(
  db: Db,
  id: string,
  patch: BannerPatch,
  opts: WriteOptions & { expectedRevision: number },
): Promise<Banner> {
  const current = await getBanner(db, id);
  if (!current) throw new NotFoundError(id);

  assertCoherent({
    ctaText: merge(patch.ctaText, current.ctaText),
    ctaUrl: merge(patch.ctaUrl, current.ctaUrl),
    startsAt: merge(patch.startsAt, current.startsAt),
    endsAt: merge(patch.endsAt, current.endsAt),
  });

  /*
   * `!== undefined`, NEVER a truthiness test: `null` clears a field, `0` is a
   * legal priority and `''` is a legal body. A filter written as
   * `patch[field] ? …` would silently drop all three — the body it dropped
   * being the one an admin had just emptied on purpose.
   *
   * The revision and the clock are appended rather than conditional, so a PATCH
   * carrying only `expectedRevision` still bumps both. It is a touch rather than
   * a no-op, and treating it as one would hand the caller a 200 that did not
   * invalidate the token it just spent.
   */
  const assignments: SQL[] = (Object.keys(PATCHABLE) as (keyof BannerPatch)[])
    .filter((field) => patch[field] !== undefined)
    .map((field) => sql`${sql.raw(PATCHABLE[field])} = ${patch[field]}`);
  assignments.push(sql`revision = revision + 1`, sql`updated_at = ${opts.now}`);

  const res = await db.execute(sql`
    UPDATE marketing_banners
       SET ${sql.join(assignments, sql`, `)}
     WHERE id = ${id} AND revision = ${opts.expectedRevision}
    RETURNING ${BANNER_COLUMNS}`);

  /*
   * `rows.length`, never `affectedRows` — measured to be 0 even on a winning
   * CAS (`server/repo/posts.ts`). The row is re-read rather than reported from
   * the copy above, because the whole value of this 409 to the client is that it
   * carries the row that WON: spec D7's conflict notice renders "Load theirs"
   * straight out of the payload instead of spending a second round trip to
   * discover a third state.
   */
  if (res.rows.length === 0) {
    const actual = await getBanner(db, id);
    if (!actual) throw new NotFoundError(id);
    throw new StaleMarketingWriteError(
      opts.expectedRevision,
      actual.revision,
      'banner',
      actual,
    );
  }

  return rowToBanner(res.rows[0]);
}
