import { sql } from 'drizzle-orm';
import { BadRequestError, NotFoundError, StaleWriteError } from '../../repo/errors';
import { toEpochMs } from '../../db/client';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';

/**
 * Who the shop tells when an order is paid — one row, `id = 'main'`
 * (migration 0980).
 *
 * FOLLOWS `settings/repo.ts` TO THE LETTER: plain `sql` templates over
 * hand-written DDL, NEVER `db.transaction` (the Neon HTTP driver throws on it
 * unconditionally while PGlite supports it — so a transaction passes every test
 * here and 500s in production), one guarded statement rather than
 * read-compare-write, and every array bind rendered explicitly because a bare
 * array bind is a `22P02`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS ROW DECIDES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * It decides who is EMAILED when a payment captures. It does not decide who
 * sees the in-app bell — every signed-in teammate holding `orders` does, off
 * the same alerts feed that has always fed it — and it does not decide whether
 * a browser notification appears, which is the viewer's own permission and
 * lives in the browser rather than in this table.
 *
 * The three surfaces are separate on purpose: the bell and the notification
 * only reach somebody who has the admin open, and the whole reason this row
 * exists is the order placed at eleven at night that nobody has open for.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * The singleton's primary key, pinned by `shop_notification_settings_id_ck`.
 *
 * A CHECK-CONSTRAINED CONSTANT rather than a table with one row by convention,
 * `shop_delivery_settings`' precedent: "there is exactly one configuration" is
 * then something the database enforces, so a second row cannot appear and leave
 * two answers to "who gets told" for whichever sorted first.
 */
const SETTINGS_ID = 'main';

export interface NotificationSettings {
  /**
   * Extra addresses typed by hand. EMPTY IS THE ORDINARY STATE, not a broken
   * one — the team roster is where the recipients usually come from, and this
   * list is for the warehouse address or the manager with no admin account.
   */
  orderRecipients: string[];
  /** Also mail everyone on the roster whose role holds the `orders` domain. */
  notifyTeam: boolean;
  /** The master switch. Off means nothing is queued at all. */
  notifyOnOrder: boolean;
  revision: number;
  updatedAt: number;
  /** The account that last saved, or `null` for the seeded row and for a
   *  teammate whose account has since been deleted (`ON DELETE SET NULL`). */
  updatedBy: string | null;
}

const COLUMNS = sql`order_recipients, notify_team, notify_on_order, revision, updated_at, updated_by`;

function rowToSettings(row: Record<string, unknown>): NotificationSettings {
  return {
    /* `text[]` arrives as a JS array from both drivers, and the CHECK
     * guarantees no NULL and no empty elements — so the cast is total. The
     * `?? []` covers only a row written before the column was NOT NULL, which
     * cannot exist; it is there so a driver quirk cannot crash the screen. */
    orderRecipients: (row.order_recipients as string[] | null) ?? [],
    notifyTeam: row.notify_team === true,
    notifyOnOrder: row.notify_on_order === true,
    // `integer`, which PGlite and Neon agree about; `toEpochMs` exists for the
    // int8 divergence and `updated_at` is the only int8 here.
    revision: Number(row.revision),
    updatedAt: toEpochMs(row.updated_at),
    updatedBy: row.updated_by == null ? null : String(row.updated_by),
  };
}

// ---------------------------------------------------------------------- read

/**
 * The whole row. `null` only if somebody deleted it.
 *
 * NO INVENTED FALLBACK, unlike `loadDeliveryRules` next door, and the
 * difference is which way the failure points. A missing delivery configuration
 * would stop a shopper checking out, so answering "the behaviour you had last
 * week" is kinder than a 500. A missing notification row would only mean the
 * shop does not email itself — so the caller declines to send rather than
 * inventing recipients, and the screen says the row is gone.
 */
export async function getNotificationSettings(db: Db): Promise<NotificationSettings | null> {
  const res = await db.execute(sql`
    SELECT ${COLUMNS} FROM shop_notification_settings WHERE id = ${SETTINGS_ID}`);
  return res.rows[0] ? rowToSettings(res.rows[0] as Record<string, unknown>) : null;
}

// --------------------------------------------------------------- normalising

/**
 * Fold an address for comparison: case out, edge whitespace out.
 *
 * THE WHOLE ADDRESS IS LOWERCASED, INCLUDING THE LOCAL PART, and that is
 * technically wrong and deliberately so — RFC 5321 makes the local part
 * case-sensitive, but no mail provider anyone here sends through treats it that
 * way, and the alternative is `Sales@` and `sales@` both being mailed about the
 * same order. Folding is used ONLY for comparison; what is STORED is the
 * spelling the operator typed.
 */
export function foldAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Is this plausibly an email address?
 *
 * PLAUSIBLY, NOT VALIDLY. A complete RFC 5322 grammar accepts things no shop
 * will ever type and rejects nothing an operator is likely to get wrong; what
 * actually happens is a stray comma from pasting two addresses into one field,
 * or a name pasted where an address belongs. So this checks the shape that
 * catches those — one `@`, something either side, a dot in the domain, no
 * whitespace and no comma — and leaves the rest to the provider, which is the
 * only thing that can really answer.
 */
