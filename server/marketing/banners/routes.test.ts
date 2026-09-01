/**
 * Banners on the wire — contract #21-23, driven through the REAL app.
 *
 * ROUTE SUITES GO THROUGH THE WHOLE STACK — router, origin guard, session
 * middleware, marketing's own `onError`, the global error handler — because the
 * seam between the repository and HTTP is what this task adds and therefore
 * where its defects are. What is only provable here is the guard attached per
 * route, the `.strict()` on a body, the exact JSON a conflict becomes, and the
 * three cross-field refusals that would otherwise be CHECK violations — i.e.
 * 500s the client retries five times for a date that can never be accepted.
 *
 * THE PUBLIC HALF IS IN `../public.test.ts`. Everything about visibility — the
 * read-time window, the placement filter, the cache headers, the parity with
 * `deriveBannerStatus` — lives there, because this file is about writing rows
 * and that one is about what the internet may see.
 *
 * NO NOUN FROM THE SEEDED PRESET APPEARS HERE (spec D11): banners carry their
 * own words, and every fixture below is absurd on purpose.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { TestCtx } from '../../test/harness';
import type { HttpClient } from '../../test/http';
import type { AuthUser } from '../../../shared/types';
import type { Banner } from './repo';

let ctx: TestCtx;
let owner: HttpClient;
let writer: HttpClient;
/** No session at all — a fresh browser, not a logged-out one. */
let anon: HttpClient;

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
  anon = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

/** The happy-path create, so a test about ONE field says only that. */
async function create(
  body: Record<string, unknown> = {},
  client: HttpClient = owner,
): Promise<Response> {
  return client.post(`${API}/banners`, {
    title: 'Half price canisters',
    placement: 'top_bar',
    ...body,
  });
}

async function created(body: Record<string, unknown> = {}): Promise<Banner> {
  const res = await create(body);
  expect(res.status).toBe(201);
  return (await json<{ banner: Banner }>(res)).banner;
}

async function list(client: HttpClient = owner): Promise<Banner[]> {
  const res = await client.get(`${API}/banners`);
  expect(res.status).toBe(200);
  return (await json<{ banners: Banner[] }>(res)).banners;
}

/** A patch that always carries the live revision, for tests that are not about
 *  the CAS. */
async function save(
  banner: Banner,
  patch: Record<string, unknown>,
  client: HttpClient = owner,
): Promise<Response> {
  return client.patch(`${API}/banners/${banner.id}`, {
    expectedRevision: banner.revision,
    ...patch,
  });
}

// -------------------------------------------------------------- the guards

describe('mounting and the guards', () => {
  it('answers 401 without a session on every route', async () => {
    expect((await anon.get(`${API}/banners`)).status).toBe(401);
    expect((await anon.post(`${API}/banners`, {})).status).toBe(401);
    expect((await anon.patch(`${API}/banners/bnr_nope`, {})).status).toBe(401);

    expect(await json(await anon.get(`${API}/banners`))).toMatchObject({
      error: 'unauthenticated',
    });
  });

  it('lets a WRITER create, edit and publish one', async () => {
    /*
     * THE FROZEN ROLE MATRIX (spec D12). Banner work is content — the posts
     * precedent, where a writer writes and publishes — and `requireOwner` is
     * reserved for the things that change what the business PAYS: program
     * rates, redemption economics, manual adjustments. A 403 here would mean a
     * shop whose sale banner waits for the owner to log in.
     */
    const banner = (await json<{ banner: Banner }>(await create({}, writer))).banner;
    expect(banner.status).toBe('draft');

    const res = await save(banner, { status: 'live' }, writer);
    expect(res.status).toBe(200);
    expect((await json<{ banner: Banner }>(res)).banner.status).toBe('live');
  });
});

// --------------------------------------------------------------------- create

