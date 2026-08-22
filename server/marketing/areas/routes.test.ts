/**
 * Service areas on the wire — contract #6.1 and #6.1b, and the gate that keeps
 * the rewards programme honest about where it works.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO THINGS THIS FILE EXISTS TO PIN, AND NEITHER IS PROVABLE ANYWHERE ELSE.
 *
 * 1. AN AREA THAT EXISTS BUT IS SWITCHED OFF REFUSES A RETURN. That is the whole
 *    point of the `active` flag — "we have heard of that place" and "we send a
 *    van there" are different claims — and a resolver that looked a row up and
 *    forgot to read the flag would pass every other test in this repository.
 *
 * 2. WRITING THE LIST IS THE OWNER'S. Which districts are served decides where
 *    the business sends a driver, so it sits beside a program's rate and the
 *    redemption economics rather than beside the day's return processing.
 *
 * NO REAL PLACE NAME APPEARS IN THIS FILE except where a SEEDED row is the thing
 * under test — the assertion that a far-away region shipped switched OFF has to
 * name the row it is reading. Everything else uses invented geography, for the
 * same reason every label fixture is absurd: a test named after a district this
 * business serves cannot tell code that read the area from code that hardcoded
 * it.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { TestCtx } from '../../test/harness';
import type { HttpClient } from '../../test/http';
import type { AuthUser } from '../../../shared/types';

let ctx: TestCtx;
let owner: HttpClient;
let writer: HttpClient;
let anon: HttpClient;
let programId: string;

const API = '/api/marketing';
const T0 = 1786600001000;
const NOW = T0 + 60_000;

/** Invented geography. The region is a place that does not exist, so nothing
 *  here can accidentally assert something about the shipped dataset. */
const REGION = 'Farflung Province';
const SERVED = 'area_cabbage_quarter';
const IDLE = 'area_turnip_hill';
const OFF = 'area_distant_marsh';

interface AreaWire {
  id: string;
  key: string;
  region: string;
  name: string;
  active: boolean;
  seeded: boolean;
  revision: number;
  needsAction: number;
  open: number;
  loadUnits: number;
  oldestAgeMs: number | null;
}

interface AreasBody {
  areas: AreaWire[];
  outOfArea: { needsAction: number; open: number };
}

async function login(user: AuthUser): Promise<HttpClient> {
  const client = httpClient(ctx.db);
  const res = await client.post('/api/auth/login', {
    email: user.email,
    password: SEED_PASSWORD,
  });
  expect(res.status).toBe(200);
  return client;
}

async function makeArea(
  id: string,
  name: string,
  active: boolean,
  aliases: string[] = [],
  region = REGION,
): Promise<void> {
  const array =
    aliases.length === 0
      ? sql`'{}'::text[]`
      : sql`ARRAY[${sql.join(
          aliases.map((alias) => sql`${alias}`),
          sql`, `,
        )}]::text[]`;
  await ctx.db.execute(sql`
    INSERT INTO marketing_service_areas
      (id, key, region, name, aliases, active, seeded, sort_order, created_at, updated_at)
    VALUES (${id}, ${id.replace(/^area_/, '').replace(/_/g, '-')}, ${region}, ${name},
            ${array}, ${active}, false, 0, ${T0}, ${T0})`);
}

/** A return in a stage, placed on a board (or on none). Raw SQL rather than the
 *  intake route, because several of these are in stages the intake cannot
 *  create and the subject here is the COUNTS, not the lifecycle. */
async function place(
  id: string,
  areaId: string | null,
  status: string,
  qty: number,
  createdAt = NOW,
): Promise<void> {
  /* An `awarded` row must satisfy `marketing_return_requests_award_ck` — the
   * money is pinned in the database, so a fixture claiming that status has to
   * carry arithmetic that adds up. */
  const awarded = status === 'awarded';
  await ctx.db.execute(sql`
    INSERT INTO marketing_return_requests
      (id, program_id, customer_email, qty_declared, qty_accepted, qty_rejected,
       points_per_unit_snapshot, points_awarded, source, status, service_area_id,
       created_at, updated_at)
    VALUES (${id}, ${programId}, ${`${id}@example.test`}, ${qty},
            ${awarded ? qty : null}, ${awarded ? 0 : null},
            7, ${awarded ? qty * 7 : null}, 'admin',
            ${status}, ${areaId}, ${createdAt}, ${createdAt})`);
}

