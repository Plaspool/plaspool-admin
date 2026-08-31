import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, readQuery, str } from '../../middleware/errors';
import { requireAuth } from '../../middleware/session';
import { currentDb } from '../../app-env';
import { createArea, listAreas, patchArea } from './repo';
import type { AppEnv } from '../../app-env';

/**
 * Service areas on the wire — contract #6.1 and #6.1b.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * READING IS `requireAuth`; EVERY WRITE IS `requireOwner`. This list decides
 * WHERE VANS GO, which is the same class of decision as a program's rate or the
 * redemption economics — the things the frozen role matrix (spec D12) reserves
 * for the owner. A writer processing returns needs to SEE the boards; switching
 * a district on commits the business to sending a driver there.
 *
 * THE GUARDS ARE ATTACHED PER ROUTE, never `routes.use('*', …)` — the rule
 * `../programs/routes.ts` states at length, and the reason `../app.ts` pins an
 * unrouted path as a 404 rather than a 401.
 *
 * THERE IS NO DELETE, and the absence is the design (plan §6.1b). An area that
 * has ever held a return is history; switching it off is the retirement, and the
 * database agrees — the foreign key has no `ON DELETE` clause, so removing one
 * with returns against it is refused at the bottom as well as unrouted at the
 * top.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const routes = new Hono<AppEnv>();

const auth = requireAuth();
const staff = requireAuth();

/** Long enough for the longest real place name several times over, short enough
 *  that a pasted document never reaches a region heading. */
const NAME = str().trim().min(1).max(120);
const REGION = str().trim().min(1).max(120);

/**
 * The spellings a person might type, as the owner enters them.
 *
 * BOUNDED BUT NOT SHAPED. The repository lower-cases, trims, de-duplicates and
 * drops any alias that folds onto the area's own name, because an owner typing
 * "Wuse 2" has said something correct and useful and answering with a validation
 * error about capital letters would be pedantry. The column's CHECK is the
 * backstop for anything that reaches it from somewhere other than this file.
 */
const ALIASES = z.array(str().trim().max(120)).max(40);

const AreasQuery = z
  .object({
    /**
     * `?active=true` is what the BOARD SWITCHER asks for; the Areas screen asks
     * for everything and groups by region itself.
     *
     * A LITERAL RATHER THAN A BOOLEAN COERCION. `z.coerce.boolean()` maps every
     * non-empty string to `true`, so `?active=false` would filter to the served
     * set — the exact opposite of what it says. One legal value, and the absence
     * of the parameter means everything.
     */
    active: z.literal('true').optional(),
  })
  .strict();

const CreateBody = z.object({ region: REGION, name: NAME, aliases: ALIASES.optional() }).strict();

/**
 * NOTE WHAT IS ABSENT: `key` and `seeded`.
 *
 * The key is the one stable handle an area has — the seed derives it from the
 * region and the name, and a rename must not move it — and `seeded` is a
 * statement about where the row came from rather than a property an edit may
 * rewrite. Neither is a guard that refuses them: `.strict()` 400s a body that
 * carries one, because the field does not exist. Two structural walls, the
 * `programs/routes.ts` arrangement.
 */
const PatchBody = z
  .object({
    expectedRevision: z.number().int().min(1),
    name: NAME.optional(),
    aliases: ALIASES.optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

/** Contract #6.1 — the switcher's rows, its badges and its out-of-area footer. */
routes.get('/areas', auth, async (c) => {
  const { active } = readQuery(c, AreasQuery);
  return c.json(await listAreas(currentDb(c), { activeOnly: active === 'true', now: Date.now() }));
});

/**
 * Contract #6.1b — an area an owner typed.
 *
 * The shipped dataset misspells real places and carries at least one entry that
 * is not where it says it is, so "add" is not a luxury: a pre-loaded list is a
 * starting point, and an owner must not need a developer to correct geography.
 * It is created INACTIVE, like every other area — switching it on is the
 * separate, deliberate act.
 */
routes.post('/areas', staff, async (c) => {
  const body = await readJson(c, CreateBody);
  const area = await createArea(currentDb(c), body, { now: Date.now() });
  return c.json({ area }, 201);
});

/** Contract #6.1b — rename, re-alias, reorder, and the Switch. CAS on
 *  `expectedRevision`; a lost race answers `stale_write` carrying the row that
 *  won, so the screen re-renders the truth without a second fetch (spec D7). */
routes.patch('/areas/:id', staff, async (c) => {
  const id = pathParam(c, 'id');
  const { expectedRevision, ...patch } = await readJson(c, PatchBody);
  const area = await patchArea(currentDb(c), id, patch, { expectedRevision, now: Date.now() });
  return c.json({ area });
});
