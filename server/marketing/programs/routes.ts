import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, str } from '../../middleware/errors';
import { requireAuth } from '../../middleware/session';
import { currentDb, currentUser } from '../../app-env';
import { createProgram, listPrograms, patchProgram } from './repo';
import type { AppEnv } from '../../app-env';

/**
 * Programs' HTTP surface — contract #1-3.
 *
 * MOUNTED INTO `marketingApp()`, which `server/index.ts` mounts at
 * `/api/marketing` in turn. Reading the list is `requireAuth()` and both writes
 * are `requireOwner()`, per the frozen role matrix (spec D12): a program is
 * configuration — the words on every customer email and the rate the business
 * pays — while a writer processing returns still has to see which programs exist
 * and what they are called. The UI renders owner-only controls as ABSENT rather
 * than disabled, so the 403 here is the backstop for a raced role change, not the
 * ordinary path.
 *
 * THE GUARDS ARE ATTACHED PER ROUTE, NEVER AS `routes.use('*', …)`.
 * `app.route(prefix, router)` flattens a router into its parent, so a blanket
 * `use` would apply to every path under `/api/marketing` — including ones no file
 * has ever heard of — and turn an unrouted path into a 401 instead of a 404: the
 * guard runs, finds no session, and refuses a request that had no handler to
 * reach. `server/shop/catalog/routes.ts` records the measurement on the blog side.
 *
 * EVERY STRING FIELD USES `str()`, NOT `z.string()`. A U+0000 in a `text` bind is
 * SQLSTATE 22021, which has no row in the error table and answers 500 — a status
 * the client retries five times for input that can never be accepted.
 * `server/nul-bytes.test.ts` walks every registered route and fails if a NUL in a
 * path segment or a string body field produces a 5xx.
 */
export const routes = new Hono<AppEnv>();

const auth = requireAuth();
const staff = requireAuth();

// ------------------------------------------------------------------ schemas

/**
 * The ceiling is the COLUMN's, not a business rule.
 *
 * `min_units_per_return`, `points_per_unit` and their siblings are `integer`, and
 * a value past this is SQLSTATE 22003 — a 500 for a number somebody typed. What
 * a sensible minimum or rate actually is belongs to the owner and is edited in
 * the UI on day one, so the server refuses only what the storage cannot hold.
 */
const INT4_MAX = 2_147_483_647;

/**
 * The stable handle, and the ONLY field on a program that cannot be changed
 * afterwards (spec D2a).
 *
 * THE REGEX MIRRORS `marketing_programs_key_ck` INSTEAD OF NORMALISING. Contract
 * #25 has the server upper-case a discount code before storing it; this does the
 * opposite and refuses, because the two fields are not the same kind of thing. A
 * discount code is typed by a customer at checkout in whatever case they like. A
 * program key is chosen once, by an owner, at a create form that shows the format
 * as a hint — and silently rewriting it there would mean the handle they were
 * shown is not the handle they got, on the one value nothing can ever rename.
 */
const KEY = str().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/, 'key');

/**
 * A word a customer will read. Trimmed rather than refused for surrounding
 * space — `marketing_programs_name_ck` requires `name = btrim(name)`, so " Caps "
 * is otherwise a CHECK violation and therefore a 500 for a stray keystroke — and
 * `.min(1)` AFTER the trim, so a field of spaces is the empty field it actually
 * is rather than a label that renders as nothing.
 */
const NAME = str().trim().min(1).max(200);
const LABEL = str().trim().min(1).max(80);
const COUNT = z.number().int().min(1).max(INT4_MAX);

const CommonFields = {
  key: KEY,
  name: NAME,
  pointsLabelSingular: LABEL,
  pointsLabelPlural: LABEL,
};

/**
 * "Unit fields required iff `kind = 'unit_return'`" (contract #2) AS A SHAPE
 * RATHER THAN AS A CHECK.
 *
 * A discriminated union makes both halves of the rule structural: the
 * `unit_return` branch requires the four rule fields and the `adhoc` branch has
 * no such keys at all, so `.strict()` refuses them. Written as a `superRefine`
 * over one wide object, the second half is the half that gets forgotten —
 * accepted-and-ignored, leaving the caller believing it set a word that the row
 * does not have and that `marketing_programs_kind_fields_ck` would have refused
 * anyway, as a 500.
 *
 * Both branches report the offending field in `detail`, which is what the
 * catalogue's `bad_request` treatment needs: an inline error keyed by field, with
 * the focus moved to that input.
 */
