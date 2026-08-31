/**
 * Settings — contract #19-20, driven through the REAL app.
 *
 * THIS FILE ALSO CARRIES THE MOUNT PROOF DEFERRED FROM A2. `marketingApp()` was
 * mounted with no routes in it, and a subsystem where auth is attached per route
 * cannot prove a mount with a 401 until it has a route to attach one to: an
 * unrouted path answers 404 whether or not anything is mounted there. So the
 * first guarded route in the subsystem is where "the mount exists AND the guard
 * is on it" becomes a single assertion — `GET /api/marketing/settings` without a
 * session is a 401 rather than a 404.
 *
 * THE SINGLETON IS SHARED STATE, so every mutating test re-reads it rather than
 * assuming a revision number. Suites in one file run in order, and a test that
 * hard-coded `expectedRevision: 1` would break the moment another test above it
 * saved anything — which is the sort of failure that gets fixed by deleting an
 * assertion.
 *
 * NO NOUN FROM THE SEEDED PRESET APPEARS HERE (spec D11), so the seeded labels
 * are asserted as "present and non-empty" and the default program is found by its
 * `seeded` flag. The words themselves live in migration 0011 and nowhere else.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_PASSWORD, freshDb } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { TestCtx } from '../../test/harness';
import type { HttpClient } from '../../test/http';
import type { AuthUser } from '../../../shared/types';
import type { MarketingSettings } from './repo';
import type { Program } from '../programs/repo';

let ctx: TestCtx;
let owner: HttpClient;
let writer: HttpClient;
let marketing: HttpClient;
let anon: HttpClient;

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
  writer = await login(ctx.users.writer);
  marketing = await login(ctx.users.marketing);
  anon = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

async function read(client: HttpClient = owner): Promise<MarketingSettings> {
  const res = await client.get('/api/marketing/settings');
  expect(res.status).toBe(200);
  return (await json<{ settings: MarketingSettings }>(res)).settings;
}

/** A patch that always carries the live revision, for the tests that are not
 *  about the CAS. */
async function save(patch: Record<string, unknown>): Promise<Response> {
  const current = await read();
  return owner.patch('/api/marketing/settings', {
    expectedRevision: current.revision,
    ...patch,
  });
}

async function seededProgram(): Promise<Program> {
  const res = await owner.get('/api/marketing/programs');
  const { programs } = await json<{ programs: Program[] }>(res);
  const found = programs.find((p) => p.seeded);
  expect(found).toBeDefined();
  return found as Program;
}

// --------------------------------------------------------------------- mount

describe('mounting and the guards', () => {
  it('answers 401 without a session — the mount proof deferred from A2', async () => {
    /*
     * A 401 rather than a 404 is what proves BOTH halves at once: the marketing
     * app is mounted under `/api/marketing` and this route is registered inside
     * it (or the answer would be 404), and `requireAuth()` is attached to it (or
     * the answer would be 200 with the deployment's configuration handed to a
     * stranger).
     */
    const res = await anon.get('/api/marketing/settings');
    expect(res.status).toBe(401);
    expect(await json(res)).toMatchObject({ error: 'unauthenticated' });

    expect((await anon.patch('/api/marketing/settings', {})).status).toBe(401);
  });

  it('lets a writer read the settings and refuses their writes with 403', async () => {
    /*
     * The frozen role matrix (spec D12): redemption economics and the words that
     * span every program are the owner's. Reading them is not — a writer's
     * screens render balances in those words, so a reader that could not see them
     * would render the currency word as nothing at all.
     */
    expect((await writer.get('/api/marketing/settings')).status).toBe(403);
    const seen = await read(marketing);
    expect(seen.pointsLabelPlural.length).toBeGreaterThan(0);

    const res = await writer.patch('/api/marketing/settings', {
      expectedRevision: seen.revision,
      pointsLabelSingular: 'Bottle Cap',
    });
    expect(res.status).toBe(403);
    // The refusal actually refused.
    expect((await read()).pointsLabelSingular).toBe(seen.pointsLabelSingular);
  });
});

// ---------------------------------------------------------------------- read

