import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { toEpochMs } from '../../db/client';
import { NotFoundError, StaleWriteError } from '../../repo/errors';
import { LID, newLogisticsId } from './ids';
import type { Packaging, ProviderId, ShipFrom } from './port';

/**
 * The courier configuration — one row, `id = 'main'` (migration 0960) — and the
 * log of every inbound courier webhook.
 *
 * `provider` IS THE FEATURE FLAG. One column holding one of `manual | fez |
 * terminal`, so two couriers cannot be switched on at once by construction
 * rather than by a rule somebody remembers. Everything downstream reads this
 * row and nothing else decides which courier a parcel is booked with.
 *
 * FOLLOWS `shop/settings/repo.ts` TO THE LETTER: plain `sql` templates over
 * hand-written DDL, NEVER `db.transaction` (the Neon HTTP driver throws on it
 * unconditionally while PGlite supports it — a transaction passes every test
 * here and 500s in production), one guarded statement rather than
 * read-compare-write, and an explicit cast on every bind that can be NULL
 * inside a `CASE` or Postgres refuses the whole statement with `42P18`.
 */

/**
 * The singleton's key, pinned by `shop_logistics_settings_id_ck`.
 *
 * A CHECK-CONSTRAINED CONSTANT rather than one row by convention: "there is
 * exactly one courier configuration" is then something the database enforces,
 * so a second row cannot appear and leave two answers to "which courier is
 * switched on" for whichever happened to sort first.
 */
const SETTINGS_ID = 'main';

/** `manual` is not a provider — it is the absence of one, spelled explicitly. */
export type ProviderSetting = ProviderId | 'manual';

export interface LogisticsSettings {
  provider: ProviderSetting;
  shipFrom: ShipFrom | null;
  packaging: Packaging;
  /** Terminal's `PA-…` record for the box below, created lazily on a quote. */
  terminalPackagingId: string | null;
  revision: number;
  updatedAt: number;
}

/**
 * THE SAME BOX MIGRATION 0960 SEEDS INTO THE COLUMN DEFAULT.
 *
 * Written down here as well as in the DDL because it is also the FLOOR every
 * read is spread over: a row hand-edited to `{}` — or one written by a future
 * migration that adds a dimension — still yields a complete `Packaging` rather
 * than a quote request with `NaN` centimetres in it. Change one and change the
 * other; `repo.test.ts` reads the seeded row and compares it against this.
 */
export const DEFAULT_PACKAGING: Packaging = {
  name: 'Spool box',
  lengthCm: 22,
  widthCm: 22,
  heightCm: 8,
  weightKg: 0.25,
};

const COLUMNS = sql`provider, ship_from, packaging, terminal_packaging_id, revision, updated_at`;

/**
 * jsonb arrives parsed from both drivers today. The string branch is the cheap
 * insurance a driver upgrade would otherwise turn into a run-time surprise —
 * the same defensive read `frozen totals` needed twice.
 */
const asJson = <T>(value: unknown): T =>
  (typeof value === 'string' ? (JSON.parse(value) as T) : (value as T));

function rowToSettings(row: Record<string, unknown>): LogisticsSettings {
  const packaging =
    row.packaging == null ? DEFAULT_PACKAGING : asJson<Partial<Packaging>>(row.packaging);
  return {
    // The CHECK constrains this to the three values; a cast is honest here.
    provider: String(row.provider) as ProviderSetting,
    shipFrom: row.ship_from == null ? null : asJson<ShipFrom>(row.ship_from),
    packaging: { ...DEFAULT_PACKAGING, ...packaging },
    terminalPackagingId:
      row.terminal_packaging_id == null ? null : String(row.terminal_packaging_id),
    // `integer`, which PGlite and Neon agree about. `updated_at` is the int8.
    revision: Number(row.revision),
    updatedAt: toEpochMs(row.updated_at),
  };
}

// ---------------------------------------------------------------------- read

