import { sql } from 'drizzle-orm';
import { toEpochMs, toEpochMsOrNull, uniqueViolation } from '../../db/client';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import {
  AreaInUseError,
  DuplicateAreaError,
  OutsideServiceAreaError,
  StaleMarketingWriteError,
} from '../errors';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';

/**
 * Service areas — the places a van goes, and the reason the rewards programme is
 * honest about where it works.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AN ADDRESS BECOMES AN AREA BY BEING CHOSEN, NEVER BY BEING PARSED.
 *
 * There is no geocoding here and there must not be. Turning a street line into a
 * district needs a geocoder, a budget and an answer for when it is wrong — and
 * being told you are outside the served set because a parser did not recognise
 * your own street is the worst failure this feature has. A picker is honest,
 * instant, and the person choosing already knows the answer.
 *
 * What `resolveArea` does instead is FORGIVE SPELLING. The picker sends an id;
 * anything else that arrives — a key, a name, one of the aliases people actually
 * type — resolves too, because the alternative is refusing a customer for
 * writing their neighbourhood the way they have always written it.
 *
 * NOTHING IN THIS SUBSYSTEM NAMES THE CITY THAT IS SERVED TODAY. The served set
 * is a row-level flag an owner edits; code that matched on a place would be
 * wrong the first time a district was switched off, and both grep guards fail on
 * it. Every sentence a customer reads about where we collect is rendered from
 * `servedNames()`.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Contract §6.1 — an area, and the four numbers the switcher draws it with. */
export interface ServiceArea {
  id: string;
  key: string;
  region: string;
  name: string;
  active: boolean;
  /** Came from the shipped dataset rather than from a person. A rename keeps it
   *  true — it never meant "unedited". */
  seeded: boolean;
  revision: number;
  /** `requested + received` in this area — the badge. The two stages where the
   *  ADMIN is the blocker, exactly as the queue's own `needsAction` counts. */
  needsAction: number;
  /** All four open stages. */
  open: number;
  /** Σ `qtyDeclared` across the open ones — the van-capacity number, which is
   *  what decides whether one vehicle is enough for a district today. */
  loadUnits: number;
  /** How long the oldest OPEN return here has been waiting, or null when nothing
   *  is. Scoped to the open set like `open` and `loadUnits` beside it: an area
   *  whose only old return was awarded last month is not an area with a problem. */
  oldestAgeMs: number | null;
  /**
   * WHAT A PICKUP FROM THIS DISTRICT NORMALLY COSTS, minor units, per line
   * (0920). NULL means "no standard for that line here", never zero.
   *
   * SHOWN AS A PLACEHOLDER AND NEVER PRE-FILLED into the return's form, which
   * is the whole reason the fallback is a read rather than a copy: a figure
   * saved onto a return because somebody accepted a default is
   * indistinguishable from one they measured, and the analytics screen would
   * lose the only thing that lets it say how much of its headline is
   * estimated.
   */
  stdTransportMinor: number | null;
  stdLocalMinor: number | null;
  stdDriverMinor: number | null;
  stdFeesMinor: number | null;
}

export interface AreasView {
  areas: ServiceArea[];
  /**
   * The switcher's red footer — returns that belong to no board.
   *
   * NOT AN AREA WITH A NULL ID, because it is not a place: it is the absence of
   * one. Given a row in `areas` it would sort somewhere among the districts and
   * would be switchable to, which is precisely the claim the design refuses to
   * make. It carries no `loadUnits` either — capacity is a question about a van,
   * and no van is going.
   */
  outOfArea: { needsAction: number; open: number };
}

/** The four statuses a return is still in flight in — the same four the
 *  one-open-return index uses, and the same definition `programs/repo.ts`
 *  writes out for `openReturns`. */
const OPEN_STATUSES = ['requested', 'scheduled', 'collected', 'received'] as const;

/** The two the ADMIN is the blocker on. Scheduled and collected are waiting on a
 *  driver, not on anybody at a desk. */
const NEEDS_ACTION_STATUSES = ['requested', 'received'] as const;