const byId = (body: AreasBody, id: string): AreaWire => {
  const found = body.areas.find((area) => area.id === id);
  expect(found, id).toBeDefined();
  return found as AreaWire;
};

beforeAll(async () => {
  ctx = await freshDb();
  owner = await login(ctx.users.owner);
  writer = await login(ctx.users.writer);
  anon = httpClient(ctx.db);

  const res = await owner.post(`${API}/programs`, {
    key: 'bottle-caps',
    kind: 'unit_return',
    name: 'Cap Returns',
    pointsLabelSingular: 'Bottle Cap',
    pointsLabelPlural: 'Bottle Caps',
    unitLabelSingular: 'canister',
    unitLabelPlural: 'canisters',
    minUnitsPerReturn: 4,
    pointsPerUnit: 7,
  });
  expect(res.status).toBe(201);
  programId = (await json<{ program: { id: string } }>(res)).program.id;

  const settings = await json<{ settings: { revision: number } }>(await owner.get(`${API}/settings`));
  expect(
    (
      await owner.patch(`${API}/settings`, {
        expectedRevision: settings.settings.revision,
        defaultReturnProgramId: programId,
      })
    ).status,
  ).toBe(200);
});

afterAll(() => ctx.close());

beforeEach(async () => {
  await ctx.db.execute(sql`TRUNCATE marketing_return_requests, marketing_return_events,
                                    marketing_ledger, marketing_balances,
                                    marketing_email_intents CASCADE`);
  /* The seeded ~800 survive — several assertions below are about them. Anything
   * a test typed goes, which is what the `seeded` flag is for. */
  await ctx.db.execute(sql`DELETE FROM marketing_service_areas WHERE seeded = false`);
});

// ------------------------------------------------------------------ reading

