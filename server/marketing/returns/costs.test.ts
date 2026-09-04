/**
 * WHAT A RETURNED UNIT COSTS US — the write and the aggregate, through the
 * REAL app (contract #15 and #16, migration 0920).
 *
 * THROUGH `createApp()` AND NOT A TEST APP, because this is money. CLAUDE.md
 * §2 is explicit about it and the reason is a real outage: a suite that
 * registers its own dependencies proves the handler and not the composition
 * root, and `GET /api/shop/orders` 401'd every caller in production while
 * every test passed. `httpClient` builds the real app; nothing here reaches
 * around it.
 *
 * NO NOUN FROM THE SEEDED PRESET APPEARS IN THIS FILE (spec D11) — the labels
 * are absurd on purpose, and the district is named after nothing real.
 *
 * WHAT THIS FILE IS ACTUALLY GUARDING. The arithmetic on the analytics screen
 * is the whole feature, and every one of its decisions is invisible in the
 * result: which returns count, what divides what, and what stands in for a
 * figure nobody typed. Each gets a test that FAILS if the decision is quietly
 * reversed, because none of them would show up as a crash.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { TestCtx } from '../../test/harness';
import type { HttpClient } from '../../test/http';
import type { AuthUser } from '../../../shared/types';

let ctx: TestCtx;
let owner: HttpClient;
/**
 * The supply-chain role, and the choice is worth stating: this surface is in
 * the ORDERS domain, not marketing (`server/middleware/permissions.ts` puts
 * `/api/marketing/returns` there — the board lives under Orders in the admin,
 * whatever its URL prefix says). So the roles that reach it are supply chain,
 * support, the owner and developers. A content WRITER is off it entirely, and
 * that refusal is asserted rather than assumed.
 */
let warehouse: HttpClient;
let writer: HttpClient;
let programId: string;

const API = '/api/marketing';

/** Two districts, so the by-area table has something to rank. */
const NEAR = 'area_cabbage_quarter';
const FAR = 'area_turnip_reach';

async function login(user: AuthUser): Promise<HttpClient> {
  const client = httpClient(ctx.db);
  await client.signIn(user);
  return client;
}

let emailSeq = 0;
const nextEmail = (): string => `dara-${(emailSeq += 1)}@example.test`;

interface Wire {
  id: string;
  revision: number;
  status: string;
  costTransportMinor: number | null;
  costLocalMinor: number | null;
  costDriverMinor: number | null;
  costFeesMinor: number | null;
  costNote: string | null;
  unitCostMinorSnapshot: number | null;
  [key: string]: unknown;
}

interface Analytics {
  generatedAt: number;
  range: string;
  rates: { unitCostMinor: number | null; unitMarketCostMinor: number | null; currency: string };
  totals: {
    returns: number;
    unitsKept: number;
    unitsRejected: number;
    rewardMinor: number;
    transportMinor: number;
    localMinor: number;
    driverMinor: number;
    feesMinor: number;
    collectionMinor: number;
    allInMinor: number;
  };
  perUnit: { allIn: number; reward: number; transport: number; local: number };
  byMonth: { month: string; unitsKept: number; allInMinor: number; perUnitMinor: number }[];
  byArea: {
    areaId: string | null;
    name: string | null;
    unitsKept: number;
    perUnitMinor: number;
    estimated: number;
  }[];
  costliest: { id: string; unitsKept: number; perUnitMinor: number; estimated: boolean }[];
  coverage: { recorded: number; estimated: number; uncosted: number };
}