describe('GET /settings', () => {
  it('returns the migration-seeded singleton, with redemption off', async () => {
    const settings = await read();

    expect(settings.revision).toBe(1);
    expect(settings.pointsLabelSingular.length).toBeGreaterThan(0);
    expect(settings.pointsLabelPlural.length).toBeGreaterThan(0);
    /*
     * OFF, AT A PLACEHOLDER RATE. The seed ships `redemption_enabled = false`
     * with a zero money side, and the CHECK forbids enabling it until somebody
     * sets a real rate — so a deployment that never reviews these numbers costs
     * the shop copy rather than discounting every cart to nothing.
     */
    expect(settings.redemptionEnabled).toBe(false);
    expect(settings.redemptionRatePoints).toBeGreaterThan(0);
    expect(settings.redemptionRateMinor).toBe(0);
    expect(settings.redemptionCurrency).toMatch(/^[A-Z]{3}$/);
    expect(settings.minRedeemPoints).toBe(0);
    expect(settings.maxRedeemBps).toBe(10000);
    expect(settings.updatedAt).toBeGreaterThan(0);
  });

  it('points the default return program at the seeded preset', async () => {
    // The seed resolves this through a scalar subquery on the key rather than
    // through a literal id, so it lands on whichever row is actually there.
    expect((await read()).defaultReturnProgramId).toBe((await seededProgram()).id);
  });
});

// --------------------------------------------------------------------- write

