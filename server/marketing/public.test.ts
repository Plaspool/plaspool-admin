/**
 * The public marketing reads — contract #29-30, spec D8.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE PROPERTIES WORTH BREAKING A BUILD OVER.
 *
 * 1. **The mount is cookieless.** These two responses carry `Cache-Control:
 *    public`, so a shared cache may store one and hand it to a different
 *    reader. The router is mounted ABOVE `sessionMiddleware` in
 *    `server/index.ts`, which is what makes that safe by construction rather
 *    than by review — and it is also the mount PROOF deferred from A2, because
 *    a subsystem whose auth is per route cannot prove a mount until it has a
 *    route to answer with.
 *
 * 2. **The SQL predicate and `deriveBannerStatus` are one rule.** They cannot
 *    be one implementation — the client cannot run SQL and Postgres cannot run
 *    TypeScript — so the parity suite below feeds the same fixture rows to both
 *    at eight instants and asserts they select the same ids. When they
 *    disagree, the admin screen says Live, the site shows nothing, and nobody
 *    can tell which one is lying.
 *
 * 3. **The rewards copy is DATA.** Every noun on the storefront's "send your
 *    empties back" page is a column, so a rename in the admin is a rename on
 *    the site within one cache TTL and no deploy.
 *
 * THE CLOCK IS INJECTED for the visibility suites (`createMarketingPublicRoutes({
 * now })`) because a banner scheduled for tomorrow and a banner that ended
 * yesterday are the two rows most worth testing, and both are propositions
 * about an instant. The mount, header and shape suites drive the REAL app
 * instead — those are about the wiring, and the wiring reads `Date.now`.
 *
 * NO NOUN FROM THE SEEDED PRESET APPEARS HERE (spec D11). The rewards suite
 * points the shop's default at a program it creates with absurd labels and
 * asserts the endpoint renders THOSE — which is the same assertion as "nothing
 * is hardcoded", made from the outside.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb } from '../test/harness';
import { httpClient, json } from '../test/http';
import { deriveBannerStatus } from '../../shared/marketing/banners';
import { createMarketingPublicRoutes } from './public';
import { listPublicBanners } from './banners/repo';
import type { TestCtx } from '../test/harness';
import type { HttpClient } from '../test/http';
import type { AuthUser } from '../../shared/types';
import type { BannerSchedule } from '../../shared/marketing/banners';
import type { AppEnv } from '../app-env';
import type { Banner, BannerPlacement, BannerStatus, PublicBanner } from './banners/repo';
import type { Program } from './programs/repo';

let ctx: TestCtx;
let owner: HttpClient;
/** No session at all — a fresh browser, not a logged-out one. */
let anon: HttpClient;

const API = '/api/marketing';
const PUBLIC = '/api/public/marketing';

/** A fixed instant the fixtures are written around, so every expectation below
 *  is legible arithmetic rather than something the reader has to trust. */
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

async function login(user: AuthUser): Promise<HttpClient> {
  const client = httpClient(ctx.db);
  const res = await client.post('/api/auth/login', {
    email: user.email,
    password: SEED_PASSWORD,
  });
  expect(res.status).toBe(200);
  return client;
}

