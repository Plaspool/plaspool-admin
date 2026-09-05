/**
 * Programs — contract #1-3, driven through the REAL app.
 *
 * ROUTE SUITES GO THROUGH THE WHOLE STACK — router, origin guard, session
 * middleware, marketing's own `onError`, the global error handler — because the
 * seam between the repository and HTTP is what this task adds and therefore where
 * its defects are. A repo function called directly proves the repo and would miss
 * every one of: the guard that is attached per route, the `.strict()` that makes
 * a rename structurally impossible, and the catalogue payload a screen reads.
 *
 * NO NOUN FROM THE SEEDED PRESET APPEARS IN THIS FILE, and that is a rule rather
 * than taste (spec D11). The preset's words live in migration 0011 and nowhere
 * else; a test that recognised the seeded row by its key would be the first
 * consumer to hard-code a renameable word, and `no-hardcoded-labels.test.ts`
 * greps this directory for exactly that. So the seeded row is found by
 * `seeded === true` — which is also how the UI's "Seeded preset" chip finds it,
 * so the test and the screen are wrong together or not at all.
 *
 * EVERY FIXTURE USES ABSURD LABELS ("Bottle Cap" / "canister"). A suite whose
 * fixtures happen to match the shipped wording cannot tell a label that was read
 * from a row apart from one that was written in source.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { TestCtx } from '../../test/harness';
import type { HttpClient } from '../../test/http';
import type { AuthUser } from '../../../shared/types';
import type { Program } from './repo';

let ctx: TestCtx;
let owner: HttpClient;
let writer: HttpClient;
let marketing: HttpClient;
/** No session at all — a fresh browser, not a logged-out one. */
let anon: HttpClient;

async function login(user: AuthUser): Promise<HttpClient> {
  const client = httpClient(ctx.db);
  await client.signIn(user);
  return client;
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

/**
 * A distinct key per call, because `key` is UNIQUE and this suite creates a lot
 * of programs. Everything else is the same absurd fixture throughout.
 */
let keySeq = 0;
function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  keySeq += 1;
  return {
    key: `bottle-caps-${keySeq}`,
    kind: 'unit_return',
    name: 'Cap Returns',
    pointsLabelSingular: 'Bottle Cap',
    pointsLabelPlural: 'Bottle Caps',
    unitLabelSingular: 'canister',
    unitLabelPlural: 'canisters',
    minUnitsPerReturn: 4,
    pointsPerUnit: 7,
    ...overrides,
  };
}

async function create(overrides: Record<string, unknown> = {}): Promise<Program> {
  const res = await owner.post('/api/marketing/programs', draft(overrides));
  expect(res.status).toBe(201);
  return (await json<{ program: Program }>(res)).program;
}

async function list(client: HttpClient = owner): Promise<Program[]> {
  const res = await client.get('/api/marketing/programs');
  expect(res.status).toBe(200);
  return (await json<{ programs: Program[] }>(res)).programs;
}

// --------------------------------------------------------------------- mount

describe('mounting and the guards', () => {
  it('answers 401 without a session on every route, and 404 for a path it does not have', async () => {
    expect((await anon.get('/api/marketing/programs')).status).toBe(401);
    expect((await anon.post('/api/marketing/programs', draft())).status).toBe(401);
    expect((await anon.patch('/api/marketing/programs/prg_x', {})).status).toBe(401);

    /*
     * The reason the guards are attached PER ROUTE. A blanket
     * `routes.use('*', requireAuth())` would answer 401 here too — the guard
     * would refuse a request that had no handler to reach — and an unrouted path
     * has to stay a 404 so a client can tell "you may not" from "there is no
     * such thing" (`server/shop/catalog/routes.ts` measured this on the blog).
     */
    const missing = await owner.get('/api/marketing/programs/prg_x/nothing-here');
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({ error: 'gone' });
  });

  it('is the marketing domain’s: marketing reads, a writer is refused outright', async () => {
    /*
     * THE ROLE MATRIX SINCE MIGRATION 0680: programs are the marketing
     * domain's, so the marketing role reads them and a content writer is off
     * the surface entirely. The 403s below are the domain gate's, and the UI
     * renders the section as absent for roles that do not hold it.
     */
    expect((await writer.get('/api/marketing/programs')).status).toBe(403);
    expect((await list(marketing)).length).toBeGreaterThan(0);

    const created = await create();
    const post = await writer.post('/api/marketing/programs', draft());
    expect(post.status).toBe(403);
    const patch = await writer.patch(`/api/marketing/programs/${created.id}`, {
      expectedRevision: created.revision,
      name: 'Writer Was Here',
    });
    expect(patch.status).toBe(403);

    // And the refusal actually refused: nothing was written.
    const after = (await list()).find((p) => p.id === created.id);
    expect(after?.name).toBe('Cap Returns');
  });
});

