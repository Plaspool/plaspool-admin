import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { toEpochMs, toEpochMsOrNull } from '../../db/client';
import { ProviderError, isIndeterminate, isRetryable } from './provider/scrub';
import { intentId as mintIntentId, eventId as mintEventId, providerReferenceFor } from './ids';
import type { Db } from '../../db/client';
import type { PaymentsCheckoutPort } from './checkout';
import type { PaymentProvider } from './provider/types';
import type { PaymentStatus } from '../../../shared/commerce/ports';
import type { CommerceEventType } from '../../../shared/commerce/events';

/**
 * The payment intent: creation, the status ladder, and the outbox writes that
 * ride with every state change.
 *
 * THREE RULES DECIDE EVERY STATEMENT BELOW.
 *
 * **1. The amount comes from `CheckoutPort` once and is never recomputed**
 * (`03-payments.md` §1). Not at capture, not at refund, not when reconciling
 * with the provider. When the provider reports a different figure, that is a
 * DISCREPANCY to record, not a correction to apply — an amount that can be
 * revised is an amount that can be revised to something the customer never
 * agreed to.
 *
 * **2. Idempotency is a UNIQUE column and a read-through, never a pre-check.**
 * `INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING *` returns zero
 * rows to the loser, and the loser then reads the winner's row. A
 * `SELECT … WHERE idempotency_key = $1` first would be evaluated against a
 * snapshot the concurrent request has already invalidated — the exact defect
 * Part 2b found across six lifecycle transitions, where mutating every CAS
 * predicate to `true` broke none of 254 tests because every precondition test
 * was satisfied by a JS check on a stale read.
 *
 * **3. The row is written BEFORE the provider is called.** Winning the unique
 * index is what earns the right to make the call. Reversed — call first, record
 * after — a lost response leaves money moved and nothing written down, and the
 * retry has no way to know. This ordering is why `createIntent` can be re-run
 * safely after a timeout: the second attempt finds the row, sees no
 * `provider_intent_id`, and re-sends the SAME derived reference, which Paystack
 * either accepts or refuses as a duplicate. Never a second charge.
 */

export interface PaymentIntentRow {
  id: string;
  checkoutId: string;
  providerIntentId: string | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  idempotencyKey: string;
  authorizationUrl: string | null;
  refundedTotal: number;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  revision: number;
}

