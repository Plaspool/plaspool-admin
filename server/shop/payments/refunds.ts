import { sql } from 'drizzle-orm';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { toEpochMs, uniqueViolation } from '../../db/client';
import { ProviderError } from './provider/scrub';
import { RefundFailedError, refundFailureOutcome } from './refund-failure';
import { refundId as mintRefundId, eventId as mintEventId } from './ids';
import { getIntent } from './intents';
import { convertMinor, parseMultiplier } from '../../../shared/commerce/fx';
import type { Db } from '../../db/client';
import type { PaymentProvider, ProviderRefund } from './provider/types';

/**
 * Refunds. Admin-initiated only in v1 (contract §13 — there is no customer RMA
 * flow), partial supported, and never able to exceed what was captured.
 *
 * A REFUND IS NOT A NEGATIVE CHARGE AND NOT A CANCELLATION (`03-payments.md`
 * §6). Three distinct states, three distinct code paths: cancelling touches an
 * intent that was never paid, refunding moves money that was.
 *
 * THE SUM-CHECK IS THE HARD PART, AND IT IS NOT WHERE IT LOOKS.
 *
 * The obvious implementation reads `SELECT SUM(amount) FROM shop_refunds WHERE
 * intent_id = $1`, compares it in JS, and inserts. That is wrong under
 * concurrency in the precise way Part 2b documented: two partial refunds
 * arriving together both read a total of 0, both pass, both insert, and
 * together they exceed the capture. The read is against a snapshot the other
 * writer has already invalidated. Mutation-testing that codebase showed every
 * such precondition had ZERO coverage — replacing the predicate with `true`
 * broke none of 254 tests, because every test was satisfied by the JS
 * pre-check.
 *
 * So the total is a COLUMN ON THE INTENT, and the guard is
 * `refunded_total + $new <= amount` inside an UPDATE's own WHERE. Two
 * concurrent updates to one row serialise on the row lock, and Postgres
 * re-evaluates the loser's predicate against the winner's committed row before
 * letting it proceed — so the loser sees the new total and fails. The refund
 * INSERT is fed `FROM` that UPDATE's `RETURNING`, so a failed guard produces
 * zero rows rather than a refund. One statement, no transaction (the Neon HTTP
 * driver rejects `transaction()`), and a CHECK constraint behind it that holds
 * the same invariant against SQL run by hand.
 */

export interface RefundRow {
  id: string;
  intentId: string;
  amount: number;
  currency: string;
  reason: string | null;
  providerRefundId: string | null;
  idempotencyKey: string;
  status: 'pending' | 'succeeded' | 'failed';
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  /**
   * What the gateway is asked to pay back, in the CHARGED currency (1140).
   * `amount`/`currency` stay the naira figure the owner asked to refund. NULL
   * for a refund of a pre-1140 intent, which is refunded in naira as before.
   */
  chargeCurrency: string | null;
  chargeAmountMinor: number | null;
}

const REFUND_COLUMNS = sql`id, intent_id, amount, currency, reason, provider_refund_id,
  idempotency_key, status, created_at, updated_at, created_by, charge_currency,
  charge_amount_minor`;

export function mapRefundRow(row: Record<string, unknown>): RefundRow {
  return {
    id: String(row.id),
    intentId: String(row.intent_id),
    amount: Number(row.amount),
    currency: String(row.currency),
    reason: row.reason == null ? null : String(row.reason),
    providerRefundId: row.provider_refund_id == null ? null : String(row.provider_refund_id),
    idempotencyKey: String(row.idempotency_key),
    status: row.status as RefundRow['status'],
    createdAt: toEpochMs(row.created_at),
    updatedAt: toEpochMs(row.updated_at),
    createdBy: String(row.created_by),
    chargeCurrency: row.charge_currency == null ? null : String(row.charge_currency),
    chargeAmountMinor: row.charge_amount_minor == null ? null : Number(row.charge_amount_minor),
  };
}

export async function listRefunds(db: Db, intentId: string): Promise<RefundRow[]> {
  const res = await db.execute(
    sql`SELECT ${REFUND_COLUMNS} FROM shop_refunds WHERE intent_id = ${intentId}
        ORDER BY created_at ASC, id ASC`,
  );
  return res.rows.map(mapRefundRow);
}

