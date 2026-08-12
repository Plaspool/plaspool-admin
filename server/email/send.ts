import {
  claimRecipient,
  claimableRecipients,
  finishBroadcast,
  listSendingBroadcasts,
  markRecipientFailed,
  markRecipientSent,
  type EmailBroadcast,
} from './repo';
import { greetingName, renderHtml, renderSubject, renderText } from './render';
import type { Db } from '../db/client';
import type { Mailer } from '../mail/port';

/**
 * The broadcast drain (HANDOFF §2 A6), built in the image of the order outbox
 * sweeper — `server/shop/orders/repo/emails.ts` — because the two have the same
 * three problems and the outbox has already been through two gauntlets with them.
 *
 * **THE CLAIM IS A CAS.** `repo.claimRecipient` moves `attempts` conditionally, so
 * a cron and an owner pressing "continue" at the same moment cannot both send to
 * the same person. The loser skips the row without sending.
 *
 * **ATTEMPTS ARE BOUNDED.** An address that is permanently undeliverable would
 * otherwise consume the whole batch budget forever, starving every other
 * subscriber — the tight-retry failure the order sweeper records in slow motion.
 * At the limit the row becomes `failed` with its `last_error` intact; it is not
 * deleted, and recovery is a human decision.
 *
 * **NOTHING HERE THROWS.** A `Mailer` that rejects is recorded on the row and the
 * drain continues to the next recipient: one bad address must not stop four
 * thousand others, and an exception escaping a cron handler is a drain that stops
 * at its first problem forever.
 *
 * WHAT THIS ADDS THAT THE OUTBOX DOES NOT: suppression. An intent in the order
 * outbox is a message that was owed the instant an order was paid. A broadcast
 * recipient is a promise to mail somebody who is STILL a subscriber when the
 * message goes out — so `unsubscribedAt` is read through the join at claim time,
 * and a person who opts out mid-drain is passed over by the batch that had not
 * reached them yet.
 */

/** How many recipients one batch will attempt. Bounds the work, not the queue. */
export const BROADCAST_BATCH = 50;

/**
 * After this many failed attempts a recipient stops being retried and the row
 * becomes `failed`. The same number the order outbox uses, deliberately: two
 * different retry ceilings in one application is two things to reason about and
 * one of them is always the one nobody remembers.
 */
export const BROADCAST_ATTEMPT_LIMIT = 8;

/** How many `sending` broadcasts one cron invocation will look at. */
export const BROADCAST_DRAIN_FANOUT = 5;

export interface DrainSummary {
  sent: number;
  /** Terminal failures written this pass — transport refusals that ran out of
   * attempts, plus suppressed recipients. */
  failed: number;
  /** Of `failed`: recipients who unsubscribed after the audience was enqueued.
   * Reported separately because "six hundred people opted out" and "six hundred
   * messages bounced" need very different responses from an operator. */
  suppressed: number;
  /** Claimed by another drain between the read and the claim. */
  skipped: number;
  /** Transport refusals that will be retried by the next drain. */
  retryable: number;
}

const EMPTY: DrainSummary = { sent: 0, failed: 0, suppressed: 0, skipped: 0, retryable: 0 };

export function emptySummary(): DrainSummary {
  return { ...EMPTY };
}

function add(a: DrainSummary, b: DrainSummary): DrainSummary {
  return {
    sent: a.sent + b.sent,
    failed: a.failed + b.failed,
    suppressed: a.suppressed + b.suppressed,
    skipped: a.skipped + b.skipped,
    retryable: a.retryable + b.retryable,
  };
}

/**
 * The unsubscribe link for one subscriber.
 *
 * BUILT FROM THE DEPLOYMENT'S OWN ALLOW-LIST, NEVER FROM A REQUEST HEADER — the
 * rule `server/routes/auth.ts` follows for invite and reset URLs, and it matters at
 * least as much here: a `Host` header is attacker-controlled on any deployment that
 * does not pin it, and an unsubscribe link built from one is a link the shop itself
 * sends to every subscriber pointing at a domain somebody else chose.
 */
export function unsubscribeUrl(origin: string, token: string): string {
  return `${origin}/api/public/unsubscribe?token=${encodeURIComponent(token)}`;
}

export interface Recipient {
  email: string;
  name: string | null;
  token: string;
}