describe('PATCH /settings', () => {
  it('saves the cross-program words and bumps the revision', async () => {
    const before = await read();
    const res = await owner.patch('/api/marketing/settings', {
      expectedRevision: before.revision,
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
    });
    expect(res.status).toBe(200);

    const { settings } = await json<{ settings: MarketingSettings }>(res);
    expect(settings.pointsLabelSingular).toBe('Bottle Cap');
    expect(settings.pointsLabelPlural).toBe('Bottle Caps');
    expect(settings.revision).toBe(before.revision + 1);
    // The response IS the stored row, not an echo of the request.
    expect(await read()).toEqual(settings);
  });

  it('refuses a stale revision with 409 stale_write carrying the settings', async () => {
    const before = await read();
    const first = await owner.patch('/api/marketing/settings', {
      expectedRevision: before.revision,
      minRedeemPoints: 25,
    });
    expect(first.status).toBe(200);

    const second = await owner.patch('/api/marketing/settings', {
      expectedRevision: before.revision,
      minRedeemPoints: 50,
    });
    expect(second.status).toBe(409);

    const body = await json<Record<string, unknown>>(second);
    expect(body.error).toBe('stale_write');
    expect(body.expected).toBe(before.revision);
    expect(body.actual).toBe(before.revision + 1);
    /*
     * Under `settings`, not `post` and not `entity`. Marketing has five
     * revisioned entities and the conflict notice renders "Load theirs" from
     * whichever one it asked about — so the name is part of the contract, and a
     * router that spelled it differently would render an empty banner.
     */
    expect(body.settings).toMatchObject({ minRedeemPoints: 25, revision: before.revision + 1 });
  });

  it('refuses enabling redemption while the money side is zero', async () => {
    const before = await read();
    expect(before.redemptionRateMinor).toBe(0);

    const res = await owner.patch('/api/marketing/settings', {
      expectedRevision: before.revision,
      redemptionEnabled: true,
    });
    /*
     * 400 AND NOT A 500. `marketing_settings_enabled_rate_ck` says the same thing
     * in the database, but a CHECK violation is SQLSTATE 23514 — no row in the
     * error table, so a 500 the client retries five times for a switch that can
     * never be flipped on its own. The detail names the RATE rather than the
     * switch, because the rate is what has to change for the request to succeed;
     * the UI gates the enable Switch on the same field.
     */
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({
      error: 'bad_request',
      detail: 'redemptionRateMinor',
    });
    expect((await read()).redemptionEnabled).toBe(false);
  });

  it('enables redemption when the same body sets a real rate', async () => {
    /*
     * The refusal above is about the MERGED row, not about the body: the rule is
     * "the stored settings may never be enabled at a zero rate", so switching on
     * and pricing in one save is legal and is what the UI actually sends.
     */
    const res = await save({
      redemptionEnabled: true,
      redemptionRatePoints: 100,
      redemptionRateMinor: 500,
    });
    expect(res.status).toBe(200);

    const settings = await read();
    expect(settings.redemptionEnabled).toBe(true);
    expect(settings.redemptionRateMinor).toBe(500);

    // …and it stays refused from the other direction: zeroing the rate on a row
    // that is switched on is the same forbidden state reached backwards.
    const zeroed = await save({ redemptionRateMinor: 0 });
    expect(zeroed.status).toBe(400);
    expect(await json(zeroed)).toMatchObject({ detail: 'redemptionRateMinor' });

    // Put it back, so the tests below start from a disabled deployment again.
    expect((await save({ redemptionEnabled: false, redemptionRateMinor: 0 })).status).toBe(200);
  });

  it('refuses an unknown defaultReturnProgramId as a FIELD error, not a missing page', async () => {
    const res = await save({ defaultReturnProgramId: 'prg_never_existed' });
    /*
     * 400 `bad_request` detail `defaultReturnProgramId`, and NOT 404 `gone`
     * (contract #20). The pattern this comes from is a Select whose options were
     * fetched a moment ago: the value raced, and the treatment is an inline error
     * beside the control the admin is looking at. `gone` renders a whole-screen
     * "no longer exists" with a back link — the wrong page for a field.
     *
     * Unrendered it would be a foreign-key violation (23503) and therefore a 500.
     */
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({
      error: 'bad_request',
      detail: 'defaultReturnProgramId',
    });
  });

  it('accepts a real program id and accepts null to clear it', async () => {
    const program = await seededProgram();

    expect((await save({ defaultReturnProgramId: null })).status).toBe(200);
    expect((await read()).defaultReturnProgramId).toBeNull();

    expect((await save({ defaultReturnProgramId: program.id })).status).toBe(200);
    expect((await read()).defaultReturnProgramId).toBe(program.id);
  });

  it('requires expectedRevision and refuses an unknown key', async () => {
    const res = await owner.patch('/api/marketing/settings', { minRedeemPoints: 5 });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'expectedRevision' });

    // `.strict()`, like every body in this application: a mistyped field that is
    // silently ignored is worse than a refusal, because the caller is told 200.
    const unknown = await save({ redemptionRate: 500 });
    expect(unknown.status).toBe(400);
    expect(await json(unknown)).toMatchObject({ detail: 'redemptionRate' });
  });

  it('refuses values the columns would refuse, naming the field', async () => {
    const cases: [string, unknown][] = [
      // BETWEEN 1 AND 10000 — a cap of zero would silently disable redemption
      // through a field that does not say so, and 10001 is not a share of
      // anything.
      ['maxRedeemBps', 0],
      ['maxRedeemBps', 10001],
      // > 0: zero points-per-anything is a division by zero in `quote()`.
      ['redemptionRatePoints', 0],
      ['minRedeemPoints', -1],
      ['redemptionRateMinor', -1],
      // `integer` columns: past int4 is SQLSTATE 22003, i.e. a 500 for a number
      // somebody typed. The ceiling is the storage's, not a business rule — what a
      // sensible rate is belongs to the owner and is edited on this same screen.
      ['redemptionRatePoints', 2_147_483_648],
      ['redemptionRateMinor', 2_147_483_648],
      ['minRedeemPoints', 2_147_483_648],
      // …and fractions, which no `integer` column can hold either.
      ['minRedeemPoints', 2.5],
      // `^[A-Z]{3}$`, the `PriceBody` precedent: `str().length(3)` alone accepts
      // "ngn", which `money()` then refuses by throwing — a 500 for a case.
      ['redemptionCurrency', 'ngn'],
      ['redemptionCurrency', 'NAIRA'],
      ['pointsLabelSingular', ''],
      ['pointsLabelPlural', '   '],
      ['pointsLabelSingular', `Bottle${String.fromCharCode(0)}Cap`],
    ];

    for (const [field, value] of cases) {
      const res = await save({ [field]: value });
      expect([res.status, field, value]).toEqual([400, field, value]);
      expect(await json(res)).toMatchObject({ error: 'bad_request', detail: field });
    }
  });
});
