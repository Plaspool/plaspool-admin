/**
 * Returns on the wire — contract #4-14, driven through the REAL app.
 *
 * ROUTE SUITES GO THROUGH THE WHOLE STACK — router, origin guard, session
 * middleware, marketing's own `onError`, the global error handler — because the
 * seam between the state machine and HTTP is what this task adds and therefore
 * where its defects are. `repo.test.ts` already proves the transitions; what is
 * only provable here is the route ORDER, the guard that is attached per route,
 * the keyset pager, the counts sidecar, and the exact JSON each domain error
 * becomes — including the re-read request every 409 carries so a screen can
 * heal without a second fetch.
 *
 * NO NOUN FROM THE SEEDED PRESET APPEARS IN THIS FILE (spec D11). Every fixture
 * uses absurd labels — "Bottle Cap" / "canister" — and the suite installs its
 * OWN program as the shop's default rather than leaning on the one migration
 * 0011 ships, so a label that was read from a row cannot be mistaken for one
 * that was written in source.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { TestCtx } from '../../test/harness';
import type { HttpClient } from '../../test/http';
import type { AuthUser } from '../../../shared/types';

let ctx: TestCtx;
let owner: HttpClient;
let writer: HttpClient;
let support: HttpClient;
/** No session at all — a fresh browser, not a logged-out one. */
let anon: HttpClient;

/** The program every test logs a return against, and the shop's default. */
let capsProgramId: string;
/** A second one, paused, for the `program_paused` row of the catalogue. */
let pausedProgramId: string;
/** A third, `adhoc`, which can never take returns. */
let adhocProgramId: string;
/** A fourth, whose returns are the only ones the counts assertions see. */
let countsProgramId: string;

const API = '/api/marketing';

async function login(user: AuthUser): Promise<HttpClient> {
  const client = httpClient(ctx.db);
  await client.signIn(user);
  return client;
}

let keySeq = 0;
async function makeProgram(over: Record<string, unknown> = {}): Promise<string> {
  keySeq += 1;
  const res = await owner.post(`${API}/programs`, {
    key: `bottle-caps-${keySeq}`,
    kind: 'unit_return',
    name: 'Cap Returns',
    pointsLabelSingular: 'Bottle Cap',
    pointsLabelPlural: 'Bottle Caps',
    unitLabelSingular: 'canister',
    unitLabelPlural: 'canisters',
    minUnitsPerReturn: 4,
    pointsPerUnit: 7,
    ...over,
  });
  expect(res.status).toBe(201);
  return (await json<{ program: { id: string } }>(res)).program.id;
}

/**
 * A place a van goes, named after nothing real.
 *
 * ABSURD ON PURPOSE, like the labels: a fixture named after a district this
 * business actually serves could not tell code that reads the area off the row
 * from code that hardcoded the place, and it would put a real place name in a
 * source file. Every intake below carries it, because the public route REQUIRES
 * a served area and no return can reach `awarded` without one.
 */
const AREA = 'area_cabbage_quarter';