async function getRefundByKey(db: Db, key: string): Promise<RefundRow | null> {
  const res = await db.execute(
    sql`SELECT ${REFUND_COLUMNS} FROM shop_refunds WHERE idempotency_key = ${key}`,
  );
  return res.rows[0] ? mapRefundRow(res.rows[0]) : null;
}

export interface CreateRefundInput {
  intentId: string;
  /** Minor units, positive. Partial when less than what remains. */
  amount: number;
  reason?: string;
  idempotencyKey: string;
  /** `users.id` of the owner who asked for it. */
  createdBy: string;
}

export interface CreateRefundResult {
  refund: RefundRow;
  /** False when this call read through to a refund an earlier call created. */
  created: boolean;
}

/**
 * `provider` MUST BE RESOLVED PER INTENT, NEVER FROM A GLOBAL "the active
 * gateway" SETTING. This function already takes it as a plain call argument
 * rather than reading one off a module-level handle — that part of "per
 * intent, not from a global" was always true here — but the CALLER'S choice
 * of which handle to pass is where the real hazard lives: `shop_payment_settings.
 * active_provider` is an admin-editable switch, and `shop_payment_intents.provider`
 * (`intents.ts`) is fixed forever at the moment a specific intent was created.
 * Those two can disagree the instant an owner flips the switch after a
 * payment has already gone through one gateway. The caller must resolve this
 * argument from THIS intent's own `getIntent(db, intentId).provider` — e.g.
 * `providerFor(intent.provider, factories)` in `routing.ts`, which
 * deliberately takes no `db` and reads no settings row, precisely so it can
 * never be tempted to re-route an already-taken payment — and never from
 * `chooseProvider`/`readPaymentSettings`, which answer "where should a NEW
 * payment go" and are the wrong question for a refund. Passing the currently
 * active gateway's handle here for an intent that was actually taken by the
 * OTHER one refunds through a gateway that never took the money.
 */
