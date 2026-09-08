import {
  claimRecipient,
  claimableRecipients,
  finishBroadcast,
  listSendingBroadcasts,
  markRecipientFailed,
  markRecipientSent,
  markRecipientSkipped,
  type ClaimedRecipient,
  type EmailBroadcast,
} from './repo';
import { greetingName, renderHtml, renderSubject, renderText, usesBasket } from './render';
import { basketBlock, basketTotal } from './basket-block';
import { basketFor } from '../shop/admin/prospects';
import { basketUrl } from '../shop/storefront-url';
import type { TemplateValues } from './render';
import type { Basket } from '../shop/admin/prospects';
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
 * at its first problem forever. That now covers the per-recipient BASKET READ as
 * well as the send — see `recordFailure` and its two callers.
 *
 * WHAT THIS ADDS THAT THE OUTBOX DOES NOT: suppression. An intent in the order
 * outbox is a message that was owed the instant an order was paid. A broadcast
 * recipient is a promise to mail somebody who is STILL a subscriber when the
 * message goes out — so `unsubscribedAt` is read through the join at claim time,
 * and a person who opts out mid-drain is passed over by the batch that had not
 * reached them yet.
 *
 * AND, SINCE THE "NOT BOUGHT YET" NUDGE, THE SAME ARGUMENT ABOUT THE BASKET. A
 * `{{basket}}` message is a promise to show somebody what they left behind, which
 * stops being true the moment they check out. So the basket is resolved HERE, per
 * recipient, at the moment of sending — never frozen onto the row at enqueue —
 * and a person whose basket has emptied in between is passed over rather than
 * told they left behind something they now own.
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
  /**
   * Of the claimed rows: people whose basket was empty by the time this batch
   * reached them, so a `{{basket}}` message was NOT sent. Counted apart from
   * `failed` and `suppressed` because "six hundred had already bought", "six
   * hundred bounced" and "six hundred opted out" need three different responses
   * from an operator — the argument `suppressed` was itself added under.
   *
   * NOT `skipped`, which already means "claimed by another drain between the
   * read and the claim" and is about concurrency, not about baskets.
   */
  emptyBasket: number;
  /** Transport refusals that will be retried by the next drain. */
  retryable: number;
}

const EMPTY: DrainSummary = {
  sent: 0,
  failed: 0,
  suppressed: 0,
  skipped: 0,
  emptyBasket: 0,
  retryable: 0,
};

export function emptySummary(): DrainSummary {
  return { ...EMPTY };
}

/**
 * Two batches' counts, added.
 *
 * EVERY FIELD IS NAMED HERE, AND THAT IS THE HAZARD THIS FUNCTION CARRIES: a
 * counter added to `DrainSummary` and to `EMPTY` but not to this list compiles,
 * passes every single-batch test, and silently reports zero the moment
 * `drainAll` touches two broadcasts. A spread would hide it in the other
 * direction, taking `b`'s value whole rather than summing it.
 */
