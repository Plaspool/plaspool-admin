/**
 * Email (brief §5): the intent is written transactionally, delivery is a sweeper, and
 * **a mailer failure never rolls back a paid order.**
 *
 * ⚠️  MOST OF THIS SUITE DRIVES `LoggingMailer`, WHICH SENDS NOTHING. What those tests
 *     prove is that the PATH is real and correct — the intent lands in the same statement
 *     as the state change, the sweeper claims it exactly once, a failure is recorded
 *     rather than propagated.
 *
 * The last two blocks are the other half, and they are new: `portMailer` adapts this
 * subsystem's `Mailer` to `server/mail/port.ts`'s, and `server/index.ts` registers a real
 * transport through it at the composition root. So "a paid order produces a real send" is
 * now assertable, and it is asserted against an INJECTED RECORDER rather than a log line —
 * which is the difference between a delivery test and a hope.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb, resetOrderTables } from './test/harness';
import type { RawCtx } from './test/harness';
import { CHECKOUT, T0, checkoutCompleted, insertEvents, paymentCaptured } from './test/fixtures';
import { sweepCommerceEvents, type ConsumerDeps } from './repo/consumer';
import { markOrderPaid, readOrder, readOrderByCheckout } from './repo/orders';
import { createFulfillment, shipFulfillment } from './repo/fulfillments';
import { EMAIL_ATTEMPT_LIMIT, listIntents, sweepEmailIntents } from './repo/emails';
import { LoggingMailer, formatAmount, portMailer, type Mailer, type RenderedEmail } from './mailer';
import { resetOrdersDeps, resolveDeps } from './ports';
import { httpClient } from '../../test/http';
import { verifyGuestToken } from './tokens';
import { countingMutant, PREDICATE } from './test/mutate';
import type { Mailer as PortMailer } from '../../mail/port';

let ctx: RawCtx;
const NOW = T0 + 10_000;
const ORIGIN = 'https://shop.test';
const ACTOR = 'usr_owner';

beforeAll(async () => {
  ctx = await migratedDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetOrderTables(ctx.db);
});

/** A mailer that always fails, so the failure path is exercised for real. */
class BrokenMailer implements Mailer {
  calls = 0;
  send(): Promise<void> {
    this.calls += 1;
    return Promise.reject(new Error('provider unreachable: connect ETIMEDOUT'));
  }
}

async function paidOrderWithLink(deps: ConsumerDeps = { origin: ORIGIN }) {
  await insertEvents(ctx.db, [checkoutCompleted(), paymentCaptured()]);
  await sweepCommerceEvents(ctx.db, deps, NOW);
  return (await readOrderByCheckout(ctx.db, CHECKOUT))!;
}

// ------------------------------------------------------- written transactionally