/**
 * One message, in the shape `server/mail/port.ts` takes.
 *
 * BOTH PARTS, ALWAYS — the port's own rule ("no client sees only one"). The values
 * substituted into the HTML part are escaped and the ones in the text part are not;
 * `server/email/render.ts` explains why that asymmetry is the point rather than an
 * inconsistency.
 */
export function renderMessage(
  snapshot: { subject: string; html: string; text: string },
  recipient: Recipient,
  origin: string,
): { to: string; subject: string; text: string; html: string } {
  const values = {
    name: greetingName(recipient.email, recipient.name),
    unsubscribeUrl: unsubscribeUrl(origin, recipient.token),
  };
  return {
    to: recipient.email,
    subject: renderSubject(snapshot.subject, values),
    text: renderText(snapshot.text, values),
    html: renderHtml(snapshot.html, values),
  };
}

/**
 * Drain one batch of one broadcast. Returns counts and NEVER throws.
 *
 * The broadcast is closed by `finishBroadcast` only when nothing is pending, and
 * that check is part of the same guarded UPDATE — so a drain that finishes its
 * batch while another is mid-flight cannot close a send that still owes people
 * mail.
 */
export async function drainBroadcast(
  db: Db,
  broadcast: EmailBroadcast,
  mailer: Mailer,
  origin: string,
  now: number,
  limit: number = BROADCAST_BATCH,
): Promise<DrainSummary> {
  const summary = emptySummary();
  const candidates = await claimableRecipients(db, broadcast.id, limit);

  for (const candidate of candidates) {
    if (!(await claimRecipient(db, candidate.id, candidate.attempts))) {
      summary.skipped += 1;
      continue;
    }

    /*
     * SUPPRESSION, CHECKED AFTER THE CLAIM AND NOT BEFORE IT. Checking first
     * would leave the row `pending` for the next drain to find, decide about
     * again, and leave pending again — a broadcast that never finishes because
     * one person unsubscribed. Claiming first means this pass owns the row and
     * can retire it.
     */
    if (candidate.unsubscribedAt !== null) {
      await markRecipientFailed(db, candidate.id, broadcast.id, 'unsubscribed', true);
      summary.failed += 1;
      summary.suppressed += 1;
      continue;
    }

    try {
      await mailer.send(renderMessage(broadcast, candidate, origin));
      await markRecipientSent(db, candidate.id, broadcast.id, now);
      summary.sent += 1;
    } catch (err: unknown) {
      /*
       * THE MESSAGE, NOT THE ERROR OBJECT, AND CAPPED. `server/middleware/errors.ts`
       * and the order sweeper make the same choice for the same reason: an error
       * object passed whole to a log can carry a `params` or a `query` property,
       * and a provider's rejection can quote the address it refused at length. The
       * address is already reachable from the row; the provider's prose about it
       * does not need to be.
       */
      const detail = (err instanceof Error ? err.message : 'send failed').slice(0, 500);
      const terminal = candidate.attempts + 1 >= BROADCAST_ATTEMPT_LIMIT;
      await markRecipientFailed(db, candidate.id, broadcast.id, detail, terminal);
      if (terminal) summary.failed += 1;
      else summary.retryable += 1;
    }
  }

  await finishBroadcast(db, broadcast.id, now);
  return summary;
}

/**
 * Every broadcast that is still sending, one batch each. The cron's entry point.
 *
 * ONE BATCH PER BROADCAST RATHER THAN ONE BROADCAST TO COMPLETION, so a huge send
 * cannot starve a small one queued behind it — and because `vercel.json` caps these
 * functions at `maxDuration: 30` and Vercel does not retry a cron that times out,
 * which makes an over-large unit of work a unit that never completes rather than
 * one that runs slowly. A backlog is drained over successive invocations.
 */
export async function drainAll(
  db: Db,
  mailer: Mailer,
  origin: string,
  now: number,
  limit: number = BROADCAST_BATCH,
): Promise<DrainSummary & { broadcasts: number }> {
  const sending = await listSendingBroadcasts(db, BROADCAST_DRAIN_FANOUT);
  let total = emptySummary();
  for (const broadcast of sending) {
    total = add(total, await drainBroadcast(db, broadcast, mailer, origin, now, limit));
  }
  return { ...total, broadcasts: sending.length };
}
