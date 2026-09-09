import { sql } from 'drizzle-orm';
import { BadRequestError, NotFoundError, StaleWriteError } from '../../repo/errors';
import { toEpochMs } from '../../db/client';
import type { Db } from '../../db/client';
import type { ProviderName } from './schema';

/**
 * The switch that decides which gateway takes a new payment — one row,
 * `id = 'main'` (migration 1100, `shop_payment_settings`).
 *
 * FOLLOWS `server/shop/settings/repo.ts` TO THE LETTER: plain `sql` templates
 * over hand-written DDL, NEVER `db.transaction` (the Neon HTTP driver throws on
 * it unconditionally while PGlite supports it — so a transaction passes every
 * test here and 500s in production), and ONE GUARDED UPDATE rather than
 * read-compare-write. The CAS check lives in the UPDATE's own `WHERE`, so
 * Postgres re-evaluates it against the winner's committed row rather than a
 * snapshot a concurrent writer has already invalidated.
 *
 * TWO CURRENCY LISTS PER GATEWAY LIVE HERE, AND THEY ARE NOT
 * `ProviderCapabilities.currencies` (`provider/types.ts`). That list is the
 * gateway's documented maximum; these columns are what THIS ACCOUNT has
 * actually switched on — Paystack's USD is not enabled here even though
 * Paystack's API supports it elsewhere. Routing reads these columns; the
 * capability list only bounds what an admin screen may offer.
 */

/**
 * The singleton's primary key, pinned by `shop_payment_settings_id_ck`.
 *
 * A CHECK-CONSTRAINED CONSTANT rather than a table with one row by convention
 * — `shop_delivery_settings`' precedent — so a second row cannot appear and
 * leave two answers to "who takes the money" for whichever sorted first.
 */
const SETTINGS_ID = 'main';

export interface PaymentSettings {
  activeProvider: ProviderName;
  /** `null` = no country rule — everyone gets `activeProvider`. */
  internationalProvider: ProviderName | null;
  /** ISO 4217, uppercase. Never empty for either gateway — the CHECK forbids it. */
  currencies: Record<ProviderName, string[]>;
  /** CAS token, as on `posts.revision`. Moves on every write. */
  revision: number;
  updatedAt: number;
}

export interface PaymentSettingsPatch {
  activeProvider?: ProviderName;
  /**
   * `undefined` LEAVES THE COUNTRY RULE ALONE. An explicit `null` CLEARS it.
   *
   * The two cannot be collapsed into one optional field —
   * `DeliverySettingsPatch.servedRegions`'s precedent. `null` is a meaningful
   * value here ("no country rule"), so the write path below tests
   * `'internationalProvider' in patch`, never truthiness or `??`: `COALESCE`
   * cannot express "set this to NULL", and truthiness cannot tell an absent
   * field from an explicit `null`.
   */
  internationalProvider?: ProviderName | null;
  /**
   * Per-gateway REPLACEMENT lists, never a merge. A key that is absent leaves
   * that gateway's currencies alone. A key that is present must not be an
   * empty list — the CHECK forbids one, and this module refuses it before the
   * statement runs, with the field named, rather than surfacing Postgres's
   * raw `23514`. Codes are uppercased here; the caller may pass lowercase.
   */
  currencies?: Partial<Record<ProviderName, string[]>>;
}

function rowToSettings(row: Record<string, unknown>): PaymentSettings {
  return {
    activeProvider: row.active_provider as ProviderName,
    internationalProvider:
      row.international_provider == null ? null : (row.international_provider as ProviderName),
    // `text[]` arrives as a JS array from both drivers, and the CHECK
    // guarantees no NULL and no empty elements, so the cast is total.
    currencies: {
      paystack: row.paystack_currencies as string[],
      flutterwave: row.flutterwave_currencies as string[],
    },
    revision: Number(row.revision),
    updatedAt: toEpochMs(row.updated_at),
  };
}

/**
 * Explicit column list rather than `*` — `intents.ts`'s `INTENT_COLUMNS`
 * precedent — so a column added later does not silently start crossing this
 * boundary. `updated_by` rides along for the RETURNING clause even though
 * `PaymentSettings` does not surface it: nothing downstream needs who flipped
 * the switch, only what it is now.
 */
const SETTINGS_COLUMNS = sql`id, active_provider, international_provider,
  paystack_currencies, flutterwave_currencies, revision, updated_at, updated_by`;

// ---------------------------------------------------------------------- read