// ---------------------------------------------------------------------- list

describe('GET /programs', () => {
  it('returns the migration-seeded preset with seeded: true and zero aggregates', async () => {
    const seeded = (await list()).filter((p) => p.seeded);
    expect(seeded).toHaveLength(1);
    /*
     * ASSERTED BY THE FLAG, NEVER BY THE KEY. `seeded` is a column migration 0011
     * sets on exactly the rows it installed, and the chip in the UI derives from
     * it for the same reason this test does: the preset's key and name are
     * renameable words, and matching on one would break the moment somebody
     * renames it — which is the one thing this feature promises is safe.
     */
    expect(seeded[0].revision).toBe(1);
    expect(seeded[0].status).toBe('active');
    expect(seeded[0].kind).toBe('unit_return');
    // Nothing has been returned or awarded against it on a fresh install, and
    // "no rows" has to read as 0 rather than as null or as an absent key.
    expect(seeded[0].awardedTotal).toBe(0);
    expect(seeded[0].openReturns).toBe(0);
  });

  it('lists a created program with seeded: false and the whole frozen shape', async () => {
    const created = await create({ name: 'Cap Returns Two' });
    const found = (await list()).find((p) => p.id === created.id);

    expect(found).toEqual({
      id: created.id,
      key: created.key,
      kind: 'unit_return',
      name: 'Cap Returns Two',
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
      unitLabelSingular: 'canister',
      unitLabelPlural: 'canisters',
      minUnitsPerReturn: 4,
      pointsPerUnit: 7,
      /* 0920's money rates. NULL on a fresh programme and not 0: nobody has
       * said what a unit costs us, and a zero would be the analytics screen
       * asserting it is free. */
      unitCostMinor: null,
      unitMarketCostMinor: null,
      status: 'active',
      conditions: {},
      /*
       * FALSE, and the assertion is the point of the column. `seeded` may only
       * ever be true for rows the migration installed — a route that let a caller
       * set it would let anybody mint a "Seeded preset" chip, and the create body
       * has no such field at all.
       */
      seeded: false,
      awardedTotal: 0,
      openReturns: 0,
      revision: 1,
      createdAt: found?.createdAt,
      updatedAt: found?.updatedAt,
    });
    expect(found?.createdAt).toBeGreaterThan(0);
  });

  it('counts open returns and sums awarded points per program', async () => {
    const program = await create();
    const now = Date.now();

    /*
     * Seeded by SQL rather than through the lifecycle routes, which do not exist
     * yet (A4/A5). What is under test is the aggregate expression, not the
     * lifecycle — and a fixture written in SQL is one that cannot pass because
     * two of this task's own functions agree with each other.
     *
     * Three requests: two open (`requested`, `received`) and one closed
     * (`awarded`). The closed one must NOT count as open, and its ledger row must
     * be the only thing `awardedTotal` sees.
     */
    const insertRequest = async (id: string, email: string, status: string) => {
      await ctx.db.execute(sql`
        INSERT INTO marketing_return_requests
          (id, program_id, customer_email, qty_declared, points_per_unit_snapshot,
           source, status, created_at, updated_at)
        VALUES (${id}, ${program.id}, ${email}, 6, 7, 'admin', ${status}, ${now}, ${now})`);
    };
    // Distinct emails: one open return per address is a partial unique index.
    await insertRequest('ret_agg_open_a', 'a@example.test', 'requested');
    await insertRequest('ret_agg_open_b', 'b@example.test', 'received');
    await ctx.db.execute(sql`
      INSERT INTO marketing_return_requests
        (id, program_id, customer_email, qty_declared, qty_accepted, qty_rejected,
         points_per_unit_snapshot, points_awarded, source, status, service_area_id,
         created_at, updated_at)
      VALUES ('ret_agg_done', ${program.id}, 'c@example.test', 6, 5, 1,
              7, 35, 'admin', 'awarded',
              /* ANY SERVED AREA. Migration 0012 refuses an awarded return with
               * none, and this fixture is about a program's aggregates rather
               * than about geography — so it asks the seed for a board rather
               * than naming one, which would put a real place in a test file. */
              (SELECT id FROM marketing_service_areas WHERE active ORDER BY id LIMIT 1),
              ${now}, ${now})`);
    await ctx.db.execute(sql`
      INSERT INTO marketing_ledger
        (id, customer_email, program_id, kind, delta, balance_after, reason,
         return_request_id, actor_type, created_at)
      VALUES ('pts_agg_one', 'c@example.test', ${program.id}, 'return_award', 35, 35,
              '5 accepted × 7 = 35 Bottle Caps', 'ret_agg_done', 'admin', ${now})`);

    /*
     * A MANUAL ADJUSTMENT TAGGED WITH THE SAME PROGRAM, WHICH MUST NOT MOVE
     * `awardedTotal`. Contract #18 lets an adjustment carry a `programId`, and
     * `marketing_ledger_award_sign_ck` only forces a program ONTO `return_award`
     * rows — nothing stops a `manual` one from having it. So the sum's
     * `kind = 'return_award'` filter is the only thing separating "what this
     * programme awarded" from "what happens to be tagged with it".
     *
     * A DEBIT rather than a credit, because that is the sharp direction: without
     * the filter a clawback would silently REDUCE the lifetime figure the Rewards
     * table shows, which reads as an award being un-awarded rather than as an
     * adjustment being made.
     */
    await ctx.db.execute(sql`
      INSERT INTO marketing_ledger
        (id, customer_email, program_id, kind, delta, balance_after, reason,
         actor_type, created_at)
      VALUES ('pts_agg_manual', 'c@example.test', ${program.id}, 'manual', -5, 30,
              'Goodwill clawback', 'admin', ${now})`);

    const found = (await list()).find((p) => p.id === program.id);
    expect(found?.openReturns).toBe(2);
    expect(found?.awardedTotal).toBe(35);

    // And the aggregates are per program, not global: the seeded preset still
    // reads zero with another program's history in the same tables.
    expect((await list()).find((p) => p.seeded)?.awardedTotal).toBe(0);
    expect((await list()).find((p) => p.seeded)?.openReturns).toBe(0);
  });

  it('orders by creation, oldest first', async () => {
    /*
     * DETERMINISTIC TIMESTAMPS, WRITTEN BY SQL. The route stamps `Date.now()`, so
     * two programs created through it can tie on `created_at` and fall through to
     * the `id ASC` tie-break — stable, but not a thing to assert an ordering
     * against. The property under test is the `ORDER BY`, not the clock.
     *
     * `ORDER BY created_at DESC` — the ordering a queue wants — reverses these
     * two, which is the change this pins: on the one screen where the reader is
     * editing the rows they are looking at, a list that reshuffles on every save
     * loses their place.
     *
     * IT DELIBERATELY DOES NOT ASSERT THAT THE SEEDED PRESET IS FIRST. Migration
     * 0011 stamps that row with a fixed authoring-time constant rather than a
     * clock read, so whether it sorts above a row created today depends on which
     * side of that constant the clock is on. `seeded` is the handle that does not.
     */
    const insert = async (id: string, key: string, createdAt: number) => {
      await ctx.db.execute(sql`
        INSERT INTO marketing_programs
          (id, key, kind, name, points_label_singular, points_label_plural,
           unit_label_singular, unit_label_plural, min_units_per_return,
           points_per_unit, created_at, updated_at)
        VALUES (${id}, ${key}, 'unit_return', 'Ordering Fixture',
                'Bottle Cap', 'Bottle Caps', 'canister', 'canisters', 4, 7,
                ${createdAt}, ${createdAt})`);
    };
    // Inserted newest-first, so a list that merely echoed insertion order passes
    // for the wrong reason.
    await insert('prg_order_late', 'order-late', 2_000);
    await insert('prg_order_early', 'order-early', 1_000);

    // Both predate every other row in the table — the seed's constant and the
    // suite's own clock readings are both far above 2000 — so they lead the list.
    expect((await list()).map((p) => p.id).slice(0, 2)).toEqual([
      'prg_order_early',
      'prg_order_late',
    ]);
  });

  it('carries the aggregates on the create and patch responses too', async () => {
    /*
     * `Program` is one frozen type and every route that returns one returns all
     * of it. A create response missing `awardedTotal` would be a screen rendering
     * `undefined` in the column it just filled, which no type on this side of the
     * wire would catch.
     */
    const created = await create();
    expect(created.awardedTotal).toBe(0);
    expect(created.openReturns).toBe(0);

    const res = await owner.patch(`/api/marketing/programs/${created.id}`, {
      expectedRevision: created.revision,
      name: 'Renamed',
    });
    const { program } = await json<{ program: Program }>(res);
    expect(program.awardedTotal).toBe(0);
    expect(program.openReturns).toBe(0);
  });
});