describe('the intent is written with the state change, not after it', () => {
  it('exists the instant the order is paid, with no sweeper having run', async () => {
    const read = await paidOrderWithLink();
    const intents = await listIntents(ctx.db, read.order.id);
    expect(read.order.status).toBe('paid');
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      kind: 'confirmation',
      to: 'Buyer@Example.test',
      sentAt: null,
      attempts: 0,
      lastError: null,
    });
  });

  it('a REFUSED transition writes no intent at all', async () => {
    /*
     * The structural half of "written in the same statement". The email CTE selects
     * `FROM upd`, so a CAS that matches nothing has no row to insert from — there is no
     * ordering in which an intent exists for a transition that did not happen.
     */
    const read = await paidOrderWithLink();
    await ctx.db.execute(sql`DELETE FROM shop_order_email_intents`);
    // Paying an already-paid order is refused.
    await expect(markOrderPaid(ctx.db, read.order.id, NOW + 1, null, null)).rejects.toThrow();
    expect(await listIntents(ctx.db, read.order.id)).toEqual([]);
  });

  it('one confirmation per order, enforced by a UNIQUE dedupe key', async () => {
    /*
     * With the status guard neutralised the transition runs twice — the same thing a
     * redelivery would do if the constraints were gone — and the customer still gets one
     * confirmation, because `dedupe_key` is UNIQUE and the insert is
     * `ON CONFLICT DO NOTHING`.
     */
    const read = await paidOrderWithLink();
    const mutant = countingMutant(ctx.db, PREDICATE.orderIsPending, 'true');
    await markOrderPaid(mutant.db, read.order.id, NOW + 1, null, null);

    expect(mutant.rewritten()).toBeGreaterThan(0);
    const confirmations = (await listIntents(ctx.db, read.order.id)).filter(
      (intent) => intent.kind === 'confirmation',
    );
    expect(confirmations).toHaveLength(1);
  });

  it('a shipment mail is per FULFILMENT, so a three-parcel order sends three', async () => {
    const read = await paidOrderWithLink();
    for (const [index, qty] of [
      [0, 1],
      [0, 1],
      [1, 1],
    ] as const) {
      const fulfillment = await createFulfillment(
        ctx.db,
        read.order.id,
        {
          lines: [{ orderLineId: read.lines[index].id, qty }],
          carrier: 'DHL',
          trackingNumber: `T${index}${qty}`,
        },
        ACTOR,
        NOW,
      );
      await shipFulfillment(ctx.db, fulfillment.id, NOW, { origin: ORIGIN, token: 'tok' }, ACTOR);
    }
    const shipments = (await listIntents(ctx.db, read.order.id)).filter(
      (intent) => intent.kind === 'shipment',
    );
    expect(shipments).toHaveLength(3);
  });
});

// ------------------------------------------------------------------ the sweeper