export async function createRefund(
  db: Db,
  provider: PaymentProvider,
  input: CreateRefundInput,
  now: number = Date.now(),
): Promise<CreateRefundResult> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new BadRequestError('amount');
  }

  const id = mintRefundId(now);

  /*
   * THE CHARGED SHARE OF THIS REFUND (1140). A converted payment is refunded
   * in the currency it was charged in, never naira and never at today's rate:
   * the naira amount converts at the multiplier STORED on the intent's
   * breakdown, by the same formula that charged it. The statement below caps
   * it at what is left of the charge, and a refund that finishes the naira
   * balance takes exactly what is left — so a full refund always pays back
   * the whole charge, whatever each partial rounded to.
   */
  const before = await getIntent(db, input.intentId);
  const converted =
    before?.chargeBreakdown && before.chargeCurrency && before.chargeCurrency !== before.currency
      ? convertMinor(input.amount, parseMultiplier(before.chargeBreakdown.multiplier), before.chargeCurrency)
      : null;
  if (
    converted !== null &&
    converted <= 0 &&
    before !== null &&
    before.refundedTotal + input.amount !== before.amount
  ) {
    // A few kobo convert to nothing in the charged currency: nothing to send.
    throw new BadRequestError('amount');
  }

  /*
   * THE ROW IS CLAIMED BEFORE THE PROVIDER IS CALLED, and on this provider that
   * ordering is the entire protection against a double refund. Paystack's
   * `POST /refund` has NO idempotency key: calling it twice creates two refunds
   * and pays the customer twice. So winning the UNIQUE `idempotency_key` is
   * what earns the right to make the call, and a retry loses the insert and
   * read-throughs instead of issuing a second one. Reverse these two and the
   * bug is invisible in every test that does not run them concurrently.
   */
  let inserted;
  try {
    /*
     * `locked` TAKES THE ROW LOCK FIRST, so `share` — the charged amount this
     * refund moves — is computed from the row as it stands AFTER any
     * concurrent refund committed, not from a snapshot. The naira guard in
     * `claim` is unchanged; the charged counter rides the same UPDATE, so the
     * two can never disagree about what has been paid back.
     */
    inserted = await db.execute(sql`
      WITH locked AS (
        SELECT id, amount, currency, refunded_total, charge_currency, charge_amount_minor,
               charge_refunded_minor
          FROM shop_payment_intents WHERE id = ${input.intentId}
         FOR UPDATE
      ),
      share AS (
        SELECT l.id,
               CASE
                 WHEN l.charge_currency IS NULL THEN NULL::integer
                 WHEN l.charge_currency = l.currency THEN ${input.amount}::integer
                 WHEN l.refunded_total + ${input.amount} = l.amount
                   THEN l.charge_amount_minor - l.charge_refunded_minor
                 ELSE LEAST(${converted ?? 0}::integer, l.charge_amount_minor - l.charge_refunded_minor)
               END AS charge_amount
          FROM locked l
      ),
      claim AS (
        UPDATE shop_payment_intents
           SET refunded_total = shop_payment_intents.refunded_total + ${input.amount},
               charge_refunded_minor = shop_payment_intents.charge_refunded_minor
                                       + COALESCE(s.charge_amount, 0),
               updated_at = ${now},
               revision = shop_payment_intents.revision + 1
          FROM share s
         WHERE shop_payment_intents.id = s.id
           AND shop_payment_intents.status IN ('captured', 'partially_refunded')
           AND shop_payment_intents.refunded_total + ${input.amount}
               <= shop_payment_intents.amount
        RETURNING shop_payment_intents.id, shop_payment_intents.currency,
                  shop_payment_intents.charge_currency, s.charge_amount
      )
      INSERT INTO shop_refunds
        (id, intent_id, amount, currency, reason, idempotency_key, status,
         created_at, updated_at, created_by, charge_currency, charge_amount_minor)
      SELECT ${id}, c.id, ${input.amount}, c.currency, ${input.reason ?? null},
             ${input.idempotencyKey}, 'pending', ${now}, ${now}, ${input.createdBy},
             CASE WHEN c.charge_amount IS NULL THEN NULL ELSE c.charge_currency END,
             c.charge_amount
        FROM claim c
      RETURNING ${REFUND_COLUMNS}`);
  } catch (err) {
    /*
     * A UNIQUE violation on `idempotency_key` is the read-through path, and it
     * is reached by the CONSTRAINT firing rather than by a prior SELECT (§5).
     *
     * Note what Postgres does for us here and why it matters: the whole
     * statement is atomic, so when the INSERT raises, the `claim` CTE's
     * increment of `refunded_total` is rolled back with it. A retry therefore
     * does not silently consume more of the refundable balance every time it is
     * attempted — which it would if the reservation and the insert were two
     * statements.
     */
    if (uniqueViolation(err) === 'shop_refunds_idempotency_key_unique') {
      const replayed = await replayByKey(db, input.idempotencyKey);
      if (replayed) return replayed;
    }
    throw err;
  }

  if (!inserted.rows[0]) {
    /*
     * THE KEY IS ASKED FIRST. A refund already holding this amount makes the
     * sum-check refuse before the INSERT can meet the key, so a retry of a
     * full refund never reached the read-through above and came back
     * `bad_request: amount` — which is what the cancel route's fixed key sends
     * after a refund nobody could confirm.
     */
    const replayed = await replayByKey(db, input.idempotencyKey);
    if (replayed) return replayed;

    /*
     * Zero rows means the guard refused. Which guard, told apart by a read —
     * and all three answers are 400, because all three are PERMANENT. Contract
     * §10: a 500 is retried five times with backoff, so a refund that can never
     * be accepted must not be one.
     */
    const intent = await getIntent(db, input.intentId);
    if (!intent) throw new NotFoundError(input.intentId);
    throw new BadRequestError(
      intent.status === 'captured' || intent.status === 'partially_refunded'
        ? 'amount' // would exceed what was captured
        : 'status', // nothing was captured to refund
    );
  }

  const refund = mapRefundRow(inserted.rows[0]);
  const intent = await getIntent(db, input.intentId);
  if (!intent?.providerIntentId) throw new BadRequestError('provider_intent_id');

  let providerRefund: ProviderRefund;
  try {
    providerRefund = await provider.refund(
      {
        providerIntentId: intent.providerIntentId,
        // In the currency it was CHARGED in (1140); naira for a pre-1140 refund.
        amount: refund.chargeAmountMinor ?? refund.amount,
        currency: refund.chargeCurrency ?? refund.currency,
        merchantNote: input.reason,
      },
      input.idempotencyKey,
    );
  } catch (err) {
    const code = err instanceof ProviderError ? err.code : 'unknown';
    const outcome = refundFailureOutcome(code);
    /*
     * THE DISTINCTION THAT DECIDES WHETHER A CUSTOMER IS PAID TWICE.
     *
     * A CLEAR REFUSAL (the gateway read the request and said no) means no money
     * moved, so the reservation is released and the refund is marked failed —
     * the balance becomes refundable again, which is correct and necessary.
     *
     * ANYTHING ELSE MEANS WE DO NOT KNOW — a timeout, a dropped connection, a
     * 5xx, an answer the adapter could not read. The refund may well have been
     * created. Releasing the reservation there lets an operator refund the same
     * money again and find out from the bank. So the row stays `pending` with
     * its amount held (owner's rule, 2026-09-15), and it is REPORTED rather than
     * returned: no webhook can ever match a row with no gateway id, so this
     * used to be a 201 the screen called "Refunded" for a refund that then
     * never settled. The owner settles it from the order page
     * (`resolveUnconfirmedRefund`).
     *
     * NAMED, NOT RETHROWN, either way. A bare `ProviderError` has no row in the
     * error table, so a gateway's plain "no" reached the owner as `internal`.
     */
    if (outcome === 'refused') {
      await releaseRefusedRefund(db, refund.id, now);
    } else {
      logUnconfirmed(refund.id, intent.provider, code, err);
    }
    throw new RefundFailedError({ provider: intent.provider, outcome, code });
  }

  /*
   * A GATEWAY THAT ANSWERS "FAILED" HAS REFUSED. Stored as this row's result it
   * went back to the caller as a refund, with the amount still reserved against
   * money that never moved.
   */
  if (providerRefund.status === 'failed') {
    await releaseRefusedRefund(db, refund.id, now);
    throw new RefundFailedError({ provider: intent.provider, outcome: 'refused', code: 'declined' });
  }

  /*
   * RECORDED, AND SETTLED IN THE SAME STATEMENT WHEN THE GATEWAY SAYS IT IS
   * DONE. Flutterwave usually answers "completed" at once, and that used to be
   * stored as `succeeded` and nothing else: the intent never moved and no
   * `payment.refunded` was written, so the order never showed the refund — and
   * Flutterwave's refund notifications are never processed to do it later.
   * A `pending` answer is recorded only; its webhook settles it.
   */
  let recorded;
  try {
    recorded = await db.execute(sql`
      WITH recorded AS (
        UPDATE shop_refunds
           SET provider_refund_id = ${providerRefund.providerRefundId},
               status = ${providerRefund.status},
               updated_at = ${now}
         WHERE id = ${refund.id} AND provider_refund_id IS NULL
        RETURNING ${REFUND_COLUMNS}
      ),
      settled AS (
        SELECT id, intent_id, amount FROM recorded WHERE status = 'succeeded'
      ),
      ${refundedEffects(mintEventId(now), now)}
      SELECT * FROM recorded`);
  } catch (err) {
    /*
     * THE GATEWAY SAID YES AND THIS WRITE FAILED. The money is moving, so the
     * row stays pending and the amount stays held. This catch used to share
     * the gateway call's, which released the amount — a refund that had been
     * sent became refundable again.
     */
    logUnconfirmed(refund.id, intent.provider, 'unknown', err);
    throw new RefundFailedError({ provider: intent.provider, outcome: 'unconfirmed', code: 'unknown' });
  }
  return {
    refund: recorded.rows[0] ? mapRefundRow(recorded.rows[0]) : refund,
    created: true,
  };
}

