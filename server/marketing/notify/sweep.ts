import { sql } from 'drizzle-orm';
import { INTENT_COLUMNS, rowToIntent, toMessage } from './mailer';
import type { Db } from '../../db/client';
import type { Mailer } from '../../mail/port';

/**
 * The outbox sweeper — delivery, and only delivery (spec D6).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INTENT IS ALREADY WRITTEN WHEN THIS RUNS. The inspection that awards the
 * points inserts the rendered message in the SAME STATEMENT as the award
 * (`returns/repo.ts`), so this file never decides *whether* a customer is owed a
 * letter — only whether it has been handed to a provider yet. That split is the
 * whole design:
 *
 * - **A mailer failure must never un-award points.** The award committed in a
 *   different statement, minutes earlier, and there is no code path from here
 *   back to `marketing_ledger` or `marketing_balances` — which is a stronger
 *   guarantee than a `catch` somebody could remove.
 * - **An award must not depend on an email provider being up.** A deployment
 *   with no `RESEND_API_KEY` at all still inspects returns and credits balances;
 *   it just has mail waiting, which the Overview counts.
 *
 * NOTHING HERE THROWS. A `Mailer` that rejects is recorded on the row and the
 * sweep continues to the next intent: one bad address must not stop every other
 * customer's mail. The route above it is fire-and-forget from the admin's
 * inspection, so an exception escaping here would surface as a failed background
 * request against a return that was, in fact, awarded correctly.
 *
 * A COPY OF `server/shop/orders/repo/emails.ts`, NOT AN IMPORT. Spec D9 forbids
 * marketing importing `server/shop/**` in either direction, and that rule is
 * what keeps the two subsystems separable. The copy is faithful — the CAS claim,
 * the batch, the attempt cap, the truncated error — and the differences are only
 * the table it reads and the two-part message this port sends.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** How many intents one sweep will attempt. Bounds the work, not the queue. */
export const MARKETING_SWEEP_LIMIT = 50;

/**
 * After this many failed attempts an intent stops being retried.
 *
 * NOT A DELETE, AND THE ROW STAYS VISIBLE with its `last_error`. An address that
 * is permanently undeliverable would otherwise consume the whole sweep budget
 * forever, starving every other message. Recovery is `UPDATE … SET attempts = 0`,
 * deliberately a human decision.
 */
export const MARKETING_ATTEMPT_LIMIT = 8;

/** Contract #27's body, verbatim: `{sent, failed, skipped}`. */
export interface SweepSummary {
  sent: number;
  failed: number;
  /** Claimed by another sweeper between the read and the claim. */
  skipped: number;
}

/**
 * Deliver what is owed. Returns counts and never throws.
 *
 * THE CLAIM IS A CAS ON `attempts`, WHICH IS WHY THERE IS NO LEASE COLUMN.
 *
 * Two sweeps running at once both read `attempts = 0`; both then try
 * `SET attempts = 1 WHERE attempts = 0`, and exactly one matches. The loser skips
 * the row WITHOUT SENDING, so concurrent sweeps cannot double-deliver — the
 * property a `claimed_at` column is usually added for, obtained from a column
 * that had to exist anyway. It matters more here than in the shop: nothing
 * schedules this sweep, so its callers are admins tapping Inspect on two returns
 * at once, and every inspection fires one.
 *
 * WHAT REMAINS, STATED PLAINLY: if the process dies between the claim and the
 * `sent_at` write, the next sweep retries and the customer may receive the
 * message twice. That is the irreducible at-least-once property of an outbox
 * without a distributed transaction across the provider. It is bounded to a
 * crash window rather than being a race any two sweeps can lose.
 */
export async function sweepMarketingEmailIntents(
  db: Db,
  mailer: Mailer,
  now: number,
  limit: number = MARKETING_SWEEP_LIMIT,
): Promise<SweepSummary> {
  const res = await db.execute(sql`
    SELECT ${INTENT_COLUMNS} FROM marketing_email_intents
     WHERE sent_at IS NULL AND attempts < ${MARKETING_ATTEMPT_LIMIT}
     ORDER BY created_at ASC, id ASC
     LIMIT ${limit}`);

  const summary: SweepSummary = { sent: 0, failed: 0, skipped: 0 };

  for (const row of res.rows) {
    const intent = rowToIntent(row);

    const claimed = await db.execute(sql`
      UPDATE marketing_email_intents
         SET attempts = attempts + 1
       WHERE id = ${intent.id} AND sent_at IS NULL AND attempts = ${intent.attempts}
      RETURNING id`);
    if (claimed.rows.length === 0) {
      summary.skipped += 1;
      continue;
    }

    try {
      /* THE STORED COLUMNS, COPIED. `toMessage` is the only way from a row to a
       * transport in this subsystem, so a letter cannot be re-worded at delivery
       * time out of labels that have been renamed since (spec D2d). */
      await mailer.send(toMessage(intent));
      await db.execute(sql`
        UPDATE marketing_email_intents
           SET sent_at = ${now}, last_error = NULL
         WHERE id = ${intent.id} AND sent_at IS NULL`);
      summary.sent += 1;
    } catch (err: unknown) {
      /*
       * THE MESSAGE, NOT THE ERROR OBJECT, AND CAPPED. `server/middleware/errors.ts`
       * makes the same choice for the same reason: an error object passed whole
       * to a log can carry a `params` or a `query` property, and a provider's
       * rejection can quote the address it refused. A recipient address is
       * already in the row; a provider's prose about it does not need to be, at
       * length — and `last_error` is rendered on the return's detail screen.
       */
      const detail = (err instanceof Error ? err.message : 'send failed').slice(0, 500);
      await db.execute(sql`
        UPDATE marketing_email_intents SET last_error = ${detail} WHERE id = ${intent.id}`);
      summary.failed += 1;
    }
  }

  return summary;
}