beforeAll(async () => {
  ctx = await freshDb();
  owner = await login(ctx.users.owner);
  anon = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

/**
 * EVERY TEST STARTS WITH AN EMPTY TABLE, unlike the suites that share fixtures.
 *
 * A public list endpoint's answer is a property of the WHOLE table, so a row
 * left behind by the test above is a false positive here in both directions —
 * an ordering assertion that passes because of a row it never mentioned, or a
 * "nothing is showing" that fails for the same reason. Sessions live in another
 * table, so the logged-in clients survive this.
 */
beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM marketing_banners`);
});

interface BannerFixture {
  id: string;
  status: BannerStatus;
  startsAt?: number | null;
  endsAt?: number | null;
  placement?: BannerPlacement;
  priority?: number;
  createdAt?: number;
  title?: string;
  body?: string;
  ctaText?: string | null;
  ctaUrl?: string | null;
}

/**
 * Fixtures by SQL rather than through the create route.
 *
 * The write path has its own suite (`banners/routes.test.ts`) and going through
 * it here would mean two requests per row and no way to name a `created_at` —
 * which the priority tie-break assertion is about. The one round trip that
 * proves the two halves are connected is its own test below.
 */
async function insertBanner(row: BannerFixture): Promise<void> {
  const at = row.createdAt ?? T0;
  await ctx.db.execute(sql`
    INSERT INTO marketing_banners
      (id, title, body, cta_text, cta_url, placement, status,
       starts_at, ends_at, priority, created_at, updated_at)
    VALUES (${row.id}, ${row.title ?? row.id}, ${row.body ?? ''},
            ${row.ctaText ?? null}, ${row.ctaUrl ?? null},
            ${row.placement ?? 'top_bar'}, ${row.status},
            ${row.startsAt ?? null}, ${row.endsAt ?? null},
            ${row.priority ?? 0}, ${at}, ${at})`);
}

/**
 * The public router alone, over the suite's database, with a NAMED clock.
 *
 * Deliberately not `createApp()`: the real app reads `Date.now`, and every
 * question in the visibility suites is "what is showing at THIS instant".
 * Everything else the mount gives — the request id, the lazy database factory —
 * is reproduced here in two lines, so what is under test is the router.
 */
function publicApp(now: number): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'test-request');
    c.set('dbFactory', () => ctx.db);
    await next();
  });
  app.route('/api', createMarketingPublicRoutes({ now: () => now }));
  return app;
}

async function showing(now: number, query = ''): Promise<PublicBanner[]> {
  const res = await publicApp(now).request(`${PUBLIC}/banners${query}`);
  expect(res.status).toBe(200);
  return (await json<{ banners: PublicBanner[] }>(res)).banners;
}

// ------------------------------------------------------- the mount and headers

describe('the mount', () => {
  it('answers 200 cookieless — the mount proof deferred from A2', async () => {
    /*
     * A 200 for a caller with NO SESSION is what proves both halves at once:
     * the public router is mounted under `/api/public/marketing` (or the answer
     * would be 404) and nothing on the path demands a session (or it would be
     * 401). `app.test.ts` already pins the other half of the guarantee — that
     * an unrouted path here answers without resolving a database handle at all.
     */
    await insertBanner({ id: 'bnr_open', status: 'live' });

    const res = await anon.get(`${PUBLIC}/banners`);
    expect(res.status).toBe(200);
    expect((await json<{ banners: PublicBanner[] }>(res)).banners.map((b) => b.id)).toEqual([
      'bnr_open',
    ]);
  });

  it('answers a signed-in caller the same bytes, and sets no cookie', async () => {
    /*
     * THE CACHEABILITY ARGUMENT, ASSERTED FROM THE OUTSIDE. A response a shared
     * cache may hand to a different reader must not vary by cookie — and this
     * router is mounted ABOVE `sessionMiddleware`, so the cookie the owner's jar
     * sends is read by nothing on this path and nothing comes back to update it.
     */
    await insertBanner({ id: 'bnr_open', status: 'live' });

    const stranger = await anon.get(`${PUBLIC}/banners`);
    const signedIn = await owner.get(`${PUBLIC}/banners`);
    expect(signedIn.status).toBe(200);
    expect(await signedIn.text()).toBe(await stranger.text());
    expect(signedIn.headers.getSetCookie()).toEqual([]);
  });

  it('carries exactly the cache and CORS headers spec D8 names', async () => {
    await insertBanner({ id: 'bnr_open', status: 'live' });

    const banners = await anon.get(`${PUBLIC}/banners`);
    /*
     * SIXTY SECONDS is the number the Banners screen's empty state promises out
     * loud ("the storefront checks for live banners every minute"), so this
     * string and that copy are one decision.
     */
    expect(banners.headers.get('cache-control')).toBe(
      'public, s-maxage=60, stale-while-revalidate=300',
    );
    expect(banners.headers.get('access-control-allow-origin')).toBe('*');
    expect(banners.headers.get('content-type')).toBe('application/json; charset=UTF-8');
    /* NEVER with `*`: the combination is exactly what turns a public read API
     * into a session-riding one. */
    expect(banners.headers.get('access-control-allow-credentials')).toBeNull();

    const rewards = await anon.get(`${PUBLIC}/rewards`);
    expect(rewards.status).toBe(200);
    // Longer, because rewards copy changes when somebody renames a programme —
    // a deliberate act on a config screen, not a scheduled event.
    expect(rewards.headers.get('cache-control')).toBe(
      'public, s-maxage=300, stale-while-revalidate=3600',
    );
    expect(rewards.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('refuses an unknown placement, with the CORS header still on the refusal', async () => {
    const res = await anon.get(`${PUBLIC}/banners?placement=sidebar`);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'placement' });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE SAME REFUSAL, THROUGH THE ROUTER ALONE — because through the real app
     * the two assertions above prove less than they look.
     *
     * `createPublicRoutes` is mounted FIRST and registers its own post-`next()`
     * middleware at `/api/public/*`, a superset of this path; the app's global
     * `onError` renders the body. Measured by mutation: deleting this router's
     * `onError` AND its own CORS middleware AND the header in `send()` leaves
     * every assertion above green, because the blog's reading API is quietly
     * supplying all three. That is a real belt, but it belongs to a file this
     * subsystem does not own and could be re-scoped without a test noticing.
     *
     * Mounted alone, nothing else can answer: the router's own `onError` is the
     * only thing that turns a thrown `BadRequestError` into a readable 400
     * instead of Hono's default 500, and the only thing that puts the header on
     * it. This is the assertion that fails when the CORS block is removed.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const alone = await publicApp(T0).request(`${PUBLIC}/banners?placement=sidebar`);
    expect(alone.status).toBe(400);
    expect(await json(alone)).toMatchObject({ error: 'bad_request', detail: 'placement' });
    expect(alone.headers.get('access-control-allow-origin')).toBe('*');

    // `.strict()`: a mistyped filter that is silently ignored would answer with
    // every placement and look like a working one.
    const unknown = await anon.get(`${PUBLIC}/banners?placment=popup`);
    expect(unknown.status).toBe(400);
    expect(await json(unknown)).toMatchObject({ detail: 'placment' });
  });

  it('serves a banner created and switched on through the admin routes', async () => {
    /* The one round trip, so "the write path feeds the read path" is asserted
     * rather than assumed by two suites that each mock the other's half. */
    const create = await owner.post(`${API}/banners`, {
      title: 'Bring back your canisters',
      body: 'We collect from your door.',
      ctaText: 'Book a pickup',
      ctaUrl: '/returns',
      placement: 'popup',
      priority: 3,
    });
    expect(create.status).toBe(201);
    const banner = (await json<{ banner: Banner }>(create)).banner;

    // A draft is invisible to the internet until somebody flips the Switch.
    expect((await json<{ banners: PublicBanner[] }>(await anon.get(`${PUBLIC}/banners`))).banners)
      .toEqual([]);

    const live = await owner.patch(`${API}/banners/${banner.id}`, {
      expectedRevision: banner.revision,
      status: 'live',
    });
    expect(live.status).toBe(200);

    const { banners } = await json<{ banners: PublicBanner[] }>(
      await anon.get(`${PUBLIC}/banners`),
    );
    expect(banners).toEqual([
      {
        id: banner.id,
        title: 'Bring back your canisters',
        body: 'We collect from your door.',
        ctaText: 'Book a pickup',
        ctaUrl: '/returns',
        placement: 'popup',
        priority: 3,
      },
    ]);

    /*
     * AND THE WAY BACK DOWN IS THE SAME WRITE. "Archive banner…" is a PATCH of
     * this one column — there is no DELETE anywhere in this subsystem, because a
     * banner that ran is a record of what the shop said in public — so taking it
     * down leaves the row where it is and the read-time predicate simply stops
     * selecting it. Asserted as one trip rather than as two suites that each
     * assume the other's half.
     */
    const archived = await owner.patch(`${API}/banners/${banner.id}`, {
      expectedRevision: (await json<{ banner: Banner }>(live)).banner.revision,
      status: 'archived',
    });
    expect(archived.status).toBe(200);

    expect(
      (await json<{ banners: PublicBanner[] }>(await anon.get(`${PUBLIC}/banners`))).banners,
    ).toEqual([]);

    // Gone from the internet, still on the admin's list — which is the whole
    // difference between archiving and deleting.
    const admin = await json<{ banners: Banner[] }>(await owner.get(`${API}/banners`));
    expect(admin.banners.find((b) => b.id === banner.id)?.status).toBe('archived');
  });
});

