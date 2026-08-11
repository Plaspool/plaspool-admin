import { sql, type SQL } from 'drizzle-orm';
import type { CommerceEventType } from '../../../shared/commerce/events';

/**
 * Appending to the outbox — as a SQL FRAGMENT, never as a second statement.
 *
 * CONTRACT §6 RULE 1 IS THE WHOLE DESIGN HERE: "Write the event in the same
 * transaction as the state change that caused it. An event that can be lost
 * while its cause commits is worse than no event, because the system then
 * believes something happened that nobody will act on."
 *
 * And in this codebase "the same transaction" has to mean "the same statement".
 * `db.transaction` throws unconditionally on the Neon HTTP driver while PGlite
 * supports it (`server/repo/posts.ts` documents the measurement), so a
 * transaction here would pass every test in this repository and 500 on every
 * production call — the exact divergence spec §9 exists to eliminate. So the
 * event is a data-modifying CTE that SELECTs FROM the CTE holding the state
 * change: if the CAS matched nothing, the source CTE has no rows, the INSERT
 * inserts nothing, and there is no event for a change that did not happen.
 *
 * THAT IS ALSO WHY THESE ARE FRAGMENTS AND NOT FUNCTIONS THAT WRITE. A function
 * called after a successful write is a second statement, and the window between
 * them is exactly the failure §6 rule 1 names. Nothing in this file executes
 * anything.
 */

/**
 * `evt_` + hex epoch-ms + a uuid, minted IN SQL.
 *
 * In SQL rather than in JS because a single statement can emit N events — one
 * per variant when a product is published — and N is not known before the
 * statement runs without reading first, which would put a read between the
 * decision and the write.
 *
 * MONOTONIC ENOUGH TO SORT BY, which is what contract §6's "ULID-ish, monotonic"
 * is for: `to_hex` of an epoch-ms is 11 hex digits today and stays 11 until the
 * year 2527, so lexicographic order over the prefix is time order for any
 * lifetime this shop has. Within one millisecond the uuid decides, and the
 * dispatcher orders by `occurred_at` anyway — the id only has to break ties
 * deterministically and never collide.
 *
 * `gen_random_uuid()` is core in PostgreSQL 13+ and present in PGlite 0.5.4
 * (PostgreSQL 18.3) — verified by execution, and verified to produce a DISTINCT
 * value per row of a multi-row INSERT … SELECT, which is the property that
 * matters here. A repeated id would be a primary-key violation that aborts the
 * whole statement, i.e. it would refuse the state change too.
 */
function eventId(occurredAt: number): SQL {
  return sql`'evt_' || to_hex(${occurredAt}::bigint) || replace(gen_random_uuid()::text, '-', '')`;
}

/**
 * An `INSERT INTO commerce_events … SELECT … FROM <from>` CTE body.
 *
 * @param from       a FROM clause rooted in a preceding data-modifying CTE.
 *                   ZERO ROWS THERE MEANS ZERO EVENTS — that is the guarantee,
 *                   and it is why this takes a clause rather than executing.
 * @param type       one of contract §6's eleven, narrowed by the compiler.
 * @param subjectId  an expression over `from` — the aggregate this is about.
 * @param payload    an expression over `from` producing jsonb.
 * @param occurredAt epoch-ms, from the same clock reading as the change.
 *
 * `from` IS A CLAUSE AND NOT A CTE NAME because one state change can fan out to
 * several events: publishing a product emits one `catalog.variant.published` per
 * sellable variant, which needs `upd JOIN shop_variants … LEFT JOIN shop_prices
 * …`. Collapsing that to a bare name would have forced a second statement to
 * find the variants, and a second statement is precisely what §6 rule 1 forbids.
 *
 * `type` is a bound parameter, like every value in this codebase. The `from`
 * clause is raw SQL because CTE names and join conditions are identifiers, which
 * cannot be parameters — it is never caller-supplied, only ever written a few
 * lines above in the same function.
 */
export function emitEvent(options: {
  from: SQL;
  type: CommerceEventType;
  subjectId: SQL;
  payload: SQL;
  occurredAt: number;
}): SQL {
  const { from, type, subjectId, payload, occurredAt } = options;
  return sql`
    INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at)
    SELECT ${eventId(occurredAt)}, ${type}, ${subjectId}, ${payload}, ${occurredAt}
      FROM ${from}
    RETURNING 1`;
}

/**
 * A jsonb object built from SQL expressions.
 *
 * `jsonb_build_object` and not string concatenation: every value stays a bound
 * parameter or a column reference, so a product title containing a quote cannot
 * change the shape of the payload. The blog side learned the same lesson about
 * `LIKE` patterns in `server/domain/slug.ts` — a predicate that is only safe
 * because of what its caller happens to pass is one refactor from being wrong.
 */
export function jsonbObject(fields: Record<string, SQL>): SQL {
  /*
   * `::text` ON THE KEY IS NOT DECORATION. `jsonb_build_object` is
   * `("any", "any", …)`, so a bare `$1` in a key position gives Postgres nothing
   * to infer from and the statement fails with SQLSTATE 42P18
   * `indeterminate_datatype` — at run time, not at build time, so it is invisible
   * until the first publish. Measured: `publishProduct` raised 42P18 on its
   * first execution, which `guardDb` scrubs to a `DbError` and a route answers
   * 500. The same applies to any scalar VALUE bound here, which is why the
   * payload builders cast theirs at the call site rather than relying on
   * inference that does not exist.
   */
  const parts = Object.entries(fields).map(([key, value]) => sql`${key}::text, ${value}`);
  return sql`jsonb_build_object(${sql.join(parts, sql`, `)})`;
}