/**
 * How old a pending refund with no gateway id must be before a person may
 * settle it by hand.
 *
 * Until then its gateway call may still be running: both adapters abort after
 * 10 s (`DEFAULT_TIMEOUT_MS` in `provider/paystack.ts` and
 * `provider/flutterwave.ts`) and `vercel.json` stops the function at 30 s. A row
 * twice that old with no gateway id is not in flight. It is a refund nobody
 * could confirm — including one whose function was stopped mid-call and never
 * got to say so.
 */
export const UNCONFIRMED_AFTER_MS = 60_000;

/** Pending, and the gateway's answer never recorded: held until settled by hand. */
function isUnconfirmed(refund: RefundRow): boolean {
  return refund.status === 'pending' && refund.providerRefundId === null;
}

/**
 * The earlier call's result for this key, or `null` when there was none.
 *
 * ONLY A REFUND THE GATEWAY ANSWERED IS A RESULT TO REPLAY. A failed row handed
 * back was a 200 the screen toasted as "Refunded" (production, 2026-09-15), and
 * so is a pending row with no gateway id — a refund nobody could confirm, held
 * for the owner to settle. A clear refusal frees its key
 * (`releaseRefusedRefund`), so a failed row found here is one the gateway
 * failed later by webhook. None of these may be answered as a refund, or sent
 * to the gateway again, before somebody has looked.
 */