// ------------------------------------------------------------- what is showing

describe('the read-time schedule', () => {
  it('shows live rows in their window and nothing else', async () => {
    await insertBanner({ id: 'bnr_live', status: 'live' });
    await insertBanner({ id: 'bnr_draft', status: 'draft' });
    await insertBanner({ id: 'bnr_archived', status: 'archived' });
    await insertBanner({ id: 'bnr_soon', status: 'live', startsAt: T0 + HOUR });
    await insertBanner({ id: 'bnr_over', status: 'live', endsAt: T0 - HOUR });
    await insertBanner({
      id: 'bnr_window',
      status: 'live',
      startsAt: T0 - HOUR,
      endsAt: T0 + HOUR,
    });

    expect((await showing(T0)).map((b) => b.id).sort()).toEqual(['bnr_live', 'bnr_window']);

    /* THE SAME ROWS, A DIFFERENT CLOCK — which is the whole of what "evaluated
     * at read time" means: nothing was written between these three assertions
     * and no job ran. `bnr_live` is in all three because a live row with no
     * window at all is the one banner the clock has no opinion about. */
    expect((await showing(T0 + 2 * HOUR)).map((b) => b.id).sort()).toEqual([
      'bnr_live',
      'bnr_soon',
    ]);
    expect((await showing(T0 - 2 * HOUR)).map((b) => b.id).sort()).toEqual([
      'bnr_live',
      'bnr_over',
    ]);
  });

  it('starts ON the start and ends ON the end', async () => {
    /*
     * THE BOUNDARIES ARE THE CONTRACT: `startsAt === now` is showing (a banner
     * scheduled for 09:00 is up AT 09:00) and `endsAt === now` is over (the
     * window is half-open, so a back-to-back pair never both show and never
     * both vanish). A `<` where a `<=` belongs is a one-millisecond
     * disagreement no manual test will ever see.
     */
    await insertBanner({ id: 'bnr_from', status: 'live', startsAt: T0 });
    await insertBanner({ id: 'bnr_until', status: 'live', endsAt: T0 });

    expect((await showing(T0 - 1)).map((b) => b.id)).toEqual(['bnr_until']);
    expect((await showing(T0)).map((b) => b.id)).toEqual(['bnr_from']);
    expect((await showing(T0 + 1)).map((b) => b.id)).toEqual(['bnr_from']);
  });

  it('orders by priority, then by recency', async () => {
    await insertBanner({ id: 'bnr_low', status: 'live', priority: 0, createdAt: T0 });
    await insertBanner({ id: 'bnr_high', status: 'live', priority: 9, createdAt: T0 - HOUR });
    await insertBanner({ id: 'bnr_mid_old', status: 'live', priority: 5, createdAt: T0 - HOUR });
    await insertBanner({ id: 'bnr_mid_new', status: 'live', priority: 5, createdAt: T0 });

    /* "Highest wins per placement" is what the editor's priority hint says, and
     * a storefront that renders `banners[0]` is reading this order. Recency
     * breaks a tie so a shop that never touches priority still gets its newest
     * banner first. */
    expect((await showing(T0 + 1)).map((b) => b.id)).toEqual([
      'bnr_high',
      'bnr_mid_new',
      'bnr_mid_old',
      'bnr_low',
    ]);
  });

  it('filters by placement', async () => {
    await insertBanner({ id: 'bnr_top', status: 'live', placement: 'top_bar' });
    await insertBanner({ id: 'bnr_pop', status: 'live', placement: 'popup' });
    await insertBanner({ id: 'bnr_sec', status: 'live', placement: 'section' });

    expect((await showing(T0, '?placement=popup')).map((b) => b.id)).toEqual(['bnr_pop']);
    /* Absent means every region, because a page that renders three of them
     * fetches once and sorts them out itself. */
    expect((await showing(T0)).map((b) => b.id).sort()).toEqual([
      'bnr_pop',
      'bnr_sec',
      'bnr_top',
    ]);
  });

  it('ships only the fields a page renders', async () => {
    await insertBanner({
      id: 'bnr_open',
      status: 'live',
      startsAt: T0 - HOUR,
      endsAt: T0 + HOUR,
      priority: 2,
    });

    const [banner] = await showing(T0);
    /*
     * NO `status`, NO `revision`, NO WINDOW. Those are the columns the ADMIN
     * decides visibility with, and this answer has already applied them —
     * shipping them would invite the storefront to re-implement the decision
     * and get a third opinion into an argument that already has two sides.
     */
    expect(Object.keys(banner).sort()).toEqual([
      'body',
      'ctaText',
      'ctaUrl',
      'id',
      'placement',
      'priority',
      'title',
    ]);
  });
});