async function makeArea(): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO marketing_service_areas
      (id, key, region, name, aliases, active, created_at, updated_at)
    VALUES (${AREA}, 'cabbage-quarter', 'Farflung Province', 'Cabbage Quarter',
            ARRAY['the cabbage']::text[], true, 1786600001000, 1786600001000)
    ON CONFLICT DO NOTHING`);
}

/** A DISTINCT address per return: one open return per email is a partial unique
 *  index, so a shared fixture address would make every second create a 409. */
let emailSeq = 0;
const nextEmail = (): string => `dara-${(emailSeq += 1)}@example.test`;

interface Wire {
  id: string;
  status: string;
  revision: number;
  customerEmail: string;
  qtyDeclared: number;
  pickupAddress: string | null;
  allowedActions: string[];
  [key: string]: unknown;
}

interface Detail {
  request: Wire;
  program: Record<string, unknown>;
  events: { type: string; note: string | null; data: Record<string, unknown> | null }[];
  emailIntents: { kind: string; sentAt: number | null; attempts: number }[];
}

async function logReturn(over: Record<string, unknown> = {}): Promise<Detail> {
  await makeArea();
  const res = await owner.post(`${API}/returns`, {
    email: nextEmail(),
    qtyDeclared: 4,
    pickupAddress: '12 Allen Avenue',
    serviceAreaId: AREA,
    ...over,
  });
  expect(res.status).toBe(201);
  return json<Detail>(res);
}

/** A transition, as the queue and the detail panel fire it. */
async function move(
  id: string,
  action: string,
  body: Record<string, unknown>,
  client: HttpClient = owner,
): Promise<Response> {
  return client.post(`${API}/returns/${id}/${action}`, body);
}

/** Drive a fresh return to `status`, and hand back its final row. */
async function returnAt(status: string, programId: string): Promise<Wire> {
  const detail = await logReturn({ programId });
  let row = detail.request;

  const step = async (action: string, body: Record<string, unknown> = {}) => {
    const res = await move(row.id, action, { expectedRevision: row.revision, ...body });
    expect(res.status).toBe(200);
    row = (await json<{ request: Wire }>(res)).request;
  };

  if (status === 'requested') return row;
  if (status === 'rejected') {
    await step('reject', { reason: 'Not ours' });
    return row;
  }
  if (status === 'cancelled') {
    await step('cancel', { reason: 'Customer changed their mind' });
    return row;
  }

  await step('schedule', { pickupAt: Date.now() + 86_400_000 });
  if (status === 'scheduled') return row;
  await step('collect');
  if (status === 'collected') return row;
  await step('receive');
  if (status === 'received') return row;
  await step('inspect', { qtyAccepted: 4, qtyRejected: 0 });
  return row;
}

beforeAll(async () => {
  ctx = await freshDb();
  owner = await login(ctx.users.owner);
  writer = await login(ctx.users.writer);
  support = await login(ctx.users.support);
  anon = httpClient(ctx.db);

  /* The board every intake in this file lands on. Installed once, because the
   * public route REQUIRES a served area and its tests post directly rather than
   * through `logReturn`. */
  await makeArea();

  capsProgramId = await makeProgram();
  countsProgramId = await makeProgram();
  pausedProgramId = await makeProgram();
  adhocProgramId = await makeProgram({
    kind: 'adhoc',
    unitLabelSingular: undefined,
    unitLabelPlural: undefined,
    minUnitsPerReturn: undefined,
    pointsPerUnit: undefined,
  });

  // Paused AFTER creation: contract #2 has no `status` field, because a program
  // that could be born paused is a program somebody creates and cannot find.
  const paused = await json<{ program: { revision: number } }>(
    await owner.patch(`${API}/programs/${pausedProgramId}`, {
      expectedRevision: 1,
      status: 'paused',
    }),
  );
  expect(paused.program.revision).toBe(2);

  /*
   * THE SHOP'S DEFAULT BECOMES THE SUITE'S OWN PROGRAM, not the seeded preset.
   * "The intake defaults from settings" is then a real assertion — the answer
   * is a program this file created — rather than a tautology about the only row
   * in the table.
   */
  const settings = await json<{ settings: { revision: number } }>(
    await owner.get(`${API}/settings`),
  );
  const patched = await owner.patch(`${API}/settings`, {
    expectedRevision: settings.settings.revision,
    defaultReturnProgramId: capsProgramId,
  });
  expect(patched.status).toBe(200);
});

afterAll(async () => {
  await ctx?.close();
});

// --------------------------------------------------------- mount and guards

describe('mounting and the guards — every route here is requireAuth', () => {
  it('answers 401 without a session on every admin route', async () => {
    expect((await anon.get(`${API}/returns`)).status).toBe(401);
    expect((await anon.get(`${API}/returns/ret_x`)).status).toBe(401);
    expect((await anon.post(`${API}/returns`, { email: 'a@b.test', qtyDeclared: 4 })).status).toBe(401);
    expect((await anon.post(`${API}/returns/ret_x/schedule`, {})).status).toBe(401);
    expect((await anon.post(`${API}/returns/ret_x/collect`, {})).status).toBe(401);
    expect((await anon.post(`${API}/returns/ret_x/receive`, {})).status).toBe(401);
    expect((await anon.post(`${API}/returns/ret_x/inspect`, {})).status).toBe(401);
    expect((await anon.post(`${API}/returns/ret_x/reject`, {})).status).toBe(401);
    expect((await anon.post(`${API}/returns/ret_x/cancel`, {})).status).toBe(401);
    expect((await anon.post(`${API}/returns/ret_x/notes`, {})).status).toBe(401);
  });

  it('lets SUPPORT drive the whole lifecycle — returns are order-side work (migration 0680)', async () => {
    /*
     * THE ROLE MATRIX SINCE MIGRATION 0680: returns belong to the ORDERS
     * domain — support and supply chain process them, the inspection that
     * awards points included — and a content writer is off the surface
     * entirely. `requireAuth` on the routes still holds; the domain gate is
     * what now decides WHICH staff.
     */
    expect((await writer.get(`${API}/returns`)).status).toBe(403);
    const detail = await json<Detail>(
      await support.post(`${API}/returns`, {
        email: nextEmail(),
        qtyDeclared: 4,
        pickupAddress: '9 Marina',
        /* A WRITER MAY CHOOSE THE BOARD, and must: the inspection at the end of
         * this walk is an award, and an award with no service area is refused by
         * the database. Choosing WHERE is staff work; deciding which places are
         * served at all is the owner's, and that is a different route. */
        serviceAreaId: AREA,
      }),
    );
    let row = detail.request;
    for (const [action, body] of [
      ['schedule', { pickupAt: Date.now() + 3_600_000 }],
      ['collect', {}],
      ['receive', {}],
      ['inspect', { qtyAccepted: 4, qtyRejected: 0 }],
    ] as const) {
      const res = await move(row.id, action, { expectedRevision: row.revision, ...body }, support);
      expect(res.status).toBe(200);
      row = (await json<{ request: Wire }>(res)).request;
    }
    expect(row.status).toBe('awarded');
  });

  it('answers 404 for an unrouted path under the prefix, not 401', async () => {
    /*
     * The reason the guards are attached PER ROUTE rather than as a blanket
     * `routes.use('*', requireAuth())`: that would answer 401 here — the guard
     * would run and refuse a request that had no handler to reach at all.
     */
    const missing = await owner.get(`${API}/returns/ret_x/nothing-here`);
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({ error: 'gone' });
  });

  it('answers 404 gone for an unknown return id', async () => {
    const res = await owner.get(`${API}/returns/ret_nope`);
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ error: 'gone' });
  });
});

// ------------------------------------------------------- the retired intake

describe('the public intake, now retired — contract #6', () => {
  it('is registered ABOVE every parameterised returns route', async () => {
    /*
     * THE ROUTE-ORDER PIN, RETARGETED TO `bulk` NOW THAT THE INTAKE IS GONE —
     * still a claim about the TABLE rather than about a response, because a
     * behavioural test would stay green through the reordering it exists to
     * prevent. Hono resolves two patterns claiming one path by registration
     * order, and `bulk` is a legal value for `:id`, exactly as `request` was —
     * so the day somebody adds `POST /returns/:id`, this is what fails instead
     * of every board selection answering `gone`.
     */
    const posts = owner.app.routes
      .filter((r) => r.method === 'POST' && r.path.startsWith(`${API}/returns`))
      .map((r) => r.path);

    const bulk = posts.indexOf(`${API}/returns/bulk`);
    const firstParam = posts.findIndex((p) => p.includes(':id'));
    expect(bulk).toBeGreaterThanOrEqual(0);
    expect(firstParam).toBeGreaterThanOrEqual(0);
    expect(bulk).toBeLessThan(firstParam);
  });

  /**
   * THE RETIRED INTAKE. It was the one unauthenticated write in this subsystem and
   * it had no caller: the storefront asks on `/api/marketing/me/returns`, where a
   * session names the customer.
   *
   * It is gone rather than merely unused because it was a griefing primitive: any
   * stranger could POST a known address, and `marketing_return_requests_open_uq`
   * would then make that customer's own request fail with `return_already_open`.
   * Rate-limited and cancellable, so low severity — but nothing depended on it.
   */
  it('is gone, and answers marketing\'s own 404 rather than 405', async () => {
    const res = await anon.post(`${API}/returns/request`, {
      email: 'someone@example.test',
      qtyDeclared: 4,
      serviceAreaId: 'anything',
    });
    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).toBe('gone');
  });
});

// ------------------------------------------------------------ admin intake

describe('the admin intake — contract #5', () => {
  it('defaults the program from settings and answers the full detail', async () => {
    const detail = await logReturn();

    expect(detail.request.status).toBe('requested');
    expect(detail.request.revision).toBe(1);
    expect(detail.request.allowedActions).toEqual(['schedule', 'reject', 'cancel', 'note']);
    // The suite's own program, installed as the default in `beforeAll` — so
    // this is the settings pointer being read, not the only row in the table.
    expect(detail.program).toEqual({
      id: capsProgramId,
      name: 'Cap Returns',
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
      unitLabelSingular: 'canister',
      unitLabelPlural: 'canisters',
      status: 'active',
      pointsPerUnit: 7,
      minUnitsPerReturn: 4,
    });
    expect(detail.events.map((e) => e.type)).toEqual(['requested']);
    expect(detail.emailIntents).toEqual([]);
  });

  it('treats an unknown programId as a field error, not a missing page', async () => {
    const res = await owner.post(`${API}/returns`, {
      email: nextEmail(),
      qtyDeclared: 4,
      programId: 'prg_nope',
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'programId' });
  });

  it('refuses a paused program with program_paused and no payload', async () => {
    const res = await owner.post(`${API}/returns`, {
      email: nextEmail(),
      qtyDeclared: 4,
      programId: pausedProgramId,
    });
    expect(res.status).toBe(409);
    const body = await json<Record<string, unknown>>(res);
    expect(body.error).toBe('program_paused');
    // The catalogue freezes the extras as NOTHING: the admin's treatment is one
    // link to the status toggle regardless of which program refused.
    expect(Object.keys(body).sort()).toEqual(['error', 'requestId']);
  });

  it('refuses an adhoc program with program_type_mismatch and no message', async () => {
    const res = await owner.post(`${API}/returns`, {
      email: nextEmail(),
      qtyDeclared: 4,
      programId: adhocProgramId,
    });
    expect(res.status).toBe(409);
    const body = await json<Record<string, unknown>>(res);
    expect(body.error).toBe('program_type_mismatch');
    // The wire carries no message BY DESIGN — the copy is the client's, keyed
    // on the code.
    expect(Object.keys(body).sort()).toEqual(['error', 'requestId']);
  });

  it('links to the return already open instead of dead-ending', async () => {
    const email = nextEmail();
    const first = await logReturn({ email });

    const res = await owner.post(`${API}/returns`, {
      email,
      qtyDeclared: 4,
      pickupAddress: '12 Allen Avenue',
    });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      error: 'return_already_open',
      existingId: first.request.id,
      status: 'requested',
    });
  });

  /**
   * TWO GUARANTEES THAT LOST THEIR ONLY ASSERTION WHEN THE RETIRED PUBLIC
   * ROUTE'S TESTS WERE DELETED, RE-POINTED HERE AT THE ADMIN INTAKE — which
   * parses the identical `optionalText()`-typed fields, so no new fixtures are
   * needed.
   *
   * BLANK NORMALISES TO ABSENT. `repo.test.ts` asserts `null` for an ABSENT
   * field, which is the repository's own normalisation and a different code
   * path from this one; `/me/returns` cannot stand in either, because
   * `customer.ts` deliberately uses `str().trim().min(1)`, so a blank there is
   * a 400, not a transform. This is the only test anywhere driving a blank
   * string through an HTTP route into `optionalText()`'s
   * `.transform((value) => (value === '' ? undefined : value))` — deleting
   * that transform today would otherwise pass the entire suite.
   *
   * A NUL IS REFUSED BEFORE THE TRANSFORM EVER RUNS. `server/nul-bytes.test.ts`'s
   * `BODIES` map does not cover marketing routes, and the surviving NUL-byte
   * test in this file drives `reason` on a cancel, whose `REASON` schema has no
   * `.transform()` at all — so nothing else in the repository can fail if this
   * ordering breaks. The `ZodString` NUL check running before the transform is
   * the whole reason `str()` is a regex rather than a refinement.
   */
  it('treats a blank optional field as absent, and refuses a NUL in one before the transform runs', async () => {
    const detail = await logReturn({ customerName: '', customerPhone: '   ', pickupAddress: '' });
    expect(detail.request.customerName).toBeNull();
    expect(detail.request.customerPhone).toBeNull();
    expect(detail.request.pickupAddress).toBeNull();

    const NUL = String.fromCharCode(0);
    const res = await owner.post(`${API}/returns`, {
      email: nextEmail(),
      qtyDeclared: 4,
      pickupAddress: `12 Allen${NUL} Avenue`,
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'pickupAddress' });
  });
});

// ------------------------------------------------------------- the lifecycle

describe('the lifecycle end to end', () => {
  it('walks requested to awarded and reports the award, the timeline and the queued mail', async () => {
    const detail = await logReturn();
    let row = detail.request;

    const schedule = await move(row.id, 'schedule', {
      expectedRevision: row.revision,
      pickupAt: 1_786_600_000_000,
      driverName: 'Tunde',
      driverPhone: '0802',
      note: 'Bike, morning slot',
    });
    expect(schedule.status).toBe(200);
    row = (await json<{ request: Wire }>(schedule)).request;
    expect(row.status).toBe('scheduled');
    expect(row.pickupScheduledAt).toBe(1_786_600_000_000);
    expect(row.allowedActions).toEqual(['collect', 'schedule', 'reject', 'cancel', 'note']);

    for (const action of ['collect', 'receive'] as const) {
      const res = await move(row.id, action, { expectedRevision: row.revision });
      expect(res.status).toBe(200);
      row = (await json<{ request: Wire }>(res)).request;
    }
    expect(row.status).toBe('received');
    expect(row.allowedActions).toEqual(['inspect', 'note']);

    /*
     * RECEIVED-VERSUS-DECLARED MAY DIFFER: four were declared, three were
     * accepted and one refused. Nothing anywhere refuses to record that, and
     * the award is computed from what was ACCEPTED at the rate the customer was
     * PROMISED — 3 × 7.
     */
    const inspected = await move(row.id, 'inspect', {
      expectedRevision: row.revision,
      qtyAccepted: 3,
      qtyRejected: 1,
      rejectedReason: 'Damaged',
    });
    expect(inspected.status).toBe(200);
    const outcome = await json<{ request: Wire; award: { points: number; balance: number } }>(inspected);
    expect(outcome.request.status).toBe('awarded');
    expect(outcome.award).toEqual({ points: 21, balance: 21 });

    const after = await json<Detail>(await owner.get(`${API}/returns/${row.id}`));
    expect(after.events.map((e) => e.type)).toEqual([
      'requested',
      'scheduled',
      'collected',
      'received',
      'inspected',
    ]);
    /*
     * THE MAIL IS QUEUED, NOT SENT, and the detail says so honestly — the
     * awarded panel renders "Notification queued — sends with the next sweep"
     * out of exactly these three fields rather than faking a "Sent".
     */
    expect(after.emailIntents).toEqual([
      { kind: 'return_awarded', sentAt: null, attempts: 0, lastError: null },
    ]);
  });

  it('records a note in any state, with no revision bump and no CAS token', async () => {
    const detail = await logReturn();
    const before = detail.request.revision;

    const res = await owner.post(`${API}/returns/${detail.request.id}/notes`, {
      note: 'Rang, no answer',
    });
    expect(res.status).toBe(201);
    const { event } = await json<{ event: { id: string; type: string; note: string; actorType: string } }>(res);
    expect(event).toMatchObject({ type: 'note', note: 'Rang, no answer', actorType: 'admin' });

    const after = await json<Detail>(await owner.get(`${API}/returns/${detail.request.id}`));
    // A note is not a change to the return: bumping the row would invalidate
    // every open editor's token for a write that moved nothing.
    expect(after.request.revision).toBe(before);
    expect(after.events.map((e) => e.type)).toEqual(['requested', 'note']);
  });

  it('refuses a schedule with no address on the row and none in the body', async () => {
    const detail = await logReturn({ pickupAddress: undefined });
    const res = await move(detail.request.id, 'schedule', {
      expectedRevision: detail.request.revision,
      pickupAt: Date.now() + 3_600_000,
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'pickupAddress' });
  });
});

// -------------------------------------------------------- the error payloads

describe('the catalogue, on the wire', () => {
  it('answers invalid_transition with the true stage and the re-read request', async () => {
    const detail = await logReturn();
    const res = await move(detail.request.id, 'inspect', {
      expectedRevision: detail.request.revision,
      qtyAccepted: 4,
      qtyRejected: 0,
    });
    expect(res.status).toBe(409);

    const body = await json<{ error: string; status: string; action: string; request: Wire; requestId: string }>(res);
    expect(body.error).toBe('invalid_transition');
    expect(body.status).toBe('requested');
    expect(body.action).toBe('inspect');
    expect(typeof body.requestId).toBe('string');
    /*
     * THE SIGNATURE PAYLOAD. The screen re-renders the true stage STRAIGHT OUT
     * OF THIS — including which buttons are legal — and keeps whatever was
     * half-typed behind a `.notice` instead of wiping the form to refetch. A
     * client that had to re-GET would show a THIRD state (the one true at the
     * time of that second read) as though it were what it had lost to.
     */
    expect(body.request.id).toBe(detail.request.id);
    expect(body.request.status).toBe('requested');
    expect(body.request.allowedActions).toEqual(['schedule', 'reject', 'cancel', 'note']);
    expect(Object.keys(body).sort()).toEqual(['action', 'error', 'request', 'requestId', 'status']);
  });

  it('carries the request under the SAME shape a success does', async () => {
    /*
     * The auto-heal renderer and the success renderer are one renderer. If the
     * 409's `request` grows or loses a key the 200's does not, the healed panel
     * silently renders a different row shape than the one it was drawing a
     * moment ago — and nothing else in either suite would notice.
     */
    const detail = await logReturn();
    const ok = await json<{ request: Wire }>(
      await move(detail.request.id, 'cancel', { expectedRevision: detail.request.revision }),
    );
    const conflict = await json<{ request: Wire }>(
      await move(detail.request.id, 'cancel', { expectedRevision: detail.request.revision }),
    );
    expect(Object.keys(conflict.request).sort()).toEqual(Object.keys(ok.request).sort());
  });

  it('answers stale_write with expected, actual and the row that beat it', async () => {
    const detail = await logReturn();
    const id = detail.request.id;
    // Somebody else schedules it first, which bumps the revision to 2.
    expect((await move(id, 'schedule', { expectedRevision: 1, pickupAt: Date.now() + 3_600_000 })).status).toBe(200);

    // Our tab still holds revision 1, and reschedule is legal from `scheduled`
    // — so the STATUS half passes and only the revision half refuses.
    const res = await move(id, 'schedule', { expectedRevision: 1, pickupAt: Date.now() + 7_200_000 });
    expect(res.status).toBe(409);
    const body = await json<{ error: string; expected: number; actual: number; request: Wire }>(res);
    expect(body.error).toBe('stale_write');
    expect(body.expected).toBe(1);
    expect(body.actual).toBe(2);
    // Under `request`, because marketing has five revisioned entities and none
    // of them is a post.
    expect(body.request.id).toBe(id);
    expect(body.request.revision).toBe(2);
  });

  it('treats a replayed inspection as already_awarded with the ledger row to link to', async () => {
    const row = await returnAt('received', capsProgramId);
    const first = await move(row.id, 'inspect', {
      expectedRevision: row.revision,
      qtyAccepted: 4,
      qtyRejected: 0,
    });
    expect(first.status).toBe(200);

    const replay = await move(row.id, 'inspect', {
      expectedRevision: row.revision,
      qtyAccepted: 4,
      qtyRejected: 0,
    });
    expect(replay.status).toBe(409);
    const body = await json<Record<string, unknown>>(replay);
    expect(body.error).toBe('already_awarded');
    expect(String(body.entryId).startsWith('pts_')).toBe(true);
    // The client treats this as SUCCESS — which is what makes retrying an
    // inspection over a flaky connection safe to offer at all.
    expect(Object.keys(body).sort()).toEqual(['entryId', 'error', 'requestId']);
  });

  it('refuses a reject once the goods are in hand, naming the stage', async () => {
    const row = await returnAt('received', capsProgramId);
    const res = await move(row.id, 'reject', { expectedRevision: row.revision, reason: 'Not ours' });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      error: 'invalid_transition',
      status: 'received',
      action: 'reject',
    });
  });

  it('takes a rejection with no reason, and refuses a reason with no rejection', async () => {
    const row = await returnAt('received', capsProgramId);
    /* Optional since 2026-09-03; the "reason with nothing rejected" direction
     * stayed, because that one stores a sentence about goods nobody refused. */
    const missing = await move(row.id, 'inspect', {
      expectedRevision: row.revision,
      qtyAccepted: 3,
      qtyRejected: 1,
    });
    expect(missing.status).toBe(200);

    const spurious = await move(row.id, 'inspect', {
      expectedRevision: row.revision,
      qtyAccepted: 4,
      qtyRejected: 0,
      rejectedReason: 'Damaged',
    });
    expect(spurious.status).toBe(400);
    expect(await json(spurious)).toMatchObject({ error: 'bad_request', detail: 'rejectedReason' });
  });

  it('refuses a body carrying a field the contract does not have', async () => {
    const detail = await logReturn();
    const res = await move(detail.request.id, 'collect', {
      expectedRevision: detail.request.revision,
      status: 'awarded',
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'status' });
  });
});

// ------------------------------------------------------------- the queue

describe('the inspection bonus is the OWNER’s — contract #6.5', () => {
  it('REFUSES SUPPORT’S TOP-UP, while the same support account inspects without one', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE GUARD IS ON THE FIELD, NOT ON THE ROUTE, AND BOTH HALVES MATTER.
     *
     * A route-level tier guard here would make support fetch an admin to
     * record what arrived in a box, and a count that needs a second person is
     * a count that stops being recorded. But minting points ABOVE the
     * programme's rate is money, and money stays with the owner/developer
     * tier (`isAdminRole`, migration 0680).
     *
     * So this test asserts the pair: support is refused with a bonus and
     * succeeds without one. Asserting only the 403 would stay green if
     * somebody "fixed" it by putting a tier guard on the route — which would
     * break the warehouse to protect the wallet.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const withBonus = await returnAt('received', capsProgramId);
    const refused = await move(
      withBonus.id,
      'inspect',
      {
        expectedRevision: withBonus.revision,
        qtyAccepted: 4,
        qtyRejected: 0,
        bonusPoints: 25,
        bonusReason: 'Goodwill',
      },
      support,
    );
    expect(refused.status).toBe(403);
    expect(await json(refused)).toMatchObject({ error: 'forbidden' });

    /* REFUSED BEFORE ANYTHING WAS WRITTEN. The worst outcome available here is
     * an award recorded with the top-up silently dropped: the screen would say
     * 145 and the customer would hold 120. */
    const untouched = await json<Detail>(await owner.get(`${API}/returns/${withBonus.id}`));
    expect(untouched.request.status).toBe('received');

    const plain = await move(
      withBonus.id,
      'inspect',
      { expectedRevision: withBonus.revision, qtyAccepted: 4, qtyRejected: 0 },
      support,
    );
    expect(plain.status).toBe(200);
    const body = await json<{ award: { points: number }; bonus: unknown }>(plain);
    expect(body.award.points).toBe(28);
    expect(body.bonus).toBeNull();
  });

  it('lets the OWNER add one, and reports the two numbers separately', async () => {
    const row = await returnAt('received', capsProgramId);
    const res = await move(row.id, 'inspect', {
      expectedRevision: row.revision,
      qtyAccepted: 4,
      qtyRejected: 0,
      bonusPoints: 25,
      bonusReason: 'Carried them down three flights',
    });
    expect(res.status).toBe(200);

    const body = await json<{
      award: { points: number; balance: number };
      bonus: { points: number; reason: string };
    }>(res);
    /* The award alone, the balance including the top-up, and the top-up under
     * its own name — so the success copy can say "28 + 25" rather than a 53
     * nobody can decompose. */
    expect(body.award.points).toBe(28);
    expect(body.award.balance).toBe(53);
    expect(body.bonus).toEqual({ points: 25, reason: 'Carried them down three flights' });
  });

  it('takes a top-up with no reason, answering with a null one', async () => {
    const row = await returnAt('received', capsProgramId);
    const res = await move(row.id, 'inspect', {
      expectedRevision: row.revision,
      qtyAccepted: 4,
      qtyRejected: 0,
      bonusPoints: 25,
    });
    expect(res.status).toBe(200);
    /* `null` on the wire, not an absent key and not `""` — the storefront and
     * the admin both render this field. */
    expect(await json(res)).toMatchObject({ bonus: { points: 25, reason: null } });
  });
});

describe('POST /returns/bulk — contract #6.4', () => {
  interface BulkResult {
    id: string;
    ok: boolean;
    error?: string;
    request?: Wire & { serviceArea: { id: string; name: string } | null };
  }

  const bulk = (body: unknown, client: HttpClient = owner) =>
    client.post(`${API}/returns/bulk`, body);

  const item = (row: Wire) => ({ id: row.id, expectedRevision: row.revision });

  it('registers above the parameterised routes — `bulk` is a legal id', async () => {
    /*
     * Hono resolves two patterns claiming one path by registration order, and
     * nothing collides TODAY (there is no `POST /returns/:id`). The ordering
     * therefore costs nothing and buys the guarantee that adding one later
     * cannot swallow the board's multi-select into a route that would answer
     * `gone` for every selection.
     */
    const posts = owner.app.routes
      .filter((r) => r.method === 'POST' && r.path.startsWith(`${API}/returns`))
      .map((r) => r.path);
    expect(posts.indexOf(`${API}/returns/bulk`)).toBeGreaterThanOrEqual(0);
    expect(posts.indexOf(`${API}/returns/bulk`)).toBeLessThan(
      posts.findIndex((p) => p.includes(':id')),
    );
  });

  it('schedules a whole selection in one call, and hands each card back', async () => {
    const rows = [await returnAt('requested', capsProgramId), await returnAt('requested', capsProgramId)];
    const res = await bulk({
      action: 'schedule',
      items: rows.map(item),
      body: { pickupAt: Date.now() + 86_400_000, driverName: 'Sade' },
    });
    expect(res.status).toBe(200);

    const { results } = await json<{ results: BulkResult[] }>(res);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    /*
     * THE CARD COMES BACK IN THE LIST'S OWN SHAPE, so the board swaps the card
     * it just moved without a refetch — including the labels and the district
     * name, neither of which the transition's own return value carries.
     */
    for (const result of results) {
      expect(result.request?.status).toBe('scheduled');
      expect(result.request?.revision).toBe(2);
      expect(result.request?.program).toMatchObject({ pointsLabelPlural: 'Bottle Caps' });
      expect(result.request?.serviceArea).toMatchObject({ name: 'Cabbage Quarter' });
    }
  });

  it('REPORTS PER ITEM AND NEVER ROLLS BACK — 200 with the failures inside it', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * PARTIAL SUCCESS IS THE TRUTH. There are no transactions in this
     * application, so a bulk call IS a loop of single statements and there is no
     * honest way to undo the ones that worked. A route answering 409 because one
     * of three cards had moved would leave two transitions applied behind an
     * error, and the screen would have to guess which.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const good = await returnAt('requested', capsProgramId);
    const moved = await returnAt('requested', capsProgramId);
    const wrongStage = await returnAt('collected', capsProgramId);

    /* This one is advanced behind the selection's back — the "Tolu Bassey moved
     * on while you were choosing" case, which is what `expectedRevision` per
     * item exists for. */
    const stale = item(moved);
    expect(
      (await move(moved.id, 'schedule', { expectedRevision: moved.revision, pickupAt: Date.now() }))
        .status,
    ).toBe(200);

    const res = await bulk({
      action: 'schedule',
      items: [item(good), stale, item(wrongStage), { id: 'ret_nope', expectedRevision: 1 }],
      body: { pickupAt: Date.now() + 86_400_000 },
    });
    expect(res.status).toBe(200);

    const { results } = await json<{ results: BulkResult[] }>(res);
    expect(results.map((r) => [r.ok, r.error])).toEqual([
      [true, undefined],
      /* Its own CAS lost, and ONLY its own: the card beside it still moved. */
      [false, 'stale_write'],
      /* The state machine refused it — a collected return cannot be scheduled,
       * and the bulk path runs the SAME guard the single route does. */
      [false, 'invalid_transition'],
      [false, 'gone'],
    ]);

    /* …and the successful one really moved, rather than being reported and
     * rolled back with its neighbours. */
    const after = await json<Detail>(await owner.get(`${API}/returns/${good.id}`));
    expect(after.request.status).toBe('scheduled');
  });

  it('RUNS EVERY ITEM’S GUARD — a bulk reject cannot reach a received return', async () => {
    /*
     * THE MUTATION THIS EXISTS FOR: replace the loop with one
     * `UPDATE … WHERE id IN (…)`. It would be faster, it would look correct, and
     * it would skip the CAS, the timeline entry and the rule that reject is
     * illegal once the goods are in hand — closing a return over a pile nobody
     * counted. The state machine has one implementation, and the board is a
     * second way to press its buttons.
     */
    const early = await returnAt('requested', capsProgramId);
    const received = await returnAt('received', capsProgramId);

    const res = await bulk({
      action: 'reject',
      items: [item(early), item(received)],
      body: { reason: 'Not ours' },
    });
    const { results } = await json<{ results: BulkResult[] }>(res);
    expect(results[0].ok).toBe(true);
    expect(results[1]).toMatchObject({ ok: false, error: 'invalid_transition' });

    const untouched = await json<Detail>(await owner.get(`${API}/returns/${received.id}`));
    expect(untouched.request.status).toBe('received');
  });

  it('notes every card in a selection without moving any of them', async () => {
    const rows = [await returnAt('requested', capsProgramId), await returnAt('collected', capsProgramId)];
    const res = await bulk({
      action: 'note',
      items: rows.map(item),
      body: { note: 'Driver says the gate is locked after six' },
    });
    const { results } = await json<{ results: BulkResult[] }>(res);
    expect(results.every((r) => r.ok)).toBe(true);

    for (const row of rows) {
      const detail = await json<Detail>(await owner.get(`${API}/returns/${row.id}`));
      /* A note bumps NOTHING — not the revision, not the stage. It is legal in
       * every state, which is why a mixed selection can all take one. */
      expect(detail.request.revision).toBe(row.revision);
      expect(detail.request.status).toBe(row.status);
      expect(detail.events.at(-1)).toMatchObject({ type: 'note' });
    }
  });

  it('refuses more than fifty in one call', async () => {
    const items = Array.from({ length: 51 }, (_, i) => ({
      id: `ret_${i}`,
      expectedRevision: 1,
    }));
    const res = await bulk({ action: 'collect', items, body: {} });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'items' });

    // …and an empty selection is a request nobody meant to send.
    expect((await bulk({ action: 'collect', items: [], body: {} })).status).toBe(400);
  });

  it('validates the shared body ONCE, before anything is written', async () => {
    /*
     * A malformed body is a 400 about the request rather than fifty identical
     * per-item failures — and parsing it inside the loop would apply the first N
     * before discovering it.
     */
    const row = await returnAt('requested', capsProgramId);
    /* AN EMPTY `reason`, NOT AN ABSENT ONE. Since 2026-09-03 the reason is
     * optional, so `{}` is a perfectly good reject body and would prove nothing
     * about when the body is parsed. `.min(1)` survives inside the `.optional()`
     * precisely so a client that builds the field and sends nothing in it is
     * still a named 400 — which is what makes it a usable malformed body here. */
    const res = await bulk({ action: 'reject', items: [item(row)], body: { reason: '' } });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'reason' });

    const detail = await json<Detail>(await owner.get(`${API}/returns/${row.id}`));
    expect(detail.request.status).toBe('requested');
  });

  it('has no `inspect` — counting what arrived is a form per return', async () => {
    /* The quantities differ by definition, so "inspect fifty returns with one
     * body" is a sentence with no meaning. The board greys it; this is why that
     * is a contract rather than a UI convention. */
    const row = await returnAt('received', capsProgramId);
    const res = await bulk({
      action: 'inspect',
      items: [item(row)],
      body: { qtyAccepted: 4, qtyRejected: 0 },
    });
    expect(res.status).toBe(400);
  });

  it('needs a session, and SUPPORT is session enough (migration 0680)', async () => {
    const row = await returnAt('requested', capsProgramId);
    expect((await bulk({ action: 'collect', items: [item(row)], body: {} }, anon)).status).toBe(401);
    /* Processing returns is order-side staff work since migration 0680 — the
     * board is a faster way to press the same buttons, and support holds it
     * where a content writer does not. */
    expect(
      (
        await bulk(
          { action: 'schedule', items: [item(row)], body: { pickupAt: Date.now() + 3_600_000 } },
          writer,
        )
      ).status,
    ).toBe(403);
    const res = await bulk(
      { action: 'schedule', items: [item(row)], body: { pickupAt: Date.now() + 3_600_000 } },
      support,
    );
    expect(res.status).toBe(200);
    expect((await json<{ results: BulkResult[] }>(res)).results[0].ok).toBe(true);
  });
});

describe('the queue — contract #4', () => {
  /** Every return in this block belongs to `countsProgramId`, so the counts are
   *  a closed set no other test can move. */
  const counted: Record<string, Wire> = {};

  beforeAll(async () => {
    for (const status of [
      'requested',
      'requested',
      'scheduled',
      'collected',
      'received',
      'awarded',
      'rejected',
      'cancelled',
    ]) {
      const row = await returnAt(status, countsProgramId);
      counted[`${status}:${row.id}`] = row;
    }
  });

  const load = async (query: string) =>
    json<{
      items: Wire[];
      nextCursor: string | null;
      counts: Record<string, number>;
    }>(await owner.get(`${API}/returns?${query}`));

  it('lists requested + received under needs_action, and counts the rest', async () => {
    const page = await load(`view=needs_action&programId=${countsProgramId}`);

    expect(page.items.map((r) => r.status).sort()).toEqual(['received', 'requested', 'requested']);
    /*
     * `needs_action` IS NOT "everything open". `scheduled` and `collected` are
     * waiting on a driver, not on anybody at this desk — a queue that listed
     * them as work is a queue nobody can empty.
     */
    expect(page.counts).toEqual({
      requested: 2,
      scheduled: 1,
      collected: 1,
      received: 1,
      awarded: 1,
      rejected: 1,
      cancelled: 1,
      needsAction: 3,
    });
  });

  it('gives the SAME counts under every view — the tabs are one sidecar', async () => {
    const needs = await load(`view=needs_action&programId=${countsProgramId}`);
    const done = await load(`view=done&programId=${countsProgramId}`);
    const all = await load(`view=all&programId=${countsProgramId}`);

    expect(done.items.map((r) => r.status).sort()).toEqual(['awarded', 'cancelled', 'rejected']);
    expect(all.items).toHaveLength(8);
    expect(done.counts).toEqual(needs.counts);
    expect(all.counts).toEqual(needs.counts);
  });

  it('narrows the counts with the row filters, so a tab reading 1 lists 1', async () => {
    /*
     * The counts share the SEARCH and the PROGRAM filter and ignore only the
     * view. That is what makes counted tabs honest here rather than decoration:
     * a tab's number is the size of the list clicking it produces.
     */
    const anyRow = Object.values(counted)[0];
    const page = await load(
      `view=all&programId=${countsProgramId}&q=${encodeURIComponent(anyRow.customerEmail)}`,
    );
    expect(page.items).toHaveLength(1);
    expect(page.counts.requested + page.counts.scheduled + page.counts.collected +
      page.counts.received + page.counts.awarded + page.counts.rejected +
      page.counts.cancelled).toBe(1);
  });

  it('scopes a board to its own district, counts and all', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE FILTER IS A ROW FILTER, WHICH IS WHY THE COUNTS MOVE WITH IT.
     *
     * A board is one district's dispatch list, so its tab strip must say what
     * that district holds — not what the city holds. Put anywhere but
     * `rowFilters`, the badge over Requested would read the city's number and
     * list the district's, which is the dishonest-counted-tab failure this
     * subsystem already refused once.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const elsewhere = 'area_turnip_hill';
    await ctx.db.execute(sql`
      INSERT INTO marketing_service_areas
        (id, key, region, name, active, created_at, updated_at)
      VALUES (${elsewhere}, 'turnip-hill', 'Farflung Province', 'Turnip Hill',
              true, 1786600001000, 1786600001000)
      ON CONFLICT DO NOTHING`);

    const moved = Object.values(counted).find((row) => row.status === 'requested');
    await ctx.db.execute(sql`
      UPDATE marketing_return_requests SET service_area_id = ${elsewhere}
       WHERE id = ${moved?.id}`);

    const here = await load(`view=all&programId=${countsProgramId}&district=${elsewhere}`);
    expect(here.items.map((r) => r.id)).toEqual([moved?.id]);
    expect(here.counts.requested).toBe(1);
    expect(here.counts.needsAction).toBe(1);

    const there = await load(`view=all&programId=${countsProgramId}&district=${AREA}`);
    expect(there.items.map((r) => r.id)).not.toContain(moved?.id);
    expect(there.counts.requested).toBe(1);

    /* Every card says which board it is on, by name — the desk above the boards
     * is whole-of-city and its Area column reads this rather than looking each
     * id up in the switcher's response. */
    expect(here.items[0].serviceArea).toEqual({ id: elsewhere, name: 'Turnip Hill' });

    // Put it back, so the counts assertions above stay a closed set.
    await ctx.db.execute(sql`
      UPDATE marketing_return_requests SET service_area_id = ${AREA} WHERE id = ${moved?.id}`);
  });

  it('lists the returns on NO board under district=none', async () => {
    /*
     * `none` IS `IS NULL`, NOT AN EQUALITY AGAINST THE STRING. Written as an
     * equality it matches nothing and answers "the out-of-area list is empty" —
     * the most dangerous lie available here, because those are precisely the
     * returns nobody can award and this is the only surface built to find them.
     */
    const stray = await logReturn({ serviceAreaId: undefined });
    expect(stray.request.serviceAreaId).toBeNull();

    const page = await load(`view=all&district=none`);
    expect(page.items.map((r) => r.id)).toContain(stray.request.id);
    expect(page.items.every((r) => r.serviceArea === null)).toBe(true);
  });

  it('answers an EMPTY board for a district id that resolves to nothing', async () => {
    /* Unlike the intake's forgiving `serviceAreaId`, this one comes from the
     * switcher the client just rendered — so an id it cannot match is a district
     * with nothing in it, which is a real and unremarkable state, not an error
     * to put in front of an operator. */
    const page = await load(`view=all&district=area_atlantis`);
    expect(page.items).toEqual([]);
    expect(page.counts.needsAction).toBe(0);
  });

  it('serves each row with the labels, the revision, the address and one ordered action list', async () => {
    const page = await load(`view=requested&programId=${countsProgramId}&limit=1`);
    const row = page.items[0];

    expect(row.revision).toBe(1);
    expect(row.pickupAddress).toBe('12 Allen Avenue');
    // The pipeline-advancing action FIRST: the queue renders exactly one button
    // and renders `allowedActions[0]`, so the order is contract.
    expect(row.allowedActions).toEqual(['schedule', 'reject', 'cancel', 'note']);
    expect(row.program).toEqual({
      id: countsProgramId,
      name: 'Cap Returns',
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
      unitLabelSingular: 'canister',
      unitLabelPlural: 'canisters',
    });

    /*
     * THE WHOLE KEY SET, against the frozen `ReturnListItem` in
     * `src/data/api-marketing.ts`. Asserting only the fields this test happens
     * to care about would let a column be added that Stream B has no type for,
     * or dropped from `LIST_COLUMNS` and left null-mapped — and the queue is
     * drawn from these rows alone, so either lands on a screen before it lands
     * in a failure.
     */
    expect(Object.keys(row).sort()).toEqual([
      'allowedActions',
      'createdAt',
      'customerEmail',
      'customerName',
      'id',
      'pickupAddress',
      'pickupScheduledAt',
      'pointsAwarded',
      /* The rate the customer was PROMISED. A board card prices a return from
       * this rather than from the programme's CURRENT rate, so a repricing
       * cannot silently restate what an old card is worth. */
      'pointsPerUnitSnapshot',
      'program',
      'qtyAccepted',
      'qtyDeclared',
      'qtyRejected',
      'revision',
      /* Which board the card belongs on, `{id, name}` or null. The NAME travels
       * beside the id because the desk is whole-of-city: its Area column has to
       * say where each row lives without looking every id up in a second
       * response. */
      'serviceArea',
      'status',
      'updatedAt',
    ]);
  });

  it('matches an email prefix and an exact ret_ id, and nothing else', async () => {
    /* A distinctive address rather than the sequence every other test uses:
     * `dara-3` is a prefix of `dara-30`, so a numbered fixture would make this
     * assertion depend on how many returns the tests before it happened to
     * create. */
    const target = await logReturn({
      programId: capsProgramId,
      email: 'prefix-probe@example.test',
    });

    const byId = await load(`view=all&q=${target.request.id}`);
    expect(byId.items.map((r) => r.id)).toEqual([target.request.id]);

    const byPrefix = await load(`view=all&q=${encodeURIComponent('prefix-pro')}`);
    expect(byPrefix.items.map((r) => r.id)).toEqual([target.request.id]);

    // A prefix, not a substring: the box finds the return you were given, it
    // does not browse.
    const bySuffix = await load(`view=all&q=${encodeURIComponent('example.test')}`);
    expect(bySuffix.items).toEqual([]);
  });

  it('pages by cursor without skipping or repeating a row', async () => {
    const programId = await makeProgram();
    const ids: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const detail = await logReturn({ programId });
      ids.push(detail.request.id);
    }

    /*
     * The rows are dated BY SQL, because the route takes its own clock — and
     * THREE TO AN INSTANT, deliberately. Thirty distinct timestamps would never
     * exercise the id tiebreak, and an even number to an instant would put every
     * page boundary between two groups rather than inside one. At three, the
     * ten-row boundary lands mid-tie: without the tiebreak the next page starts
     * after the whole instant and two returns vanish, with no error anywhere to
     * say so. Verified by mutation — dropping `AND r.id > …` fails this test.
     */
    const at = (index: number) => 1_700_000_000_000 + Math.floor(index / 3) * 1000;
    for (const [index, id] of ids.entries()) {
      await ctx.db.execute(sql`
        UPDATE marketing_return_requests SET created_at = ${at(index)} WHERE id = ${id}`);
    }

    /** Oldest first, ties broken by id — what the ORDER BY promises. */
    const expected = [...ids]
      .map((id, index) => ({ id, at: at(index) }))
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
      .map((r) => r.id);

    const walked: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const q = `view=all&programId=${programId}&limit=10${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const res: { items: Wire[]; nextCursor: string | null } = await load(q);
      expect(res.items).toHaveLength(10);
      walked.push(...res.items.map((r) => r.id));
      cursor = res.nextCursor;
      // The third page is the last one: `size + 1` is the whole of the evidence
      // needed for "is there another", and there is not.
      expect(cursor === null).toBe(page === 2);
    }

    // OLDEST FIRST, and every row exactly once. A queue whose aging bands exist
    // to surface the row nobody has dealt with cannot bury it on page three.
    expect(walked).toEqual(expected);
    expect(new Set(walked).size).toBe(30);
  });

  it('refuses a cursor that did not come from this list, and a limit out of range', async () => {
    expect((await owner.get(`${API}/returns?view=all&cursor=not-a-cursor`)).status).toBe(400);
    expect((await owner.get(`${API}/returns?view=all&limit=500`)).status).toBe(400);
    expect((await owner.get(`${API}/returns?view=all&limit=abc`)).status).toBe(400);
  });

  it('refuses an unknown view and an unknown filter rather than ignoring them', async () => {
    const view = await owner.get(`${API}/returns?view=schedulled`);
    expect(view.status).toBe(400);
    expect(await json(view)).toMatchObject({ error: 'bad_request', detail: 'view' });

    // `?vieww=done` would otherwise quietly return the whole queue and look
    // like a bug in the tab strip.
    const typo = await owner.get(`${API}/returns?vieww=done`);
    expect(typo.status).toBe(400);
    expect(await json(typo)).toMatchObject({ error: 'bad_request', detail: 'vieww' });
  });

  it('lists every status when no view is named', async () => {
    /*
     * The SCREEN's default is `needs_action` and it names it on every request.
     * A route that quietly withheld five of seven statuses because one screen
     * prefers it that way would be a filter nobody asked for and nothing in the
     * response admits to.
     */
    const page = await load(`programId=${countsProgramId}`);
    expect(page.items).toHaveLength(8);
  });
});

// ------------------------------------------------------------------ NUL bytes

describe('a NUL byte', () => {
  const NUL = String.fromCharCode(0);

  it('is a 400 in the path, the query and a body field — never a 5xx', async () => {
    const path = await owner.get(`${API}/returns/${encodeURIComponent(NUL)}`);
    expect(path.status).toBe(400);

    const query = await owner.get(`${API}/returns?view=all&q=${encodeURIComponent(NUL)}`);
    expect(query.status).toBe(400);

    const detail = await logReturn();
    const body = await move(detail.request.id, 'cancel', {
      expectedRevision: detail.request.revision,
      reason: `changed${NUL}mind`,
    });
    expect(body.status).toBe(400);
    expect(await json(body)).toMatchObject({ error: 'bad_request' });
  });
});