export function mapIntentRow(row: Record<string, unknown>): PaymentIntentRow {
  return {
    id: String(row.id),
    checkoutId: String(row.checkout_id),
    providerIntentId: row.provider_intent_id == null ? null : String(row.provider_intent_id),
    amount: Number(row.amount),
    currency: String(row.currency),
    status: row.status as PaymentStatus,
    idempotencyKey: String(row.idempotency_key),
    authorizationUrl: row.authorization_url == null ? null : String(row.authorization_url),
    refundedTotal: Number(row.refunded_total),
    createdAt: toEpochMs(row.created_at),
    updatedAt: toEpochMs(row.updated_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    revision: Number(row.revision),
  };
}

const INTENT_COLUMNS = sql`id, checkout_id, provider_intent_id, amount, currency, status,
  idempotency_key, authorization_url, refunded_total, created_at, updated_at, last_error, revision`;

/**
 * What an idempotency key is a key FOR.
 *
 * `checkoutId`, `amount` and `currency` — the money-relevant facts, and nothing
 * else. The email is deliberately excluded: it decides where a receipt goes,
 * not what is charged, and including it would make a retry that normalised the
 * address differently (a trimmed space, a lower-cased domain) fail as key
 * reuse — turning a recoverable timeout into a permanent 400 on a charge that
 * may already have happened.
 */
function fingerprint(checkoutId: string, amount: number, currency: string): string {
  return createHash('sha256').update(`${checkoutId}|${amount}|${currency}`).digest('hex');
}

export async function getIntent(db: Db, id: string): Promise<PaymentIntentRow | null> {
  const res = await db.execute(
    sql`SELECT ${INTENT_COLUMNS} FROM shop_payment_intents WHERE id = ${id}`,
  );
  return res.rows[0] ? mapIntentRow(res.rows[0]) : null;
}

export async function getIntentByProviderRef(
  db: Db,
  providerIntentId: string,
): Promise<PaymentIntentRow | null> {
  const res = await db.execute(
    sql`SELECT ${INTENT_COLUMNS} FROM shop_payment_intents
        WHERE provider_intent_id = ${providerIntentId}`,
  );
  return res.rows[0] ? mapIntentRow(res.rows[0]) : null;
}

/**
 * Every intent for one checkout, oldest first.
 *
 * TWO COLUMNS, NOT `INTENT_COLUMNS`, and the narrowness is the point: the only
 * caller is the composition root's adapter for Cart's `CheckoutPaymentsPort`,
 * which asks one question — did money move on this checkout — and must not be
 * handed `idempotency_key`, `authorization_url` or `last_error` on its way to
 * answering it. Same projection discipline as `paymentPort.status`.
 */
export async function intentsForCheckout(
  db: Db,
  checkoutId: string,
): Promise<Array<{ id: string; status: PaymentStatus }>> {
  const res = await db.execute(sql`
    SELECT id, status FROM shop_payment_intents
     WHERE checkout_id = ${checkoutId}
     ORDER BY created_at, id`);
  return res.rows.map((row) => ({
    id: String(row.id),
    status: row.status as PaymentStatus,
  }));
}

async function getIntentByKey(db: Db, key: string): Promise<PaymentIntentRow | null> {
  const res = await db.execute(
    sql`SELECT ${INTENT_COLUMNS} FROM shop_payment_intents WHERE idempotency_key = ${key}`,
  );
  return res.rows[0] ? mapIntentRow(res.rows[0]) : null;
}

export interface CreateIntentInput {
  checkoutId: string;
  /** The customer's, for the provider's receipt. NOT a money-relevant field. */
  email: string;
  /**
   * The caller's key. Required — there is no unkeyed way to create an intent,
   * because `03-payments.md` §1 makes an unkeyed retry a defect rather than a
   * resilience feature, and the surest way to prevent one is to have no API
   * that permits it.
   */
  idempotencyKey: string;
  callbackUrl?: string;
}

export interface CreateIntentResult {
  intent: PaymentIntentRow;
  /** False when this call read through to an intent an earlier call created. */
  created: boolean;
}

/**
 * Create — or recover — the intent for a checkout.
 *
 * The whole idempotency story is in the order of the five steps, so they are
 * numbered in the code.
 */
export async function createIntent(
  db: Db,
  provider: PaymentProvider,
  checkout: PaymentsCheckoutPort,
  input: CreateIntentInput,
  now: number = Date.now(),
): Promise<CreateIntentResult> {
  /*
   * 1. THE AMOUNT, FROM THE PORT, ONCE. Never from the request body.
   *
   * `grandTotal` is a `Money`, so the currency travels WITH the number — the
   * amount and the currency are never two independently-sourced values, which
   * is the whole of contract §10's "no `number` amounts without an accompanying
   * currency". `totals()` throws `NotFoundError` for a checkout that does not
   * exist or is not frozen, and that is deliberately not caught: it is already
   * a 404 and a permanent stop under spec §8's retry policy.
   */
  const totals = await checkout.totals(db, input.checkoutId);
  const { amount, currency } = totals.grandTotal;

  /*
   * 1b. HAND THE EMAIL BACK TO CART, because this is the only moment anything
   *     knows it (admin#27).
   *
   * `shop_carts.email` is nullable and no cart route collects one, so without
   * this every `checkout.completed` would carry `email: null` — and Orders parks
   * an event with no email, twenty times, then abandons it. A customer charged
   * and no order, which is the whole of the issue this closes.
   *
   * BEST EFFORT, AND DELIBERATELY NOT ALLOWED TO FAIL THE INTENT. The port
   * refuses silently for a cart that has moved on; anything else it raises is
   * logged and dropped, because a checkout that cannot be paid for is strictly
   * worse than a confirmation email somebody has to reconcile. It runs BEFORE
   * the provider call so a slow provider cannot leave it unrun.
   */
  await checkout.recordContact(db, input.checkoutId, input.email).catch((err: unknown) => {
    // eslint-disable-next-line no-console -- names only; this column and this
    // log are read by humans and an arbitrary message is not scrubbed.
    console.error(
      '[payments] could not record the checkout contact',
      JSON.stringify({
        checkoutId: input.checkoutId,
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
  });

  const id = mintIntentId(now);
  const fp = fingerprint(input.checkoutId, amount, currency);

  // 2. CLAIM THE KEY. The insert is the claim; a loser gets zero rows back.
  const inserted = await db.execute(sql`
    INSERT INTO shop_payment_intents
      (id, checkout_id, amount, currency, status, idempotency_key, request_fingerprint,
       refunded_total, created_at, updated_at, revision)
    VALUES (${id}, ${input.checkoutId}, ${amount}, ${currency},
            'requires_payment', ${input.idempotencyKey}, ${fp}, 0, ${now}, ${now}, 1)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING ${INTENT_COLUMNS}`);

  if (!inserted.rows[0]) {
    // 3. READ THROUGH to the winner. This is the "second call with the same key
    //    returns the first call's result" half of §5, and it is reached only by
    //    a real constraint violation, not by a guess.
    return { intent: await readThrough(db, provider, input, fp, now), created: false };
  }

  const intent = mapIntentRow(inserted.rows[0]);
  // 4. THE PROVIDER, now that the row exists and the key is ours.
  return { intent: await attachProvider(db, provider, intent, input, now), created: true };
}

/**
 * The loser's path: find the winner's intent and make sure it is usable.
 *
 * IT DOES NOT JUST RETURN THE ROW. A row whose `provider_intent_id` is NULL is
 * the signature of the case §5 calls out — the first caller claimed the key and
 * then its provider call timed out, so the intent exists and the customer has
 * nowhere to pay. Returning it unchanged would leave the checkout permanently
 * stuck behind a key that can never be reused. So the retry finishes the job,
 * with the SAME derived reference.
 */
async function readThrough(
  db: Db,
  provider: PaymentProvider,
  input: CreateIntentInput,
  fp: string,
  now: number,
): Promise<PaymentIntentRow> {
  const existing = await getIntentByKey(db, input.idempotencyKey);
  /*
   * Not `!` — the winner could in principle be gone. A missing row here means
   * the constraint fired against something that no longer exists, which is a
   * genuine 500 rather than something to paper over with a second insert.
   */
  if (!existing) throw new Error('idempotency key conflicted with no readable row');

  /*
   * KEY REUSE WITH A DIFFERENT REQUEST IS REFUSED, LOUDLY.
   *
   * Returning the first call's result is only safe while the second call is
   * asking the same question. A key reused against a different checkout or a
   * changed total is a caller bug, and answering it with the old intent would
   * hand back an authorization URL for one amount while the caller believes
   * another. 400 and not 500: it is permanent, and contract §10 makes a 500 a
   * request the client re-sends five times.
   */
  const res = await db.execute(
    sql`SELECT request_fingerprint FROM shop_payment_intents WHERE id = ${existing.id}`,
  );
  if (String(res.rows[0]?.request_fingerprint) !== fp) {
    throw new BadRequestError('idempotency_key');
  }

  if (existing.providerIntentId) return existing;
  return attachProvider(db, provider, existing, input, now);
}

/**
 * Call the provider and record what it said.
 *
 * `providerReferenceFor(intent.id)` IS A PURE FUNCTION OF THE INTENT ID, which
 * is what makes this safe to run twice. Paystack has no idempotency header; the
 * unique `reference` is the mechanism, and a reference minted per ATTEMPT
 * rather than per INTENT would turn every timeout into a second transaction.
 */
async function attachProvider(
  db: Db,
  provider: PaymentProvider,
  intent: PaymentIntentRow,
  input: CreateIntentInput,
  now: number,
): Promise<PaymentIntentRow> {
  const reference = providerReferenceFor(intent.id);
  let providerIntent;
  try {
    providerIntent = await provider.createIntent({
      reference,
      amount: intent.amount,
      currency: intent.currency,
      email: input.email,
      callbackUrl: input.callbackUrl,
      metadata: { intentId: intent.id, checkoutId: intent.checkoutId },
    });
  } catch (err) {
    const code = err instanceof ProviderError ? err.code : 'unknown';
    /*
     * A DUPLICATE REFERENCE IS NOT A FAILURE — it is the provider telling us
     * that our previous attempt got through and we lost the answer. Asking it
     * what the transaction actually is, is the reconciliation §5 says only a
     * key makes possible. Treating this as an error would abandon a transaction
     * the customer may already have paid.
     */
    if (code === 'duplicate_reference') {
      providerIntent = await provider.fetchIntent(reference);
    } else {
      /*
       * TERMINAL FOR THIS ATTEMPT, AND THE STATUS SAYS SO (admin#30). A code
       * that is neither retryable nor indeterminate can never resolve itself —
       * re-sending the identical request would get the identical refusal — so
       * leaving the row at `requires_payment` misrepresents it as payable when
       * it has no `authorization_url` and never will for this attempt. Retryable
       * (`network`, `rate_limited`, `provider_unavailable`) and indeterminate
       * (`timeout`) codes are left alone: those genuinely might still succeed,
       * and `readThrough` already re-drives `attachProvider` for a row whose
       * `provider_intent_id` is still NULL regardless of `status`, so marking
       * this row `failed` does not block that retry — it only stops the row
       * from lying about being payable in the meantime.
       *
       * ONLY A GENUINE `ProviderError` EARNS `terminal` (admin#30 review).
       * `err instanceof ProviderError` is checked here too, not just for
       * `code` above — a `TypeError` from a bug in this function reads as
       * `code === 'unknown'`, which is also neither retryable nor
       * indeterminate, and would otherwise stamp an intent `failed` with
       * `last_error: 'unknown'` for OUR bug rather than a payment failure.
       * `recordIntentError` still records `code` either way, for the log.
       */
      const terminal = err instanceof ProviderError && !isRetryable(code) && !isIndeterminate(code);
      await recordIntentError(db, intent.id, code, now, terminal);

      /*
       * A PROVIDER REJECTION IS A 4xx, NOT A 500 — BUT ONLY WHEN THE PROVIDER
       * ACTUALLY NAMED THE FIELD (admin#30, sharpened on review).
       * `invalid_request` is the bucket for EVERY Paystack 4xx: a bad email,
       * an amount below the processor's minimum, a currency the account has
       * not enabled, a malformed `callback_url`. Assuming `email` for all of
       * them would tell a customer to fix an address that was fine, while a
       * genuine operator misconfiguration gets laundered into a client error
       * that never pages anyone — the exact failure this issue exists to
       * remove, just moved one layer up. So this only fires when
       * `err.field === 'email'`, which `paystack.ts`'s `#classifyField`
       * sets ONLY by matching Paystack's own message against the word
       * "email" (matched, never carried — same discipline as `#classify`).
       * Every other `invalid_request` — and every other non-retryable code —
       * falls through to `throw err`, which has no mapping in
       * `server/middleware/errors.ts` and becomes a 500: a vague-but-true
       * refusal beats a specific lie, and an unrecognised misconfiguration
       * SHOULD page someone.
       */
      if (code === 'invalid_request' && err instanceof ProviderError && err.field === 'email') {
        throw new BadRequestError('email');
      }
      throw err;
    }
  }

  /*
   * A RETRY THAT SUCCEEDS UN-FAILS THE ROW (admin#30). A prior attempt on this
   * same key may have marked the row 'failed' (see recordIntentError's
   * `terminal` flag); this attempt just proved that wrong, so `status` is set
   * back to 'requires_payment' explicitly rather than left alone.
   */
  const updated = await db.execute(sql`
    UPDATE shop_payment_intents
       SET provider_intent_id = ${providerIntent.providerIntentId},
           authorization_url = ${providerIntent.authorizationUrl},
           status = 'requires_payment',
           last_error = NULL,
           updated_at = ${now},
           revision = revision + 1
     WHERE id = ${intent.id} AND provider_intent_id IS NULL
    RETURNING ${INTENT_COLUMNS}`);

  /*
   * Zero rows means a concurrent caller attached first. That is a race we LOSE
   * gracefully rather than retry: both callers derived the same reference from
   * the same intent id, so the row the winner wrote is the row this caller
   * wanted. Re-reading is the whole recovery.
   */
  if (!updated.rows[0]) {
    const current = await getIntent(db, intent.id);
    if (!current) throw new NotFoundError(intent.id);
    return current;
  }
  return mapIntentRow(updated.rows[0]);
}

/**
 * Record a provider failure against the intent.
 *
 * `code` IS AN ENUMERATED `ProviderErrorCode` AND NOTHING ELSE — never a
 * message, never a body. `shop_payment_intents.last_error` is read by humans in
 * psql and shipped into logs, and this is the column an error message would
 * have to pass through to get there.
 *
 * `terminal` MOVES THE STATUS TO `'failed'` (admin#30). `'failed'` is already a
 * valid `PaymentStatus` and already in the `shop_payment_intents_status_ck`
 * CHECK — no migration for this. Left `false` for a code the caller may still
 * retry into success (`network`, `timeout`, `rate_limited`,
 * `provider_unavailable`), where `requires_payment` remains the honest status.
 *
 * A RAW `UPDATE`, DELIBERATELY NOT `applyIntentStatus` (admin#30 review). This
 * bypasses the `EVENT_FOR['failed'] -> 'payment.failed'` outbox write below —
 * on purpose, not as an oversight: `applyIntentStatus` announces a provider
 * TRANSACTION reaching a terminal state, and here none ever existed to
 * announce. Orders has nothing to react to for an intent Paystack refused
 * before it was ever created at the provider.
 */
export async function recordIntentError(
  db: Db,
  id: string,
  code: string,
  now: number = Date.now(),
  terminal = false,
): Promise<void> {
  await db.execute(sql`
    UPDATE shop_payment_intents
       SET last_error = ${code},
           updated_at = ${now},
           status = ${terminal ? 'failed' : sql`status`},
           revision = ${terminal ? sql`revision + 1` : sql`revision`}
     WHERE id = ${id}`);
}

// --------------------------------------------------------- the status ladder

/** The outbox type each terminal status announces. `null` = nothing to announce. */
const EVENT_FOR: Partial<Record<PaymentStatus, CommerceEventType>> = {
  authorized: 'payment.authorized',
  captured: 'payment.captured',
  failed: 'payment.failed',
};

export interface ApplyStatusResult {
  /** False when another drain had already processed this event row. */
  claimed: boolean;
  /** False when the event was below the intent's high-water mark. */
  moved: boolean;
  /** The outbox row written, when one was. */
  emittedEventId: string | null;
}

/**
 * Apply one verified provider event to an intent, and emit the outbox event —
 * IN ONE STATEMENT.
 *
 * WHY ONE STATEMENT AND NOT A TRANSACTION. Contract §6 rule 1 requires the
 * event to be written in the same transaction as the state change that caused
 * it, because "an event that can be lost while its cause commits is worse than
 * no event". This codebase cannot use `db.transaction()` on the hot path — the
 * Neon HTTP driver rejects it unconditionally (spec §4.3a, and
 * `server/db/client.ts` says so at length). A single statement IS a transaction
 * in Postgres, so a chain of data-modifying CTEs gives exactly the guarantee
 * §6 asks for, on the driver we actually run.
 *
 * THE CHAIN, and why each link is where it is:
 *
 * - `cur` reads the intent's status on the statement's snapshot, so the anomaly
 *   text below and the rank guard in `moved` are decided against the same row.
 * - `claimed` marks the raw event row processed, gated on `processed_at IS
 *   NULL`. THIS is what makes three concurrent deliveries produce one state
 *   change: they race on this UPDATE and exactly one wins.
 * - `moved` depends on `claimed` through `EXISTS`, which is load-bearing — a
 *   data-modifying CTE runs whether or not anything references it, so without
 *   that dependency the loser of the claim would still move the intent.
 * - the final INSERT selects `FROM moved`, so no outbox event is written for a
 *   transition that did not happen.
 *
 * OUT-OF-ORDER ARRIVAL IS RECORDED, NOT REFUSED (§4). The rank guard means a
 * `captured` that arrives before `authorized` wins, and the later `authorized`
 * loses and is annotated. Throwing instead would return a non-200 for an event
 * that is not wrong, and Paystack would redeliver it for 72 hours.
 */
export async function applyIntentStatus(
  db: Db,
  args: {
    eventRowId: string;
    /**
     * NULLABLE, and the null case is handled rather than guarded against. A
     * verified event we cannot place is still an event: it is acknowledged (so
     * the provider stops redelivering for 72 hours) and annotated
     * `unresolved_intent`, rather than throwing and turning a harmless
     * mystery into a delivery-failure alarm. `WHERE id = NULL` matches nothing,
     * so no row moves.
     */
    intentId: string | null;
    next: PaymentStatus;
    providerIntentId: string | null;
    failureReason: string | null;
  },
  now: number = Date.now(),
): Promise<ApplyStatusResult> {
  const eventType = EVENT_FOR[args.next] ?? null;
  const outboxId = mintEventId(now);

  const res = await db.execute(sql`
    WITH cur AS (
      SELECT id, status FROM shop_payment_intents WHERE id = ${args.intentId}
    ),
    claimed AS (
      UPDATE shop_payment_events
         SET processed_at = ${now},
             anomaly = CASE
               WHEN NOT EXISTS (SELECT 1 FROM cur) THEN 'unresolved_intent'
               WHEN (SELECT shop_payment_status_rank(status) FROM cur)
                    >= shop_payment_status_rank(${args.next})
                 THEN 'superseded:' || ${args.next} || ':after:'
                      || (SELECT status FROM cur)
               ELSE NULL
             END
       WHERE id = ${args.eventRowId} AND processed_at IS NULL
      RETURNING id
    ),
    moved AS (
      UPDATE shop_payment_intents
         SET status = ${args.next},
             provider_intent_id = COALESCE(provider_intent_id, ${args.providerIntentId}),
             last_error = ${args.failureReason},
             updated_at = ${now},
             revision = revision + 1
       WHERE id = ${args.intentId}
         AND EXISTS (SELECT 1 FROM claimed)
         AND shop_payment_status_rank(status) < shop_payment_status_rank(${args.next})
      RETURNING id, checkout_id, amount, currency
    ),
    emitted AS (
      INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at, attempts)
      SELECT ${outboxId}, ${eventType}, m.id,
             jsonb_build_object(
               'intentId', m.id,
               'checkoutId', m.checkout_id,
               'amount', m.amount,
               'currency', m.currency,
               'occurredAt', ${now}::bigint
             ) || CASE WHEN ${eventType}::text = 'payment.failed'
                       THEN jsonb_build_object('reason', COALESCE(${args.failureReason}, 'unknown'))
                       ELSE '{}'::jsonb END,
             ${now}, 0
        FROM moved m
       WHERE ${eventType}::text IS NOT NULL
      RETURNING id
    )
    SELECT (SELECT count(*) FROM claimed)::int AS claimed,
           (SELECT count(*) FROM moved)::int AS moved,
           (SELECT id FROM emitted) AS emitted_id`);

  const row = res.rows[0] ?? {};
  return {
    claimed: Number(row.claimed) > 0,
    moved: Number(row.moved) > 0,
    emittedEventId: row.emitted_id == null ? null : String(row.emitted_id),
  };
}

/**
 * Cancel an intent locally.
 *
 * NOTHING IS SENT TO PAYSTACK, because there is nothing to send: it has no
 * endpoint that cancels an uncompleted transaction, and abandoning it IS the
 * cancellation (`capabilities.remoteCancel === false`). Which means the
 * customer can still pay a checkout we have marked cancelled — so the rank
 * ladder puts `cancelled` below `captured` deliberately, and a later
 * `charge.success` moves the intent to `captured` with the anomaly recorded.
 * Refusing that would mean holding money we deny having.
 */
export async function cancelIntent(
  db: Db,
  id: string,
  now: number = Date.now(),
): Promise<PaymentIntentRow> {
  const res = await db.execute(sql`
    UPDATE shop_payment_intents
       SET status = 'cancelled', updated_at = ${now}, revision = revision + 1
     WHERE id = ${id}
       AND shop_payment_status_rank(status) < shop_payment_status_rank('cancelled')
    RETURNING ${INTENT_COLUMNS}`);

  if (res.rows[0]) return mapIntentRow(res.rows[0]);

  /*
   * Zero rows is either "no such intent" (404) or "already past cancellable"
   * (400, permanent). Told apart by a read, and they must be told apart: a 404
   * for an intent that exists and is captured would send a client looking for a
   * row it can see.
   */
  const current = await getIntent(db, id);
  if (!current) throw new NotFoundError(id);
  throw new BadRequestError('status');
}

export { toEpochMsOrNull };
