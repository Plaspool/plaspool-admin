/**
 * `DELETE /api/admin/email/broadcasts/:id` — drafts only.
 *
 * The property under test is the STATUS WALL: a draft has told nobody anything
 * and may vanish; anything that has started sending is the record of what real
 * inboxes received and must refuse with the row attached, exactly the shape the
 * templates screen already gets for a system template's delete.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb } from '../test/harness';
import type { TestCtx } from '../test/harness';
import { httpClient, json } from '../test/http';
import type { HttpClient } from '../test/http';
import { addSubscriber } from '../email/repo';
import type { AuthUser } from '../../shared/types';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM email_broadcast_recipients`);
  await ctx.db.execute(sql`DELETE FROM email_broadcasts`);
  await ctx.db.execute(sql`DELETE FROM email_subscribers`);
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
});

async function login(user: AuthUser): Promise<HttpClient> {
  const c = httpClient(ctx.db);
  const res = await c.post('/api/auth/login', { email: user.email, password: SEED_PASSWORD });
  expect(res.status).toBe(200);
  return c;
}

async function seedBroadcast(status: 'draft' | 'sending' | 'sent'): Promise<string> {
  const res = await ctx.db.execute(sql`
    INSERT INTO email_broadcasts (id, subject, html, text, status, created_at)
    VALUES (gen_random_uuid(), 'You have been invited to write',
            '<p>{{unsubscribe_url}}</p>', 'x {{unsubscribe_url}}', ${status}, ${Date.now()})
    RETURNING id`);
  return String(res.rows[0].id);
}

async function broadcastCount(): Promise<number> {
  const res = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM email_broadcasts`);
  return Number(res.rows[0].n);
}

describe('DELETE /api/admin/email/broadcasts/:id', () => {
  it('deletes a draft, and any stray recipient rows with it', async () => {
    const id = await seedBroadcast('draft');
    /* The invariant says a draft has no recipients; the statement must not
     * depend on it. Seed one anyway and prove it goes too. */
    const { subscriber } = await addSubscriber(
      ctx.db,
      { email: 'stray@example.test', source: 'manual' },
      Date.now(),
    );
    await ctx.db.execute(sql`
      INSERT INTO email_broadcast_recipients (id, broadcast_id, subscriber_id, status)
      VALUES (gen_random_uuid(), ${id}::uuid, ${subscriber.id}::uuid, 'pending')`);

    const c = await login(ctx.users.owner);
    const res = await c.del(`/api/admin/email/broadcasts/${id}`);
    expect(res.status).toBe(200);
    expect(await broadcastCount()).toBe(0);
    const orphans = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM email_broadcast_recipients`,
    );
    expect(Number(orphans.rows[0].n)).toBe(0);
  });

  it('refuses anything that has started, with the row attached', async () => {
    const id = await seedBroadcast('sending');
    const c = await login(ctx.users.owner);
    const res = await c.del(`/api/admin/email/broadcasts/${id}`);
    expect(res.status).toBe(409);
    const body = await json<{ error: string; broadcast?: { status: string } }>(res);
    expect(body.error).toBe('precondition_failed');
    expect(await broadcastCount()).toBe(1);
  });

  it('404s an id that names nothing', async () => {
    const c = await login(ctx.users.owner);
    const res = await c.del('/api/admin/email/broadcasts/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });

  it('is owner-only, like every other email admin route', async () => {
    const id = await seedBroadcast('draft');
    const c = await login(ctx.users.writer);
    expect((await c.del(`/api/admin/email/broadcasts/${id}`)).status).toBe(403);
    expect(await broadcastCount()).toBe(1);
  });
});