// --------------------------------------------------------------------- parity

describe('the SQL predicate and deriveBannerStatus', () => {
  /**
   * Every interesting shape a banner can have, once.
   *
   * The two archived and two draft rows carry live-looking windows on purpose:
   * the precedence half of the rule ("archived is archived whatever the dates
   * say") is the half a predicate written as three ANDed clauses gets wrong.
   */
  const FIXTURES: (BannerSchedule & { id: string })[] = [
    { id: 'bnr_always', status: 'live', startsAt: null, endsAt: null },
    { id: 'bnr_from_t0', status: 'live', startsAt: T0, endsAt: null },
    { id: 'bnr_until_t0', status: 'live', startsAt: null, endsAt: T0 },
    { id: 'bnr_window', status: 'live', startsAt: T0 - HOUR, endsAt: T0 + HOUR },
    { id: 'bnr_draft', status: 'draft', startsAt: null, endsAt: null },
    { id: 'bnr_draft_window', status: 'draft', startsAt: T0 - HOUR, endsAt: T0 + HOUR },
    { id: 'bnr_archived', status: 'archived', startsAt: null, endsAt: null },
    { id: 'bnr_archived_window', status: 'archived', startsAt: T0 - HOUR, endsAt: T0 + HOUR },
  ];

  const INSTANTS = [
    T0 - HOUR - 1,
    T0 - HOUR,
    T0 - 1,
    T0,
    T0 + 1,
    T0 + HOUR - 1,
    T0 + HOUR,
    T0 + HOUR + 1,
  ];

  it('select exactly the same banners at every boundary', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE PARITY TEST. `banners/repo.ts#showingAt` is the WHERE clause the
     * storefront is served through; `shared/marketing/banners.ts` is the pure
     * function the admin list renders its chip from. They cannot be one
     * implementation — the client cannot run SQL — so this is the assertion
     * that keeps them one RULE, and it is run at eight instants because the
     * disagreements that matter are all at boundaries.
     * ═══════════════════════════════════════════════════════════════════════
     */
    for (const fixture of FIXTURES) await insertBanner(fixture);

    for (const now of INSTANTS) {
      const fromSql = (await listPublicBanners(ctx.db, { now })).map((b) => b.id).sort();
      const fromShared = FIXTURES.filter((b) => deriveBannerStatus(b, now) === 'live')
        .map((b) => b.id)
        .sort();
      expect([now, fromSql]).toEqual([now, fromShared]);
    }
  });

  it('hands the admin row straight to the shared function', async () => {
    /*
     * A COMPILE-TIME ASSERTION as much as a runtime one: the wire `Banner` IS a
     * `BannerSchedule`, so the client calls `deriveBannerStatus(banner, now)`
     * with the row exactly as it arrived. A field renamed on one side of that
     * assignment stops this file compiling, which is the earliest anybody could
     * find out.
     */
    await insertBanner({ id: 'bnr_open', status: 'live', startsAt: T0 - HOUR });

    const { banners } = await json<{ banners: Banner[] }>(await owner.get(`${API}/banners`));
    const schedule: BannerSchedule = banners[0];
    expect(deriveBannerStatus(schedule, T0)).toBe('live');
    expect(deriveBannerStatus(schedule, T0 - 2 * HOUR)).toBe('scheduled');
  });
});

