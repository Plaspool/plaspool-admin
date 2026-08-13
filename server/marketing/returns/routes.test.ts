/**
 * Returns on the wire — contract #4-14, driven through the REAL app.
 *
 * ROUTE SUITES GO THROUGH THE WHOLE STACK — router, origin guard, session
 * middleware, marketing's own `onError`, the global error handler — because the
 * seam between the state machine and HTTP is what this task adds and therefore
 * where its defects are. `repo.test.ts` already proves the transitions; what is
 * only provable here is the route ORDER, the guard that is attached per route
 * (and the one route that deliberately has none), the keyset pager, the counts
 * sidecar, and the exact JSON each domain error becomes — including the re-read
 * request every 409 carries so a screen can heal without a second fetch.
 *
 * NO NOUN FROM THE SEEDED PRESET APPEARS IN THIS FILE (spec D11). Every fixture
 * uses absurd labels — "Bottle Cap" / "canister" — and the suite installs its
 * OWN program as the shop's default rather than leaning on the one migration
 * 0011 ships, so a label that was read from a row cannot be mistaken for one
 * that was written in source.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import { INTAKE_EMAIL_LIMIT, INTAKE_IP_LIMIT } from './routes';
import type { TestCtx } from '../../test/harness';
import type { HttpClient } from '../../test/http';
import type { AuthUser } from '../../../shared/types';

let ctx: TestCtx;
let owner: HttpClient;
let writer: HttpClient;
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
  const res = await client.post('/api/auth/login', {
    email: user.email,
    password: SEED_PASSWORD,
  });
  expect(res.status).toBe(200);
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
  const res = await owner.post(`${API}/returns`, {
    email: nextEmail(),
    qtyDeclared: 4,
    pickupAddress: '12 Allen Avenue',
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
  anon = httpClient(ctx.db);

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

describe('mounting, the guards, and the one route that has none', () => {
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

  it('lets a WRITER drive the whole lifecycle — transitions are requireAuth, not requireOwner', async () => {
    /*
     * The frozen role matrix (spec D12). Any staff member processes returns,
     * including the inspection that awards the points; `requireOwner` is
     * reserved for the writes that change what a return is WORTH. A writer who
     * had to fetch the owner to record a count is a count that stops being
     * recorded.
     */
    const detail = await json<Detail>(
      await writer.post(`${API}/returns`, {
        email: nextEmail(),
        qtyDeclared: 4,
        pickupAddress: '9 Marina',
      }),
    );
    let row = detail.request;
    for (const [action, body] of [
      ['schedule', { pickupAt: Date.now() + 3_600_000 }],
      ['collect', {}],
      ['receive', {}],
      ['inspect', { qtyAccepted: 4, qtyRejected: 0 }],
    ] as const) {
      const res = await move(row.id, action, { expectedRevision: row.revision, ...body }, writer);
      expect(res.status).toBe(200);
      row = (await json<{ request: Wire }>(res)).request;
    }
    expect(row.status).toBe('awarded');
  });

  it('answers 404 for an unrouted path under the prefix, not 401', async () => {
    /*
     * The reason the guards are attached PER ROUTE. A blanket
     * `routes.use('*', requireAuth())` would answer 401 here — the guard would
     * refuse a request that had no handler to reach — and would ALSO close the
     * public intake, which is the one route in this file that must stay open.
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

// ------------------------------------------------------------ public intake

describe('the public intake — contract #6', () => {
  /** Its own IP per test, so one test's budget cannot exhaust another's. */
  const fromIp = (ip: string) => ({ headers: { 'x-real-ip': ip } });

  it('is registered ABOVE every parameterised returns route', async () => {
    /*
     * THE ROUTE-ORDER PIN, and it has to be a claim about the TABLE rather than
     * about a response: nothing collides today (there is no `POST /returns/:id`
     * for `request` to be swallowed by), so a behavioural test would stay green
     * through the reordering it exists to prevent. Hono resolves two patterns
     * claiming one path by registration order, and `request` is a legal value
     * for `:id` — so the day somebody adds that route, this is what fails
     * instead of every storefront submission answering `gone`.
     */
    const posts = owner.app.routes
      .filter((r) => r.method === 'POST' && r.path.startsWith(`${API}/returns`))
      .map((r) => r.path);

    const intake = posts.indexOf(`${API}/returns/request`);
    const firstParam = posts.findIndex((p) => p.includes(':id'));
    expect(intake).toBeGreaterThanOrEqual(0);
    expect(firstParam).toBeGreaterThanOrEqual(0);
    expect(intake).toBeLessThan(firstParam);
  });

  it('creates a return with no session at all, and answers in the program\'s own words', async () => {
    const email = nextEmail();
    const res = await anon.post(
      `${API}/returns/request`,
      { email, qtyDeclared: 6, name: 'Dara', phone: '0801', pickupAddress: '4 Awolowo Road' },
      fromIp('198.51.100.1'),
    );
    expect(res.status).toBe(201);

    const body = await json<{ requestId: string; qtyDeclared: number; program: Record<string, unknown> }>(res);
    expect(body.requestId.startsWith('ret_')).toBe(true);
    expect(body.qtyDeclared).toBe(6);

    /*
     * LABEL-COMPLETE, so the storefront renders its confirmation entirely out
     * of config — the never-hardcode guarantee, public edition. Asserted by
     * EQUALITY: a key added here is a key the storefront may start depending
     * on, and one dropped is a sentence it cannot finish.
     */
    expect(body.program).toEqual({
      name: 'Cap Returns',
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
      unitLabelSingular: 'canister',
      unitLabelPlural: 'canisters',
      pointsPerUnit: 7,
      minUnitsPerReturn: 4,
    });

    // Nothing internal travelled with it.
    expect(Object.keys(body).sort()).toEqual(['program', 'qtyDeclared', 'requestId']);

    // And the row is real, attributed to the CUSTOMER rather than to staff.
    const detail = await json<Detail>(await owner.get(`${API}/returns/${body.requestId}`));
    expect(detail.request.customerEmail).toBe(email);
    /* THE RENAME, asserted with values rather than with nulls: this body spells
     * them `name`/`phone` while the row spells them `customerName`/
     * `customerPhone`, and a hand-written mapping between two pairs of
     * same-typed strings is exactly the kind that can be swapped without any
     * shape assertion noticing. */
    expect(detail.request.customerName).toBe('Dara');
    expect(detail.request.customerPhone).toBe('0801');
    /* Attributed to the CUSTOMER: a history that credited every request to
     * whoever happened to be signed in could not answer "did they ask, or did
     * we log it for them". */
    expect(detail.request.source).toBe('customer');
    expect(detail.events[0]).toMatchObject({ type: 'requested', actorType: 'customer', actorId: null });
  });

  it('refuses a fourth request for one address with 429 and a Retry-After', async () => {
    const email = nextEmail();
    const ip = '198.51.100.2';
    const send = () =>
      anon.post(`${API}/returns/request`, { email, qtyDeclared: 5 }, fromIp(ip));

    expect((await send()).status).toBe(201);
    // The second and third are refused by the OPEN-RETURN index, and they still
    // spend budget: a limiter that only counted successes would let a loop
    // hammer the create path for free.
    expect((await send()).status).toBe(409);
    expect((await send()).status).toBe(409);
    expect(INTAKE_EMAIL_LIMIT).toBe(3);

    const limited = await send();
    expect(limited.status).toBe(429);
    // The HEADER as well as the body: the storefront's countdown reads it, and
    // it is set by the shared `toResponse` — which is why `rate_limited` must
    // fall through marketing's own renderer rather than be re-rendered by it.
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await json(limited)).toMatchObject({ error: 'rate_limited' });
  });

  it('bounds one host with the IP budget, and spends it before the body is read', async () => {
    /*
     * THE OTHER BUCKET, and a per-email budget cannot stand in for it: thirty
     * addresses from one host spend thirty separate email budgets and none of
     * their own, so without this the create path is a free loop for anybody
     * willing to vary the address.
     *
     * Driven with an INVALID body ON PURPOSE. The IP limiter is registered
     * ABOVE `readJson`, so a request refused by the schema has already cost
     * budget — which is the whole reason it sits there ("a limiter cannot bound
     * work that runs after it"). Move it below the parse and this loop becomes
     * free, and the 429 below becomes a 201.
     */
    const ip = '203.0.113.7';
    for (let i = 0; i < INTAKE_IP_LIMIT; i += 1) {
      expect((await anon.post(`${API}/returns/request`, { nope: true }, fromIp(ip))).status).toBe(400);
    }

    const limited = await anon.post(
      `${API}/returns/request`,
      { email: nextEmail(), qtyDeclared: 4 },
      fromIp(ip),
    );
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);

    // Keyed on the HOST and not globally: the office behind the next NAT is
    // untouched, which is the difference between a rate limit and an outage.
    const elsewhere = await anon.post(
      `${API}/returns/request`,
      { email: nextEmail(), qtyDeclared: 4 },
      fromIp('203.0.113.8'),
    );
    expect(elsewhere.status).toBe(201);
  });

  it('is refused cross-origin — that is what stands where the session would be', async () => {
    /*
     * The one route in this subsystem with no `requireAuth` behind it, so the
     * guard that replaces the session is pinned HERE rather than left to the
     * generic middleware suite: `originGuard` is mounted above the whole
     * sub-app (`server/index.ts`, well below the marketing mount), and this is
     * the route whose entire safety argument rests on that being true.
     *
     * DEPLOY NOTE: the storefront's origin must be in `APP_ORIGINS`, or every
     * customer submitting the form sees exactly this.
     */
    const res = await anon.post(
      `${API}/returns/request`,
      { email: nextEmail(), qtyDeclared: 4 },
      { headers: { origin: 'https://not-the-storefront.test', 'x-real-ip': '203.0.113.9' } },
    );
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ error: 'forbidden' });
  });

  it('carries the minimum in below_minimum, in the program\'s own words', async () => {
    const res = await anon.post(
      `${API}/returns/request`,
      { email: nextEmail(), qtyDeclared: 2 },
      fromIp('198.51.100.3'),
    );
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({
      error: 'below_minimum',
      detail: 'qtyDeclared',
      min: 4,
    });
  });

  it('treats a blank optional field as an absent one, not as an empty value', async () => {
    /*
     * A storefront form is plain HTML: an optional input nobody filled in posts
     * `""`. Stored, that is not NULL — `pickup_address = ''` satisfies
     * `schedule`'s "an address on the row or in the body" and sends a driver to
     * a blank doorstep — and refused, it is a 400 for leaving an optional field
     * alone.
     */
    const res = await anon.post(
      `${API}/returns/request`,
      { email: nextEmail(), qtyDeclared: 4, name: '', phone: '   ', pickupAddress: '' },
      fromIp('198.51.100.5'),
    );
    expect(res.status).toBe(201);

    const { requestId } = await json<{ requestId: string }>(res);
    const detail = await json<Detail>(await owner.get(`${API}/returns/${requestId}`));
    expect(detail.request.customerName).toBeNull();
    expect(detail.request.customerPhone).toBeNull();
    expect(detail.request.pickupAddress).toBeNull();
  });

  it('takes no programId and no note — the storefront chooses neither', async () => {
    for (const extra of [{ programId: capsProgramId }, { note: 'please hurry' }]) {
      const res = await anon.post(
        `${API}/returns/request`,
        { email: nextEmail(), qtyDeclared: 4, ...extra },
        fromIp('198.51.100.4'),
      );
      expect(res.status).toBe(400);
      expect(await json(res)).toMatchObject({ error: 'bad_request' });
    }
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

  it('needs a rejection reason iff something was rejected, both ways', async () => {
    const row = await returnAt('received', capsProgramId);
    const missing = await move(row.id, 'inspect', {
      expectedRevision: row.revision,
      qtyAccepted: 3,
      qtyRejected: 1,
    });
    expect(missing.status).toBe(400);
    expect(await json(missing)).toMatchObject({ error: 'bad_request', detail: 'rejectedReason' });

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
      'program',
      'qtyAccepted',
      'qtyDeclared',
      'qtyRejected',
      'revision',
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

    const intake = await anon.post(
      `${API}/returns/request`,
      { email: `a${NUL}b@example.test`, qtyDeclared: 4 },
      { headers: { 'x-real-ip': '198.51.100.9' } },
    );
    expect(intake.status).toBe(400);

    // Including the optional fields, whose schema ends in a `.transform()` —
    // the NUL check is a `ZodString` rule and runs BEFORE it, which is the
    // whole reason `str()` is a regex rather than a refinement.
    const optional = await anon.post(
      `${API}/returns/request`,
      { email: nextEmail(), qtyDeclared: 4, pickupAddress: `12 Allen${NUL} Avenue` },
      { headers: { 'x-real-ip': '198.51.100.9' } },
    );
    expect(optional.status).toBe(400);
    expect(await json(optional)).toMatchObject({ error: 'bad_request', detail: 'pickupAddress' });
  });
});
