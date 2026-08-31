/**
 * The outbox routes (migration 0660's range): the first cross-order surface over
 * `shop_order_email_intents`, and the two verbs that make the Home banner's
 * count actionable — retry and dismiss.
 *
 * Every test drives the REAL app (`ordersClient` → `createApp`), because the
 * seam under test is HTTP: the guards, the 404-vs-double-send rule, and the
 * property that a dismissed row leaves BOTH the sweeper's candidate set and the
 * stats backlog. The repo alone cannot prove the stats route and the sweeper
 * read the same predicate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { json } from '../../test/http';
import { ordersClient, resetOrdersDeps, type OrdersClient } from './test/app';
import { resetOrderTables } from './test/harness';
import { CHECKOUT, T0, checkoutCompleted, insertEvents, paymentCaptured } from './test/fixtures';
import { sweepCommerceEvents, type ConsumerDeps } from './repo/consumer';
import { readOrderByCheckout, type OrderRead } from './repo/orders';
import {
  EMAIL_ATTEMPT_LIMIT,
  listIntents,
  sweepEmailIntents,
  type EmailIntent,
} from './repo/emails';
import type { Mailer, RenderedEmail } from './mailer';
import type { AuthUser } from '../../../shared/types';

let ctx: TestCtx;
const NOW = T0 + 10_000;
const DEPS: ConsumerDeps = { origin: 'https://studio.test' };

/** Records instead of sending — the delivery assertion is against this. */
class RecordingMailer implements Mailer {
  sent: RenderedEmail[] = [];
  send(message: RenderedEmail): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

class BrokenMailer implements Mailer {
  send(): Promise<void> {
    return Promise.reject(new Error('provider unreachable: connect ETIMEDOUT'));
  }
}

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  resetOrdersDeps();
  await resetOrderTables(ctx.db);
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
});

async function login(user: AuthUser, deps = {}): Promise<OrdersClient> {
  const c = ordersClient(ctx.db, { now: () => NOW, ...deps });
  const res = await c.post('/api/auth/login', { email: user.email, password: SEED_PASSWORD });
  expect(res.status).toBe(200);
  return c;
}

/** One paid order, which owes `placed` + `confirmation`. */
async function paidOrder(): Promise<OrderRead> {
  await insertEvents(ctx.db, [checkoutCompleted(), paymentCaptured()]);
  await sweepCommerceEvents(ctx.db, DEPS, NOW);
  return (await readOrderByCheckout(ctx.db, CHECKOUT))!;
}