// -------------------------------------------------------------------- rewards

describe('GET /api/public/marketing/rewards', () => {
  /** The words this deployment uses, in this suite. Absurd on purpose: a
   *  fixture that matched the shipped preset could not tell a label READ FROM A
   *  ROW from one written in source. */
  const CAPS = {
    key: 'bottle-caps',
    kind: 'unit_return',
    name: 'Cap Returns',
    pointsLabelSingular: 'Bottle Cap',
    pointsLabelPlural: 'Bottle Caps',
    unitLabelSingular: 'canister',
    unitLabelPlural: 'canisters',
    minUnitsPerReturn: 4,
    pointsPerUnit: 7,
  };

  let caps: Program;
  let goodwill: Program;

  beforeAll(async () => {
    const capsRes = await owner.post(`${API}/programs`, CAPS);
    expect(capsRes.status).toBe(201);
    caps = (await json<{ program: Program }>(capsRes)).program;

    const adhocRes = await owner.post(`${API}/programs`, {
      key: 'goodwill',
      kind: 'adhoc',
      name: 'Goodwill',
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
    });
    expect(adhocRes.status).toBe(201);
    goodwill = (await json<{ program: Program }>(adhocRes)).program;
  });

  /** Settings are a singleton and every test here moves them, so the live
   *  revision is re-read rather than assumed. */
  async function settings(patch: Record<string, unknown>): Promise<void> {
    const read = await owner.get(`${API}/settings`);
    const { settings: current } = await json<{ settings: { revision: number } }>(read);
    const res = await owner.patch(`${API}/settings`, {
      expectedRevision: current.revision,
      ...patch,
    });
    expect(res.status).toBe(200);
  }

  async function setStatus(program: Program, status: 'active' | 'paused'): Promise<void> {
    const read = await owner.get(`${API}/programs`);
    const { programs } = await json<{ programs: Program[] }>(read);
    const live = programs.find((p) => p.id === program.id) as Program;
    const res = await owner.patch(`${API}/programs/${program.id}`, {
      expectedRevision: live.revision,
      status,
    });
    expect(res.status).toBe(200);
  }

  async function rewards(): Promise<{ program: Record<string, unknown> | null }> {
    const res = await anon.get(`${PUBLIC}/rewards`);
    expect(res.status).toBe(200);
    return json<{ program: Record<string, unknown> | null }>(res);
  }

  it('renders the default program entirely out of its own columns', async () => {
    await settings({ defaultReturnProgramId: caps.id });

    /*
     * THE NEVER-HARDCODE GUARANTEE, PUBLIC EDITION. The storefront's whole
     * "send your empties back" page is built from this — what the programme is
     * called, what the points are called, what the thing being sent back is
     * called, how many make a request and what each accepted one earns — so a
     * rename in the admin is a rename on the site within one cache TTL and no
     * deploy.
     */
    expect((await rewards()).program).toEqual({
      name: 'Cap Returns',
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
      unitLabelSingular: 'canister',
      unitLabelPlural: 'canisters',
      minUnitsPerReturn: 4,
      pointsPerUnit: 7,
    });
  });

  it('follows a rename, with no deploy and nothing to invalidate but a cache', async () => {
    await settings({ defaultReturnProgramId: caps.id });
    const read = await owner.get(`${API}/programs`);
    const live = (await json<{ programs: Program[] }>(read)).programs.find(
      (p) => p.id === caps.id,
    ) as Program;

    const res = await owner.patch(`${API}/programs/${caps.id}`, {
      expectedRevision: live.revision,
      name: 'Reel Returns',
      pointsLabelSingular: 'Loop Point',
      pointsLabelPlural: 'Loop Points',
      unitLabelSingular: 'reel',
      unitLabelPlural: 'reels',
    });
    expect(res.status).toBe(200);

    expect((await rewards()).program).toMatchObject({
      name: 'Reel Returns',
      pointsLabelSingular: 'Loop Point',
      unitLabelPlural: 'reels',
    });

    // Put the words back, so the tests below read as they are written.
    const after = (await json<{ programs: Program[] }>(await owner.get(`${API}/programs`))).programs
      .find((p) => p.id === caps.id) as Program;
    expect(
      (
        await owner.patch(`${API}/programs/${caps.id}`, {
          expectedRevision: after.revision,
          name: CAPS.name,
          pointsLabelSingular: CAPS.pointsLabelSingular,
          pointsLabelPlural: CAPS.pointsLabelPlural,
          unitLabelSingular: CAPS.unitLabelSingular,
          unitLabelPlural: CAPS.unitLabelPlural,
        })
      ).status,
    ).toBe(200);
  });

  it('answers null while the programme is paused', async () => {
    /* "Returns are paused" is the one sentence a storefront can render without
     * knowing anything else, and it is the same answer for every reason a
     * programme is not taking returns. */
    await settings({ defaultReturnProgramId: caps.id });
    await setStatus(caps, 'paused');
    expect((await rewards()).program).toBeNull();

    await setStatus(caps, 'active');
    expect((await rewards()).program).not.toBeNull();
  });

  it('answers null when the shop has no default programme', async () => {
    await settings({ defaultReturnProgramId: null });
    expect((await rewards()).program).toBeNull();
  });

  it('answers null when the default programme takes no returns', async () => {
    /*
     * An `adhoc` programme has no unit words and no rules — points are granted
     * by hand — so there is no page to render. The alternative is a storefront
     * that says "return at least null canisters", which is why the query
     * requires the four columns rather than trusting
     * `marketing_programs_kind_fields_ck` to have kept them non-null.
     */
    await settings({ defaultReturnProgramId: goodwill.id });
    expect((await rewards()).program).toBeNull();
  });
});