describe('GET /areas — contract #6.1', () => {
  it('counts what is waiting per board, and leaves the closed ones out', async () => {
    await makeArea(SERVED, 'Cabbage Quarter', true);
    await place('ret_a', SERVED, 'requested', 6, NOW - 10_000);
    await place('ret_b', SERVED, 'received', 4);
    await place('ret_c', SERVED, 'scheduled', 2);
    /* Closed returns are not work and not load: an area whose only old return
     * was awarded last month is not an area with a problem today. */
    await place('ret_d', SERVED, 'awarded', 99);
    await place('ret_e', SERVED, 'cancelled', 99);

    const body = await json<AreasBody>(await owner.get(`${API}/areas`));
    const area = byId(body, SERVED);
    /* `requested + received` — the two stages where the ADMIN is the blocker.
     * The scheduled one is waiting on a driver and is open but not action. */
    expect(area.needsAction).toBe(2);
    expect(area.open).toBe(3);
    expect(area.loadUnits).toBe(12);
    expect(area.oldestAgeMs).toBeGreaterThanOrEqual(10_000);
  });

  it('lists an idle area with zeros rather than hiding it', async () => {
    /*
     * THE DESIGN DECISION, ASSERTED. Removing a district with nothing waiting
     * would read as "we do not serve there", which is a different and much worse
     * claim than "nothing is waiting there today". The switcher greys it; the
     * API still has to send it.
     */
    await makeArea(SERVED, 'Cabbage Quarter', true);
    await makeArea(IDLE, 'Turnip Hill', true);
    await place('ret_a', SERVED, 'requested', 6);

    const body = await json<AreasBody>(await owner.get(`${API}/areas`));
    expect(byId(body, IDLE)).toMatchObject({
      needsAction: 0,
      open: 0,
      loadUnits: 0,
      oldestAgeMs: null,
    });
  });

  it('reports returns on no board at all in the footer, never as an area', async () => {
    /*
     * The out-of-area group is the ABSENCE of a place, not a place. Given a row
     * among the areas it would sort somewhere in the list and be switchable to,
     * which is exactly the claim the design refuses to make.
     */
    await makeArea(SERVED, 'Cabbage Quarter', true);
    await place('ret_a', null, 'requested', 6);
    await place('ret_b', null, 'scheduled', 3);
    await place('ret_c', null, 'cancelled', 3);

    const body = await json<AreasBody>(await owner.get(`${API}/areas`));
    expect(body.outOfArea).toEqual({ needsAction: 1, open: 2 });
    expect(body.areas.some((area) => area.id === null || area.name === '')).toBe(false);
  });

  it('narrows to the served set for the switcher, and ships everything otherwise', async () => {
    await makeArea(SERVED, 'Cabbage Quarter', true);
    await makeArea(OFF, 'Distant Marsh', false);

    const all = await json<AreasBody>(await owner.get(`${API}/areas`));
    expect(all.areas.map((a) => a.id)).toContain(OFF);

    const served = await json<AreasBody>(await owner.get(`${API}/areas?active=true`));
    expect(served.areas.map((a) => a.id)).toContain(SERVED);
    expect(served.areas.map((a) => a.id)).not.toContain(OFF);
    expect(served.areas.every((a) => a.active)).toBe(true);
  });

  it('ships the shipped dataset: every region present, one of them served', async () => {
    /*
     * The model is national from the first day and only the DATA is one city, so
     * the far-away rows are already there and an owner switching on a region is
     * a Switch rather than a deploy. Counted and grouped rather than named —
     * except the one row that has to be named to prove it reached this far.
     */
    const body = await json<AreasBody>(await owner.get(`${API}/areas`));
    const seeded = body.areas.filter((area) => area.seeded);
    expect(new Set(seeded.map((area) => area.region)).size).toBe(37);
    expect(new Set(seeded.filter((area) => area.active).map((area) => area.region)).size).toBe(1);

    const faraway = seeded.find((area) => area.id === 'area_rivers_port_harcourt');
    expect(faraway).toBeDefined();
    expect(faraway?.active).toBe(false);
    expect(faraway?.seeded).toBe(true);
  });

  it('needs a session, and needs nothing more than one', async () => {
    expect((await anon.get(`${API}/areas`)).status).toBe(401);
    // A writer must SEE the boards to work them; only writing the list is the
    // owner's, which is the next describe.
    expect((await writer.get(`${API}/areas`)).status).toBe(200);
  });

  it('refuses a filter it does not have, rather than ignoring it', async () => {
    // `.strict()`, like every other query in this subsystem: a mistyped filter
    // that is silently dropped returns the whole table and looks like a bug in
    // the switcher.
    expect((await owner.get(`${API}/areas?activ=true`)).status).toBe(400);
    /* `?active=false` is NOT a way to ask for the unserved ones — the parameter
     * has one legal value and its absence means everything. A boolean coercion
     * here would map "false" to true and return the exact opposite. */
    expect((await owner.get(`${API}/areas?active=false`)).status).toBe(400);
  });
});

// --------------------------------------------------------------- the gate