async function replayByKey(db: Db, key: string): Promise<CreateRefundResult | null> {
  const existing = await getRefundByKey(db, key);
  if (!existing) return null;
  if (existing.status === 'failed' || isUnconfirmed(existing)) {
    const paidThrough = await getIntent(db, existing.intentId);
    if (!paidThrough) throw new NotFoundError(existing.intentId);
    throw new RefundFailedError({ provider: paidThrough.provider, outcome: 'unconfirmed', code: 'unknown' });
  }
  return { refund: existing, created: false };
}

/**
 * The only record of an unknown result, because the error table does not log
 * an answered 4xx. Enumerated fields and an error NAME only — never a message,
 * which is where a gateway body or a query parameter would ride along
 * (`provider/scrub.ts`).
 */
function logUnconfirmed(refundId: string, provider: string, code: string, err: unknown): void {
  // eslint-disable-next-line no-console -- an unconfirmed refund needs a person, and this is where one looks
  console.error(
    '[payments] refund unconfirmed, amount held',
    JSON.stringify({ refundId, provider, code, error: err instanceof Error ? err.name : typeof err }),
  );
}

/**
 * The succeeded half of a settlement, as CTEs over a `settled` CTE of
 * (id, intent_id, amount): move the intent, and write `payment.refunded` so
 * Orders updates the order, emails the customer and gives points back. The same
 * two effects `applyRefundEvent` has for a webhook's `succeeded`, for the two
 * paths no webhook ever reaches — a gateway that finishes the refund at once,
 * and an owner saying an unconfirmed one went through.
 *
 * The intent's status is a function of its `refunded_total`, which already
 * holds this refund's reservation — see `applyRefundEvent` for why it is not
 * rank-guarded.
 */
function refundedEffects(outboxId: string, now: number) {
  return sql`
    intent AS (
      UPDATE shop_payment_intents i
         SET status = CASE WHEN i.refunded_total >= i.amount THEN 'refunded'
                           ELSE 'partially_refunded' END,
             updated_at = ${now},
             revision = i.revision + 1
       WHERE i.id = (SELECT intent_id FROM settled)
      RETURNING i.id, i.checkout_id, i.amount, i.currency, i.refunded_total
    ),
    emitted AS (
      INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at, attempts)
      SELECT ${outboxId}, 'payment.refunded', i.id,
             jsonb_build_object(
               'intentId', i.id,
               'checkoutId', i.checkout_id,
               'amount', i.amount,
               'currency', i.currency,
               'occurredAt', ${now}::bigint,
               'refundId', s.id,
               'refundedAmount', s.amount,
               'refundedTotal', i.refunded_total,
               'remainingBalance', i.amount - i.refunded_total
             ),
             ${now}, 0
        FROM intent i JOIN settled s ON s.intent_id = i.id
      RETURNING id
    )`;
}

/**
 * Mark a refund failed, give its reservation back, and free its key — in one
 * statement. For a refund where NOTHING MOVED: the gateway refused it, or the
 * owner checked and it never went out.
 *
 * Gated on `status = 'pending'` so that a concurrent webhook that already
 * settled it cannot be undone, and so the release cannot happen twice — a
 * double release would understate `refunded_total` and let the same money be
 * refunded again.
 *
 * THE KEY IS FREED because it exists to stop a second refund while the first
 * may still be moving money, and nothing is moving. Left taken, the same click
 * reads the refusal back forever — for the cancel route, whose key is fixed,
 * an order that could never be cancelled with that refund. So the failed row
 * keeps its key with its own id appended (still unique, still readable) and
 * the original key is free again.
 */
async function releaseRefusedRefund(db: Db, id: string, now: number): Promise<void> {
  await db.execute(sql`
    WITH failed AS (
      UPDATE shop_refunds
         SET status = 'failed', updated_at = ${now},
             idempotency_key = idempotency_key || ':refused:' || id
       WHERE id = ${id} AND status = 'pending'
      RETURNING intent_id, amount, charge_amount_minor
    )
    UPDATE shop_payment_intents i
       SET refunded_total = i.refunded_total - f.amount,
           charge_refunded_minor = i.charge_refunded_minor - COALESCE(f.charge_amount_minor, 0),
           updated_at = ${now}
      FROM failed f
     WHERE i.id = f.intent_id`);
}