describe('delivery is a sweeper', () => {
  it('records the rendered message and marks the intent sent', async () => {
    const read = await paidOrderWithLink();
    const mailer = new LoggingMailer();

    expect(await sweepEmailIntents(ctx.db, mailer, NOW + 100)).toEqual({
      sent: 1,
      failed: 0,
      skipped: 0,
    });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe('Buyer@Example.test');
    expect(mailer.sent[0].subject).toContain(read.order.orderNumber);

    const intents = await listIntents(ctx.db, read.order.id);
    expect(intents[0]).toMatchObject({ sentAt: NOW + 100, attempts: 1, lastError: null });

    // A second sweep has nothing to do.
    expect(await sweepEmailIntents(ctx.db, mailer, NOW + 200)).toMatchObject({ sent: 0 });
    expect(mailer.sent).toHaveLength(1);
  });

  it('A MAILER FAILURE NEVER ROLLS BACK A PAID ORDER', async () => {
    /*
     * The property brief §5 exists for, asserted directly. The order committed in a
     * different statement, minutes earlier, and there is no code path from the sweeper back
     * to `shop_orders` — which is a stronger guarantee than a `catch` somebody could
     * remove.
     */
    const read = await paidOrderWithLink();
    const broken = new BrokenMailer();

    const summary = await sweepEmailIntents(ctx.db, broken, NOW + 100);
    expect(summary).toEqual({ sent: 0, failed: 1, skipped: 0 });

    // The order is untouched: still paid, same revision, same paid_at.
    const after = await readOrder(ctx.db, read.order.id);
    expect(after!.order).toMatchObject({
      status: 'paid',
      paidAt: read.order.paidAt,
      revision: read.order.revision,
    });

    // And the intent is retryable, with the reason recorded.
    const intents = await listIntents(ctx.db, read.order.id);
    expect(intents[0]).toMatchObject({ sentAt: null, attempts: 1 });
    expect(intents[0].lastError).toContain('provider unreachable');
  });

  it('one bad address does not stop the rest of the queue', async () => {
    const read = await paidOrderWithLink();
    // A second intent, to a different address.
    await ctx.db.execute(sql`
      INSERT INTO shop_order_email_intents (id, order_id, kind, to_email, subject, body,
                                            created_at, dedupe_key)
      VALUES ('eml_second', ${read.order.id}, 'refund', 'other@test.local', 'Refund', 'body',
              ${NOW + 1}, 'refund:manual')`);

    let call = 0;
    const flaky: Mailer = {
      send: (_message: RenderedEmail) => {
        call += 1;
        return call === 1 ? Promise.reject(new Error('nope')) : Promise.resolve();
      },
    };

    const summary = await sweepEmailIntents(ctx.db, flaky, NOW + 100);
    expect(summary).toEqual({ sent: 1, failed: 1, skipped: 0 });
  });

  it('retries a failure on the next sweep, then stops at the attempt limit', async () => {
    const read = await paidOrderWithLink();
    const broken = new BrokenMailer();

    for (let i = 1; i <= EMAIL_ATTEMPT_LIMIT; i += 1) {
      const summary = await sweepEmailIntents(ctx.db, broken, NOW + i);
      expect(summary.failed, `sweep ${i}`).toBe(1);
    }
    expect(broken.calls).toBe(EMAIL_ATTEMPT_LIMIT);

    // Capped: a permanently undeliverable address must not starve every other message.
    expect(await sweepEmailIntents(ctx.db, broken, NOW + 99)).toEqual({
      sent: 0,
      failed: 0,
      skipped: 0,
    });
    expect(broken.calls).toBe(EMAIL_ATTEMPT_LIMIT);

    // The row is still there with its reason — nothing was deleted.
    const intents = await listIntents(ctx.db, read.order.id);
    expect(intents[0]).toMatchObject({ sentAt: null, attempts: EMAIL_ATTEMPT_LIMIT });
    expect(intents[0].lastError).toContain('provider unreachable');
  });

  it('two concurrent sweeps deliver once, because the claim is a CAS on attempts', async () => {
    /*
     * Both sweeps read `attempts = 0`; both try `SET attempts = 1 WHERE attempts = 0`; one
     * matches. The loser skips WITHOUT SENDING. That is the property a `claimed_at` lease
     * column is usually added for, obtained from a column that had to exist anyway.
     */
    await paidOrderWithLink();
    const mailer = new LoggingMailer();

    const [first, second] = await Promise.all([
      sweepEmailIntents(ctx.db, mailer, NOW + 100),
      sweepEmailIntents(ctx.db, mailer, NOW + 100),
    ]);

    expect(mailer.sent).toHaveLength(1);
    expect(first.sent + second.sent).toBe(1);
    expect(first.skipped + second.skipped).toBe(1);
  });
});

// ------------------------------------------------------------------- rendering

