/**
 * The area resolver and the two guards that stand between an address and a
 * points award.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS BESIDE `routes.test.ts`, WHICH ALREADY DRIVES THE GATE.
 *
 * The gate is guarded TWICE and the two guards hide each other from a route
 * test. `requireServedArea` refuses an area that is switched off; the intake's
 * INSERT then re-selects that area `WHERE active`, closing the window between
 * the two. Delete either one and the route still answers `409
 * outside_service_area`, because the other catches it — so a suite that only
 * drove HTTP would watch a guard be deleted and stay green, which is the exact
 * defect the house rule about mutation-testing guards exists for.
 *
 * So each is pinned HERE, on its own, against the thing only it can do.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb } from '../../test/harness';
import { OutsideServiceAreaError } from '../errors';
import { createRequest } from '../returns/repo';
import { listAreas, requireServedArea, resolveArea, servedNames } from './repo';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';

let db: Db;
let close: () => Promise<void>;

const T0 = 1786600001000;
const NOW = T0 + 60_000;
const PROGRAM = 'prg_caps';
const REGION = 'Farflung Province';
const SERVED = 'area_cabbage_quarter';
const OFF = 'area_distant_marsh';

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});
afterAll(() => close());

beforeEach(async () => {
  await db.execute(sql`TRUNCATE marketing_return_requests, marketing_return_events,
                                marketing_ledger, marketing_balances,
                                marketing_email_intents CASCADE`);
  await db.execute(sql`DELETE FROM marketing_service_areas WHERE seeded = false`);
  await db.execute(sql`DELETE FROM marketing_programs WHERE seeded = false`);
  await db.execute(sql`
    INSERT INTO marketing_programs
      (id, key, kind, name, points_label_singular, points_label_plural,
       unit_label_singular, unit_label_plural, min_units_per_return, points_per_unit,
       created_at, updated_at)
    VALUES (${PROGRAM}, 'bottle-caps', 'unit_return', 'Cap Returns', 'Bottle Cap',
            'Bottle Caps', 'canister', 'canisters', 4, 7, ${T0}, ${T0})`);
});

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
  await db.execute(sql`
    INSERT INTO marketing_service_areas
      (id, key, region, name, aliases, active, seeded, sort_order, created_at, updated_at)
    VALUES (${id}, ${id.replace(/^area_/, '').replace(/_/g, '-')}, ${region}, ${name},
            ${array}, ${active}, false, 0, ${T0}, ${T0})`);
}

const intake = (serviceAreaId?: string, email = 'dara@example.test') => ({
  email,
  qtyDeclared: 6,
  programId: PROGRAM,
  source: 'admin' as const,
  now: NOW,
  serviceAreaId,
});

describe('resolveArea — the picker sends an id, a person sends a spelling', () => {
  it('finds a row by id, by key, by name and by alias', async () => {
    await makeArea(SERVED, 'Cabbage Quarter', true, ['cabbage 2']);
    for (const token of [
      SERVED,
      'cabbage-quarter',
      'Cabbage Quarter',
      'CABBAGEQUARTER',
      '  cabbage quarter ',
      'cabbage 2',
      'Cabbage2',
    ]) {
      expect((await resolveArea(db, token))?.id, token).toBe(SERVED);
    }
  });

  it('answers null for a token that names nothing', async () => {
    await makeArea(SERVED, 'Cabbage Quarter', true);
    for (const token of ['', '   ', 'atlantis', 'area_nowhere']) {
      expect(await resolveArea(db, token), token).toBeNull();
    }
  });

  it('RESOLVES a switched-off area rather than pretending it is not there', async () => {
    /*
     * The caller needs to tell "there is no such place" from "we do not go there
     * yet". Both refuse the return, but only one of them is somewhere an owner
     * can switch on this afternoon — and a resolver that hid inactive rows would
     * make the Areas screen the only way to discover that.
     */
    await makeArea(OFF, 'Distant Marsh', false);
    const area = await resolveArea(db, 'distant marsh');
    expect(area?.id).toBe(OFF);
    expect(area?.active).toBe(false);
  });

  it('prefers the SERVED one when a name means two places', async () => {
    await makeArea(SERVED, 'Turnip Hill', true);
    await makeArea(OFF, 'Turnip Hill', false, [], 'Nearby Province');
    expect((await resolveArea(db, 'turnip hill'))?.id).toBe(SERVED);
    // …and the losing row is still reachable by the handles that are unique.
    expect((await resolveArea(db, OFF))?.id).toBe(OFF);
  });
});

describe('requireServedArea — GUARD ONE', () => {
  it('REFUSES AN AREA THAT EXISTS AND IS SWITCHED OFF', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE MUTATION: drop `|| !area.active`. Every route test stays green,
     * because the intake's INSERT catches it a layer down — and the business
     * quietly starts accepting returns for places it has no driver for whenever
     * that second guard is refactored. This is the test that goes red.
     * ═══════════════════════════════════════════════════════════════════════
     */
    await makeArea(SERVED, 'Cabbage Quarter', true);
    await makeArea(OFF, 'Distant Marsh', false);

    await expect(requireServedArea(db, OFF)).rejects.toBeInstanceOf(OutsideServiceAreaError);
    await expect(requireServedArea(db, 'atlantis')).rejects.toBeInstanceOf(
      OutsideServiceAreaError,
    );
    expect((await requireServedArea(db, SERVED)).id).toBe(SERVED);
  });

  it('names the served places on the refusal, and never the unserved one', async () => {
    await makeArea(SERVED, 'Cabbage Quarter', true);
    await makeArea(OFF, 'Distant Marsh', false);
    const err = await requireServedArea(db, OFF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutsideServiceAreaError);
    expect((err as OutsideServiceAreaError).served).toContain('Cabbage Quarter');
    expect((err as OutsideServiceAreaError).served).not.toContain('Distant Marsh');
  });

  it('reads the served list live, so switching one off changes the sentence', async () => {
    await makeArea(SERVED, 'Cabbage Quarter', true);
    expect(await servedNames(db)).toContain('Cabbage Quarter');
    await db.execute(sql`UPDATE marketing_service_areas SET active = false WHERE id = ${SERVED}`);
    expect(await servedNames(db)).not.toContain('Cabbage Quarter');
  });
});

