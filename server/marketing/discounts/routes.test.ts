/**
 * Discount codes on the wire — contract #24-26, driven through the REAL app.
 *
 * ROUTE SUITES GO THROUGH THE WHOLE STACK — router, origin guard, session
 * middleware, marketing's own `onError`, the global error handler — because the
 * seam between the repository and HTTP is what this task adds and therefore
 * where its defects are. What is only provable here is the guard attached per
 * route, the `.strict()` on a body, the exact JSON a conflict becomes, and the
 * refusals that would otherwise be CHECK violations — i.e. 500s the client
 * retries five times for input that can never be accepted.
 *
 * TWO PROPERTIES THIS FILE EXISTS FOR ABOVE THE REST:
 *
 * 1. `save10` and `SAVE10` are ONE code. Normalisation happens before
 *    validation, so a lower-case code is stored upper rather than refused, and
 *    the second one is `409 duplicate_code` rather than a second row that half
 *    the people holding the flyer would be told does not exist.
 * 2. What a code is WORTH cannot be edited. Five fields are absent from the
 *    patch schema, and this file asserts the 400 for each — the assertion that
 *    goes red if the `.strict()` is ever dropped, because a widened schema does
 *    not fail loudly: it accepts the body, ignores the field, and answers 200.
 *
 * NO NOUN FROM THE SEEDED PRESET APPEARS HERE (spec D11): a discount names
 * nothing but itself, and every fixture below is absurd on purpose.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { TestCtx } from '../../test/harness';
import type { HttpClient } from '../../test/http';
import type { AuthUser } from '../../../shared/types';
import type { Discount } from './repo';

let ctx: TestCtx;
let owner: HttpClient;
let writer: HttpClient;
/** No session at all — a fresh browser, not a logged-out one. */
let anon: HttpClient;
let marketing: HttpClient;

const API = '/api/marketing';

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
 * A code no other test in this file has used.
 *
 * The database lives for the whole file, and `marketing_discount_codes_code_uq`
 * is exactly what several of these tests are about — so a shared literal would
 * make every later test fail with the 409 an earlier one was asserting.
 */
let minted = 0;
function nextCode(): string {
  minted += 1;
  return `TESTCODE${minted}`;
}

/** The happy-path create, so a test about ONE field says only that. */
async function create(
  body: Record<string, unknown> = {},
  client: HttpClient = owner,
): Promise<Response> {
  return client.post(`${API}/discounts`, {
    code: nextCode(),
    kind: 'percent',
    percentBps: 1500,
    ...body,
  });
}

async function created(body: Record<string, unknown> = {}): Promise<Discount> {
  const res = await create(body);
  expect(res.status).toBe(201);
  return (await json<{ discount: Discount }>(res)).discount;
}

async function list(client: HttpClient = owner): Promise<Discount[]> {
  const res = await client.get(`${API}/discounts`);
  expect(res.status).toBe(200);
  return (await json<{ discounts: Discount[] }>(res)).discounts;
}

/** A patch that always carries the live revision, for tests that are not about
 *  the CAS. */
async function save(
  discount: Discount,
  patch: Record<string, unknown>,
  client: HttpClient = owner,
): Promise<Response> {
  return client.patch(`${API}/discounts/${discount.id}`, {
    expectedRevision: discount.revision,
    ...patch,
  });
}

// -------------------------------------------------------------- the guards

describe('mounting and the guards', () => {
  it('answers 401 without a session on every route', async () => {
    expect((await anon.get(`${API}/discounts`)).status).toBe(401);
    expect((await anon.post(`${API}/discounts`, {})).status).toBe(401);
    expect((await anon.patch(`${API}/discounts/dsc_nope`, {})).status).toBe(401);

    expect(await json(await anon.get(`${API}/discounts`))).toMatchObject({
      error: 'unauthenticated',
    });
  });

  it('belongs to the marketing domain: marketing writes, a writer sees nothing', async () => {
    /*
     * THE ROLE MATRIX SINCE MIGRATION 0680 (shared/roles.ts). Discounts are
     * the marketing role's whole job, so the domain gate admits marketing,
     * owner and developer and nobody else — a content writer no longer even
     * reads the list. Spec D12's owner-only write rule is superseded by the
     * owner's role model; the domain gate is what keeps a writer out.
     */
    const existing = await created();

    expect((await writer.get(`${API}/discounts`)).status).toBe(403);

    const post = await create({ code: 'MKTG10' }, marketing);
    expect(post.status).toBe(201);

    const patch = await save(existing, { status: 'disabled' }, marketing);
    expect(patch.status).toBe(200);
  });
});