/**
 * A money rate on a programme, MINOR UNITS.
 *
 * `min(0)` and not `min(1)`, unlike `COUNT`: a programme that pays nothing in
 * money is a real arrangement — the reward is the points — while a programme
 * awarding zero points is a programme that does nothing at all.
 */
const MONEY = z.number().int().min(0).max(2_147_483_647);

const CreateProgramBody = z.discriminatedUnion('kind', [
  z
    .object({
      ...CommonFields,
      kind: z.literal('unit_return'),
      unitLabelSingular: LABEL,
      unitLabelPlural: LABEL,
      minUnitsPerReturn: COUNT,
      pointsPerUnit: COUNT,
      /* OPTIONAL, unlike the points rate beside them: a programme is complete
       * without a money rate — it just cannot be costed until one is set, and
       * the analytics screen says exactly that rather than inventing a zero. */
      unitCostMinor: MONEY.optional(),
      unitMarketCostMinor: MONEY.optional(),
    })
    .strict(),
  z
    .object({
      ...CommonFields,
      kind: z.literal('adhoc'),
    })
    .strict(),
]);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RENAME-SAFETY WALL, AND IT IS AN ABSENCE RATHER THAN A RULE.
 *
 * There is no `key` field here and no `kind` field, so `.strict()` answers 400
 * `bad_request` detail `key` to any body that carries one. That is the whole of
 * spec D2a's "structurally un-editable": nothing tests a flag, nothing consults a
 * list of protected fields, and there is no line to delete. Every ledger row,
 * every return request and the settings' default pointer hang off the identity
 * this refuses to move.
 *
 * `conditions`, `seeded` and `revision` are absent for the same reason. `seeded`
 * is the sharpest: it is the sole input to the "Seeded preset" chip, so a
 * settable one is a badge anybody can mint.
 *
 * `routes.test.ts` pins this by asserting the 400 — which is exactly the
 * assertion that goes red if the `.strict()` is ever dropped, because a widened
 * schema does not fail loudly, it accepts the body and silently ignores the
 * field while telling the caller 200.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const ProgramPatchBody = z
  .object({
    /**
     * REQUIRED, unlike the blog's optional `baseRevision`. Every screen that
     * edits a program has read one first, and without the token a second tab
     * silently overwrites the first — the failure the revision column exists to
     * prevent.
     */
    expectedRevision: z.number().int().min(1),
    name: NAME.optional(),
    pointsLabelSingular: LABEL.optional(),
    pointsLabelPlural: LABEL.optional(),
    unitLabelSingular: LABEL.optional(),
    unitLabelPlural: LABEL.optional(),
    minUnitsPerReturn: COUNT.optional(),
    pointsPerUnit: COUNT.optional(),
    /**
     * THE TWO MONEY RATES (0920), and they are OWNER-ONLY by virtue of being
     * on this route: `patchProgram` is already the owner's, because changing
     * what a return is WORTH is the thing spec D12 reserves. Recording what a
     * van cost is anybody's and lives on the return instead.
     *
     * `min(0)` and not `min(1)`, unlike `COUNT` above: a programme that pays
     * nothing in money is a real arrangement — the reward is the points — and
     * `null` clears the rate back to "we have not decided", which is a
     * different claim from zero and the only way to undo a mistyped figure.
     */
    unitCostMinor: MONEY.nullable().optional(),
    unitMarketCostMinor: MONEY.nullable().optional(),
    status: z.enum(['active', 'paused']).optional(),
  })
  .strict();

// ------------------------------------------------------------------- routes

routes.get('/programs', auth, async (c) => {
  const programs = await listPrograms(currentDb(c));
  return c.json({ programs });
});

routes.post('/programs', staff, async (c) => {
  const draft = await readJson(c, CreateProgramBody);
  const program = await createProgram(currentDb(c), draft, {
    actorId: currentUser(c).id,
    now: Date.now(),
  });
  return c.json({ program }, 201);
});

routes.patch('/programs/:id', staff, async (c) => {
  const id = pathParam(c, 'id');
  const { expectedRevision, ...patch } = await readJson(c, ProgramPatchBody);
  const program = await patchProgram(currentDb(c), id, patch, {
    expectedRevision,
    actorId: currentUser(c).id,
    now: Date.now(),
  });
  return c.json({ program });
});