describe('the intake gate — outside_service_area', () => {
  let emailSeq = 0;
  const nextEmail = () => `dara-${(emailSeq += 1)}@example.test`;

  it('refuses an area nobody has heard of, and names the ones we do serve', async () => {
    await makeArea(SERVED, 'Cabbage Quarter', true);
    await makeArea(IDLE, 'Turnip Hill', true);

    const res = await owner.post(`${API}/returns`, {
      email: nextEmail(),
      qtyDeclared: 6,
      serviceAreaId: 'area_atlantis',
    });
    expect(res.status).toBe(409);
    const body = await json<{ error: string; served: string[] }>(res);
    expect(body.error).toBe('outside_service_area');
    /*
     * THE LIST TRAVELS ON THE ERROR. A customer told only "no" has a dead end;
     * told "not there, but here are the places that work" they have something to
     * do. It has to come from the database on every refusal, because an owner
     * switching a district off at nine must change the sentence at nine.
     */
    expect(body.served).toContain('Cabbage Quarter');
    expect(body.served).toContain('Turnip Hill');
  });

  it('REFUSES AN AREA THAT EXISTS AND IS SWITCHED OFF — the whole point of the flag', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE MUTATION THIS TEST EXISTS FOR. Drop `&& area.active` from
     * `requireServedArea`, or `WHERE active` from the intake's INSERT, and every
     * other assertion in this repository stays green while the business starts
     * promising vans to places it has no driver for.
     *
     * The row EXISTS — the refusal is not "no such place", it is "not yet".
     * ═══════════════════════════════════════════════════════════════════════
     */
    await makeArea(SERVED, 'Cabbage Quarter', true);
    await makeArea(OFF, 'Distant Marsh', false);

    const exists = await ctx.db.execute(sql`
      SELECT active FROM marketing_service_areas WHERE id = ${OFF}`);
    expect(exists.rows).toHaveLength(1);
    expect(exists.rows[0].active).toBe(false);

    const res = await owner.post(`${API}/returns`, {
      email: nextEmail(),
      qtyDeclared: 6,
      serviceAreaId: OFF,
    });
    expect(res.status).toBe(409);
    const body = await json<{ error: string; served: string[] }>(res);
    expect(body.error).toBe('outside_service_area');
    /* And the refusal does not leak it as somewhere to try. */
    expect(body.served).not.toContain('Distant Marsh');
  });

  it('forgives the spelling — case, spacing and punctuation all resolve', async () => {
    /*
     * The alias list is what stops a customer being told they are outside the
     * served set for writing their own neighbourhood their own way. Both sides
     * are folded, so nothing depends on the dataset being punctuated the way the
     * customer punctuates.
     */
    await makeArea(SERVED, 'Cabbage Quarter', true, ['cabbage 2', 'the cabbage']);

    for (const token of [
      'Cabbage Quarter',
      'cabbage quarter',
      'CabbageQuarter',
      '  cabbage-quarter  ',
      'Cabbage 2',
      'cabbage2',
      'THE CABBAGE',
      SERVED,
    ]) {
      const res = await owner.post(`${API}/returns`, {
        email: nextEmail(),
        qtyDeclared: 6,
        serviceAreaId: token,
      });
      expect(res.status, token).toBe(201);
      const detail = await json<{ request: { serviceAreaId: string } }>(res);
      expect(detail.request.serviceAreaId, token).toBe(SERVED);
    }
  });

  it('prefers the SERVED area when a name means two places', async () => {
    /*
     * Place names repeat: three of the shipped districts share a name with a
     * local government area in some other state. The tie-break is "active
     * first", and it is right — only a served area could have accepted the
     * return anyway.
     */
    await makeArea(SERVED, 'Turnip Hill', true);
    await makeArea(OFF, 'Turnip Hill', false, [], 'Nearby Province');

    const res = await owner.post(`${API}/returns`, {
      email: nextEmail(),
      qtyDeclared: 6,
      serviceAreaId: 'turnip hill',
    });
    expect(res.status).toBe(201);
    expect((await json<{ request: { serviceAreaId: string } }>(res)).request.serviceAreaId).toBe(
      SERVED,
    );
  });

  it('lets an ADMIN log an out-of-area return, which can never be awarded', async () => {
    /*
     * A phone-in from out of town is a real request. Refusing to record it would
     * not make it stop existing; it would make it exist only in somebody's
     * memory. So it is logged with no board, lands in the footer, and the
     * DATABASE is what stops it ever paying.
     */
    await makeArea(SERVED, 'Cabbage Quarter', true);
    const res = await owner.post(`${API}/returns`, { email: nextEmail(), qtyDeclared: 6 });
    expect(res.status).toBe(201);

    const detail = await json<{ request: { id: string; serviceAreaId: string | null } }>(res);
    expect(detail.request.serviceAreaId).toBeNull();

    const body = await json<AreasBody>(await owner.get(`${API}/areas`));
    expect(body.outOfArea.open).toBe(1);
  });

  /**
   * `POST /returns/request` — the public form this test used to drive — is
   * retired (`returns/routes.ts`); the customer's own requirement to name a
   * district now lives on `/me/returns`'s `.strict()` body, which needs a shop
   * session to reach. That test moved to `server/shop/composition.test.ts`,
   * into the describe block a customer's own return already has — the one
   * place a shop session is legal, and the only place left where the
   * requirement can still be driven end to end.
   */
  it('gives the ADMIN intake the same 409, with the same list — the gate does not care who is asking', async () => {
    /*
     * RE-POINTED FROM THE RETIRED PUBLIC FORM TO THE ADMIN INTAKE. `createRequest`
     * calls `requireServedArea` whenever a `serviceAreaId` is supplied, regardless
     * of which caller supplied it, so this is still a genuine exercise of the
     * gate rather than a test standing in for one that no longer exists.
     */
    await makeArea(SERVED, 'Cabbage Quarter', true);
    await makeArea(OFF, 'Distant Marsh', false);
    const res = await owner.post(`${API}/returns`, {
      email: nextEmail(),
      qtyDeclared: 6,
      serviceAreaId: OFF,
    });
    expect(res.status).toBe(409);
    const body = await json<{ error: string; served: string[] }>(res);
    expect(body.error).toBe('outside_service_area');
    /*
     * `served` IS THE WHOLE SERVED SET, not this test's corner of it — the
     * shipped seed switches on a city's worth of districts and they are all real
     * answers to "where can I send this instead". Asserted by membership for
     * that reason: pinning the array would pin the seed's contents into a suite
     * about the gate, and would break the day an owner switched a district off.
     */
    expect(body.served).toContain('Cabbage Quarter');
    expect(body.served).not.toContain('Distant Marsh');
  });
});