// -------------------------------------------------------------------- create

describe('POST /discounts', () => {
  it('creates an ACTIVE code, with the column defaults for everything unsaid', async () => {
    const discount = await created({ percentBps: 2000 });

    /*
     * ACTIVE, unlike a banner's `draft`, and the difference is deliberate: a
     * banner is words shown to every visitor whether they asked or not, while a
     * code does nothing until somebody types it — and in v1 nothing redeems one
     * at all. A create that landed disabled would be a second step for a row
     * that cannot spend money either way.
     */
    expect(discount.status).toBe('active');
    expect(discount.id.startsWith('dsc_')).toBe(true);
    expect(discount.kind).toBe('percent');
    expect(discount.percentBps).toBe(2000);
    expect(discount.amountMinor).toBeNull();
    expect(discount.currency).toBeNull();
    expect(discount.revision).toBe(1);
    /* Nothing increments this yet and no route can write it: it counts promises
     * already kept, so a settable one is a history anybody could invent. */
    expect(discount.redeemedCount).toBe(0);
    expect(discount.startsAt).toBeNull();
    expect(discount.endsAt).toBeNull();
    expect(discount.maxRedemptions).toBeNull();
    expect(discount.note).toBeNull();
    expect(discount.createdAt).toBeGreaterThan(0);
    expect(discount.updatedAt).toBe(discount.createdAt);
  });

  it('normalises the code to upper case BEFORE it validates it', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * CONTRACT #25, AND THE ORDER OF THOSE TWO WORDS IS THE WHOLE OF IT. A
     * customer types a code at a checkout box in whatever case their phone
     * decided on, so a lower-case body is an ordinary request and not a
     * malformed one — refusing it with a message about capital letters would
     * fail the person holding the flyer, not the person who made it.
     *
     * The opposite of what a program key gets (`../programs/routes.ts` refuses
     * rather than rewrites), because a key is chosen once by an owner at a form
     * that shows the format as a hint.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const discount = await created({ code: '  free-delivery  ' });
    expect(discount.code).toBe('FREE-DELIVERY');

    // …and the stored row is the normalised one, not an echo of the request.
    expect((await list()).find((d) => d.id === discount.id)?.code).toBe('FREE-DELIVERY');
  });

  it('stores a fixed-amount code with the currency the amount is in', async () => {
    const startsAt = 1_800_000_000_000;
    const discount = await created({
      kind: 'fixed_amount',
      percentBps: undefined,
      amountMinor: 250_000,
      currency: 'NGN',
      startsAt,
      endsAt: startsAt + 86_400_000,
      maxRedemptions: 40,
      note: 'Podcast read, week one',
    });

    expect(discount).toMatchObject({
      kind: 'fixed_amount',
      amountMinor: 250_000,
      currency: 'NGN',
      percentBps: null,
      startsAt,
      endsAt: startsAt + 86_400_000,
      maxRedemptions: 40,
      note: 'Podcast read, week one',
    });
    // The response IS the stored row, not an echo of the request.
    expect((await list()).find((d) => d.id === discount.id)).toEqual(discount);
  });

  it('refuses a second code that differs only in case, naming the collision', async () => {
    /*
     * THE POINT OF NORMALISING FIRST. Two rows differing only in case would be
     * two campaigns a customer cannot tell apart, and whichever one the
     * redeeming surface found first would decide what the other was worth.
     * `marketing_discount_codes_code_uq` sees the normalised value, so this is
     * a refusal rather than a duplicate.
     */
    const first = await created({ code: 'HALFPRICE' });
    expect(first.code).toBe('HALFPRICE');

    const clash = await create({ code: 'halfprice' });
    expect(clash.status).toBe(409);
    expect(await json(clash)).toMatchObject({
      error: 'duplicate_code',
      // The NORMALISED code, which is the row that exists — echoing what was
      // typed would send somebody looking for a code that is not there.
      code: 'HALFPRICE',
    });
  });

  it('refuses a code the column would refuse, naming the field', async () => {
    const NUL = String.fromCharCode(0);
    /* `marketing_discount_codes_code_ck`: 3..32 characters, opening on a letter
     * or digit. Mirrored in zod rather than trusted, because unrendered it is
     * SQLSTATE 23514 — a 500 for a code with a space in it. */
    for (const code of ['', 'AB', '-LEADING', 'HAS SPACE', 'PUNCT!', 'X'.repeat(33), `OK${NUL}`]) {
      const res = await create({ code });
      expect([res.status, code]).toEqual([400, code]);
      expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'code' });
    }
  });

  it('requires the fields its kind is priced from', async () => {
    const percent = await create({ percentBps: undefined });
    expect(percent.status).toBe(400);
    expect(await json(percent)).toMatchObject({ detail: 'percentBps' });

    const amount = await create({
      kind: 'fixed_amount',
      percentBps: undefined,
      amountMinor: 500,
    });
    expect(amount.status).toBe(400);
    /* "500 off" is not a price until it says 500 of what, and
     * `marketing_discount_codes_kind_fields_ck` ties the two columns together. */
    expect(await json(amount)).toMatchObject({ detail: 'currency' });
  });

  it('refuses the OTHER kind’s fields rather than ignoring them', async () => {
    /*
     * A DISCRIMINATED UNION, so each branch simply has no key for the other
     * kind's columns and `.strict()` refuses one. Written as a `superRefine`
     * over a single wide object this is the half that gets forgotten: the body
     * is accepted, the field ignored, and the caller told 201 for a discount it
     * believes it priced two ways.
     */
    /* ONE stray field per probe: `zodDetail` joins every unrecognized key into
     * the detail, so a body carrying two would answer `amountMinor.currency` —
     * true, but not a field an editor can focus. */
    const percentWithAmount = await create({ amountMinor: 500 });
    expect(percentWithAmount.status).toBe(400);
    expect(await json(percentWithAmount)).toMatchObject({
      error: 'bad_request',
      detail: 'amountMinor',
    });

    const amountWithPercent = await create({
      kind: 'fixed_amount',
      amountMinor: 500,
      currency: 'NGN',
      percentBps: 1000,
    });
    expect(amountWithPercent.status).toBe(400);
    expect(await json(amountWithPercent)).toMatchObject({ detail: 'percentBps' });
  });

  it('refuses values the columns would refuse, naming the field', async () => {
    const cases: [string, unknown][] = [
      // `BETWEEN 1 AND 10000`: zero discounts nothing and 10001 is more than
      // the order is worth.
      ['percentBps', 0],
      ['percentBps', 10_001],
      ['percentBps', 12.5],
      // `integer`: past int4 is SQLSTATE 22003, i.e. a 500 for a number
      // somebody typed.
      ['maxRedemptions', 0],
      ['maxRedemptions', 2_147_483_648],
      ['startsAt', -1],
      ['endsAt', 'tomorrow'],
      // The discriminator itself. `invalid_union` reports at `kind`, which is
      // the control an editor would render as a segmented pair.
      ['kind', 'buy_one_get_one'],
    ];

    for (const [field, value] of cases) {
      const res = await create({ [field]: value });
      expect([res.status, field, value]).toEqual([400, field, value]);
      expect(await json(res)).toMatchObject({ error: 'bad_request', detail: field });
    }

    /* `str().length(3)` alone accepts "ngn", which `money()` then refuses by
     * throwing a programming-error class with no row in the error table — a
     * measured 500 on the shop side for a lower-case currency code. */
    const currency = await create({
      kind: 'fixed_amount',
      percentBps: undefined,
      amountMinor: 500,
      currency: 'ngn',
    });
    expect(currency.status).toBe(400);
    expect(await json(currency)).toMatchObject({ detail: 'currency' });
  });

  it('refuses a window that ends before — or exactly when — it starts', async () => {
    const startsAt = 1_800_000_000_000;
    for (const endsAt of [startsAt - 1, startsAt]) {
      const res = await create({ startsAt, endsAt });
      expect([res.status, endsAt]).toEqual([400, endsAt]);
      /*
       * ON THE END FIELD, which is where the editor renders it and the one a
       * human almost always mistyped. `endsAt === startsAt` is refused too: a
       * window of zero length is a campaign that cannot run for an instant, and
       * it looks exactly like one that has not started yet.
       */
      expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'endsAt' });
    }
  });

  it('refuses an unknown key rather than ignoring it', async () => {
    // `.strict()`, like every body in this application: a mistyped field that is
    // silently dropped is worse than a refusal, because the caller is told 201.
    for (const field of ['status', 'redeemedCount']) {
      const res = await create({ [field]: field === 'status' ? 'disabled' : 5 });
      expect([res.status, field]).toEqual([400, field]);
      expect(await json(res)).toMatchObject({ error: 'bad_request', detail: field });
    }
  });

  it('normalises a blank note to nothing at all', async () => {
    /* A controlled textarea posts `""` rather than nothing when an admin empties
     * it, and an empty note is a row that reads as having one until you open
     * it. */
    expect((await created({ note: '   ' })).note).toBeNull();
  });
});