/**
 * The whole row.
 *
 * THROWS RATHER THAN ANSWERING A DEFAULT, unlike `getDeliverySettings`. That row
 * is read on the money path and a checkout that 500s over a missing
 * configuration is worse than one that behaves like last week; this one is read
 * by a settings screen and by the booking path, and inventing `manual` for a
 * shop that has Fez switched on would silently stop booking couriers with
 * nothing anywhere saying so.
 */
export async function getLogisticsSettings(db: Db): Promise<LogisticsSettings> {
  const res = await db.execute(sql`
    SELECT ${COLUMNS} FROM shop_logistics_settings WHERE id = ${SETTINGS_ID}`);
  const row = res.rows[0];
  if (row === undefined) throw new NotFoundError('logistics_settings');
  return rowToSettings(row as Record<string, unknown>);
}

// --------------------------------------------------------------------- write

export interface LogisticsSettingsPatch {
  provider?: ProviderSetting;
  /**
   * `undefined` LEAVES IT ALONE; an explicit `null` CLEARS it. The two cannot be
   * collapsed, which is why the statement below uses `CASE WHEN <given>` rather
   * than `COALESCE` — `COALESCE` cannot tell "do not change" from "set to null".
   */
  shipFrom?: ShipFrom | null;
  packaging?: Packaging;
}

export interface LogisticsWriteOptions {
  expectedRevision: number;
  actorId: string;
  now: number;
}

/**
 * Write the row, compare-and-swap on `expectedRevision`.
 *
 * ONE STATEMENT, NO TRANSACTION AND NO PRIOR READ. The `WHERE … AND revision =`
 * makes read-compare-write atomic in the database, so two settings tabs cannot
 * quietly overwrite each other's courier choice. Zero rows back means exactly
 * one of two things and the follow-up SELECT only says which.
 *
 * A PACKAGING CHANGE DROPS THE CACHED TERMINAL PACKAGING ID, and it is decided
 * by the database rather than by the caller: the comparison is old-versus-new
 * inside the same UPDATE (a SET expression reads the row's pre-update values),
 * so saving the same box twice keeps the record Terminal already holds while
 * genuinely resizing it forces the next quote to create a new one. A caller
 * deciding this would be a caller who can forget to.
 */
export async function patchLogisticsSettings(
  db: Db,
  patch: LogisticsSettingsPatch,
  opts: LogisticsWriteOptions,
): Promise<LogisticsSettings> {
  const providerGiven = patch.provider !== undefined;
  const fromGiven = patch.shipFrom !== undefined;
  const packGiven = patch.packaging !== undefined;

  const shipFromJson = patch.shipFrom == null ? null : JSON.stringify(patch.shipFrom);
  const packagingJson = packGiven ? JSON.stringify(patch.packaging) : null;

  const res = await db.execute(sql`
    UPDATE shop_logistics_settings SET
      provider = CASE WHEN ${providerGiven}
                      THEN ${patch.provider ?? null}::text
                      ELSE provider END,
      ship_from = CASE WHEN ${fromGiven}
                       THEN ${shipFromJson}::jsonb
                       ELSE ship_from END,
      packaging = CASE WHEN ${packGiven}
                       THEN ${packagingJson}::jsonb
                       ELSE packaging END,
      -- packaging on the right reads the PRE-update box, so this is old vs new
      terminal_packaging_id = CASE WHEN ${packGiven}
                                    AND packaging IS DISTINCT FROM ${packagingJson}::jsonb
                                   THEN NULL
                                   ELSE terminal_packaging_id END,
      revision = revision + 1,
      updated_at = ${opts.now},
      updated_by = ${opts.actorId}::uuid
    WHERE id = ${SETTINGS_ID} AND revision = ${opts.expectedRevision}
    RETURNING ${COLUMNS}`);

  const written = res.rows[0];
  if (written !== undefined) return rowToSettings(written as Record<string, unknown>);

  /* The update matched nothing: either the row is gone — which no route can do
   * and which the settings screen must be told about plainly — or somebody
   * saved first, which is a 409 carrying the revision to re-read. */
  const current = await db.execute(sql`
    SELECT revision FROM shop_logistics_settings WHERE id = ${SETTINGS_ID}`);
  const row = current.rows[0];
  if (row === undefined) throw new NotFoundError('logistics_settings');
  throw new StaleWriteError(opts.expectedRevision, Number(row.revision ?? 0));
}