function add(a: DrainSummary, b: DrainSummary): DrainSummary {
  return {
    sent: a.sent + b.sent,
    failed: a.failed + b.failed,
    suppressed: a.suppressed + b.suppressed,
    skipped: a.skipped + b.skipped,
    emptyBasket: a.emptyBasket + b.emptyBasket,
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
 *
 * `basket` IS THE READER'S OWN, RESOLVED A MOMENT AGO BY THE CALLER, and `null`
 * for every message that does not carry one — which is every broadcast this
 * feature predates. It defaults so those callers, and the test-send route, read
 * exactly as they did.
 *
 * `origin` IS THIS DEPLOYMENT'S, AND IS NOT PASSED ON TO `basketBlock`. The two
 * URLs in a nudge come from opposite places on purpose: the unsubscribe link is
 * built from the deployment's own allow-list (below), the basket link from the
 * STOREFRONT's origin (`basketUrl`), and the product photographs from whichever
 * origin serves `/api/public/images/…` — which is this application, and which
 * `basketBlock`'s own default already knows. Handing it `origin` would work in
 * production by coincidence and 404 every photograph the first time a caller
 * passed anything else.
 */
export function renderMessage(
  snapshot: { subject: string; html: string; text: string },
  recipient: Recipient,
  origin: string,
  basket: Basket | null = null,
): { to: string; subject: string; text: string; html: string } {
  const values: TemplateValues = {
    name: greetingName(recipient.email, recipient.name),
    unsubscribeUrl: unsubscribeUrl(origin, recipient.token),
    /*
     * ALL THREE ARRIVE TOGETHER OR NOT AT ALL. A message carrying a basket table
     * and a blank total would be worse than one carrying neither, and gating them
     * on the same `basket` makes that structurally impossible.
     */
    ...(basket
      ? {
          basketTotal: basketTotal(basket),
          basketUrl: basketUrl(),
          blocks: { basket: basketBlock(basket) },
        }
      : {}),
  };
  return {
    to: recipient.email,
    subject: renderSubject(snapshot.subject, values),
    text: renderText(snapshot.text, values),
    html: renderHtml(snapshot.html, values),
  };
}

/**
 * Record a refusal on one claimed row, and count it.
 *
 * ONE PLACE THAT KNOWS THE ATTEMPT CEILING, because there are now two ways to
 * fail a recipient — the provider refusing the message, and the database
 * refusing to say what is in their basket — and two ceilings drifting apart
 * would mean one kind of failure retried forever while the other gave up.
 *
 * THE MESSAGE, NOT THE ERROR OBJECT, AND CAPPED. `server/middleware/errors.ts`
 * and the order sweeper make the same choice for the same reason: an error
 * object passed whole to a log can carry a `params` or a `query` property, and a
 * provider's rejection can quote the address it refused at length. The address is
 * already reachable from the row; the provider's prose about it does not need to
 * be.
 */
async function recordFailure(
  db: Db,
  broadcastId: string,
  candidate: ClaimedRecipient,
  err: unknown,
  fallback: string,
  summary: DrainSummary,
): Promise<void> {
  const detail = (err instanceof Error ? err.message : fallback).slice(0, 500);
  const terminal = candidate.attempts + 1 >= BROADCAST_ATTEMPT_LIMIT;
  await markRecipientFailed(db, candidate.id, broadcastId, detail, terminal);
  if (terminal) summary.failed += 1;
  else summary.retryable += 1;
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
  /*
   * A PROPERTY OF THE SNAPSHOT, SO IT IS ANSWERED ONCE. Whether this broadcast
   * carries `{{basket}}` cannot vary by recipient, and asking per recipient
   * would scan both bodies four thousand times for one answer. It also decides
   * whether anybody's basket is read at all: an ordinary newsletter must not pay
   * a per-recipient query for a placeholder it does not contain.
   */
  const needsBasket = usesBasket(broadcast.html) || usesBasket(broadcast.text);
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

    /*
     * ═════════════════════════════════════════════════════════════════════════
     * THE BASKET IS RESOLVED AFTER THE CLAIM, NOT AT ENQUEUE. Between the pick
     * and the batch that reaches it, a shopper can pay, empty the basket, or let
     * the cart expire — a window of minutes on a big send. Freezing the basket at
     * enqueue would mail a picture of goods somebody already owns, which is the
     * single most likely embarrassment in this feature.
     *
     * AND AFTER THE SUPPRESSION CHECK, NOT BEFORE IT. Somebody who has opted out
     * is passed over whatever is in their basket, so reading it first would be a
     * query for a message that was never going to be sent — and it would report an
     * opt-out as `emptyBasket` whenever both were true, hiding the one of the two
     * an operator has to act on.
     *
     * THE ROW WILL READ `attempts = 1`, and that is not a defect. The claim above
     * is a CAS that moves `attempts` before this code can know anything about the
     * basket, and it has to be: checking first would leave the row pending for the
     * next drain to find, decide about again, and leave pending again — the
     * never-finishing broadcast the suppression comment above describes.
     * `markRecipientSkipped` therefore does not touch `attempts` itself.
     * ═════════════════════════════════════════════════════════════════════════
     */
    let basket: Basket | null = null;
    if (needsBasket) {
      try {
        basket = await basketFor(db, candidate.email);
      } catch (err: unknown) {
        /*
         * A BASKET THIS DRAIN COULD NOT READ IS A RETRY — NOT A SKIP, AND NOT A
         * SEND. `basketFor` is a database call inside a loop that must not throw,
         * and both other answers are worse: recording `skipped` would claim "they
         * have already bought" on evidence nobody has, and sending anyway would
         * deliver the literal text `{{basket}}` to a reader. Recorded through the
         * same ceiling a refused message is, so a permanently unreadable row
         * retires instead of consuming every future batch.
         */
        await recordFailure(db, broadcast.id, candidate, err, 'basket lookup failed', summary);
        continue;
      }
      /*
       * `basketFor` already returns `null` for a cart with no lines, so the second
       * half of this condition is unreachable today. It is written anyway because it
       * costs nothing, and because the alternative is that the day that function
       * starts returning an empty basket — a plausible shape for a caller that
       * wants the cart's currency or its expiry — this one silently mails a table
       * with no rows in it.
       */
      if (basket === null || basket.lines.length === 0) {
        await markRecipientSkipped(db, candidate.id, broadcast.id, 'basket_empty');
        summary.emptyBasket += 1;
        continue;
      }
    }

    try {
      await mailer.send(renderMessage(broadcast, candidate, origin, basket));
      await markRecipientSent(db, candidate.id, broadcast.id, now);
      summary.sent += 1;
    } catch (err: unknown) {
      await recordFailure(db, broadcast.id, candidate, err, 'send failed', summary);
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