function plausibleAddress(value: string): boolean {
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value);
}

/**
 * The recipient list as the column will hold it: trimmed, de-duplicated on the
 * folded form, first spelling wins.
 *
 * NORMALISED WHERE IT CAN BE AND REFUSED WHERE IT CANNOT, `normalizeServedRegions`'
 * precedent. An owner who types " sales@plaspool.com " has said something
 * correct and a validation error about whitespace is pedantry. `Sales@` after
 * `sales@` is the same inbox, so the second is dropped rather than mailed
 * twice. But `sales at plaspool` is not an address at all, and it has to be a
 * 400 naming the field rather than a row that quietly fails to deliver eight
 * times and then stops.
 *
 * AN EMPTY RESULT IS ALLOWED, which is the one place this differs from its
 * model. "Nobody extra" is a legitimate saved state — see the migration header
 * — so clearing the field is a save and not an error.
 */
export function normalizeRecipients(recipients: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of recipients) {
    const value = raw.trim();
    /* A blank entry is the empty row a list editor leaves behind when somebody
     * adds a field and changes their mind. Dropped, not refused — refusing it
     * would make the screen unsavable for a reason the operator cannot see. */
    if (value === '') continue;
    if (!plausibleAddress(value)) throw new BadRequestError('orderRecipients');
    const folded = foldAddress(value);
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(value);
  }
  return out;
}

// --------------------------------------------------------------------- write

export interface NotificationSettingsPatch {
  orderRecipients?: readonly string[];
  notifyTeam?: boolean;
  notifyOnOrder?: boolean;
}

export interface NotificationSettingsWriteOptions {
  expectedRevision: number;
  actorId: string;
  now: number;
}

/**
 * `ARRAY[…]::text[]` and never a bare bind: a JS array handed straight to the
 * driver is a `22P02`. The empty case needs the cast written out because
 * `ARRAY[]` on its own has no element type Postgres can infer.
 */
function textArray(values: readonly string[]): SQL {
  if (values.length === 0) return sql`'{}'::text[]`;
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * Write the row, compare-and-swap on `expectedRevision`.
 *
 * ONE STATEMENT, NO TRANSACTION AND NO PRIOR READ. The `WHERE … AND revision =`
 * makes read-compare-write atomic in the database, so two settings tabs cannot
 * quietly overwrite each other. Zero rows back therefore means exactly one of
 * two things, and the follow-up SELECT is only there to say which.
 *
 * `CASE WHEN <provided>` PER COLUMN RATHER THAN `COALESCE`, for the reason
 * `patchDeliverySettings` gives: `COALESCE` cannot tell "do not change" from
 * "set to this", and a bare NULL bind inside one needs an explicit cast anyway
 * or Postgres refuses the whole statement with `42P18`.
 */
export async function patchNotificationSettings(
  db: Db,
  patch: NotificationSettingsPatch,
  opts: NotificationSettingsWriteOptions,
): Promise<NotificationSettings> {
  const recipientsGiven = patch.orderRecipients !== undefined;
  const teamGiven = patch.notifyTeam !== undefined;
  const orderGiven = patch.notifyOnOrder !== undefined;

  /* Normalised BEFORE the statement so a refusal is a 400 naming the field
   * rather than a CHECK violation surfacing as a 500. */
  const recipients = recipientsGiven ? normalizeRecipients(patch.orderRecipients ?? []) : [];

  const res = await db.execute(sql`
    UPDATE shop_notification_settings SET
      order_recipients = CASE WHEN ${recipientsGiven}
                              THEN ${textArray(recipients)}
                              ELSE order_recipients END,
      notify_team = CASE WHEN ${teamGiven}
                         THEN ${patch.notifyTeam ?? false}
                         ELSE notify_team END,
      notify_on_order = CASE WHEN ${orderGiven}
                             THEN ${patch.notifyOnOrder ?? false}
                             ELSE notify_on_order END,
      revision = revision + 1,
      updated_at = ${opts.now},
      updated_by = ${opts.actorId}::uuid
    WHERE id = ${SETTINGS_ID} AND revision = ${opts.expectedRevision}
    RETURNING ${COLUMNS}`);

  const written = res.rows[0];
  if (written !== undefined) return rowToSettings(written as Record<string, unknown>);

  /* The update matched nothing. Either the row is gone — which no route can do
   * and which the settings screen must be told about plainly — or somebody else
   * saved first, which is a 409 carrying the revision to re-read. */
  const current = await db.execute(sql`
    SELECT revision FROM shop_notification_settings WHERE id = ${SETTINGS_ID}`);
  const row = current.rows[0];
  if (row === undefined) throw new NotFoundError('notification_settings');
  throw new StaleWriteError(opts.expectedRevision, Number(row.revision ?? 0));
}