// ----------------------------------------------------------------------- list

describe('GET /discounts', () => {
  it('returns every status, newest first', async () => {
    const active = await created({ code: 'STILLRUNNING' });
    const disabled = await created({ code: 'LONGOVER' });
    expect((await save(disabled, { status: 'disabled' })).status).toBe(200);

    /* BOTH STATUSES IN ONE ANSWER, and the screen groups them. There is no
     * delete here — `redeemedCount` is a record of what a code was worth to the
     * people who used it — so a status filter would be a second request for the
     * same page. */
    const discounts = await list();
    const seen = new Map(discounts.map((d) => [d.id, d]));
    expect(seen.get(active.id)?.status).toBe('active');
    expect(seen.get(disabled.id)?.status).toBe('disabled');

    /*
     * ORDERING ASSERTED AS A PROPERTY, not as an expected array of ids: rows
     * created in the same millisecond fall to the `id DESC` tie-break, which is
     * random by construction. The direction is what the contract is about, and
     * the row below pins it from the other end.
     */
    const times = discounts.map((d) => d.createdAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    // A row that is genuinely older sorts last, whatever the tie-break does.
    await ctx.db.execute(sql`
      INSERT INTO marketing_discount_codes
        (id, code, kind, percent_bps, created_at, updated_at)
      VALUES ('dsc_ancient', 'FIRSTEVER', 'percent', 500, 1, 1)`);
    const withAncient = await list();
    expect(withAncient[withAncient.length - 1].id).toBe('dsc_ancient');
  });
});

// ---------------------------------------------------------------------- patch

describe('PATCH /discounts/:id', () => {
  it('turns a code off and bumps the revision', async () => {
    const discount = await created();
    const res = await save(discount, { status: 'disabled', note: 'Campaign over' });
    expect(res.status).toBe(200);

    const saved = (await json<{ discount: Discount }>(res)).discount;
    expect(saved.status).toBe('disabled');
    expect(saved.note).toBe('Campaign over');
    expect(saved.revision).toBe(discount.revision + 1);
    expect(saved.updatedAt).toBeGreaterThanOrEqual(discount.updatedAt);
    // Turning it off changes nothing about what it was worth.
    expect(saved.percentBps).toBe(discount.percentBps);
    expect(saved.code).toBe(discount.code);
  });

  it('clears the end date, the cap and the note with null, and leaves absent fields alone', async () => {
    /*
     * `undefined` MEANS "LEAVE IT ALONE" AND `null` MEANS "CLEAR IT" — three
     * states, not two. Removing an end date is how a campaign is extended
     * indefinitely and removing a cap is how it becomes unlimited; a patch that
     * could only ever SET them would leave the only way out of a schedule being
     * a code nobody can extend.
     */
    const startsAt = 1_800_000_000_000;
    const discount = await created({
      startsAt,
      endsAt: startsAt + 3_600_000,
      maxRedemptions: 10,
      note: 'Some note',
    });

    const res = await save(discount, { endsAt: null, maxRedemptions: null, note: null });
    expect(res.status).toBe(200);
    const saved = (await json<{ discount: Discount }>(res)).discount;
    expect(saved.endsAt).toBeNull();
    expect(saved.maxRedemptions).toBeNull();
    expect(saved.note).toBeNull();
    // Untouched fields survive: a patch is not a replace.
    expect(saved.startsAt).toBe(startsAt);
    expect(saved.status).toBe('active');
  });

  it('clears the START date, and the window rule sees it cleared', async () => {
    /*
     * THE OTHER HALF OF "null MEANS CLEAR IT", and the half a merge written as
     * `patch.startsAt ?? current.startsAt` would get wrong while passing every
     * row above: `??` cannot tell an absent field from a cleared one, so the
     * window would be judged against a start date this body just deleted.
     *
     * The edit below is legal — the row that results has no start at all, so
     * `marketing_discount_codes_window_ck` has nothing to compare — and under
     * `??` it is a 400 naming a field the caller did not get wrong. A false
     * refusal, not a 500, which is why nothing else here notices it.
     */
    const startsAt = 1_800_000_000_000;
    const discount = await created({ startsAt, endsAt: startsAt + 3_600_000 });

    const res = await save(discount, { startsAt: null, endsAt: startsAt - 3_600_000 });
    expect(res.status).toBe(200);

    const saved = (await json<{ discount: Discount }>(res)).discount;
    expect(saved.startsAt).toBeNull();
    expect(saved.endsAt).toBe(startsAt - 3_600_000);
  });

  it('judges the window on the MERGED row, not on the body', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE CASE A SCHEMA COULD NOT CATCH, and the reason `assertWindow` lives in
     * the repository rather than in a `superRefine`. Half of the rule is in the
     * database: the start date was stored last week and only the end date is in
     * this body. Unrendered this is `marketing_discount_codes_window_ck` —
     * SQLSTATE 23514, i.e. a 500 the client retries five times for a date that
     * can never be accepted.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const startsAt = 1_800_000_000_000;
    const scheduled = await created({ startsAt });

    const res = await save(scheduled, { endsAt: startsAt - 60_000 });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'endsAt' });

    // …and the row is untouched by the refusal.
    expect((await list()).find((d) => d.id === scheduled.id)).toMatchObject({
      startsAt,
      endsAt: null,
      revision: scheduled.revision,
    });
  });

  it('has no way to change what a code is WORTH', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE IMMUTABILITY WALL, AND IT IS AN ABSENCE RATHER THAN A RULE. Five
     * fields are simply not in the patch schema, so `.strict()` names whichever
     * one a body carries. A code is printed on a flyer and read out on a
     * podcast; every copy is a promise made in the past tense, and a route that
     * could turn 20% into 5% would let the shop rewrite one it already made. To
     * change what a code is worth you disable it and create another.
     *
     * THIS IS THE ASSERTION THAT GOES RED IF THE `.strict()` IS DROPPED — a
     * widened schema does not fail loudly, it accepts the body, ignores the
     * field, and answers 200.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const discount = await created({ code: 'IMMUTABLE1', percentBps: 2500 });

    const frozen: [string, unknown][] = [
      ['code', 'IMMUTABLE2'],
      ['kind', 'fixed_amount'],
      ['percentBps', 500],
      ['amountMinor', 500],
      ['currency', 'NGN'],
      ['redeemedCount', 9],
    ];

    for (const [field, value] of frozen) {
      const res = await save(discount, { [field]: value });
      expect([res.status, field]).toEqual([400, field]);
      expect(await json(res)).toMatchObject({ error: 'bad_request', detail: field });
    }

    // Nothing moved, including the revision — a refused patch is not a touch.
    expect((await list()).find((d) => d.id === discount.id)).toEqual(discount);
  });

  it('refuses a stale revision with 409 stale_write carrying the discount', async () => {
    const discount = await created({ note: 'Contended' });
    expect((await save(discount, { note: 'Mine' })).status).toBe(200);

    const second = await save(discount, { note: 'Theirs' });
    expect(second.status).toBe(409);

    const body = await json<Record<string, unknown>>(second);
    expect(body.error).toBe('stale_write');
    expect(body.expected).toBe(discount.revision);
    expect(body.actual).toBe(discount.revision + 1);
    /*
     * Under `discount`, not `post` and not `entity`. Marketing has five
     * revisioned entities and the conflict notice renders "Load theirs" out of
     * whichever one it asked about — so the name is part of the contract, and a
     * router that spelled it differently would render an empty form. Carrying
     * the row is what saves the client a second fetch that would show a THIRD
     * state as though it were what the write lost to (spec D7).
     */
    expect(body.discount).toMatchObject({
      id: discount.id,
      note: 'Mine',
      revision: discount.revision + 1,
    });
  });

  it('requires expectedRevision, and 404s an unknown id', async () => {
    const discount = await created();

    const noToken = await owner.patch(`${API}/discounts/${discount.id}`, {
      status: 'disabled',
    });
    expect(noToken.status).toBe(400);
    expect(await json(noToken)).toMatchObject({ detail: 'expectedRevision' });

    const gone = await owner.patch(`${API}/discounts/dsc_never_existed`, {
      expectedRevision: 1,
      status: 'disabled',
    });
    expect(gone.status).toBe(404);
    expect(await json(gone)).toMatchObject({ error: 'gone' });
  });
});