describe('POST /banners', () => {
  it('creates a DRAFT, with the column defaults for everything unsaid', async () => {
    const banner = await created({ title: 'Free delivery this week' });

    /*
     * DRAFT, AND THERE IS NO WAY TO ASK FOR ANYTHING ELSE — the create schema
     * has no `status` field, so `.strict()` refuses one. The editor's whole
     * shape (write it, look at the preview, then flip the Switch) assumes a
     * create cannot publish to every visitor in one request.
     */
    expect(banner.status).toBe('draft');
    expect(banner.id.startsWith('bnr_')).toBe(true);
    expect(banner.revision).toBe(1);
    expect(banner.body).toBe('');
    expect(banner.priority).toBe(0);
    expect(banner.startsAt).toBeNull();
    expect(banner.endsAt).toBeNull();
    expect(banner.ctaText).toBeNull();
    expect(banner.ctaUrl).toBeNull();
    expect(banner.createdAt).toBeGreaterThan(0);
    expect(banner.updatedAt).toBe(banner.createdAt);
  });

  it('stores the whole banner when the whole banner is given', async () => {
    const startsAt = 1_800_000_000_000;
    const banner = await created({
      title: 'Bring back your canisters',
      body: 'We collect from your door.',
      ctaText: 'Book a pickup',
      ctaUrl: '/returns',
      placement: 'popup',
      startsAt,
      endsAt: startsAt + 86_400_000,
      priority: 7,
    });

    expect(banner).toMatchObject({
      title: 'Bring back your canisters',
      body: 'We collect from your door.',
      ctaText: 'Book a pickup',
      ctaUrl: '/returns',
      placement: 'popup',
      startsAt,
      endsAt: startsAt + 86_400_000,
      priority: 7,
    });
    // The response IS the stored row, not an echo of the request.
    expect((await list()).find((b) => b.id === banner.id)).toEqual(banner);
  });

  it('refuses half a CTA, naming the field that has to be filled in', async () => {
    /*
     * `marketing_banners_cta_pair_ck` says the same thing in the database, where
     * it is SQLSTATE 23514 and therefore a 500 — five retries for a button that
     * can never be saved. Named here it is an inline field error, and it names
     * the MISSING half rather than the field that was sent: focusing the input
     * an admin has already filled in tells them their correct value is wrong.
     */
    const url = await create({ ctaUrl: '/sale' });
    expect(url.status).toBe(400);
    expect(await json(url)).toMatchObject({ error: 'bad_request', detail: 'ctaText' });

    const text = await create({ ctaText: 'Shop the sale' });
    expect(text.status).toBe(400);
    expect(await json(text)).toMatchObject({ error: 'bad_request', detail: 'ctaUrl' });
  });

  it('treats an EMPTY CTA pair as no CTA at all', async () => {
    /*
     * Two controlled inputs an admin who wants no button simply leaves alone
     * post `""` rather than nothing. Without the blank normalisation that is
     * two empty strings, a `.min(1)` failure, and a field error for a field
     * nobody touched.
     */
    const banner = await created({ ctaText: '', ctaUrl: '' });
    expect(banner.ctaText).toBeNull();
    expect(banner.ctaUrl).toBeNull();
  });

  it('refuses a CTA URL that is not http(s) or a site path', async () => {
    /*
     * A SECURITY CONSTRAINT, not tidiness: this column is served by a cookieless
     * public endpoint and rendered into an anchor on the storefront, so a
     * `javascript:` destination is stored XSS with a publish button in front of
     * it. `marketing_banners_cta_url_ck` is the backstop; this is the answer a
     * human gets.
     */
    for (const ctaUrl of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.test', 'sale']) {
      const res = await create({ ctaText: 'Go', ctaUrl });
      expect([res.status, ctaUrl]).toEqual([400, ctaUrl]);
      expect(await json(res)).toMatchObject({ detail: 'ctaUrl' });
    }

    // …and the two shapes that ARE allowed, so the refusal above is not a
    // regex that refuses everything.
    expect((await created({ ctaText: 'Go', ctaUrl: 'https://shop.test/sale' })).ctaUrl).toBe(
      'https://shop.test/sale',
    );
    expect((await created({ ctaText: 'Go', ctaUrl: '/sale' })).ctaUrl).toBe('/sale');
  });

  it('refuses a window that ends before — or exactly when — it starts', async () => {
    const startsAt = 1_800_000_000_000;
    for (const endsAt of [startsAt - 1, startsAt]) {
      const res = await create({ startsAt, endsAt });
      expect([res.status, endsAt]).toEqual([400, endsAt]);
      /*
       * ON THE END FIELD, which is where the editor renders it (spec §UI
       * Banners). `endsAt === startsAt` is refused too: the read-time predicate
       * is `starts_at <= now AND ends_at > now`, which no instant satisfies when
       * the two are equal — a banner that can never show looks exactly like one
       * that has not started yet.
       */
      expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'endsAt' });
    }
  });

  it('refuses values the columns would refuse, naming the field', async () => {
    const NUL = String.fromCharCode(0);
    const cases: [string, unknown][] = [
      // `marketing_banners_title_ck`: non-empty after btrim, and the route
      // trims first so " Sale " is stored rather than 500ing on the CHECK.
      ['title', ''],
      ['title', '   '],
      ['title', `Sale${NUL}`],
      ['placement', 'sidebar'],
      ['placement', ''],
      // `integer`: past int4 is SQLSTATE 22003, i.e. a 500 for a number
      // somebody typed.
      ['priority', 2_147_483_648],
      ['priority', 1.5],
      ['startsAt', -1],
      ['endsAt', 'tomorrow'],
    ];

    for (const [field, value] of cases) {
      const res = await create({ [field]: value });
      expect([res.status, field, value]).toEqual([400, field, value]);
      expect(await json(res)).toMatchObject({ error: 'bad_request', detail: field });
    }
  });

  it('refuses an unknown key rather than ignoring it', async () => {
    // `.strict()`, like every body in this application: a mistyped field that is
    // silently dropped is worse than a refusal, because the caller is told 201.
    const res = await create({ status: 'live' });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'status' });
  });

  it('trims the title rather than refusing the space around it', async () => {
    expect((await created({ title: '  Weekend sale  ' })).title).toBe('Weekend sale');
  });
});