/**
 * Cache Terminal's packaging record, or drop it.
 *
 * NO CAS AND NO REVISION BUMP, deliberately. This is a value the adapter learns
 * from Terminal during a quote, not an edit an operator made — bumping the
 * revision would invalidate an open settings tab because a customer happened to
 * ask for a delivery price, and taking `expectedRevision` would make the quote
 * path fail over a race that costs nothing.
 */
export async function setTerminalPackagingId(db: Db, id: string | null): Promise<void> {
  await db.execute(sql`
    UPDATE shop_logistics_settings
       SET terminal_packaging_id = ${id}::text
     WHERE id = ${SETTINGS_ID}`);
}

// ------------------------------------------------------------ the webhook log

export type WebhookApplied = 'applied' | 'ignored' | 'unmatched' | 'rejected';

export interface WebhookRow {
  id: string;
  provider: ProviderId;
  providerRef: string | null;
  rawStatus: string | null;
  verified: boolean;
  applied: WebhookApplied;
  receivedAt: number;
}

/**
 * 16 KB, and the payload is REPLACED rather than sliced when it is bigger.
 *
 * A truncated JSON document is not JSON, so storing the first 16 KB of one would
 * put a value in a `jsonb` column that cannot be parsed — and the column is NOT
 * NULL, so the insert would simply fail and the delivery would go unrecorded.
 * The marker keeps the row, which is the whole point of the log: it answers
 * "does this courier's traffic reach us at all".
 */
const MAX_PAYLOAD = 16 * 1024;

export async function logWebhook(
  db: Db,
  row: {
    provider: ProviderId;
    providerRef: string | null;
    rawStatus: string | null;
    verified: boolean;
    applied: WebhookApplied;
    payload: unknown;
    now: number;
  },
): Promise<void> {
  let payload = JSON.stringify(row.payload ?? null);
  const bytes = Buffer.byteLength(payload);
  if (bytes > MAX_PAYLOAD) payload = JSON.stringify({ truncated: true, bytes });

  await db.execute(sql`
    INSERT INTO shop_logistics_webhooks
      (id, provider, provider_ref, raw_status, verified, applied, payload, received_at)
    VALUES (
      ${newLogisticsId(LID.webhook)}, ${row.provider}, ${row.providerRef}::text,
      ${row.rawStatus}::text, ${row.verified}, ${row.applied}, ${payload}::jsonb, ${row.now})`);
}

/**
 * The most recent deliveries, newest first. **The payload is not returned.**
 *
 * The settings screen shows that a courier is calling and how each call was
 * judged; the bodies are diagnostic and can carry a customer's address, so they
 * stay in the table rather than riding out on an admin read.
 */
export async function listRecentWebhooks(db: Db, limit = 10): Promise<WebhookRow[]> {
  const res = await db.execute(sql`
    SELECT id, provider, provider_ref, raw_status, verified, applied, received_at
      FROM shop_logistics_webhooks
     ORDER BY received_at DESC, id DESC
     LIMIT ${limit}`);

  return res.rows.map((r) => ({
    id: String(r.id),
    provider: r.provider as ProviderId,
    providerRef: r.provider_ref == null ? null : String(r.provider_ref),
    rawStatus: r.raw_status == null ? null : String(r.raw_status),
    verified: r.verified === true,
    applied: r.applied as WebhookApplied,
    receivedAt: toEpochMs(r.received_at),
  }));
}