describe('the intake INSERT’s own predicate — GUARD TWO', () => {
  it('WRITES NOTHING when the board is retired between the resolve and the write', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE RACE GUARD ONE CANNOT CLOSE, and the only way to observe it.
     *
     * `requireServedArea` reads the flag; the INSERT happens afterwards. In
     * between, an owner can switch the district off — and a booked pickup for a
     * district with no driver is exactly what this whole feature exists to
     * prevent. So the INSERT re-selects the area `WHERE a.active`, and a
     * retirement in the window makes it write nothing at all.
     *
     * DRIVEN WITH A DATABASE HANDLE THAT PERFORMS THE RETIREMENT, because a
     * genuine interleaving is not something a test can schedule. The proxy
     * switches the area off immediately before the statement that inserts the
     * return — which is precisely the instant the race would land in.
     *
     * THE MUTATION: drop `AND a.active` from the INSERT's SELECT. This goes red;
     * nothing else does.
     * ═══════════════════════════════════════════════════════════════════════
     */
    await makeArea(SERVED, 'Cabbage Quarter', true);

    let retired = false;
    const racing = {
      ...db,
      execute: async (statement: SQL) => {
        /* `db.execute` is what every repository call goes through, so the proxy
         * has to recognise the ONE statement it means to race — the insert —
         * rather than firing on the resolver's own reads. */
        const text = JSON.stringify(statement);
        if (!retired && text.includes('INSERT INTO marketing_return_requests')) {
          retired = true;
          await db.execute(sql`
            UPDATE marketing_service_areas SET active = false WHERE id = ${SERVED}`);
        }
        return db.execute(statement);
      },
    } as unknown as Db;

    await expect(createRequest(racing, intake(SERVED))).rejects.toBeInstanceOf(
      OutsideServiceAreaError,
    );
    expect(retired, 'the proxy never saw the insert — the guard was not exercised').toBe(true);

    /* AND NOTHING WAS WRITTEN. The chained CTEs mean a zero-row insert also
     * writes no timeline entry, so the failure leaves no half-created return
     * behind for somebody to find later and wonder about. */
    const rows = await db.execute(sql`SELECT count(*)::int AS n FROM marketing_return_requests`);
    expect(Number(rows.rows[0].n)).toBe(0);
    const events = await db.execute(sql`SELECT count(*)::int AS n FROM marketing_return_events`);
    expect(Number(events.rows[0].n)).toBe(0);
  });

  it('writes the area onto the row when the board is still running', async () => {
    await makeArea(SERVED, 'Cabbage Quarter', true);
    const row = await createRequest(db, intake(SERVED));
    expect(row.serviceAreaId).toBe(SERVED);
  });

  it('writes NULL, and no error, when the admin names no area at all', async () => {
    // A phone-in from out of town is a real request. The database is what stops
    // it ever paying, not the intake.
    const row = await createRequest(db, intake(undefined));
    expect(row.serviceAreaId).toBeNull();
  });
});

describe('listAreas — the switcher’s numbers', () => {
  it('measures every age from ONE clock reading', async () => {
    /*
     * `now` is passed in rather than read per row, so two areas whose oldest
     * returns arrived in the same millisecond cannot report ages that differ by
     * the time the loop took.
     */
    await makeArea(SERVED, 'Cabbage Quarter', true);
    await db.execute(sql`
      INSERT INTO marketing_return_requests
        (id, program_id, customer_email, qty_declared, points_per_unit_snapshot,
         source, status, service_area_id, created_at, updated_at)
      VALUES ('ret_a', ${PROGRAM}, 'a@example.test', 6, 7, 'admin', 'requested',
              ${SERVED}, ${NOW - 5_000}, ${NOW})`);

    const view = await listAreas(db, { now: NOW });
    const area = view.areas.find((a) => a.id === SERVED);
    expect(area?.oldestAgeMs).toBe(5_000);
  });

  it('never reports a negative age, whatever the clocks say', async () => {
    /* A row stamped a moment into the future — two machines, an import — would
     * otherwise render as a negative duration, which every formatter in the
     * client turns into nonsense. */
    await makeArea(SERVED, 'Cabbage Quarter', true);
    await db.execute(sql`
      INSERT INTO marketing_return_requests
        (id, program_id, customer_email, qty_declared, points_per_unit_snapshot,
         source, status, service_area_id, created_at, updated_at)
      VALUES ('ret_future', ${PROGRAM}, 'b@example.test', 6, 7, 'admin', 'requested',
              ${SERVED}, ${NOW + 10_000}, ${NOW})`);

    const view = await listAreas(db, { now: NOW });
    expect(view.areas.find((a) => a.id === SERVED)?.oldestAgeMs).toBe(0);
  });
});
