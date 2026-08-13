import { Hono } from 'hono';
import { z } from 'zod';
import { readJson, str } from '../../middleware/errors';
import { requireAuth, requireOwner } from '../../middleware/session';
import { currentDb, currentUser } from '../../app-env';
import { NotFoundError } from '../../repo/errors';
import { getSettings, patchSettings } from './repo';
import type { AppEnv } from '../../app-env';

/**
 * The cross-program settings — contract #19-20.
 *
 * READ BY ANY STAFF, WRITTEN ONLY BY THE OWNER (the frozen role matrix, spec
 * D12). The write is owner-only because these fields are the shop's money and its
 * vocabulary: the rate at which points become naira, the cap on how much of an
 * order they may pay, and the words every balance tile in the section renders in.
 * The read is not, because those same words are what a writer's screens are made
 * of — a reader who could not fetch them would render the currency word as
 * nothing at all.
 *
 * Guards attach PER ROUTE. See the note in `../programs/routes.ts`; the same
 * measurement applies, and this is the route whose 401 proves the whole subsystem
 * is mounted (`routes.test.ts`, deferred from task A2).
 *
 * THERE IS NO POST AND NO DELETE. The row is a CHECK-pinned singleton installed
 * by migration 0011 — a shop has one configuration, and a route that could create
 * or remove it would be a route that can leave the section with none.
 */
export const routes = new Hono<AppEnv>();

const auth = requireAuth();
const owner = requireOwner();

/** The columns are `integer`; past this is SQLSTATE 22003, i.e. a 500 for a
 *  number somebody typed. What a sensible rate is belongs to the owner. */
const INT4_MAX = 2_147_483_647;

const LABEL = str().trim().min(1).max(80);

const SettingsPatchBody = z
  .object({
    /** Required — see the note on the program patch. A settings screen that could
     *  save without one is two tabs quietly overwriting each other. */
    expectedRevision: z.number().int().min(1),
    pointsLabelSingular: LABEL.optional(),
    pointsLabelPlural: LABEL.optional(),
    redemptionEnabled: z.boolean().optional(),
    /** `> 0` in the column: zero points-per-anything is a division by zero in
     *  `quote()`. */
    redemptionRatePoints: z.number().int().min(1).max(INT4_MAX).optional(),
    redemptionRateMinor: z.number().int().min(0).max(INT4_MAX).optional(),
    /**
     * SHAPE-CHECKED HERE AND NOT ONLY IN THE COLUMN, the `PriceBody` precedent:
     * `str().length(3)` alone accepts `"ngn"`, which `money()` then refuses by
     * throwing a programming-error class with no row in the error table — a
     * measured 500 on the shop side for a lower-case currency code.
     */
    redemptionCurrency: str().regex(/^[A-Z]{3}$/, 'iso4217').optional(),
    minRedeemPoints: z.number().int().min(0).max(INT4_MAX).optional(),
    /** `BETWEEN 1 AND 10000` in the column. Zero would silently disable
     *  redemption through a field that does not say so. */
    maxRedeemBps: z.number().int().min(1).max(10_000).optional(),
    /** `null` clears it: a shop with no default program is a shop whose intake
     *  answers `409 program_paused`, which is a state, not a fault. */
    defaultReturnProgramId: str().min(1).max(200).nullable().optional(),
  })
  .strict();

routes.get('/settings', auth, async (c) => {
  const settings = await getSettings(currentDb(c));
  /*
   * UNREACHABLE THROUGH ANY ROUTE, and answered rather than invented anyway.
   * Migration 0011 seeds this row and nothing deletes it, so `null` here means a
   * hand-run DELETE or a database restored from before the migration. The
   * temptation is to return a default object — which would put the shop's points
   * words in server source, the one thing spec D2 makes impossible everywhere
   * else, and would hide a broken deployment behind a screen that looked fine.
   */
  if (settings === null) throw new NotFoundError('settings');
  return c.json({ settings });
});

routes.patch('/settings', owner, async (c) => {
  const { expectedRevision, ...patch } = await readJson(c, SettingsPatchBody);
  const settings = await patchSettings(currentDb(c), patch, {
    expectedRevision,
    actorId: currentUser(c).id,
    now: Date.now(),
  });
  return c.json({ settings });
});