// ------------------------------------------------------------------ writing

describe('the areas an owner edits — contract #6.1b', () => {
  it('is closed to a writer, in both directions', async () => {
    /*
     * WHERE VANS GO IS THE OWNER'S DECISION, beside a program's rate and the
     * redemption economics rather than beside the day's return processing. The
     * UI renders these controls as ABSENT for a writer; this is the backstop.
     */
    await makeArea(SERVED, 'Cabbage Quarter', true);
    const created = await writer.post(`${API}/areas`, { region: REGION, name: 'Sprout Lane' });
    expect(created.status).toBe(403);
    const patched = await writer.patch(`${API}/areas/${SERVED}`, {
      expectedRevision: 1,
      active: false,
    });
    expect(patched.status).toBe(403);
  });

  it('adds an area — switched OFF, and not seeded', async () => {
    const res = await owner.post(`${API}/areas`, {
      region: REGION,
      name: 'Sprout Lane',
      aliases: ['Sprout', 'sprout'],
    });
    expect(res.status).toBe(201);
    const { area } = await json<{ area: { id: string; key: string; active: boolean; seeded: boolean } }>(res);
    /* Created inactive, like every other area: switching one on is the separate,
     * deliberate act, not something that happens the instant somebody finishes
     * typing a name. */
    expect(area.active).toBe(false);
    /* `seeded` is false because a PERSON typed this one. It is the only thing
     * the Areas screen may derive "shipped" from. */
    expect(area.seeded).toBe(false);
    expect(area.key).toBe('farflung-province-sprout-lane');

    const stored = await ctx.db.execute(sql`
      SELECT aliases FROM marketing_service_areas WHERE id = ${area.id}`);
    // Lower-cased and de-duplicated rather than refused: an owner typing
    // "Sprout" has said something correct and useful.
    expect(stored.rows[0].aliases).toEqual(['sprout']);
  });

  it('refuses a duplicate name in one region, and allows it in another', async () => {
    await makeArea(SERVED, 'Cabbage Quarter', true);

    const clash = await owner.post(`${API}/areas`, { region: REGION, name: 'cabbage quarter' });
    expect(clash.status).toBe(409);
    expect(await json(clash)).toMatchObject({
      error: 'duplicate_area',
      region: REGION,
      name: 'cabbage quarter',
    });

    /*
     * …AND THE SAME NAME IN A DIFFERENT REGION IS FINE. Place names genuinely
     * repeat across states, and a global uniqueness would refuse the second one
     * a real place.
     */
    const elsewhere = await owner.post(`${API}/areas`, {
      region: 'Nearby Province',
      name: 'Cabbage Quarter',
    });
    expect(elsewhere.status).toBe(201);
  });

  it('renames a SEEDED area and keeps it seeded', async () => {
    /*
     * The shipped dataset misspells real places. An owner must be able to
     * correct one without a developer, and `seeded` must survive the correction:
     * it only ever meant "this row was not typed by a person", so clearing it
     * would make the Areas screen call a shipped row hand-made the moment
     * somebody fixed its spelling.
     */
    const id = 'area_rivers_port_harcourt';
    const res = await owner.patch(`${API}/areas/${id}`, {
      expectedRevision: 1,
      name: 'Corrected By The Owner',
    });
    expect(res.status).toBe(200);
    const { area } = await json<{ area: AreaWire }>(res);
    expect(area.name).toBe('Corrected By The Owner');
    expect(area.seeded).toBe(true);
    expect(area.revision).toBe(2);
    /* The key does not move with the name — it is the stable handle, and the
     * PATCH schema has no field for it at all. */
    expect(area.key).toBe('rivers-port-harcourt');

    await owner.patch(`${API}/areas/${id}`, { expectedRevision: 2, name: 'Port Harcourt' });
  });

  it('has no field for the key or the seeded flag — structurally, not by a guard', async () => {
    await makeArea(SERVED, 'Cabbage Quarter', true);
    for (const body of [{ key: 'something-else' }, { seeded: false }]) {
      const res = await owner.patch(`${API}/areas/${SERVED}`, { expectedRevision: 1, ...body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('loses a CAS race and hands back the row that won', async () => {
    await makeArea(SERVED, 'Cabbage Quarter', true);
    expect(
      (await owner.patch(`${API}/areas/${SERVED}`, { expectedRevision: 1, name: 'Theirs' })).status,
    ).toBe(200);

    const stale = await owner.patch(`${API}/areas/${SERVED}`, {
      expectedRevision: 1,
      name: 'Mine',
    });
    expect(stale.status).toBe(409);
    /* THE ROW TRAVELS UNDER ITS OWN NAME, so the conflict notice renders "Load
     * theirs" out of the payload rather than spending a second round trip to
     * discover a third state. */
    expect(await json(stale)).toMatchObject({
      error: 'stale_write',
      expected: 1,
      actual: 2,
      area: { id: SERVED, name: 'Theirs' },
    });
  });

  it('REFUSES to switch off a board that still holds open returns, and says how many', async () => {
    /*
     * Deactivating would strand them: they would fall off every board into the
     * out-of-area footer, unrewardable, with nothing on screen to say why. The
     * count is the payload's whole job — it turns a wall into "move these four
     * first".
     */
    await makeArea(SERVED, 'Cabbage Quarter', true);
    await place('ret_a', SERVED, 'requested', 6);
    await place('ret_b', SERVED, 'collected', 4);
    await place('ret_c', SERVED, 'awarded', 4);

    const res = await owner.patch(`${API}/areas/${SERVED}`, {
      expectedRevision: 1,
      active: false,
    });
    expect(res.status).toBe(409);
    /* THREE returns are on this board and only TWO are open. A closed one is
     * history, not a pickup somebody is waiting for. */
    expect(await json(res)).toMatchObject({ error: 'area_in_use', open: 2 });

    const still = await ctx.db.execute(sql`
      SELECT active FROM marketing_service_areas WHERE id = ${SERVED}`);
    expect(still.rows[0].active).toBe(true);
  });

  it('switches one off once nothing is waiting, and on with no ceremony at all', async () => {
    await makeArea(SERVED, 'Cabbage Quarter', true);
    await place('ret_done', SERVED, 'awarded', 4);

    const off = await owner.patch(`${API}/areas/${SERVED}`, {
      expectedRevision: 1,
      active: false,
    });
    expect(off.status).toBe(200);
    expect((await json<{ area: AreaWire }>(off)).area.active).toBe(false);

    /* Switching ON is never refused — there is nothing to strand. */
    const on = await owner.patch(`${API}/areas/${SERVED}`, { expectedRevision: 2, active: true });
    expect(on.status).toBe(200);
    expect((await json<{ area: AreaWire }>(on)).area.active).toBe(true);
  });

  it('answers gone for an area that is not there', async () => {
    const res = await owner.patch(`${API}/areas/area_nowhere`, {
      expectedRevision: 1,
      name: 'Nowhere',
    });
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ error: 'gone' });
  });

  it('has no DELETE — switching off is the retirement', async () => {
    /*
     * The absence is the design (plan §6.1b). An area that has ever held a
     * return is history, and the database agrees: the foreign key has no
     * `ON DELETE`, so removing one with returns against it is refused at the
     * bottom as well as unrouted at the top.
     */
    await makeArea(SERVED, 'Cabbage Quarter', true);
    const res = await owner.del(`${API}/areas/${SERVED}`);
    expect(res.status).toBe(404);
  });
});