// ----------------------------------------------------------------------- list

describe('GET /banners', () => {
  it('returns every status, newest first', async () => {
    const draft = await created({ title: 'A draft banner' });
    const live = await created({ title: 'A live banner' });
    expect((await save(live, { status: 'live' })).status).toBe(200);
    const archived = await created({ title: 'An archived banner' });
    expect((await save(archived, { status: 'archived' })).status).toBe(200);

    /* ALL THREE STATUSES IN ONE ANSWER, and the client derives the chip: the
     * screen groups archived rows under their own heading rather than hiding
     * them (there is no delete anywhere), so a status filter here would be a
     * second request for the same page. */
    const banners = await list();
    const seen = new Map(banners.map((b) => [b.id, b]));
    expect(seen.get(draft.id)?.status).toBe('draft');
    expect(seen.get(live.id)?.status).toBe('live');
    expect(seen.get(archived.id)?.status).toBe('archived');

    /*
     * ORDERING ASSERTED AS A PROPERTY, not as an expected array of ids: rows
     * created in the same millisecond fall to the `id DESC` tie-break, which is
     * random by construction. The direction is what the contract is about, and
     * the row below pins it from the other end.
     */
    const times = banners.map((b) => b.createdAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    // A row that is genuinely older sorts last, whatever the tie-break does.
    await ctx.db.execute(sql`
      INSERT INTO marketing_banners (id, title, placement, created_at, updated_at)
      VALUES ('bnr_ancient', 'The first banner', 'section', 1, 1)`);
    const withAncient = await list();
    expect(withAncient[withAncient.length - 1].id).toBe('bnr_ancient');
  });
});

// ---------------------------------------------------------------------- patch

describe('PATCH /banners/:id', () => {
  it('edits the words and bumps the revision', async () => {
    const banner = await created({ title: 'Before' });
    const res = await save(banner, { title: 'After', body: 'New body' });
    expect(res.status).toBe(200);

    const saved = (await json<{ banner: Banner }>(res)).banner;
    expect(saved.title).toBe('After');
    expect(saved.body).toBe('New body');
    expect(saved.revision).toBe(banner.revision + 1);
    expect(saved.updatedAt).toBeGreaterThanOrEqual(banner.updatedAt);
  });

  it('maps the enabled Switch to draft ↔ live and archives through the same route', async () => {
    /* Spec §UI Banners: the editor's Switch is `draft ↔ live` and "Archive
     * banner…" is a Confirm over the SAME field. There is no DELETE anywhere in
     * this subsystem — a banner that ran is a record of what the shop said in
     * public. */
    let banner = await created({ title: 'Switch me on' });
    for (const status of ['live', 'draft', 'archived'] as const) {
      const res = await save(banner, { status });
      expect([res.status, status]).toEqual([200, status]);
      banner = (await json<{ banner: Banner }>(res)).banner;
      expect(banner.status).toBe(status);
    }
  });

  it('clears a schedule and a CTA with null, and leaves absent fields alone', async () => {
    /*
     * `undefined` MEANS "LEAVE IT ALONE" AND `null` MEANS "CLEAR IT" — three
     * states, not two. Removing an end date is how a campaign is extended
     * indefinitely and removing a CTA is how a button becomes a sentence; a
     * patch that could only ever SET them would leave the only way out of a
     * schedule being a banner nobody can turn off.
     */
    const startsAt = 1_800_000_000_000;
    const banner = await created({
      startsAt,
      endsAt: startsAt + 3_600_000,
      ctaText: 'Book',
      ctaUrl: '/returns',
      body: 'Some body',
    });

    const res = await save(banner, { endsAt: null, ctaText: null, ctaUrl: null });
    expect(res.status).toBe(200);
    const saved = (await json<{ banner: Banner }>(res)).banner;
    expect(saved.endsAt).toBeNull();
    expect(saved.ctaText).toBeNull();
    expect(saved.ctaUrl).toBeNull();
    // Untouched fields survive: a patch is not a replace.
    expect(saved.startsAt).toBe(startsAt);
    expect(saved.body).toBe('Some body');
  });

  it('judges both cross-field rules on the MERGED row, not on the body', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE CASE A SCHEMA COULD NOT CATCH, and the reason `assertCoherent` lives
     * in the repository rather than in a `superRefine`. Half of each rule is in
     * the database: the start date was stored last week and only the end date
     * is in this body. Unrendered, both of these are CHECK violations — 500s
     * the client retries five times for input that can never be accepted.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const startsAt = 1_800_000_000_000;
    const scheduled = await created({ startsAt });

    const window = await save(scheduled, { endsAt: startsAt - 60_000 });
    expect(window.status).toBe(400);
    expect(await json(window)).toMatchObject({ detail: 'endsAt' });

    const pair = await created({ ctaText: 'Book', ctaUrl: '/returns' });
    // Clearing one half of a stored pair leaves a label with no destination.
    const half = await save(pair, { ctaUrl: null });
    expect(half.status).toBe(400);
    expect(await json(half)).toMatchObject({ detail: 'ctaUrl' });

    // …and the row is untouched by the refusal.
    const stored = (await list()).find((b) => b.id === pair.id);
    expect(stored).toMatchObject({ ctaUrl: '/returns', revision: pair.revision });
  });

  it('refuses a stale revision with 409 stale_write carrying the banner', async () => {
    const banner = await created({ title: 'Contended' });
    expect((await save(banner, { title: 'Mine' })).status).toBe(200);

    const second = await save(banner, { title: 'Theirs' });
    expect(second.status).toBe(409);

    const body = await json<Record<string, unknown>>(second);
    expect(body.error).toBe('stale_write');
    expect(body.expected).toBe(banner.revision);
    expect(body.actual).toBe(banner.revision + 1);
    /*
     * Under `banner`, not `post` and not `entity`. Marketing has five revisioned
     * entities and the conflict notice renders "Load theirs" out of whichever
     * one it asked about — so the name is part of the contract, and a router
     * that spelled it differently would render an empty banner. Carrying the
     * row is what saves the client a second fetch that would show a THIRD state
     * as though it were what the write lost to (spec D7).
     */
    expect(body.banner).toMatchObject({
      id: banner.id,
      title: 'Mine',
      revision: banner.revision + 1,
    });
  });

  it('requires expectedRevision, refuses unknown keys, and 404s an unknown id', async () => {
    const banner = await created({ title: 'Guarded' });

    const noToken = await owner.patch(`${API}/banners/${banner.id}`, { title: 'x' });
    expect(noToken.status).toBe(400);
    expect(await json(noToken)).toMatchObject({ detail: 'expectedRevision' });

    const unknownKey = await save(banner, { seeded: true });
    expect(unknownKey.status).toBe(400);
    expect(await json(unknownKey)).toMatchObject({ detail: 'seeded' });

    const gone = await owner.patch(`${API}/banners/bnr_never_existed`, {
      expectedRevision: 1,
      title: 'x',
    });
    expect(gone.status).toBe(404);
    expect(await json(gone)).toMatchObject({ error: 'gone' });
  });
});
