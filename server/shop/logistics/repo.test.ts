import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { NotFoundError } from '../../repo/errors';
import {
  DEFAULT_PACKAGING,
  getLogisticsSettings,
  listRecentWebhooks,
  logWebhook,
  patchLogisticsSettings,
  setTerminalPackagingId,
} from './repo';
import type { Packaging, ShipFrom } from './port';

/**
 * The courier settings singleton and the inbound webhook log (migration 0960),
 * against a real Postgres.
 *
 * PGlite rather than a fake, for the reasons this repository keeps re-learning:
 * the CAS is a `WHERE … AND revision =` the database evaluates, the packaging
 * comparison is `jsonb IS DISTINCT FROM`, and both are the sort of thing a
 * hand-rolled double agrees with right up until it matters.
 *
 * ONE FIXTURE IS THE STORED DEFAULT ON PURPOSE. `DEFAULT_PACKAGING` is the same
 * box migration 0960 seeds into the column, so the read path is exercised
 * against the value a fresh deployment actually holds rather than against one
 * invented here — CLAUDE.md §2's empty-document lesson, applied to a row.
 */

let ctx: TestCtx;

/** The clock every write is given, so `updated_at` is an assertion, not a race. */
const NOW = 1_800_000_000_000;
/** What migration 0960's INSERT put in `updated_at`. */
const SEEDED_AT = 1_786_600_005_100;

const SHIP_FROM: ShipFrom = {
  name: 'PlaSpool',
  phone: '08030000000',
  email: 'dispatch@plaspool.com',
  line1: '12 Aminu Kano Crescent',
  line2: 'Suite 4',
  city: 'Wuse 2',
  region: 'FCT',
  postalCode: '900288',
  countryCode: 'NG',
};

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

/**
 * DELETE-then-INSERT rather than an UPDATE, so a test that destroys the row to
 * exercise `NotFoundError` leaves the next one a seeded database rather than an
 * empty table. Everything unnamed here takes the DDL default, which is the
 * point of the fixture note above.
 */
beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM shop_logistics_webhooks`);
  await ctx.db.execute(sql`DELETE FROM shop_logistics_settings`);
  await ctx.db.execute(sql`
    INSERT INTO shop_logistics_settings (id, provider, updated_at)
    VALUES ('main', 'manual', ${SEEDED_AT})`);
});

const write = (expectedRevision: number) => ({
  expectedRevision,
  actorId: ctx.users.owner.id,
  now: NOW,
});

describe('getLogisticsSettings', () => {
  it('reads the seeded row, packaging and all', async () => {
    expect(await getLogisticsSettings(ctx.db)).toEqual({
      provider: 'manual',
      shipFrom: null,
      packaging: DEFAULT_PACKAGING,
      terminalPackagingId: null,
      revision: 1,
      updatedAt: SEEDED_AT,
    });
  });

  it('throws NotFoundError when somebody has deleted the singleton', async () => {
    await ctx.db.execute(sql`DELETE FROM shop_logistics_settings WHERE id = 'main'`);
    await expect(getLogisticsSettings(ctx.db)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('patchLogisticsSettings', () => {
  it('refuses a stale revision, names both sides, and changes nothing', async () => {
    await expect(
      patchLogisticsSettings(ctx.db, { provider: 'fez' }, write(7)),
    ).rejects.toMatchObject({ name: 'StaleWriteError', expected: 7, actual: 1 });

    expect(await getLogisticsSettings(ctx.db)).toMatchObject({ provider: 'manual', revision: 1 });
  });

  it('switches the courier on with a ship-from address and bumps the revision', async () => {
    const saved = await patchLogisticsSettings(
      ctx.db,
      { provider: 'fez', shipFrom: SHIP_FROM },
      write(1),
    );

    expect(saved).toMatchObject({
      provider: 'fez',
      shipFrom: SHIP_FROM,
      revision: 2,
      updatedAt: NOW,
    });
    /* The returned row IS the stored row, not a hopeful reconstruction. */
    expect(await getLogisticsSettings(ctx.db)).toEqual(saved);

    const res = await ctx.db.execute(sql`
      SELECT updated_by FROM shop_logistics_settings WHERE id = 'main'`);
    expect(String(res.rows[0]!.updated_by)).toBe(ctx.users.owner.id);
  });

  it('leaves an absent key alone and clears the address on an explicit null', async () => {
    await patchLogisticsSettings(ctx.db, { provider: 'fez', shipFrom: SHIP_FROM }, write(1));

    /* `{}` still bumps the revision — a save is a save — but touches nothing. */
    const untouched = await patchLogisticsSettings(ctx.db, {}, write(2));
    expect(untouched).toMatchObject({ provider: 'fez', shipFrom: SHIP_FROM, revision: 3 });

    const cleared = await patchLogisticsSettings(ctx.db, { shipFrom: null }, write(3));
    expect(cleared.shipFrom).toBeNull();
    expect(cleared.provider).toBe('fez');
  });

  it('drops the cached Terminal packaging id when the box changes, and keeps it when it does not', async () => {
    await setTerminalPackagingId(ctx.db, 'PA-1234');
    expect((await getLogisticsSettings(ctx.db)).terminalPackagingId).toBe('PA-1234');

    /* Saving the SAME box is not a change: Terminal's record still describes it. */
    const same = await patchLogisticsSettings(ctx.db, { packaging: DEFAULT_PACKAGING }, write(1));
    expect(same.terminalPackagingId).toBe('PA-1234');

    const bigger: Packaging = {
      ...DEFAULT_PACKAGING,
      name: 'Double spool box',
      heightCm: 16,
      weightKg: 0.4,
    };
    const changed = await patchLogisticsSettings(ctx.db, { packaging: bigger }, write(2));
    expect(changed.packaging).toEqual(bigger);
    expect(changed.terminalPackagingId).toBeNull();
  });

  it('setTerminalPackagingId clears with a null and never moves the revision', async () => {
    await setTerminalPackagingId(ctx.db, 'PA-1234');
    await setTerminalPackagingId(ctx.db, null);
    const s = await getLogisticsSettings(ctx.db);
    expect(s.terminalPackagingId).toBeNull();
    /* It is a cache write, not an operator edit — nobody's open tab is stale. */
    expect(s.revision).toBe(1);
  });
});

describe('the webhook log', () => {
  const stored = async (providerRef: string): Promise<Record<string, unknown>> => {
    const res = await ctx.db.execute(sql`
      SELECT payload FROM shop_logistics_webhooks WHERE provider_ref = ${providerRef}`);
    const payload = res.rows[0]!.payload;
    return (typeof payload === 'string' ? JSON.parse(payload) : payload) as Record<string, unknown>;
  };

  it('records a delivery and lists the newest first', async () => {
    await logWebhook(ctx.db, {
      provider: 'fez',
      providerRef: 'FEZ-1',
      rawStatus: 'PICKED UP',
      verified: true,
      applied: 'applied',
      payload: { status: 'PICKED UP' },
      now: NOW,
    });
    await logWebhook(ctx.db, {
      provider: 'terminal',
      providerRef: null,
      rawStatus: null,
      verified: false,
      applied: 'rejected',
      payload: null,
      now: NOW + 1_000,
    });

    const rows = await listRecentWebhooks(ctx.db, 10);
    expect(rows.map((r) => r.provider)).toEqual(['terminal', 'fez']);
    expect(rows[0]).toMatchObject({
      provider: 'terminal',
      providerRef: null,
      rawStatus: null,
      verified: false,
      applied: 'rejected',
      receivedAt: NOW + 1_000,
    });
    expect(rows[1]).toMatchObject({
      provider: 'fez',
      providerRef: 'FEZ-1',
      rawStatus: 'PICKED UP',
      verified: true,
      applied: 'applied',
      receivedAt: NOW,
    });
    expect(rows[1]!.id.startsWith('lgw_')).toBe(true);
  });

  it('honours the limit, newest end first', async () => {
    for (let i = 0; i < 5; i += 1) {
      await logWebhook(ctx.db, {
        provider: 'fez',
        providerRef: `FEZ-${i}`,
        rawStatus: 'IN TRANSIT',
        verified: true,
        applied: 'applied',
        payload: { i },
        now: NOW + i,
      });
    }
    const rows = await listRecentWebhooks(ctx.db, 2);
    expect(rows.map((r) => r.providerRef)).toEqual(['FEZ-4', 'FEZ-3']);
  });

  it('stores a payload under the cap verbatim', async () => {
    await logWebhook(ctx.db, {
      provider: 'terminal',
      providerRef: 'TR-1',
      rawStatus: 'delivered',
      verified: true,
      applied: 'applied',
      payload: { event: 'shipment.delivered', data: { id: 'sh_1' } },
      now: NOW,
    });
    expect(await stored('TR-1')).toEqual({
      event: 'shipment.delivered',
      data: { id: 'sh_1' },
    });
  });

  it('replaces a payload over 16 KB with a marker rather than storing it', async () => {
    const big = { blob: 'x'.repeat(20_000) };
    await logWebhook(ctx.db, {
      provider: 'fez',
      providerRef: 'FEZ-BIG',
      rawStatus: 'DELIVERED',
      verified: true,
      applied: 'ignored',
      payload: big,
      now: NOW,
    });

    expect(await stored('FEZ-BIG')).toEqual({
      truncated: true,
      bytes: Buffer.byteLength(JSON.stringify(big)),
    });
    /* Everything BUT the payload survives the truncation — the log's whole job
     * is to say a courier's calls reach us, and that answer must not depend on
     * how chatty the courier was. */
    const rows = await listRecentWebhooks(ctx.db, 10);
    expect(rows[0]).toMatchObject({ provider: 'fez', providerRef: 'FEZ-BIG', applied: 'ignored' });
  });
});