/** Refunds held against a payment because nobody could confirm them, oldest first. */
export async function listUnconfirmedRefunds(db: Db, intentId: string): Promise<RefundRow[]> {
  const res = await db.execute(sql`
    SELECT ${REFUND_COLUMNS} FROM shop_refunds
     WHERE intent_id = ${intentId} AND status = 'pending' AND provider_refund_id IS NULL
     ORDER BY created_at ASC, id ASC`);
  return res.rows.map(mapRefundRow);
}

export type ResolveRefundOutcome = 'sent' | 'not_sent';

export type ResolveRefundResult =
  | { ok: true; refund: RefundRow }
  | { ok: false; reason: 'gone' | 'not_unconfirmed' | 'too_new' };

/**
 * The owner settles a refund nobody could confirm, after checking the gateway's
 * dashboard (owner's rule, 2026-09-15).
 *
 * - `sent`: it went through. The refund succeeds, the amount stays counted, and
 *   `payment.refunded` tells Orders — the same effects as a webhook's success.
 * - `not_sent`: it never went out. Released exactly like a refusal, key freed.
 *   No `payment.refund_failed`: the customer was never told a refund was
 *   coming, so an email saying it failed would be the first they heard of it.
 *
 * THE GUARD IS THE STATEMENT'S OWN WHERE — pending, no gateway id, and older
 * than `UNCONFIRMED_AFTER_MS` — never a read before it. The read after a
 * refusal only explains which part said no.
 */
export async function resolveUnconfirmedRefund(
  db: Db,
  refundId: string,
  outcome: ResolveRefundOutcome,
  now: number = Date.now(),
): Promise<ResolveRefundResult> {
  const cutoff = now - UNCONFIRMED_AFTER_MS;
  const held = sql`
    id = ${refundId} AND status = 'pending' AND provider_refund_id IS NULL
    AND created_at <= ${cutoff}`;

  const res =
    outcome === 'sent'
      ? await db.execute(sql`
          WITH settled AS (
            UPDATE shop_refunds SET status = 'succeeded', updated_at = ${now}
             WHERE ${held}
            RETURNING ${REFUND_COLUMNS}
          ),
          ${refundedEffects(mintEventId(now), now)}
          SELECT * FROM settled`)
      : await db.execute(sql`
          WITH settled AS (
            UPDATE shop_refunds
               SET status = 'failed', updated_at = ${now},
                   idempotency_key = idempotency_key || ':refused:' || id
             WHERE ${held}
            RETURNING ${REFUND_COLUMNS}
          ),
          released AS (
            UPDATE shop_payment_intents i
               SET refunded_total = i.refunded_total - s.amount, updated_at = ${now}
              FROM settled s
             WHERE i.id = s.intent_id
            RETURNING i.id
          )
          SELECT * FROM settled`);

  if (res.rows[0]) return { ok: true, refund: mapRefundRow(res.rows[0]) };

  const current = await db.execute(sql`SELECT ${REFUND_COLUMNS} FROM shop_refunds WHERE id = ${refundId}`);
  if (!current.rows[0]) return { ok: false, reason: 'gone' };
  const row = mapRefundRow(current.rows[0]);
  return { ok: false, reason: isUnconfirmed(row) && row.createdAt > cutoff ? 'too_new' : 'not_unconfirmed' };
}

export interface ApplyRefundResult {
  claimed: boolean;
  settled: boolean;
  emittedEventId: string | null;
  /** The refund could not be matched; the event is left for a later drain. */
  unresolved: boolean;
}