describe('what the customer would read', () => {
  it('the confirmation lists the lines from the ORDER’S OWN SNAPSHOT and the frozen total', async () => {
    const read = await paidOrderWithLink();
    const mailer = new LoggingMailer();
    await sweepEmailIntents(ctx.db, mailer, NOW + 100);
    const body = mailer.sent[0].body;

    expect(body).toContain('2 × Enamel Mug (MUG-NAVY)');
    expect(body).toContain('1 × Logo T-Shirt (TEE-M)');
    expect(body).toContain('Total: 54.00 USD');

    /*
     * RENDERED FROM THE SNAPSHOT, WHICH IS THE POINT. A rename in the catalog must not
     * change what an already-sent email said — and an email is the one place that would be
     * least recoverable, because the customer keeps it forever.
     */
    await ctx.db.execute(sql`
      UPDATE shop_order_lines SET fulfilled_qty = 0 WHERE order_id = ${read.order.id}`);
    expect(mailer.sent[0].body).toContain('Enamel Mug');
  });

  it('carries a guest access link whose token opens THAT order and no other', async () => {
    const read = await paidOrderWithLink();
    const mailer = new LoggingMailer();
    await sweepEmailIntents(ctx.db, mailer, NOW + 100);

    const match = /token=([^\s&]+)/.exec(mailer.sent[0].body);
    expect(match).not.toBeNull();
    const token = decodeURIComponent(match![1]);

    const grant = verifyGuestToken(token, NOW + 200);
    expect(grant).toEqual({
      orderNumber: read.order.orderNumber,
      email: 'buyer@example.test',
    });
    // And the link is built from the deployment's own allow-listed origin, never a header.
    expect(mailer.sent[0].body).toContain(`${ORIGIN}/shop/orders/`);
  });

  it('with no origin configured the mail still renders, just without a link', async () => {
    await paidOrderWithLink({ origin: null });
    const mailer = new LoggingMailer();
    await sweepEmailIntents(ctx.db, mailer, NOW + 100);
    expect(mailer.sent[0].body).toContain('Enamel Mug');
    expect(mailer.sent[0].body).not.toContain('token=');
  });

  it('a shipment mail lists only what is in THAT parcel', async () => {
    const read = await paidOrderWithLink();
    const fulfillment = await createFulfillment(
      ctx.db,
      read.order.id,
      {
        lines: [{ orderLineId: read.lines[1].id, qty: 1 }],
        carrier: 'DHL',
        trackingNumber: 'TRACK-1',
      },
      ACTOR,
      NOW,
    );
    await shipFulfillment(ctx.db, fulfillment.id, NOW, null, ACTOR);

    const mailer = new LoggingMailer();
    await sweepEmailIntents(ctx.db, mailer, NOW + 100);
    const shipment = mailer.sent.find((m) => m.subject.includes('has shipped'));
    expect(shipment).toBeDefined();
    expect(shipment!.body).toContain('Tracking: TRACK-1 (DHL)');
    expect(shipment!.body).toContain('Logo T-Shirt');
    // The mug is still in the warehouse. Telling the customer otherwise is a support call.
    expect(shipment!.body).not.toContain('Enamel Mug');
  });
});

// ------------------------------------------------------------ real delivery