// -------------------------------------------------------------------- create

describe('POST /programs', () => {
  it('creates an adhoc program with no unit fields at all', async () => {
    keySeq += 1;
    const res = await owner.post('/api/marketing/programs', {
      key: `goodwill-${keySeq}`,
      kind: 'adhoc',
      name: 'Goodwill',
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
    });
    expect(res.status).toBe(201);

    const { program } = await json<{ program: Program }>(res);
    expect(program.kind).toBe('adhoc');
    // Nothing is counted, so there is no word for the thing being counted and no
    // rate to price it at. The kind-coupling CHECK says the same in the database.
    expect(program.unitLabelSingular).toBeNull();
    expect(program.unitLabelPlural).toBeNull();
    expect(program.minUnitsPerReturn).toBeNull();
    expect(program.pointsPerUnit).toBeNull();
  });

  it('refuses a unit_return program with the unit fields missing, naming the field', async () => {
    keySeq += 1;
    const res = await owner.post('/api/marketing/programs', {
      key: `half-built-${keySeq}`,
      kind: 'unit_return',
      name: 'Half Built',
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
    });
    expect(res.status).toBe(400);
    /*
     * A NAMED FIELD AND NOT `body`. The catalogue's treatment for `bad_request`
     * is an inline error keyed by `detail` with the focus moved to that input —
     * "something was wrong" with no field to blame is the error this contract
     * exists to stop shipping.
     */
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'unitLabelSingular' });
  });

  it('refuses an adhoc program that carries unit fields, structurally', async () => {
    keySeq += 1;
    const res = await owner.post('/api/marketing/programs', {
      key: `confused-${keySeq}`,
      kind: 'adhoc',
      name: 'Confused',
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
      unitLabelSingular: 'canister',
    });
    /*
     * "Required iff `kind = 'unit_return'`" is a SHAPE here, not a check: the
     * body is a discriminated union, so the adhoc branch simply has no such key
     * and `.strict()` refuses it. Accepted-and-ignored would leave the caller
     * believing it had set a word that the row does not have.
     */
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'unitLabelSingular' });
  });

  it('refuses a duplicate key with 409 duplicate_program_key carrying the key', async () => {
    const first = await create();
    const res = await owner.post('/api/marketing/programs', draft({ key: first.key }));
    expect(res.status).toBe(409);

    const body = await json(res);
    expect(body).toMatchObject({ error: 'duplicate_program_key', key: first.key });
    /*
     * 409 AND NOT THE 400 the base class would give unrendered: "that key is
     * taken" is a conflict with state, and it needs different words in a form
     * from "that key has a capital letter in it". The catalogue freezes the
     * extras as `key` alone — no `detail` — so the keys are asserted exactly.
     */
    expect(Object.keys(body).sort()).toEqual(['error', 'key', 'requestId']);
  });

  it('refuses a key the column would refuse, before the column has to', async () => {
    // The CHECK is `lower(key)` and `^[a-z0-9][a-z0-9_-]*$`. Reaching it is a
    // 23514 with no row in the error table, i.e. a 500 for a typo.
    for (const key of ['Bottle-Caps', 'bottle caps', '-leading', '']) {
      const res = await owner.post('/api/marketing/programs', draft({ key }));
      expect([res.status, key]).toEqual([400, key]);
      expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'key' });
    }
  });

  it('refuses a body that tries to set what the server decides', async () => {
    /*
     * `seeded`, `status`, `conditions`, `revision` and the aggregates are all
     * absent from the create schema, so `.strict()` refuses each by name. The
     * sharpest is `seeded`: it is the sole input to the "Seeded preset" chip, so
     * a settable one would be a badge anybody could mint.
     */
    for (const field of ['seeded', 'status', 'conditions', 'revision', 'awardedTotal']) {
      const res = await owner.post('/api/marketing/programs', draft({ [field]: 1 }));
      expect([res.status, field]).toEqual([400, field]);
      expect(await json(res)).toMatchObject({ error: 'bad_request', detail: field });
    }
  });

  it('refuses values the columns would refuse, naming the field', async () => {
    /*
     * THE SAME TABLE THE SETTINGS SUITE CARRIES, AND FOR THE SAME REASON. Every
     * value below reaches a CHECK or an `integer`'s limit if the schema lets it
     * through, and 23514 / 22003 have no row in the error table — so the answer
     * would be a 500 that the client's retry policy re-sends five times for input
     * that can never be stored. The route's validators exist to make each of these
     * an inline error on a named input instead; nothing pinned that until now.
     */
    const cases: [string, unknown][] = [
      // `name <> '' AND name = btrim(name)`: a field of spaces is the empty field
      // it actually is, not a label that renders as nothing.
      ['name', '   '],
      // `points_label_singular <> ''` and its plural — the words a customer reads.
      ['pointsLabelPlural', '  '],
      ['unitLabelSingular', ''],
      // `min_units_per_return > 0` / `points_per_unit > 0`. A minimum of zero is a
      // rule that refuses nothing; a rate of zero awards nothing for a return the
      // customer was told was worth something.
      ['minUnitsPerReturn', 0],
      ['pointsPerUnit', 0],
      // `integer` columns: a fraction is not one, and anything past int4 is 22003.
      ['minUnitsPerReturn', 1.5],
      ['pointsPerUnit', 2_147_483_648],
    ];

    for (const [field, value] of cases) {
      const res = await owner.post('/api/marketing/programs', draft({ [field]: value }));
      expect([res.status, field, value]).toEqual([400, field, value]);
      expect(await json(res)).toMatchObject({ error: 'bad_request', detail: field });
    }
  });

  it('trims surrounding space instead of failing the btrim CHECK', async () => {
    /*
     * THE OTHER HALF OF `marketing_programs_name_ck`, which is `name <> '' AND
     * name = btrim(name)`. A stray leading space is a CHECK violation and so a 500
     * for one keystroke; trimmed at the boundary it is simply the name the admin
     * meant. Asserted on the STORED row as well as on the response, because a trim
     * applied on the way out would leave the untrimmed value in the column, where
     * the next write to touch that row would still fail the CHECK.
     */
    const created = await create({ name: '  Cap Returns  ', pointsLabelSingular: ' Bottle Cap ' });
    expect(created.name).toBe('Cap Returns');
    expect(created.pointsLabelSingular).toBe('Bottle Cap');
    expect((await list()).find((p) => p.id === created.id)?.name).toBe('Cap Returns');
  });

  it('answers a NUL byte with 400, not a 500', async () => {
    const res = await owner.post(
      '/api/marketing/programs',
      draft({ name: `Cap${String.fromCharCode(0)}Returns` }),
    );
    /*
     * U+0000 in a `text` bind is SQLSTATE 22021, which has no row in the error
     * table and answers 500 — a status the client's retry policy re-sends five
     * times for input that can never be accepted. `str()` is the boundary and
     * `server/nul-bytes.test.ts` walks every route to prove nobody forgot it.
     */
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'name' });
  });
});

