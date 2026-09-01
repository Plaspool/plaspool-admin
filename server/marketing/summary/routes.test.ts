/**
 * The Overview's read on the wire — contract #28, driven through the REAL app.
 *
 * THIS ROUTE IS HERE BECAUSE IT WAS MISSING. Every other endpoint in the frozen
 * contract landed with a task; #28 landed with none, and the gap was invisible
 * until the deployed Overview asked for it and got the application's own 404
 * `gone`. So the first thing this suite asserts is the thing that was wrong:
 * the path answers at all, under a session, through the mount.
 *
 * NO NOUN FROM THE SEEDED PRESET APPEARS HERE (spec D11) — the program below is
 * absurd on purpose, and the summary carries no words of its own anyway: the
 * labels it ships are the ones its rows' programs carry.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { TestCtx } from '../../test/harness';
import type { HttpClient } from '../../test/http';
import type { AuthUser } from '../../../shared/types';
import type { MarketingSummary } from './repo';

let ctx: TestCtx;
let owner: HttpClient;
let writer: HttpClient;
let marketing: HttpClient;
let anon: HttpClient;

const API = '/api/marketing';

/**
 * The suite's clock, taken once at load.
 *
 * REAL RATHER THAN A ROUND CONSTANT, because the route reads `Date.now()` and
 * the tiles report an AGE: a fixture pinned to a fixed instant in the past would
 * make every age the distance to that instant rather than the interval under
 * test. Every timestamp below hangs off this, so the intervals are exact and the
 * assertions are bands rather than equalities — a suite takes seconds to run.
 */
const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function login(user: AuthUser): Promise<HttpClient> {
  const client = httpClient(ctx.db);
  await client.signIn(user);
  return client;
}

/** A program of its own, so nothing here depends on the seeded preset's numbers. */
async function seedProgram(): Promise<string> {
  const id = 'prg_summary_fixture';
  await ctx.db.execute(sql`
    INSERT INTO marketing_programs
      (id, key, kind, name, points_label_singular, points_label_plural,
       unit_label_singular, unit_label_plural, min_units_per_return, points_per_unit,
       status, conditions, seeded, revision, created_at, updated_at)
    VALUES (${id}, 'bottle-caps', 'unit_return', 'Canister Returns',
            'Bottle Cap', 'Bottle Caps', 'canister', 'canisters', 4, 7,
            'active', '{}'::jsonb, false, 1, ${NOW - 40 * DAY}, ${NOW - 40 * DAY})
    ON CONFLICT (key) DO NOTHING`);
  return id;
}