/**
 * Apply a verified `refund.*` webhook.
 *
 * `payment.refunded` IS EMITTED HERE AND NOT AT CREATION, because a refund is
 * asynchronous on this provider: Paystack answers `POST /refund` with
 * `pending` and settles later. Announcing "refunded" when the request was
 * merely accepted would tell Orders money had moved that may still fail.
 *
 * `payment.refund_failed` IS EMITTED HERE TOO (task-d4), on the opposite
 * settlement. Until this existed, a refund the provider ACCEPTED and later
 * failed to settle unwound perfectly on this side — the refund row, the
 * reservation, the intent's status — and told nobody: the `emitted` CTE below
 * only matched `succeeded`. That was inert while nothing acted on an
 * accepted-but-unsettled refund; it stopped being inert once cancelling a paid
 * order started refunding first and cancelling on anything short of a thrown
 * error (`b9051ab`), which meant a provider's ordinary `pending` could be
 * followed by a `failed` against an order already gone. `emitted_failed`
 * mirrors `emitted`'s shape with the opposite `WHERE`, so a redelivered
 * settlement is exactly as inert as the succeeded arm already was.
 *
 * THE INTENT'S NEW STATUS IS DERIVED FROM `refunded_total`, AND IS THE ONE
 * TRANSITION IN THIS SUBSYSTEM THAT IS NOT RANK-GUARDED. Everywhere else,
 * `shop_payment_status_rank` refuses a move that would pull an intent
 * backwards, because webhooks arrive out of order. Here that guard would be
 * actively wrong: this is not a transition, it is a FUNCTION of a column that
 * is authoritative and moves in BOTH directions — a failed refund gives its
 * reservation back. Rank-guarded, an intent whose only refund later failed
 * would be pinned at `refunded` forever.
 *
 * AN UNRESOLVED REFUND IS LEFT UNPROCESSED ON PURPOSE, and this differs from
 * the intent path deliberately. A `refund.pending` webhook can genuinely beat
 * our own `UPDATE … SET provider_refund_id` by a few milliseconds, so the row
 * we need may exist a moment later — marking the event processed would discard
 * a real event over a race. An intent event cannot have that race (the intent
 * is written before the reference can be paid), so there the unresolved case is
 * terminal and IS marked. The cost here is that an event that never resolves
 * stays pending forever with `last_error = 'unresolved_refund'`, which is one
 * cheap UPDATE per drain and a monitorable condition rather than silent loss.
 */