async function area(id: string, key: string, name: string): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO marketing_service_areas
      (id, key, region, name, aliases, active, created_at, updated_at)
    VALUES (${id}, ${key}, 'Farflung Province', ${name},
            '{}'::text[], true, 1786600001000, 1786600001000)
    ON CONFLICT (id) DO NOTHING`);
}

/**
 * A return driven all the way to `awarded`, with the quantities the caller
 * names — the only shape the analytics counts.
 *
 * DRIVEN THROUGH THE REAL ROUTES rather than inserted, so the costing rate
 * this suite asserts on is the one `createRequest` actually snapshots. An
 * INSERT here would let the snapshot silently stop being written and every
 * assertion below would still pass against the programme's live rate.
 */
async function awarded(opts: {
  areaId?: string;
  declared?: number;
  accepted?: number;
}): Promise<Wire> {
  const declared = opts.declared ?? 10;
  const accepted = opts.accepted ?? declared;
  const created = await owner.post(`${API}/returns`, {
    email: nextEmail(),
    qtyDeclared: declared,
    pickupAddress: '12 Allen Avenue',
    serviceAreaId: opts.areaId ?? NEAR,
    programId,
  });
  expect(created.status).toBe(201);
  let row = (await json<{ request: Wire }>(created)).request;

  const step = async (action: string, body: Record<string, unknown> = {}) => {
    const res = await owner.post(`${API}/returns/${row.id}/${action}`, {
      expectedRevision: row.revision,
      ...body,
    });
    expect(res.status).toBe(200);
    row = (await json<{ request: Wire }>(res)).request;
  };

  await step('schedule', { pickupAt: Date.now() + 86_400_000 });
  await step('collect');
  await step('receive');
  await step('inspect', { qtyAccepted: accepted, qtyRejected: declared - accepted });
  return row;
}

async function setCosts(row: Wire, body: Record<string, unknown>): Promise<Wire> {
  const res = await owner.post(`${API}/returns/${row.id}/costs`, {
    expectedRevision: row.revision,
    ...body,
  });
  expect(res.status).toBe(200);
  return (await json<{ request: Wire }>(res)).request;
}

const read = async (range = 'all'): Promise<Analytics> =>
  json<Analytics>(await owner.get(`${API}/returns/analytics?range=${range}`));

beforeAll(async () => {
  ctx = await freshDb();
  owner = await login(ctx.users.owner);
  warehouse = await login(ctx.users.supplyChain);
  writer = await login(ctx.users.writer);

  await area(NEAR, 'cabbage-quarter', 'Cabbage Quarter');
  await area(FAR, 'turnip-reach', 'Turnip Reach');

  const created = await owner.post(`${API}/programs`, {
    key: 'bottle-caps-costs',
    kind: 'unit_return',
    name: 'Cap Returns',
    pointsLabelSingular: 'Bottle Cap',
    pointsLabelPlural: 'Bottle Caps',
    unitLabelSingular: 'canister',
    unitLabelPlural: 'canisters',
    minUnitsPerReturn: 4,
    pointsPerUnit: 7,
  });
  expect(created.status).toBe(201);
  programId = (await json<{ program: { id: string } }>(created)).program.id;

  /* The shop's default, so `GET /returns/analytics` reads ITS rates rather
   * than whichever row happens to be first in the table. */
  await ctx.db.execute(sql`
    UPDATE marketing_settings SET default_return_program_id = ${programId} WHERE id = 'main'`);
});

afterAll(() => ctx.close());

beforeEach(async () => {
  /* Returns and their history only. The programme, the settings pointer and
   * the two districts survive, because every test here is about numbers
   * measured ACROSS returns and re-creating the fixtures each time would make
   * the suite's own arithmetic the thing under test. */
  await ctx.db.execute(sql`TRUNCATE marketing_return_requests, marketing_return_events,
                                    marketing_ledger, marketing_balances,
                                    marketing_email_intents CASCADE`);
  await ctx.db.execute(sql`
    UPDATE marketing_programs
       SET unit_cost_minor = 10000, unit_market_cost_minor = 85000
     WHERE id = ${programId}`);
  await ctx.db.execute(sql`
    UPDATE marketing_service_areas
       SET std_transport_minor = NULL, std_local_minor = NULL,
           std_driver_minor = NULL, std_fees_minor = NULL`);
});

// ═══════════════════════════════════════════════════════ recording the cost ══

describe('recording what a pickup cost — contract #15', () => {
  it('saves the four lines and puts the change in the history', async () => {
    const row = await awarded({});
    const after = await setCosts(row, {
      transportMinor: 250000,
      localMinor: 80000,
      driverMinor: 50000,
      feesMinor: 20000,
      note: 'Second trip — the first driver broke down',
    });

    expect(after.costTransportMinor).toBe(250000);
    expect(after.costLocalMinor).toBe(80000);
    expect(after.costDriverMinor).toBe(50000);
    expect(after.costFeesMinor).toBe(20000);
    expect(after.costNote).toBe('Second trip — the first driver broke down');
    /* A CAS, unlike a note: this changed the row, so the token moved. */
    expect(after.revision).toBe(row.revision + 1);

    const detail = await json<{ events: { type: string; data: Record<string, unknown> | null }[] }>(
      await owner.get(`${API}/returns/${row.id}`),
    );
    const costed = detail.events.filter((e) => e.type === 'costed');
    expect(costed).toHaveLength(1);
    /* WHAT WAS SET, not the whole row — a later correction has to read as
     * "transport changed", and a snapshot of four columns would bury it. */
    expect(costed[0].data).toMatchObject({ transportMinor: 250000, localMinor: 80000 });
  });

  it('is legal AFTER the return is closed — the invoice arrives late', async () => {
    const row = await awarded({});
    expect(row.status).toBe('awarded');
    const after = await setCosts(row, { transportMinor: 300000 });
    expect(after.costTransportMinor).toBe(300000);
  });

  it('leaves a line alone when it is absent and CLEARS it when it is null', async () => {
    const row = await awarded({});
    const first = await setCosts(row, { transportMinor: 250000, localMinor: 80000 });

    const second = await setCosts(first, { localMinor: 90000 });
    /* Absent means "do not touch", which is what makes a one-field correction
       possible at all. */
    expect(second.costTransportMinor).toBe(250000);
    expect(second.costLocalMinor).toBe(90000);

    const third = await setCosts(second, { transportMinor: null });
    /* NULL is not zero: it is back to "nobody wrote it down", which is the
       only way a figure typed into the wrong box is undone — and the only
       reason `coverage` can ever be right again for this pickup. */
    expect(third.costTransportMinor).toBeNull();
    expect(third.costLocalMinor).toBe(90000);
  });

  it('takes zero, which is not the same as nothing', async () => {
    const row = await awarded({});
    const after = await setCosts(row, { transportMinor: 0 });
    /* "Our van was going anyway." A `min(1)` would force staff to lie about
       this by leaving the box empty, and the box being empty means something
       else entirely. */
    expect(after.costTransportMinor).toBe(0);
  });

  it('clears the note when told null, and refuses a blank one', async () => {
    const row = await awarded({});
    const written = await setCosts(row, { transportMinor: 100, note: 'Second trip' });
    expect(written.costNote).toBe('Second trip');

    const cleared = await setCosts(written, { note: null });
    /* NULL is how blank is spelled — one spelling, the rule every optional
       sentence in this admin has followed since 2026-09-03. */
    expect(cleared.costNote).toBeNull();

    /* And whitespace is a 400 rather than a second spelling of blank, exactly
       as `RejectBody` and `CancelBody` already answer it. The screen sends
       `null` or nothing; it never sends spaces. */
    const blank = await owner.post(`${API}/returns/${row.id}/costs`, {
      expectedRevision: cleared.revision,
      note: '   ',
    });
    expect(blank.status).toBe(400);
  });

  it('refuses a negative figure, a body with nothing in it, and a stale token', async () => {
    const row = await awarded({});

    const negative = await owner.post(`${API}/returns/${row.id}/costs`, {
      expectedRevision: row.revision,
      transportMinor: -1,
    });
    expect(negative.status).toBe(400);

    const empty = await owner.post(`${API}/returns/${row.id}/costs`, {
      expectedRevision: row.revision,
    });
    /* Not a no-op that bumps the revision: silently invalidating every other
       open editor's token for a write that moved nothing is worse. */
    expect(empty.status).toBe(400);

    const moved = await setCosts(row, { transportMinor: 100 });
    const stale = await owner.post(`${API}/returns/${row.id}/costs`, {
      expectedRevision: row.revision,
      transportMinor: 200,
    });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({ error: 'stale_write' });
    /* The 409 carries the row that won, so the screen heals without a second
       fetch — spec D7, the shape every other conflict here uses. */
    expect(moved.costTransportMinor).toBe(100);
  });

  it('is 400 for an unknown field and 404 for an unknown return', async () => {
    const row = await awarded({});
    const unknownField = await owner.post(`${API}/returns/${row.id}/costs`, {
      expectedRevision: row.revision,
      totalMinor: 500,
    });
    expect(unknownField.status).toBe(400);

    const missing = await owner.post(`${API}/returns/ret_nope/costs`, {
      expectedRevision: 1,
      transportMinor: 100,
    });
    expect(missing.status).toBe(404);
  });

  it('is warehouse work, not the owner’s — and not a content writer’s', async () => {
    const row = await awarded({});
    /* Writing down what a van cost is warehouse work, so it does not need the
       owner. What IS owner-only is changing what a return is worth, and that
       rate lives on the programme behind `requireOwner`. */
    const ok = await warehouse.post(`${API}/returns/${row.id}/costs`, {
      expectedRevision: row.revision,
      transportMinor: 120000,
    });
    expect(ok.status).toBe(200);

    /* A content writer holds neither `orders` nor anything money-adjacent
       (migration 0680), and this route stands on the same wall as every
       sibling in the file. */
    const refused = await writer.post(`${API}/returns/${row.id}/costs`, {
      expectedRevision: row.revision + 1,
      transportMinor: 999,
    });
    expect(refused.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════ the money rates ══

describe('the costing rate', () => {
  it('is snapshotted onto the return, so repricing cannot rewrite history', async () => {
    const before = await awarded({});
    expect(before.unitCostMinorSnapshot).toBe(10000);

    const programs = await json<{ programs: { id: string; revision: number }[] }>(
      await owner.get(`${API}/programs`),
    );
    const repriced = await owner.patch(`${API}/programs/${programId}`, {
      expectedRevision: programs.programs.find((p) => p.id === programId)!.revision,
      unitCostMinor: 20000,
    });
    expect(repriced.status).toBe(200);

    /* The old return still prices at what it was created under. The new one
       picks up the new rate — the same discipline `pointsPerUnitSnapshot`
       has always had, and the reason the dashboard cannot be rewritten by an
       edit made months later. */
    const after = await awarded({});
    expect(after.unitCostMinorSnapshot).toBe(20000);

    const a = await read();
    expect(a.totals.rewardMinor).toBe(10 * 10000 + 10 * 20000);
  });

  it('falls back to the programme’s CURRENT rate for a return older than 0920', async () => {
    const row = await awarded({});
    /* Exactly the shape every production row is in the moment this ships:
       created before the column existed, so the snapshot is NULL. */
    await ctx.db.execute(sql`
      UPDATE marketing_return_requests SET unit_cost_minor_snapshot = NULL WHERE id = ${row.id}`);

    const a = await read();
    expect(a.totals.rewardMinor).toBe(10 * 10000);
  });

  it('reports a rate nobody has set as missing rather than as zero', async () => {
    await ctx.db.execute(sql`
      UPDATE marketing_programs SET unit_cost_minor = NULL WHERE id = ${programId}`);
    const a = await read();
    expect(a.rates.unitCostMinor).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════ the arithmetic ══

describe('what a unit costs us — contract #16', () => {
  it('divides by units KEPT, so a bad batch pushes the cost up', async () => {
    /* Ten collected, eight kept. The pickup cost the same either way, so the
       eight good ones carry all of it — which is what makes the figure mean
       "what a USABLE unit costs us". */
    const row = await awarded({ declared: 10, accepted: 8 });
    await setCosts(row, { transportMinor: 160000 });

    const a = await read();
    expect(a.totals.unitsKept).toBe(8);
    expect(a.totals.unitsRejected).toBe(2);
    expect(a.totals.rewardMinor).toBe(8 * 10000);
    expect(a.totals.collectionMinor).toBe(160000);
    expect(a.totals.allInMinor).toBe(80000 + 160000);
    expect(a.perUnit.allIn).toBe((80000 + 160000) / 8);
    /* The owner's whole point: the headline rate says 100 a unit and the real
       figure is 300. */
    expect(a.perUnit.reward).toBe(10000);
    expect(a.perUnit.transport).toBe(20000);
  });

  it('counts a pickup that came back with NOTHING usable, cost and all', async () => {
    const good = await awarded({ declared: 10, accepted: 10 });
    await setCosts(good, { transportMinor: 100000 });

    const wasted = await awarded({ declared: 10, accepted: 0 });
    await setCosts(wasted, { transportMinor: 500000 });

    const a = await read();
    /* The van went either way. Leaving the wasted trip out would understate
       the programme by exactly what it wastes, which is the number most worth
       knowing. */
    expect(a.totals.returns).toBe(2);
    expect(a.totals.unitsKept).toBe(10);
    expect(a.totals.collectionMinor).toBe(600000);
    expect(a.perUnit.allIn).toBe((10 * 10000 + 600000) / 10);
  });

  it('leaves an open return out entirely — nothing is settled yet', async () => {
    const created = await owner.post(`${API}/returns`, {
      email: nextEmail(),
      qtyDeclared: 10,
      pickupAddress: '12 Allen Avenue',
      serviceAreaId: NEAR,
      programId,
    });
    expect(created.status).toBe(201);

    const a = await read();
    expect(a.totals.returns).toBe(0);
    /* And the guard that matters: no division by a zero divisor anywhere. */
    expect(a.perUnit.allIn).toBe(0);
  });

  it('leaves a CANCELLED return out — usually nothing ever moved', async () => {
    const created = await owner.post(`${API}/returns`, {
      email: nextEmail(),
      qtyDeclared: 10,
      pickupAddress: '12 Allen Avenue',
      serviceAreaId: NEAR,
      programId,
    });
    const row = (await json<{ request: Wire }>(created)).request;
    await owner.post(`${API}/returns/${row.id}/cancel`, {
      expectedRevision: row.revision,
      reason: 'Changed their mind',
    });

    const a = await read();
    /* A wall of "changed my mind" cancellations counted as free pickups would
       drag every average down with events that never happened. A rejection is
       counted, because a van did go. */
    expect(a.totals.returns).toBe(0);
  });
});

// ════════════════════════════════════════════════ standards and disclosure ══

describe('the district standard', () => {
  it('stands in per LINE where nobody typed one', async () => {
    await ctx.db.execute(sql`
      UPDATE marketing_service_areas
         SET std_transport_minor = 200000, std_local_minor = 50000, std_driver_minor = 30000
       WHERE id = ${NEAR}`);

    const row = await awarded({ declared: 10, accepted: 10 });
    /* Transport typed, the rest silent. The typed figure wins on its own line
       and the standards fill the other two — an all-or-nothing fallback would
       throw away the one real number the moment a second box was filled. */
    await setCosts(row, { transportMinor: 111000 });

    const a = await read();
    expect(a.totals.transportMinor).toBe(111000);
    expect(a.totals.localMinor).toBe(50000);
    expect(a.totals.driverMinor).toBe(30000);
    expect(a.totals.feesMinor).toBe(0);
  });

  it('does NOT overwrite a typed zero', async () => {
    await ctx.db.execute(sql`
      UPDATE marketing_service_areas SET std_transport_minor = 200000 WHERE id = ${NEAR}`);
    const row = await awarded({ declared: 10, accepted: 10 });
    await setCosts(row, { transportMinor: 0 });

    const a = await read();
    /* "Our van was going anyway" must survive. A COALESCE that treated 0 as
       absent would silently charge this pickup two thousand naira it never
       spent — and would do it invisibly, on every free run. */
    expect(a.totals.transportMinor).toBe(0);
  });

  it('is a LIVE setting: correcting it moves every estimate that leans on it', async () => {
    await ctx.db.execute(sql`
      UPDATE marketing_service_areas SET std_transport_minor = 200000 WHERE id = ${NEAR}`);
    await awarded({ declared: 10, accepted: 10 });
    expect((await read()).totals.transportMinor).toBe(200000);

    await ctx.db.execute(sql`
      UPDATE marketing_service_areas SET std_transport_minor = 260000 WHERE id = ${NEAR}`);
    /* Nothing was copied onto the return, so the correction reaches history.
       That is the whole reason 0920 resolves this at read time. */
    expect((await read()).totals.transportMinor).toBe(260000);
  });

  it('counts recorded, estimated and uncosted apart', async () => {
    await ctx.db.execute(sql`
      UPDATE marketing_service_areas SET std_transport_minor = 200000 WHERE id = ${NEAR}`);

    const typed = await awarded({ areaId: NEAR, declared: 10, accepted: 10 });
    await setCosts(typed, { transportMinor: 100000 });
    await awarded({ areaId: NEAR, declared: 10, accepted: 10 }); // estimated
    await awarded({ areaId: FAR, declared: 10, accepted: 10 }); // no standard at all

    const a = await read();
    expect(a.coverage).toEqual({ recorded: 1, estimated: 1, uncosted: 1 });
    /* The uncosted one contributes nothing to the collection total, which
       UNDERSTATES the headline — so the screen has to say so rather than
       quietly averaging a zero in. */
    expect(a.totals.collectionMinor).toBe(100000 + 200000);
  });
});

// ══════════════════════════════════════════════════════════════ the slices ══

describe('the slices the screen draws', () => {
  it('ranks districts by cost per unit, dearest first, with the out-of-area group', async () => {
    const cheap = await awarded({ areaId: NEAR, declared: 10, accepted: 10 });
    await setCosts(cheap, { transportMinor: 100000 });
    const dear = await awarded({ areaId: FAR, declared: 10, accepted: 10 });
    await setCosts(dear, { transportMinor: 900000 });

    const a = await read();
    expect(a.byArea.map((r) => r.name)).toEqual(['Turnip Reach', 'Cabbage Quarter']);
    expect(a.byArea[0].perUnitMinor).toBe((10 * 10000 + 900000) / 10);
    expect(a.byArea[1].perUnitMinor).toBe((10 * 10000 + 100000) / 10);
  });

  it('buckets by month and never draws a month it kept nothing in', async () => {
    const row = await awarded({ declared: 10, accepted: 10 });
    await setCosts(row, { transportMinor: 100000 });

    const a = await read();
    expect(a.byMonth).toHaveLength(1);
    expect(a.byMonth[0].month).toMatch(/^\d{4}-\d{2}$/);
    expect(a.byMonth[0].unitsKept).toBe(10);
    expect(a.byMonth[0].perUnitMinor).toBe((10 * 10000 + 100000) / 10);
  });

  it('lists the dearest pickups and never one that kept nothing', async () => {
    const dear = await awarded({ declared: 10, accepted: 2 });
    await setCosts(dear, { transportMinor: 400000 });
    const cheap = await awarded({ declared: 10, accepted: 10 });
    await setCosts(cheap, { transportMinor: 40000 });
    const wasted = await awarded({ declared: 10, accepted: 0 });
    await setCosts(wasted, { transportMinor: 900000 });

    const a = await read();
    /* The wasted pickup is the most expensive thing in the window and it is
       ABSENT: it has no cost per unit to rank by, and dividing by its zero is
       the one arithmetic error this statement could make. */
    expect(a.costliest.map((r) => r.id)).toEqual([dear.id, cheap.id]);
    expect(a.costliest[0].perUnitMinor).toBe((2 * 10000 + 400000) / 2);
    expect(a.costliest[0].estimated).toBe(false);
  });

  it('honours the range and refuses one that is not on the picker', async () => {
    const row = await awarded({ declared: 10, accepted: 10 });
    await setCosts(row, { transportMinor: 100000 });
    /* Closed long enough ago to fall out of a 30-day window but not a 90. */
    await ctx.db.execute(sql`
      UPDATE marketing_return_requests
         SET closed_at = ${Date.now() - 45 * 86_400_000} WHERE id = ${row.id}`);

    expect((await read('30')).totals.returns).toBe(0);
    expect((await read('90')).totals.returns).toBe(1);
    expect((await read('all')).totals.returns).toBe(1);

    /* Every value is a scan bound, so the parameter is an enum and not a
       number — `?range=3650` typed for `365` would be a full-table scan
       served with a straight face. */
    expect((await owner.get(`${API}/returns/analytics?range=3650`)).status).toBe(400);
    expect((await owner.get(`${API}/returns/analytics?days=30`)).status).toBe(400);
  });

  it('is registered ABOVE /returns/:id, so the word is not read as an id', async () => {
    const a = await read();
    /* `analytics` is a legal `:id`. If the ordering ever flipped, this would
       be a 404 for a return that does not exist. */
    expect(a.generatedAt).toBeGreaterThan(0);
    expect(a.rates.unitMarketCostMinor).toBe(85000);
  });

  it('needs a session', async () => {
    const anon = httpClient(ctx.db);
    expect((await anon.get(`${API}/returns/analytics`)).status).toBe(401);
  });
});