/** The whole row. */
export async function readPaymentSettings(db: Db): Promise<PaymentSettings> {
  const res = await db.execute(
    sql`SELECT ${SETTINGS_COLUMNS} FROM shop_payment_settings WHERE id = ${SETTINGS_ID}`,
  );
  const row = res.rows[0];
  /*
   * MIGRATION 1100 SEEDS THIS ROW AND NOTHING DELETES IT, SO THIS IS
   * UNREACHABLE ONCE THE MIGRATION HAS RUN. It is still checked rather than
   * assumed: `PaymentSettings` promises a value, never `| null`, and the one
   * thing worse than a route 500ing on a missing configuration row is that
   * 500 arriving with no name attached to it.
   */
  if (row === undefined) throw new NotFoundError('payment_settings');
  return rowToSettings(row as Record<string, unknown>);
}

// --------------------------------------------------------------- normalising

/**
 * Uppercase every code and refuse an empty list — the DB CHECK
 * (`^[A-Z]{3}(,[A-Z]{3})*$` over the joined array) forbids one, and a name
 * attached here beats Postgres's raw `23514` reaching a route. `field` is the
 * patch key this list came from, so the error names which gateway's list.
 */
function normalizeCurrencyCodes(codes: readonly string[], field: string): string[] {
  if (codes.length === 0) throw new BadRequestError(field);
  return codes.map((code) => code.toUpperCase());
}

// --------------------------------------------------------------------- write

/**
 * Write the row, compare-and-swap on `expectedRevision`.
 *
 * ONE STATEMENT, NO TRANSACTION AND NO PRIOR READ. Three things about the
 * shape below are load-bearing rather than stylistic, each a documented
 * production failure elsewhere in this codebase:
 *
 * - `international_provider` is assigned from a ternary over
 *   `'internationalProvider' in patch`, not `patch.internationalProvider ??
 *   something`. `null` clears the country rule and is a meaningful value;
 *   `COALESCE` cannot express "set to NULL".
 * - Every array bind goes through `sql.param(...)::text[]` — a bare array
 *   bind is a `22P02`.
 * - Every possibly-NULL bind carries an explicit cast (`::text`, `::uuid`),
 *   or Postgres refuses the whole statement with `42P18`.
 */
export async function writePaymentSettings(
  db: Db,
  patch: PaymentSettingsPatch,
  expectedRevision: number,
  userId: string | null,
  now: number = Date.now(),
): Promise<PaymentSettings> {
  /* Normalised BEFORE the statement so an empty list is a named refusal
   * rather than a CHECK violation surfacing as an unlabelled 500. */
  const paystackCodes =
    patch.currencies?.paystack !== undefined
      ? normalizeCurrencyCodes(patch.currencies.paystack, 'currencies.paystack')
      : null;
  const flutterwaveCodes =
    patch.currencies?.flutterwave !== undefined
      ? normalizeCurrencyCodes(patch.currencies.flutterwave, 'currencies.flutterwave')
      : null;

  const res = await db.execute(sql`
    UPDATE shop_payment_settings
       SET active_provider = COALESCE(${patch.activeProvider ?? null}::text, active_provider),
           international_provider = ${
             'internationalProvider' in patch
               ? sql`${patch.internationalProvider}::text`
               : sql`international_provider`
           },
           paystack_currencies = COALESCE(${
             paystackCodes === null ? null : sql.param(paystackCodes)
           }::text[], paystack_currencies),
           flutterwave_currencies = COALESCE(${
             flutterwaveCodes === null ? null : sql.param(flutterwaveCodes)
           }::text[], flutterwave_currencies),
           revision = revision + 1,
           updated_at = ${now},
           updated_by = ${userId}::uuid
     WHERE id = ${SETTINGS_ID} AND revision = ${expectedRevision}
    RETURNING ${SETTINGS_COLUMNS}`);

  const written = res.rows[0];
  if (written !== undefined) return rowToSettings(written as Record<string, unknown>);

  /*
   * The update matched nothing. Either somebody else saved first — a CAS
   * loss, `settings/repo.ts`'s fallback-SELECT precedent — or the row is
   * gone, which no route in this codebase can do. Distinguish rather than
   * guess: the follow-up read is only here to say which.
   */
  const current = await db.execute(
    sql`SELECT revision FROM shop_payment_settings WHERE id = ${SETTINGS_ID}`,
  );
  const row = current.rows[0];
  if (row === undefined) throw new NotFoundError('payment_settings');
  throw new StaleWriteError(expectedRevision, Number(row.revision ?? 0));
}