export async function applyRefundEvent(
  db: Db,
  args: {
    eventRowId: string;
    providerRefundId: string;
    status: 'pending' | 'succeeded' | 'failed';
  },
  now: number = Date.now(),
): Promise<ApplyRefundResult> {
  const outboxId = mintEventId(now);

  if (args.status === 'pending') {
    // Nothing to settle. Acknowledge it so the provider stops redelivering.
    const res = await db.execute(sql`
      UPDATE shop_payment_events SET processed_at = ${now}
       WHERE id = ${args.eventRowId} AND processed_at IS NULL
      RETURNING id`);
    return {
      claimed: res.rows.length > 0,
      settled: false,
      emittedEventId: null,
      unresolved: false,
    };
  }

  const target = args.status === 'succeeded' ? 'succeeded' : 'failed';

  const res = await db.execute(sql`
    WITH cur AS (
      SELECT id, intent_id, amount FROM shop_refunds
       WHERE provider_refund_id = ${args.providerRefundId}
    ),
    claimed AS (
      -- The casts are load-bearing. A bound parameter arrives with no declared
      -- type, so CASE WHEN ... THEN $1 ELSE NULL END resolves to text, and
      -- assigning that to a bigint column is SQLSTATE 42804. Measured, not
      -- predicted: five tests in this file failed exactly that way first.
      UPDATE shop_payment_events
         SET processed_at = CASE WHEN EXISTS (SELECT 1 FROM cur)
                                 THEN ${now}::bigint ELSE NULL::bigint END,
             last_error = CASE WHEN EXISTS (SELECT 1 FROM cur) THEN NULL::text
                               ELSE 'unresolved_refund'::text END
       WHERE id = ${args.eventRowId} AND processed_at IS NULL
      RETURNING id
    ),
    settled AS (
      UPDATE shop_refunds r
         SET status = ${target}, updated_at = ${now}
       WHERE r.id = (SELECT id FROM cur)
         AND r.status = 'pending'
         AND EXISTS (SELECT 1 FROM claimed)
         AND EXISTS (SELECT 1 FROM cur)
      RETURNING r.id, r.intent_id, r.amount, r.charge_currency, r.charge_amount_minor
    ),
    intent AS (
      UPDATE shop_payment_intents i
         SET refunded_total = CASE WHEN ${target}::text = 'failed'
                                   THEN i.refunded_total - (SELECT amount FROM settled)
                                   ELSE i.refunded_total END,
             -- The charged twin gives its reservation back with it (1140).
             charge_refunded_minor = CASE WHEN ${target}::text = 'failed'
                                   THEN i.charge_refunded_minor
                                        - COALESCE((SELECT charge_amount_minor FROM settled), 0)
                                   ELSE i.charge_refunded_minor END,
             -- Derived from the total, and deliberately NOT rank-guarded.
             -- See the note above this function.
             status = CASE
               WHEN ${target}::text = 'failed' AND i.refunded_total - (SELECT amount FROM settled) <= 0
                 THEN 'captured'
               WHEN ${target}::text = 'failed'
                 THEN 'partially_refunded'
               WHEN i.refunded_total >= i.amount THEN 'refunded'
               ELSE 'partially_refunded'
             END,
             updated_at = ${now},
             revision = i.revision + 1
       WHERE i.id = (SELECT intent_id FROM settled)
      RETURNING i.id, i.checkout_id, i.amount, i.currency, i.refunded_total
    ),
    emitted AS (
      INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at, attempts)
      SELECT ${outboxId}, 'payment.refunded', i.id,
             jsonb_build_object(
               'intentId', i.id,
               'checkoutId', i.checkout_id,
               'amount', i.amount,
               'currency', i.currency,
               'occurredAt', ${now}::bigint,
               'refundId', s.id,
               'refundedAmount', s.amount,
               'refundedTotal', i.refunded_total,
               'remainingBalance', i.amount - i.refunded_total
             )
             -- What actually went back, in the charged currency (1140).
             || CASE WHEN s.charge_currency IS NULL THEN '{}'::jsonb
                     ELSE jsonb_build_object('chargeRefund', jsonb_build_object(
                       'currency', s.charge_currency, 'amount', s.charge_amount_minor)) END,
             ${now}, 0
        FROM intent i JOIN settled s ON s.intent_id = i.id
       WHERE ${target}::text = 'succeeded'
      RETURNING id
    ),
    -- task-d4: THE OTHER HALF OF emitted, AND THE WHOLE POINT OF THIS TASK.
    --
    -- SQL comments here, not a JS block comment: this whole WITH clause is
    -- one tagged template literal, and an unescaped backtick in a JS-style
    -- comment placed inside it would close the template early. Every note
    -- below stays backtick-free for the same reason.
    --
    -- Same shape, same intent/settled join, opposite WHERE -- a pure
    -- addition sitting beside the succeeded arm rather than a change to it.
    -- outboxId is safely reused: target is one value for the whole
    -- statement, so exactly one of emitted/emitted_failed ever produces a
    -- row per call and there is never a collision.
    --
    -- Payments unwinds itself correctly on a failed settlement -- settled
    -- marks the refund row failed, intent gives the reservation back -- and
    -- until this arm existed it told nobody. That was harmless while nothing
    -- downstream acted on an accepted-but-unsettled refund; it stopped being
    -- harmless when cancelling a paid order (b9051ab) started refunding
    -- FIRST and cancelling on anything short of a thrown error, including
    -- the provider's ordinary pending. A refund accepted and later failed
    -- left a cancelled order and no signal the money never moved.
    --
    -- refundedTotal here is the POST-UNWIND figure, not a total that grew:
    -- i.refunded_total was read AFTER the intent CTE's own CASE already
    -- subtracted this failed amount back out, so a consumer is told the
    -- balance as it now stands, not as it stood before the failure.
    emitted_failed AS (
      INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at, attempts)
      SELECT ${outboxId}, 'payment.refund_failed', i.id,
             jsonb_build_object(
               'intentId', i.id,
               'checkoutId', i.checkout_id,
               'amount', i.amount,
               'currency', i.currency,
               'occurredAt', ${now}::bigint,
               'refundId', s.id,
               'failedAmount', s.amount,
               'refundedTotal', i.refunded_total
             ),
             ${now}, 0
        FROM intent i JOIN settled s ON s.intent_id = i.id
       WHERE ${target}::text = 'failed'
      RETURNING id
    )
    SELECT (SELECT count(*) FROM claimed)::int AS claimed,
           (SELECT count(*) FROM settled)::int AS settled,
           (SELECT count(*) FROM cur)::int AS resolved,
           COALESCE((SELECT id FROM emitted), (SELECT id FROM emitted_failed)) AS emitted_id`);

  const row = res.rows[0] ?? {};
  return {
    claimed: Number(row.claimed) > 0,
    settled: Number(row.settled) > 0,
    emittedEventId: row.emitted_id == null ? null : String(row.emitted_id),
    unresolved: Number(row.resolved) === 0,
  };
}