// ------------------------------------------------------------------ NUL bytes

describe('a NUL byte', () => {
  const NUL = String.fromCharCode(0);

  it('is a 400 in the id and in the free-text field — never a 5xx', async () => {
    const discount = await created();

    /*
     * A COMPLETE, VALID BODY, so the only thing left for the route to refuse is
     * the segment. `server/nul-bytes.test.ts` walks every registered path
     * parameter, but it sends `{}` — which this route answers 400 for the
     * missing `expectedRevision` before `pathParam` is ever consulted. Its
     * green is therefore not evidence for this route, and deleting `pathParam`
     * here leaves the whole repository still passing. (`../programs/routes.test.ts`
     * carries the same probe for the same reason.)
     */
    const path = await owner.patch(`${API}/discounts/${encodeURIComponent(NUL)}`, {
      expectedRevision: 1,
      status: 'disabled',
    });
    expect(path.status).toBe(400);
    expect(await json(path)).toMatchObject({ error: 'bad_request', detail: 'id' });

    /*
     * `note` IS THE ONLY FIELD ON THESE ROUTES WHERE `str()` IS LOAD-BEARING,
     * and its schema ends in a `.transform()` — the NUL check is a `ZodString`
     * rule and runs BEFORE it, which is the whole reason `str()` is a regex
     * rather than a refinement (`../returns/routes.test.ts` states it the same
     * way). `code` cannot stand in: U+0000 is outside `[A-Z0-9_-]`, so the
     * pattern refuses it and the boundary check is never reached.
     *
     * Untranslated this is SQLSTATE 22021 — a 500, with a retry policy behind
     * it, for a character somebody pasted out of a spreadsheet.
     */
    const posted = await create({ note: `Podcast${NUL}read` });
    expect(posted.status).toBe(400);
    expect(await json(posted)).toMatchObject({ error: 'bad_request', detail: 'note' });

    const patched = await save(discount, { note: `Podcast${NUL}read` });
    expect(patched.status).toBe(400);
    expect(await json(patched)).toMatchObject({ error: 'bad_request', detail: 'note' });
  });
});
