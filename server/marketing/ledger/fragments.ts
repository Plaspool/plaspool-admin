import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

/**
 * The balance counter and the ledger row — as SQL FRAGMENTS, never as statements.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING IN THIS FILE EXECUTES ANYTHING, and that is the whole design (the
 * `server/shop/catalog/events.ts` idiom, for the same reason it gives).
 *
 * `db.transaction` throws unconditionally on the Neon HTTP driver while PGlite
 * supports it, so a transaction here would pass every test in this repository
 * and 500 on every production call. Atomicity is therefore ONE STATEMENT of
 * chained data-modifying CTEs, and a function that WROTE a balance would be a
 * second statement — with a window in which a return is `awarded` and the
 * customer has not been paid, or has been paid twice.
 *
 * So these build CTE bodies that `SELECT … FROM` the CTE holding the state
 * change. If the CAS above them matched nothing, the source CTE has no rows, the
 * INSERT inserts nothing, and there is no credit for an inspection that did not
 * happen.
 *
 * TWO CONSUMERS, ONE IMPLEMENTATION OF BALANCE SEMANTICS. `returns/repo.ts`
 * chains these off its inspect statement; A6's `credit()` / `debit()` executors
 * wrap the same builders for manual adjustments and for the redemption port. The
 * alternative — an award path that maintains `lifetime_earned` and an adjustment
 * path that forgets to — is exactly the drift a shared builder exists to
 * prevent, and it is invisible until somebody's loyalty tier is wrong.
 *
 * THE DEBIT'S GUARD IS THE RACE FIX, NOT A CHECK. Two requests that both read a
 * balance of 100 and both decide 60 is affordable are the classic overdraft; the
 * debit below is `SET balance = balance - x WHERE … AND balance >= x` with the
 * ledger INSERT selecting FROM it, so the loser updates zero rows and inserts
 * nothing. `marketing_balances_balance_ck` is the backstop underneath that,
 * which is what makes a FUTURE debit written without the predicate fail loudly
 * instead of handing a customer a negative wallet.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** `marketing_ledger_kind_ck`, in TypeScript. */
export type LedgerKind = 'return_award' | 'manual' | 'redemption' | 'redemption_release';

/** `marketing_ledger_actor_ck` / `marketing_return_events_actor_ck`. */
export type ActorType = 'admin' | 'customer' | 'system';

/**
 * A credit creates the wallet if it is the customer's first points ever; a debit
 * cannot, because there is nothing to take points from.
 *
 * A UNION RATHER THAN AN OPTIONAL FIELD, so `customerId` is not accepted on a
 * path that would silently ignore it: a debit must not re-stamp the shop id on a
 * balance row, since the id that arrives with a spend is whoever happened to be
 * signed in and the one already on the row is whoever earned the points.
 *
 * Every `SQL` here is an EXPRESSION OVER `from` — `upd.customer_email`,
 * `upd.points_awarded` — or a bound parameter. Each is cast where it lands,
 * because in `INSERT … SELECT $1` there is no target column for Postgres to
 * infer a parameter's type from and the failure is SQLSTATE 42P18 at run time
 * (`server/shop/catalog/events.ts` measured the same thing on
 * `jsonb_build_object`).
 */
export type BalanceMove =
  | {
      direction: 'credit';
      /** A FROM clause rooted in a preceding data-modifying CTE. Zero rows there
       *  means zero balance change — that is the guarantee this shape buys. */
      from: SQL;
      email: SQL;
      /** The shop's customer id, or `NULL`. First writer wins; see below. */
      customerId: SQL;
      /** A POSITIVE magnitude. Credits add it to `balance` AND to
       *  `lifetime_earned`. */
      amount: SQL;
      now: number;
    }
  | {
      direction: 'debit';
      from: SQL;
      email: SQL;
      /** A POSITIVE magnitude — the sign lives in the statement, not in the
       *  number, so `balance >= amount` reads as the question it is. */
      amount: SQL;
      now: number;
    };

/**
 * The balance CTE. Both shapes RETURN `customer_email, balance` — the balance AS
 * IT NOW STANDS — so `ledgerInsertFragment` can read `balance_after` off either
 * one without knowing which way the money went.
 *
 * `lifetime_earned` COUNTS CREDITS ONLY and is not derivable from `balance`: a
 * customer who earned 500 and spent 500 must read as loyal, not as a stranger.
 * It is maintained here rather than at the call sites for the reason in the
 * header — one of them would eventually forget.
 *
 * `customer_id` is `COALESCE(existing, proposed)`, i.e. FIRST WRITER WINS. A
 * guest earns points under an email, signs up later, and the id arrives with a
 * subsequent credit; overwriting it each time would make the column mean "the
 * last session that touched this wallet" instead of "the account this wallet
 * belongs to", and spec D10's later merge backfill reads it as the latter.
 */