/** Exhaust one intent's budget, the way eight failed sweeps would. */
async function exhaust(intentId: string): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE shop_order_email_intents
       SET attempts = ${EMAIL_ATTEMPT_LIMIT}, last_error = 'to address is invalid'
     WHERE id = ${intentId}`);
}

async function intentsOf(orderId: string): Promise<EmailIntent[]> {
  return listIntents(ctx.db, orderId);
}

interface OutboxPage {
  items: { id: string; orderNumber: string; subject: string; lastError: string | null }[];
  counts: { attention: number; queued: number; sent: number; dismissed: number };
}

describe('GET /api/shop/admin/emails', () => {
  it('401s an anonymous caller', async () => {
    const c = ordersClient(ctx.db, { now: () => NOW });
    expect((await c.get('/api/shop/admin/emails')).status).toBe(401);
  });

  it('slices the table into disjoint buckets, each row carrying its order number', async () => {
    const read = await paidOrder();
    const [first] = await intentsOf(read.order.id);
    await exhaust(first.id);

    const c = await login(ctx.users.owner);
    const attention = await json<OutboxPage>(await c.get('/api/shop/admin/emails'));
    expect(attention.counts).toEqual({ attention: 1, queued: 1, sent: 0, dismissed: 0 });
    expect(attention.items).toHaveLength(1);
    expect(attention.items[0].id).toBe(first.id);
    expect(attention.items[0].lastError).toBe('to address is invalid');
    /* The join is the point of the route: the screen links each row to its
     * order, and the order NUMBER is what an operator recognises. */
    expect(attention.items[0].orderNumber).toBe(read.order.orderNumber);

    const queued = await json<OutboxPage>(await c.get('/api/shop/admin/emails?bucket=queued'));
    expect(queued.items).toHaveLength(1);
    expect(queued.items[0].id).not.toBe(first.id);
  });

  it('refuses an unknown bucket with a 400, not a silent default', async () => {
    const c = await login(ctx.users.owner);
    expect((await c.get('/api/shop/admin/emails?bucket=everything')).status).toBe(400);
  });
});

describe('POST /api/shop/admin/emails/:id/retry', () => {
  it('resets a dead intent and DELIVERS it in the same request', async () => {
    const read = await paidOrder();
    const [dead] = await intentsOf(read.order.id);
    await exhaust(dead.id);

    const mailer = new RecordingMailer();
    const c = await login(ctx.users.owner, { mailer });
    const res = await c.post(`/api/shop/admin/emails/${dead.id}/retry`);
    expect(res.status).toBe(200);
    const body = await json<{ ok: true; emails: { sent: number } }>(res);
    /* The sweep the retry runs is the ordinary bounded one, so the OTHER queued
     * intent goes too — retry may deliver more than one message, never fewer. */
    expect(body.emails.sent).toBe(2);
    expect(mailer.sent.map((m) => m.subject)).toHaveLength(2);

    const after = await intentsOf(read.order.id);
    for (const intent of after) expect(intent.sentAt).not.toBeNull();
  });

  it('404s a SENT intent rather than double-delivering it', async () => {
    const read = await paidOrder();
    const mailer = new RecordingMailer();
    await sweepEmailIntents(ctx.db, mailer, NOW);
    const [sent] = await intentsOf(read.order.id);
    expect(sent.sentAt).not.toBeNull();
    const delivered = mailer.sent.length;

    const c = await login(ctx.users.owner, { mailer });
    expect((await c.post(`/api/shop/admin/emails/${sent.id}/retry`)).status).toBe(404);
    expect(mailer.sent).toHaveLength(delivered);
  });

  it('a retry whose send fails again records the fresh error and stays unsent', async () => {
    const read = await paidOrder();
    const [dead] = await intentsOf(read.order.id);
    await exhaust(dead.id);

    const c = await login(ctx.users.owner, { mailer: new BrokenMailer() });
    const body = await json<{ emails: { sent: number; failed: number } }>(
      await c.post(`/api/shop/admin/emails/${dead.id}/retry`),
    );
    expect(body.emails.sent).toBe(0);
    expect(body.emails.failed).toBe(2);

    const after = (await intentsOf(read.order.id)).find((i) => i.id === dead.id)!;
    expect(after.sentAt).toBeNull();
    expect(after.attempts).toBe(1);
    expect(after.lastError).toContain('ETIMEDOUT');
  });
});

describe('POST /api/shop/admin/emails/:id/dismiss', () => {
  it('removes the row from the sweeper, the backlog and the attention bucket', async () => {
    const read = await paidOrder();
    const [dead, other] = await intentsOf(read.order.id);
    await exhaust(dead.id);

    const c = await login(ctx.users.owner);
    expect((await c.post(`/api/shop/admin/emails/${dead.id}/dismiss`)).status).toBe(200);

    /* The sweeper no longer sees it: only the other intent goes out. */
    const mailer = new RecordingMailer();
    const swept = await sweepEmailIntents(ctx.db, mailer, NOW);
    expect(swept.sent).toBe(1);
    expect((await intentsOf(read.order.id)).find((i) => i.id === other.id)!.sentAt).not.toBeNull();

    /* The Home banner's number: `stuck` must not count a dismissed row, or the
     * screen built to clear the alert could never clear it. */
    const stats = await json<{ emails: { stuck: number; pending: number } }>(
      await c.get('/api/shop/admin/stats'),
    );
    expect(stats.emails.stuck).toBe(0);

    const page = await json<OutboxPage>(await c.get('/api/shop/admin/emails?bucket=dismissed'));
    expect(page.counts).toEqual({ attention: 0, queued: 0, sent: 1, dismissed: 1 });
    expect(page.items[0].id).toBe(dead.id);
  });

  it('retry undoes a dismissal', async () => {
    const read = await paidOrder();
    const [dead] = await intentsOf(read.order.id);
    await exhaust(dead.id);

    const mailer = new RecordingMailer();
    const c = await login(ctx.users.owner, { mailer });
    await c.post(`/api/shop/admin/emails/${dead.id}/dismiss`);
    expect((await c.post(`/api/shop/admin/emails/${dead.id}/retry`)).status).toBe(200);

    const after = (await intentsOf(read.order.id)).find((i) => i.id === dead.id)!;
    expect(after.dismissedAt).toBeNull();
    expect(after.sentAt).not.toBeNull();
  });

  it('404s a sent intent — there is nothing to give up on', async () => {
    const read = await paidOrder();
    await sweepEmailIntents(ctx.db, new RecordingMailer(), NOW);
    const [sent] = await intentsOf(read.order.id);
    const c = await login(ctx.users.owner);
    expect((await c.post(`/api/shop/admin/emails/${sent.id}/dismiss`)).status).toBe(404);
  });
});