/** A return in a named state at a named age — the tiles are aggregates over these. */
async function seedReturn(input: {
  id: string;
  programId: string;
  status: string;
  email: string;
  createdAt: number;
  pickupAt?: number;
  receivedAt?: number;
  closedAt?: number;
  qtyAccepted?: number;
  pointsAwarded?: number;
}): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO marketing_return_requests
      (id, program_id, customer_email, qty_declared, qty_accepted, qty_rejected,
       points_per_unit_snapshot, points_awarded, source, status, service_area_id,
       pickup_scheduled_at, received_at, closed_at, revision, created_at, updated_at)
    VALUES (${input.id}, ${input.programId}, ${input.email}, 6,
            ${input.qtyAccepted ?? null}, ${input.qtyAccepted === undefined ? null : 0},
            7, ${input.pointsAwarded ?? null}, 'admin', ${input.status},
            /* ANY SERVED AREA. Migration 0012 refuses an awarded return with
             * none, and these fixtures are about the Overview's tiles rather
             * than about geography — so they ask the seed for a board rather
             * than naming one, which would put a real place in a test file. */
            (SELECT id FROM marketing_service_areas WHERE active ORDER BY id LIMIT 1),
            ${input.pickupAt ?? null}, ${input.receivedAt ?? null}, ${input.closedAt ?? null},
            1, ${input.createdAt}, ${input.createdAt})`);
}

beforeAll(async () => {
  ctx = await freshDb();
  owner = await login(ctx.users.owner);
  writer = await login(ctx.users.writer);
  marketing = await login(ctx.users.marketing);
  anon = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

describe('the marketing summary', () => {
  it('ANSWERS AT ALL — the route exists and is mounted', async () => {
    const res = await owner.get(`${API}/summary`);
    // The defect this file was written for answered 404 `gone` here.
    expect(res.status).toBe(200);
    const body = await json<MarketingSummary>(res);
    expect(body.tiles).toBeDefined();
    expect(Array.isArray(body.oldestOpen)).toBe(true);
    expect(Array.isArray(body.latestLedger)).toBe(true);
    expect(Array.isArray(body.banners)).toBe(true);
    expect(typeof body.pendingEmailIntents).toBe('number');
  });

  it('refuses a reader with no session', async () => {
    const res = await anon.get(`${API}/summary`);
    expect(res.status).toBe(401);
    expect(await json(res)).toMatchObject({ error: 'unauthenticated' });
  });

  it('serves the marketing role — and refuses a content writer (migration 0680)', async () => {
    expect((await writer.get(`${API}/summary`)).status).toBe(403);
    const res = await marketing.get(`${API}/summary`);
    expect(res.status).toBe(200);
  });

  it('counts each tile over its own statuses, and ages the oldest', async () => {
    const programId = await seedProgram();
    await seedReturn({
      id: 'ret_sum_req_old',
      programId,
      status: 'requested',
      email: 'old@example.com',
      createdAt: NOW - 3 * DAY,
    });
    await seedReturn({
      id: 'ret_sum_req_new',
      programId,
      status: 'requested',
      email: 'new@example.com',
      createdAt: NOW - 2 * HOUR,
    });
    await seedReturn({
      id: 'ret_sum_sched',
      programId,
      status: 'scheduled',
      email: 'sched@example.com',
      createdAt: NOW - 5 * HOUR,
      pickupAt: NOW + 12 * HOUR,
    });
    await seedReturn({
      id: 'ret_sum_recv',
      programId,
      status: 'received',
      email: 'recv@example.com',
      createdAt: NOW - 6 * DAY,
      receivedAt: NOW - 30 * HOUR,
    });

    const body = await json<MarketingSummary>(await owner.get(`${API}/summary`));

    expect(body.tiles.needsScheduling.count).toBe(2);
    expect(body.tiles.outForPickup.count).toBe(1);
    expect(body.tiles.toInspect.count).toBe(1);

    // The OLDEST of the two requested, not the newest and not their mean.
    expect(body.tiles.needsScheduling.oldestAgeMs).toBeGreaterThan(2.9 * DAY);
    expect(body.tiles.outForPickup.nextPickupAt).toBe(NOW + 12 * HOUR);
    // Since it ARRIVED (30h), not since it was requested (6d) — the tile is
    // about how long a box has sat on a shelf.
    expect(body.tiles.toInspect.oldestAgeMs).toBeGreaterThan(29 * HOUR);
    expect(body.tiles.toInspect.oldestAgeMs).toBeLessThan(40 * HOUR);
  });

  it('lists the oldest OPEN returns first, with the action the server allows', async () => {
    const body = await json<MarketingSummary>(await owner.get(`${API}/summary`));

    expect(body.oldestOpen.length).toBeGreaterThanOrEqual(4);
    expect(body.oldestOpen.length).toBeLessThanOrEqual(5);

    const ages = body.oldestOpen.map((r) => r.createdAt);
    expect([...ages].sort((a, b) => a - b)).toEqual(ages);

    // Served, never guessed (spec D4): the panel renders `allowedActions[0]`.
    const received = body.oldestOpen.find((r) => r.id === 'ret_sum_recv');
    expect(received?.allowedActions[0]).toBe('inspect');
    const requested = body.oldestOpen.find((r) => r.id === 'ret_sum_req_old');
    expect(requested?.allowedActions[0]).toBe('schedule');

    // Each row carries its own program's words — the panel has none of its own.
    expect(received?.program.unitLabelPlural).toBe('canisters');
  });

  it('counts only awarded returns inside the thirty-day window', async () => {
    const programId = await seedProgram();
    await seedReturn({
      id: 'ret_sum_recent_award',
      programId,
      status: 'awarded',
      email: 'recent@example.com',
      createdAt: NOW - 10 * DAY,
      closedAt: NOW - 2 * DAY,
      qtyAccepted: 5,
      pointsAwarded: 35,
    });
    await seedReturn({
      id: 'ret_sum_old_award',
      programId,
      status: 'awarded',
      email: 'ancient@example.com',
      createdAt: NOW - 200 * DAY,
      // Outside the thirty-day window by a wide margin — so this row must not
      // be summed, however many points it carries.
      closedAt: NOW - 200 * DAY,
      qtyAccepted: 9,
      pointsAwarded: 63,
    });

    const body = await json<MarketingSummary>(await owner.get(`${API}/summary`));
    expect(body.tiles.awarded30d.returns).toBe(1);
    expect(body.tiles.awarded30d.points).toBe(35);
  });

  it('shows the latest ledger rows with the address and the stored wording', async () => {
    await ctx.db.execute(sql`
      INSERT INTO marketing_balances (customer_email, balance, lifetime_earned, updated_at)
      VALUES ('ledger@example.com', 40, 40, ${Date.now()})
      ON CONFLICT (customer_email) DO NOTHING`);
    await ctx.db.execute(sql`
      INSERT INTO marketing_ledger
        (id, customer_email, program_id, kind, delta, balance_after, reason,
         actor_type, actor_id, created_at)
      VALUES ('pts_sum_1', 'ledger@example.com', NULL, 'manual', 40, 40,
              'Counted at the counter — 40 Jar Lids', 'admin', NULL, ${Date.now()})`);

    const body = await json<MarketingSummary>(await owner.get(`${API}/summary`));
    const row = body.latestLedger.find((e) => e.id === 'pts_sum_1');

    expect(row?.customerEmail).toBe('ledger@example.com');
    expect(row?.balanceAfter).toBe(40);
    // Verbatim: the wording of the day it was written, not today's labels.
    expect(row?.reason).toBe('Counted at the counter — 40 Jar Lids');
    expect(body.latestLedger.length).toBeLessThanOrEqual(8);
  });

  it('omits archived banners and counts unsent mail', async () => {
    const at = Date.now();
    await ctx.db.execute(sql`
      INSERT INTO marketing_banners
        (id, title, body, placement, status, priority, revision, created_at, updated_at)
      VALUES ('bnr_sum_live', 'Winter hours', '', 'top_bar', 'live', 0, 1, ${at}, ${at}),
             ('bnr_sum_gone', 'Last winter', '', 'top_bar', 'archived', 0, 1, ${at}, ${at})`);
    await ctx.db.execute(sql`
      INSERT INTO marketing_email_intents
        (id, kind, return_request_id, dedupe_key, to_email, subject, text, html,
         attempts, created_at)
      VALUES ('mmi_sum_1', 'return_awarded', 'ret_sum_recent_award',
              'return_awarded:ret_sum_recent_award', 'recent@example.com',
              'You earned 35 Bottle Caps', 'text', '<p>html</p>', 0, ${at})`);

    const body = await json<MarketingSummary>(await owner.get(`${API}/summary`));

    const ids = body.banners.map((b) => b.id);
    expect(ids).toContain('bnr_sum_live');
    expect(ids).not.toContain('bnr_sum_gone');
    expect(body.pendingEmailIntents).toBe(1);
  });
});