export function balanceUpsertFragment(move: BalanceMove): SQL {
  if (move.direction === 'debit') {
    /*
     * AN `UPDATE`, NOT AN UPSERT, and the asymmetry is deliberate: a debit
     * against an address with no balance row must write nothing rather than
     * create a wallet at zero and then fail the CHECK. Zero rows here is the
     * signal the caller turns into `409 insufficient_balance` — the same zero
     * rows an overdraft produces, which is correct, because "no wallet" and "not
     * enough in the wallet" are one answer to the customer.
     */
    return sql`
      UPDATE marketing_balances
         SET balance = marketing_balances.balance - src.amount,
             updated_at = ${move.now}::bigint
        FROM (SELECT (${move.email})::text AS customer_email,
                     (${move.amount})::integer AS amount
                FROM ${move.from}) src
       WHERE marketing_balances.customer_email = src.customer_email
         AND marketing_balances.balance >= src.amount
      RETURNING marketing_balances.customer_email, marketing_balances.balance`;
  }

  return sql`
    INSERT INTO marketing_balances
      (customer_email, customer_id, balance, lifetime_earned, updated_at)
    SELECT (${move.email})::text, (${move.customerId})::text,
           (${move.amount})::integer, (${move.amount})::integer, ${move.now}::bigint
      FROM ${move.from}
    ON CONFLICT (customer_email) DO UPDATE
       SET balance = marketing_balances.balance + EXCLUDED.balance,
           lifetime_earned = marketing_balances.lifetime_earned + EXCLUDED.lifetime_earned,
           customer_id = COALESCE(marketing_balances.customer_id, EXCLUDED.customer_id),
           updated_at = EXCLUDED.updated_at
    RETURNING customer_email, balance`;
}

export interface LedgerEntryDraft {
  /**
   * A FROM clause that INCLUDES THE BALANCE CTE. `balance_after` has exactly one
   * correct source — the balance the counter now holds — and joining the two
   * here is what makes a row that says "120 → 180" true rather than plausible.
   */
  from: SQL;
  /** Minted by the caller so it can be reported without a second read. */
  id: string;
  email: SQL;
  customerId: SQL;
  /** `NULL` for a manual adjustment: it belongs to no program
   *  (`marketing_ledger_award_sign_ck` only demands one for an award). */
  programId: SQL;
  kind: LedgerKind;
  /** SIGNED. Positive credits, negative debits — the ledger is the arithmetic. */
  delta: SQL;
  /** Read off the balance CTE. See `from`. */
  balanceAfter: SQL;
  /**
   * RENDER-FINAL AT WRITE TIME, never a template resolved later (spec D2d). The
   * words a customer is shown for a March award must still read as they did in
   * March after the shop renames the programme in June — so this arrives already
   * interpolated from the labels of that instant, and nothing re-renders it.
   */
  reason: string;
  returnRequestId: SQL;
  orderId: SQL;
  actorType: ActorType;
  actorId: string | null;
  now: number;
}

/**
 * One ledger row, written FROM the balance CTE.
 *
 * IDEMPOTENCY IS NOT IN THIS FUNCTION and must not be added to it: the three
 * partial uniques on `marketing_ledger` (award per return, redemption per order,
 * release per order) refuse a second row with every application guard deleted,
 * which is the property spec D3 is after. A `WHERE NOT EXISTS` here would be a
 * check evaluated against a snapshot a concurrent writer has already
 * invalidated — the thing the constraints exist because of.
 */
export function ledgerInsertFragment(draft: LedgerEntryDraft): SQL {
  return sql`
    INSERT INTO marketing_ledger
      (id, customer_email, customer_id, program_id, kind, delta, balance_after,
       reason, return_request_id, order_id, actor_type, actor_id, created_at)
    SELECT ${draft.id}::text, (${draft.email})::text, (${draft.customerId})::text,
           (${draft.programId})::text, ${draft.kind}::text, (${draft.delta})::integer,
           (${draft.balanceAfter})::integer, ${draft.reason}::text,
           (${draft.returnRequestId})::text, (${draft.orderId})::text,
           ${draft.actorType}::text, ${draft.actorId}::text, ${draft.now}::bigint
      FROM ${draft.from}
    RETURNING id AS entry_id, balance_after`;
}