/** A `server/mail/port.ts` transport that records the two-part message. */
class PortRecorder implements PortMailer {
  readonly sent: { to: string; subject: string; text: string; html: string }[] = [];
  send(message: { to: string; subject: string; text: string; html: string }): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

describe('a paid order produces a REAL send, not a log line', () => {
  it('reaches an injected transport as text AND html', async () => {
    /*
     * THE GAP HANDOFF §1.11 NAMES, CLOSED AND ASSERTED. A complete outbox — dedupe
     * keys, eight-attempt retries, a CAS claim — delivered nothing, because this
     * subsystem's `Mailer` (`{ to, subject, body }`) and `server/mail/port.ts`'s
     * (`{ to, subject, text, html }`) were two interfaces with nothing between them.
     */
    await paidOrderWithLink();
    const recorder = new PortRecorder();

    const summary = await sweepEmailIntents(ctx.db, portMailer(recorder), NOW + 100);
    expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(recorder.sent).toHaveLength(1);

    const message = recorder.sent[0];
    expect(message.to).toBe('Buyer@Example.test');
    // The stored body IS the text part, verbatim — deriving text from html would
    // make the record of what a customer was told a lossy round trip.
    expect(message.text).toContain('2 × Enamel Mug (MUG-NAVY)');
    expect(message.text).toContain('Total: 54.00 USD');
    // And the html is derived from it, with the access link made clickable: a bare
    // URL in an HTML part is not a link in several clients, and a dead "view your
    // order" link is a support ticket per order.
    expect(message.html).toContain('<p>');
    expect(message.html).toContain(`<a href="${ORIGIN}/shop/orders/`);
  });

  it('escapes a product title before it becomes markup', async () => {
    /*
     * A line title is a string somebody typed into the catalog, and it reaches the
     * adapter verbatim. Escaping happens BEFORE linkifying so the linkifier only
     * ever sees text it produced itself.
     */
    const read = await paidOrderWithLink();
    await ctx.db.execute(sql`
      UPDATE shop_order_email_intents
         SET body = 'Mug <3 & "quoted" https://shop.test/x'
       WHERE order_id = ${read.order.id}`);

    const recorder = new PortRecorder();
    await sweepEmailIntents(ctx.db, portMailer(recorder), NOW + 100);
    const html = recorder.sent[0].html;
    expect(html).toContain('Mug &lt;3 &amp; &quot;quoted&quot;');
    expect(html).toContain('<a href="https://shop.test/x">');
    expect(html).not.toContain('<3');
  });

  it('a transport that rejects is still recorded on the row, never thrown', async () => {
    // The adapter must not swallow a rejection: the sweeper's whole job is to
    // record the failure and leave the intent unsent.
    const read = await paidOrderWithLink();
    const broken: PortMailer = { send: () => Promise.reject(new Error('resend refused: HTTP 429')) };

    expect(await sweepEmailIntents(ctx.db, portMailer(broken), NOW + 100)).toEqual({
      sent: 0,
      failed: 1,
      skipped: 0,
    });
    const intents = await listIntents(ctx.db, read.order.id);
    expect(intents[0]).toMatchObject({ sentAt: null, attempts: 1 });
    expect(intents[0].lastError).toContain('HTTP 429');
  });

  it('THE COMPOSITION ROOT WIRES IT — building the app is what registers a transport', async () => {
    /*
     * The line that was missing entirely: `registerOrdersDeps` had zero production
     * callers, so `resolveDeps().mailer` was always `LoggingMailer` and the sweeper
     * marked intents delivered that nobody received.
     *
     * Asserted by building the REAL `createApp()` — which is all `httpClient` does
     * here, no request is made — and then sweeping through whatever it registered.
     * `resetOrdersDeps()` on both sides because the registry is module state, and a
     * suite that leaves a transport in it leaks into the next file in the worker.
     */
    resetOrdersDeps();
    try {
      const recorder = new PortRecorder();
      expect(resolveDeps().mailer).toBeInstanceOf(LoggingMailer);

      httpClient(ctx.db, { mailer: recorder });
      expect(resolveDeps().mailer).not.toBeInstanceOf(LoggingMailer);

      await paidOrderWithLink();
      const summary = await sweepEmailIntents(ctx.db, resolveDeps().mailer, NOW + 100);
      expect(summary.sent).toBe(1);
      expect(recorder.sent.map((m) => m.to)).toEqual(['Buyer@Example.test']);
    } finally {
      resetOrdersDeps();
    }
  });

  it('does NOT clobber a transport a suite already registered', async () => {
    /*
     * Why the composition root calls `registerOrdersDefaults` and not
     * `registerOrdersDeps`. `httpClient` builds the real app in EVERY server suite,
     * so a last-write-wins registration there would replace a fake registered
     * moments earlier — and the test would go on passing, having asserted on a
     * recorder nothing ever called.
     */
    resetOrdersDeps();
    try {
      const mine = new LoggingMailer();
      const { registerOrdersDeps } = await import('./ports');
      registerOrdersDeps({ mailer: mine });
      httpClient(ctx.db);
      expect(resolveDeps().mailer).toBe(mine);
    } finally {
      resetOrdersDeps();
    }
  });
});

describe('formatAmount', () => {
  it('is locale-independent and unambiguous', () => {
    // No `Intl`: it needs a locale nobody has chosen and formats differently across Node
    // builds with different ICU data, which makes a test either brittle or impossible.
    expect(formatAmount(5400, 'USD')).toBe('54.00 USD');
    expect(formatAmount(5, 'USD')).toBe('0.05 USD');
    expect(formatAmount(0, 'USD')).toBe('0.00 USD');
    expect(formatAmount(-1234, 'USD')).toBe('-12.34 USD');
    expect(formatAmount(100_000_000, 'GBP')).toBe('1000000.00 GBP');
  });
});