const AREA_COLUMNS = sql.raw(
  `id, key, region, name, aliases, active, seeded, sort_order,
   std_transport_minor, std_local_minor, std_driver_minor, std_fees_minor,
   revision, created_at, updated_at`,
);

/** The row as the API carries it, minus the counts a join supplies. */
export interface AreaRow {
  id: string;
  key: string;
  region: string;
  name: string;
  aliases: string[];
  active: boolean;
  seeded: boolean;
  sortOrder: number;
  /**
   * WHAT A PICKUP FROM THIS DISTRICT NORMALLY COSTS, minor units, per line
   * (0920). NULL means "no standard for that line here", never zero.
   *
   * SHOWN AS A PLACEHOLDER AND NEVER PRE-FILLED into the return's form, which
   * is the whole reason the fallback is a read rather than a copy: a figure
   * saved onto a return because somebody accepted a default is
   * indistinguishable from one they measured, and the analytics screen would
   * lose the only thing that lets it say how much of its headline is
   * estimated.
   */
  stdTransportMinor: number | null;
  stdLocalMinor: number | null;
  stdDriverMinor: number | null;
  stdFeesMinor: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** The four standards off any row shape that carries them, as numbers or
 *  nulls. Written once because three readers need it and each `Number(x)` on a
 *  NULL is a silent `0` — which would turn "no standard here" into "this
 *  district is free", the one wrong answer that looks plausible. */
function stdCosts(row: Record<string, unknown>) {
  const at = (key: string): number | null => (row[key] == null ? null : Number(row[key]));
  return {
    stdTransportMinor: at('std_transport_minor'),
    stdLocalMinor: at('std_local_minor'),
    stdDriverMinor: at('std_driver_minor'),
    stdFeesMinor: at('std_fees_minor'),
  };
}

function rowToArea(row: Record<string, unknown>): AreaRow {
  return {
    id: String(row.id),
    key: String(row.key),
    region: String(row.region),
    name: String(row.name),
    // `text[]` arrives as a JS array from both drivers; the CHECK guarantees no
    // NULL elements, so the cast is total.
    aliases: (row.aliases ?? []) as string[],
    active: row.active === true,
    seeded: row.seeded === true,
    sortOrder: Number(row.sort_order),
    ...stdCosts(row),
    revision: Number(row.revision),
    createdAt: toEpochMs(row.created_at),
    updatedAt: toEpochMs(row.updated_at),
  };
}

function statusIn(statuses: readonly string[]): SQL {
  return sql`status IN (${sql.join(
    statuses.map((status) => sql`${status}`),
    sql`, `,
  )})`;
}

/**
 * The counts, per area, in ONE grouped pass over the open returns.
 *
 * A SUBQUERY JOINED TO THE AREAS RATHER THAN FOUR CORRELATED SUB-SELECTS. There
 * are ~800 areas and the correlated form would run four scans per row; this runs
 * one over the open set, which is small by construction — the whole point of the
 * queue is that it gets emptied.
 *
 * LEFT JOINED, so an area with nothing waiting is still LISTED. That is the
 * design decision, not an implementation detail: hiding an idle district would
 * read as "we do not serve there", which is a different and much worse claim
 * than "nothing is waiting there today".
 */
const areaCounts = sql`
  SELECT service_area_id,
         count(*) FILTER (WHERE ${statusIn(NEEDS_ACTION_STATUSES)})::int AS needs_action,
         count(*)::int AS open_count,
         COALESCE(sum(qty_declared), 0)::int AS load_units,
         min(created_at) AS oldest_at
    FROM marketing_return_requests
   WHERE ${statusIn(OPEN_STATUSES)}
   GROUP BY service_area_id`;

export interface AreasQuery {
  /** `?active=true` — what the board switcher asks for. The Areas screen asks
   *  for everything and groups by region itself. */
  activeOnly?: boolean;
  /** One clock reading, passed in, so every `oldestAgeMs` in one response is
   *  measured from the same instant. */
  now: number;
}

/** Contract #6.1 — the switcher's rows and its footer. */
export async function listAreas(db: Db, q: AreasQuery): Promise<AreasView> {
  const res = await db.execute(sql`
    SELECT a.id, a.key, a.region, a.name, a.active, a.seeded, a.revision,
           a.std_transport_minor, a.std_local_minor, a.std_driver_minor, a.std_fees_minor,
           COALESCE(c.needs_action, 0) AS needs_action,
           COALESCE(c.open_count, 0) AS open_count,
           COALESCE(c.load_units, 0) AS load_units,
           c.oldest_at
      FROM marketing_service_areas a
      LEFT JOIN (${areaCounts}) c ON c.service_area_id = a.id
     WHERE ${q.activeOnly === true ? sql`a.active` : sql`true`}
     ORDER BY a.region ASC, a.sort_order ASC, a.id ASC`);

  const areas = res.rows.map((row) => {
    const oldestAt = toEpochMsOrNull(row.oldest_at);
    return {
      id: String(row.id),
      key: String(row.key),
      region: String(row.region),
      name: String(row.name),
      active: row.active === true,
      seeded: row.seeded === true,
      revision: Number(row.revision),
      ...stdCosts(row),
      needsAction: Number(row.needs_action),
      open: Number(row.open_count),
      loadUnits: Number(row.load_units),
      /* Clamped at zero rather than allowed to go negative. A row created a
       * millisecond into the future — two machines' clocks, an imported
       * timestamp — would otherwise render as a negative age, which every
       * duration formatter in the client turns into nonsense. */
      oldestAgeMs: oldestAt === null ? null : Math.max(0, q.now - oldestAt),
    };
  });

  /*
   * THE FOOTER IS ITS OWN READ, because `LEFT JOIN … ON c.service_area_id = a.id`
   * cannot produce it: the out-of-area group has no area row to hang off, which
   * is the whole reason it is a footer and not a district.
   */
  const orphans = await db.execute(sql`
    SELECT count(*) FILTER (WHERE ${statusIn(NEEDS_ACTION_STATUSES)})::int AS needs_action,
           count(*)::int AS open_count
      FROM marketing_return_requests
     WHERE service_area_id IS NULL AND ${statusIn(OPEN_STATUSES)}`);

  return {
    areas,
    outOfArea: {
      needsAction: Number(orphans.rows[0]?.needs_action ?? 0),
      open: Number(orphans.rows[0]?.open_count ?? 0),
    },
  };
}

/**
 * The names of the places we collect from, for the refusal that has to name
 * them.
 *
 * THE 409 CARRIES THIS RATHER THAN THE CLIENT KNOWING IT. A customer told "we do
 * not collect there" and nothing else has been given a dead end; told "we
 * collect in these, try another address" they have something to do. And it must
 * come from the database on every refusal, because an owner switching a district
 * off at 9am must change the sentence at 9am.
 */
export async function servedNames(db: Db): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT name FROM marketing_service_areas
     WHERE active
     ORDER BY region ASC, sort_order ASC, id ASC`);
  return res.rows.map((row) => String(row.name));
}

/** The public projection — what a shopper's district Select is built from.
 *
 *  NOT `servedNames` WITH MORE COLUMNS. That one answers the OutsideServiceArea
 *  error's "here are the places that work", which is prose; this one answers a
 *  form control, which needs the id to submit and the region to group by. They
 *  drift apart the moment either grows a filter, so they are two functions. */
export interface PublicArea {
  id: string;
  region: string;
  name: string;
  /** The stable handle a rename does not move — what checkout's
   *  `shop_addresses.district` stores and `shop_delivery_areas` prices by.
   *  The id would also survive a rename, but the key is what the delivery
   *  table already joins on, so the picker submits it. */
  key: string;
}

export async function publicAreas(db: Db): Promise<PublicArea[]> {
  const res = await db.execute(sql`
    SELECT id, region, name, key FROM marketing_service_areas
     WHERE active
     ORDER BY region ASC, sort_order ASC, id ASC`);
  return res.rows.map((row) => ({
    id: String(row.id),
    region: String(row.region),
    name: String(row.name),
    key: String(row.key),
  }));
}

/**
 * Fold a token the way a person types it: case and punctuation out, letters and
 * digits left.
 *
 * `wuse 2`, `Wuse II`, `wuse-2` and `WUSE2` are four spellings of one place, and
 * three of them are what a customer actually writes. Applied to BOTH sides — the
 * stored name and alias, and the incoming token — so nothing depends on the
 * dataset having been punctuated the way the customer punctuates.
 */
const folded = (value: SQL | string): SQL =>
  sql`regexp_replace(lower(${value}), '[^a-z0-9]+', '', 'g')`;

/**
 * The area a token names, or null.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUR WAYS IN, AND THE TIE-BREAK IS "SERVED FIRST".
 *
 * The id and the key are unique by index, so they cannot be ambiguous. A folded
 * NAME can be: place names repeat across states, and three of the served
 * districts share a name with an LGA somewhere else. `ORDER BY active DESC` is
 * what settles those — and it settles them correctly, because only a served area
 * could have accepted the return anyway.
 *
 * `sort_order, id` finish the ordering so the answer is DETERMINISTIC rather
 * than whatever the planner returned first. Two ACTIVE areas folding together
 * would be a genuine ambiguity, and `scripts/gen-service-areas.ts` refuses to
 * generate a seed containing one.
 *
 * IT RESOLVES INACTIVE ROWS TOO, deliberately. The caller needs to tell "there
 * is no such place" from "we do not go there yet" — both refuse the return, but
 * only one of them is a place the owner can switch on this afternoon.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function resolveArea(db: Db, token: string): Promise<AreaRow | null> {
  const trimmed = token.trim();
  if (trimmed === '') return null;
  const lowered = trimmed.toLowerCase();

  const res = await db.execute(sql`
    SELECT ${AREA_COLUMNS}
      FROM marketing_service_areas
     WHERE id = ${trimmed}
        OR key = ${lowered}
        OR ${folded(sql`name`)} = ${folded(sql`${trimmed}`)}
        OR EXISTS (SELECT 1 FROM unnest(aliases) alias
                    WHERE ${folded(sql`alias`)} = ${folded(sql`${trimmed}`)})
     ORDER BY active DESC, sort_order ASC, id ASC
     LIMIT 1`);

  const row = res.rows[0];
  return row ? rowToArea(row) : null;
}

/**
 * Resolve a token to a SERVED area, or refuse with the list of places we do
 * serve.
 *
 * ONE ERROR FOR THREE CONDITIONS — absent, unknown, and known-but-not-served —
 * because they are one answer to the person reading it: "not here, but here are
 * the places that work". Telling a customer that their district EXISTS in our
 * database but is switched off is an internal detail dressed up as help.
 */
export async function requireServedArea(db: Db, token: string): Promise<AreaRow> {
  const area = await resolveArea(db, token);
  if (!area || !area.active) throw new OutsideServiceAreaError(await servedNames(db));
  return area;
}

// -------------------------------------------------------------------- writing

export interface AreaDraft {
  region: string;
  name: string;
  aliases?: string[];
}

/** Contract #6.1b's PATCH body minus `expectedRevision`. NOTE WHAT IS ABSENT:
 *  `key` and `seeded`. The key is the stable handle and `seeded` is a statement
 *  about where a row came from — neither is a thing an edit may rewrite. */
export interface AreaPatch {
  name?: string;
  aliases?: string[];
  active?: boolean;
  sortOrder?: number;
  /**
   * The district's standard pickup cost, per line (0920). `null` CLEARS one —
   * back to "we have no standard here", which is a different claim from "it is
   * free" and the only way to unset a figure typed by mistake.
   */
  stdTransportMinor?: number | null;
  stdLocalMinor?: number | null;
  stdDriverMinor?: number | null;
  stdFeesMinor?: number | null;
}

export interface AreaWriteOptions {
  now: number;
}

const AREA_NAME_UQ = 'marketing_service_areas_region_name_uq';
const AREA_KEY_UQ = 'marketing_service_areas_key_uq';

/** `marketing_service_areas_key_ck`, in TypeScript — the same slug the seed
 *  generator derives, so a hand-added area and a shipped one are named the same
 *  way. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function getArea(db: Db, id: string): Promise<AreaRow | null> {
  const res = await db.execute(sql`
    SELECT ${AREA_COLUMNS} FROM marketing_service_areas WHERE id = ${id}`);
  const row = res.rows[0];
  return row ? rowToArea(row) : null;
}

/** `ARRAY['a','b']` — drizzle binds a JS array as one value the driver cannot
 *  cast to `text[]`, and a hand-built `'{…}'` literal would need its own
 *  quoting rules for the aliases that contain a space. */
function textArray(values: readonly string[]): SQL {
  if (values.length === 0) return sql`'{}'::text[]`;
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * Aliases as the column will hold them: trimmed, lower-cased, de-duplicated, and
 * never a second copy of the area's own name.
 *
 * NORMALISED HERE RATHER THAN REFUSED. An owner typing "Wuse 2" into an alias
 * box has said something correct and useful; answering with a validation error
 * about capital letters would be pedantry, and the CHECK that forbids it exists
 * to stop dead data reaching the column, not to lecture. A duplicate is dropped
 * for the same reason.
 */
function normaliseAliases(aliases: readonly string[], name: string): string[] {
  const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const nameAt = fold(name);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of aliases) {
    const alias = raw.trim().toLowerCase();
    const at = fold(alias);
    /* An alias that folds onto the name is a match that already works — the
     * resolver folds `name` too — so storing it is a second copy of one answer. */
    if (at === '' || at === nameAt || seen.has(at)) continue;
    seen.add(at);
    out.push(alias);
  }
  return out;
}

/**
 * Contract #6.1b — an area an owner typed, because the shipped dataset is a
 * starting point and not an authority.
 *
 * `seeded` IS NOT SET, so it takes its `false` default: this row came from a
 * person. `active` is not set either, and that default is `false` — a new area
 * is switched on deliberately, by the same Switch every other area uses, rather
 * than being live the instant somebody finishes typing its name.
 */
export async function createArea(
  db: Db,
  draft: AreaDraft,
  opts: AreaWriteOptions,
): Promise<AreaRow> {
  const region = draft.region.trim();
  const name = draft.name.trim();
  if (region === '') throw new BadRequestError('region');
  if (name === '') throw new BadRequestError('name');

  const base = `${slug(region)}-${slug(name)}`;
  if (base === '' || !/^[a-z0-9][a-z0-9_-]*$/.test(base)) throw new BadRequestError('name');

  const id = `area_${base.replace(/-/g, '_')}`;
  const aliases = normaliseAliases(draft.aliases ?? [], name);

  try {
    const res = await db.execute(sql`
      INSERT INTO marketing_service_areas
        (id, key, region, name, aliases, sort_order, created_at, updated_at)
      VALUES (${id}, ${base}, ${region}, ${name}, ${textArray(aliases)},
              /* Sorted to the END of its region rather than to 0, so a new area
               * does not silently jump the shipped list's order. */
              (SELECT COALESCE(max(sort_order) + 1, 0) FROM marketing_service_areas
                WHERE region = ${region}),
              ${opts.now}, ${opts.now})
      RETURNING ${AREA_COLUMNS}`);
    return rowToArea(res.rows[0]);
  } catch (err) {
    /*
     * BOTH UNIQUES MEAN THE SAME THING TO A PERSON. The key is derived from the
     * region and the name, so a key collision IS a name collision — reported
     * under a different index only because two rows can slug alike while their
     * names differ in punctuation ("Ado-Odo/Ota" and "Ado Odo Ota"). One code,
     * one inline field error, because "that area already exists" is the true
     * sentence in both cases.
     */
    const violated = uniqueViolation(err);
    if (violated === AREA_NAME_UQ || violated === AREA_KEY_UQ) {
      throw new DuplicateAreaError(region, name);
    }
    throw err;
  }
}

/** The columns a PATCH may write, and the column each maps to. `key` and
 *  `seeded` are absent BY CONSTRUCTION — this object is the SET clause. */
const PATCHABLE: Record<keyof AreaPatch, string> = {
  name: 'name',
  aliases: 'aliases',
  active: 'active',
  sortOrder: 'sort_order',
  stdTransportMinor: 'std_transport_minor',
  stdLocalMinor: 'std_local_minor',
  stdDriverMinor: 'std_driver_minor',
  stdFeesMinor: 'std_fees_minor',
};

/** The four money fields, so the assignment loop can cast their NULLs. A bound
 *  `null` in a SET has no target column to infer from and is SQLSTATE 42P18 at
 *  run time rather than at build time. */
const MONEY_FIELDS = new Set<keyof AreaPatch>([
  'stdTransportMinor',
  'stdLocalMinor',
  'stdDriverMinor',
  'stdFeesMinor',
]);

/**
 * Contract #6.1b — rename, re-alias, reorder, and the Switch that decides where
 * vans go.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RENAMING A SEEDED AREA IS ALLOWED AND CLEARS NOTHING.
 *
 * The shipped dataset misspells real places. An owner must be able to correct
 * one without a developer, and `seeded` must survive the correction: it only
 * ever meant "this row was not typed by a person", so clearing it on a rename
 * would make the Areas screen call a shipped row hand-made the moment somebody
 * fixed its spelling.
 *
 * SWITCHING OFF AN AREA THAT STILL HOLDS OPEN RETURNS IS REFUSED, and the
 * refusal carries the count. A van that stops running does not make its pickups
 * disappear — the returns would fall off every board and land in the out-of-area
 * footer, unrewardable, with nothing on screen to say why. The UI moves them
 * first. Switching one ON is never refused: there is nothing to strand.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function patchArea(
  db: Db,
  id: string,
  patch: AreaPatch,
  opts: AreaWriteOptions & { expectedRevision: number },
): Promise<AreaRow> {
  const current = await getArea(db, id);
  if (!current) throw new NotFoundError(id);

  if (patch.active === false && current.active) {
    const res = await db.execute(sql`
      SELECT count(*)::int AS n FROM marketing_return_requests
       WHERE service_area_id = ${id} AND ${statusIn(OPEN_STATUSES)}`);
    const open = Number(res.rows[0]?.n ?? 0);
    /*
     * READ-THEN-DECIDE, and it does not need to be a CAS. The race it cannot
     * close — a return logged into this area in the same millisecond — is closed
     * one layer down instead: the intake's INSERT selects the area `WHERE
     * active`, so once this write lands no further return can join it. What is
     * left is a return that arrived a moment BEFORE the switch, which lands in
     * the footer and is exactly what the count would have warned about.
     */
    if (open > 0) throw new AreaInUseError(open);
  }

  const name = patch.name?.trim();
  if (patch.name !== undefined && name === '') throw new BadRequestError('name');

  const assignments: SQL[] = [];
  for (const field of Object.keys(PATCHABLE) as (keyof AreaPatch)[]) {
    if (patch[field] === undefined) continue;
    const column = sql.raw(PATCHABLE[field]);
    if (field === 'aliases') {
      assignments.push(
        sql`${column} = ${textArray(normaliseAliases(patch.aliases ?? [], name ?? current.name))}`,
      );
    } else if (field === 'name') {
      assignments.push(sql`${column} = ${name}`);
    } else if (MONEY_FIELDS.has(field)) {
      assignments.push(sql`${column} = ${patch[field]}::integer`);
    } else {
      assignments.push(sql`${column} = ${patch[field]}`);
    }
  }
  assignments.push(sql`revision = revision + 1`, sql`updated_at = ${opts.now}`);

  try {
    const res = await db.execute(sql`
      UPDATE marketing_service_areas
         SET ${sql.join(assignments, sql`, `)}
       WHERE id = ${id} AND revision = ${opts.expectedRevision}
      RETURNING ${AREA_COLUMNS}`);

    /* `rows.length`, never `affectedRows` — measured to be 0 even on a winning
     * CAS (`server/repo/posts.ts`). */
    if (res.rows.length === 0) {
      const actual = await getArea(db, id);
      if (!actual) throw new NotFoundError(id);
      throw new StaleMarketingWriteError(opts.expectedRevision, actual.revision, 'area', actual);
    }
    return rowToArea(res.rows[0]);
  } catch (err) {
    if (uniqueViolation(err) === AREA_NAME_UQ) {
      throw new DuplicateAreaError(current.region, name ?? current.name);
    }
    throw err;
  }
}