// --------------------------------------------------------------------- patch

describe('PATCH /programs/:id', () => {
  it('renames every word and bumps the revision', async () => {
    const created = await create();
    const res = await owner.patch(`/api/marketing/programs/${created.id}`, {
      expectedRevision: created.revision,
      name: 'Reel Returns',
      pointsLabelSingular: 'Loop Point',
      pointsLabelPlural: 'Loop Points',
      unitLabelSingular: 'reel',
      unitLabelPlural: 'reels',
      minUnitsPerReturn: 3,
      pointsPerUnit: 11,
      status: 'paused',
    });
    expect(res.status).toBe(200);

    const { program } = await json<{ program: Program }>(res);
    expect(program.name).toBe('Reel Returns');
    expect(program.pointsLabelPlural).toBe('Loop Points');
    expect(program.unitLabelPlural).toBe('reels');
    expect(program.minUnitsPerReturn).toBe(3);
    expect(program.pointsPerUnit).toBe(11);
    expect(program.status).toBe('paused');
    expect(program.revision).toBe(created.revision + 1);
    // The identity did not move with the words. That is the whole promise.
    expect(program.key).toBe(created.key);
    expect(program.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  it('refuses a body carrying key or kind — the rename-safety wall', async () => {
    const created = await create();

    for (const field of ['key', 'kind']) {
      const res = await owner.patch(`/api/marketing/programs/${created.id}`, {
        expectedRevision: created.revision,
        [field]: field === 'key' ? 'moved-key' : 'adhoc',
      });
      /*
       * THE MUTATION TEST FOR `.strict()`. Drop it from the patch schema and this
       * goes green-to-red the useful way round: the body is accepted, the field
       * is silently ignored, and the caller is told 200 for a change that did not
       * happen. `key` is the only stable handle a program has — every ledger row,
       * every return request and the settings' default pointer are attached to
       * the id it identifies — so "silently ignored" is the failure mode this
       * whole design is arranged to make impossible rather than unlikely.
       */
      expect([res.status, field]).toEqual([400, field]);
      expect(await json(res)).toMatchObject({ error: 'bad_request', detail: field });
    }

    const after = (await list()).find((p) => p.id === created.id);
    expect(after?.key).toBe(created.key);
    expect(after?.revision).toBe(created.revision);
  });

  it('refuses a stale revision with 409 stale_write carrying the program', async () => {
    const created = await create();
    const first = await owner.patch(`/api/marketing/programs/${created.id}`, {
      expectedRevision: created.revision,
      name: 'First Writer Won',
    });
    expect(first.status).toBe(200);

    const second = await owner.patch(`/api/marketing/programs/${created.id}`, {
      expectedRevision: created.revision,
      name: 'Second Writer Lost',
    });
    expect(second.status).toBe(409);

    const body = await json<Record<string, unknown>>(second);
    expect(body.error).toBe('stale_write');
    expect(body.expected).toBe(created.revision);
    expect(body.actual).toBe(created.revision + 1);
    /*
     * THE ROW THAT WON TRAVELS WITH THE REFUSAL, under its own name. Spec D7:
     * every 409 carries the re-read entity so no screen needs a second fetch —
     * the conflict notice renders "Load theirs" straight out of this payload. A
     * client forced to re-GET would show a THIRD state (the one true at the time
     * of that second read) as though it were what its write had lost to.
     */
    expect(body.program).toMatchObject({
      id: created.id,
      name: 'First Writer Won',
      revision: created.revision + 1,
    });
  });

  it('requires expectedRevision', async () => {
    const created = await create();
    const res = await owner.patch(`/api/marketing/programs/${created.id}`, { name: 'Nope' });
    // Optional would mean a second tab silently overwrites the first, which is
    // the failure the revision column exists to prevent.
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'expectedRevision' });
  });

  it('answers an unknown id with 404 gone', async () => {
    const res = await owner.patch('/api/marketing/programs/prg_never', {
      expectedRevision: 1,
      name: 'Ghost',
    });
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ error: 'gone' });
  });

  it('refuses a rule field on an adhoc program instead of 500ing on the CHECK', async () => {
    keySeq += 1;
    const res = await owner.post('/api/marketing/programs', {
      key: `manual-only-${keySeq}`,
      kind: 'adhoc',
      name: 'Manual Only',
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
    });
    const { program } = await json<{ program: Program }>(res);

    for (const field of ['unitLabelSingular', 'minUnitsPerReturn', 'pointsPerUnit']) {
      const patch = await owner.patch(`/api/marketing/programs/${program.id}`, {
        expectedRevision: program.revision,
        [field]: field === 'unitLabelSingular' ? 'canister' : 4,
      });
      /*
       * `marketing_programs_kind_fields_ck` ties the four rule columns to the
       * kind, and `kind` is not patchable — so these fields do not exist on this
       * program and never will. Left to the database it is a 23514, i.e. a 500
       * that the client retries five times. Named here, it is an inline error on
       * the input that should not have been rendered.
       */
      expect([patch.status, field]).toEqual([400, field]);
      expect(await json(patch)).toMatchObject({ error: 'bad_request', detail: field });
    }
  });

  it('refuses the same out-of-range values on the way in as on the way up', async () => {
    /*
     * THE PATCH SCHEMA IS A SECOND DECLARATION OF THE SAME LIMITS, and this is the
     * path that matters more: a create with a bad rate never becomes a row, while
     * a PATCH is aimed at a program that already has returns hanging off it. The
     * create suite pins the shared constants; this pins that the patch body
     * actually reuses them rather than declaring `z.number()` and letting the
     * column answer 22003.
     */
    const created = await create();
    const cases: [string, unknown][] = [
      ['name', '  '],
      ['pointsLabelSingular', ''],
      ['pointsPerUnit', 0],
      ['minUnitsPerReturn', 2_147_483_648],
    ];

    for (const [field, value] of cases) {
      const res = await owner.patch(`/api/marketing/programs/${created.id}`, {
        expectedRevision: created.revision,
        [field]: value,
      });
      expect([res.status, field, value]).toEqual([400, field, value]);
      expect(await json(res)).toMatchObject({ error: 'bad_request', detail: field });
    }

    // Nothing was written by any of them — a refused patch must not have spent the
    // revision the caller is still holding.
    expect((await list()).find((p) => p.id === created.id)?.revision).toBe(created.revision);
  });

  it('answers a NUL byte in the id with 400, not a 500', async () => {
    const res = await owner.patch(
      `/api/marketing/programs/${encodeURIComponent(String.fromCharCode(0))}`,
      { expectedRevision: 1, name: 'Nope' },
    );
    expect(res.status).toBe(400);
  });
});
