import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, readQuery, str } from '../../middleware/errors';
import { requireAuth, requireOwner } from '../../middleware/session';
import { currentDb, currentUser } from '../../app-env';
import {
  MAX_QUERY_LENGTH,
  adjust,
  foldEmail,
  getCustomerSummary,
  listCustomers,
  listLedger,
} from './repo';
import type { AppEnv } from '../../app-env';

/**
 * Customers, their balances and the points ledger — contract #15-18.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * READING IS `requireAuth`, ADJUSTING IS `requireOwner`, and that split is the
 * frozen role matrix (spec D12) rather than a preference. Staff processing
 * returns have to see a customer's balance — it is on the screen they inspect
 * from — while minting points out of nothing is the same class of act as
 * repricing a program: it costs the business money and nothing upstream vetted
 * it. The UI renders "Adjust balance…" as ABSENT for writers, so the 403 here is
 * the backstop for a raced role change, not the ordinary path.
 *
 * THE GUARDS ARE ATTACHED PER ROUTE, NEVER AS `routes.use('*', …)` — the long
 * version is in `../programs/routes.ts`. `app.route(prefix, router)` flattens a
 * router into its parent, so a blanket `use` would turn every unrouted path
 * under `/api/marketing` into a 401 instead of a 404.
 *
 * THE ADDRESS IS THE IDENTITY AND IT TRAVELS IN THE PATH (spec D10). There is
 * deliberately no lookup-by-customer-id endpoint: guest checkout is the default
 * path, most balances have no account behind them, and a second addressing
 * scheme would be a second answer to "whose points are these". The directory's
 * search matches customer ids so an admin can find a person by whatever they
 * have; every row it returns links by email.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const routes = new Hono<AppEnv>();

const auth = requireAuth();
const owner = requireOwner();

// ------------------------------------------------------------------ schemas

/** The columns are `integer`; past this is SQLSTATE 22003, i.e. a 500 for a
 *  number somebody typed. */
const INT4_MAX = 2_147_483_647;

const CustomerQuery = z
  .object({
    /** Contract #15 spells it `query`, not `q` — the returns queue's box filters
     *  a list of rows and this one searches for a person. Kept as the contract
     *  has it so one client helper cannot serve both by accident. */
    query: str().max(MAX_QUERY_LENGTH).optional(),
    cursor: str().optional(),
    /** `pageLimit` decides the range and answers 400 itself; this only makes a
     *  non-numeric `?limit=abc` a 400 here rather than a NaN there. */
    limit: z.coerce.number().int().optional(),
  })
  /* STRICT, like the bodies. A mistyped filter that is silently ignored is
   * worse than a refusal: `?querry=dara` would return the whole directory and
   * look like a bug in the search box. */
  .strict();

const LedgerQuery = z
  .object({
    /**
     * DEFAULTS TO `all`. Unlike the returns queue — whose screen opens on
     * `needs_action` and names its view on every request — this filter is a set
     * of tabs above a history, and the honest answer to "show me this
     * customer's ledger" is the whole of it.
     */
    kind: z.enum(['awards', 'manual', 'redemptions', 'all']).default('all'),
    cursor: str().optional(),
    limit: z.coerce.number().int().optional(),
  })
  .strict();

/**
 * Contract #18 — the manual adjustment.
 *
 * `delta` IS SIGNED AND THE ZERO IS REFUSED HERE AS WELL AS IN THE REPOSITORY.
 * The UI sends the sign from its Credit/Debit control, so a zero can only
 * arrive from a client that skipped the control — and `marketing_ledger_delta_ck`
 * would answer it with SQLSTATE 23514, which has no row in the error table and
 * becomes a 500 the client retries five times. Named in the schema it is an
 * inline error under the amount input, which is where the fix is.
 *
 * `reason` IS REQUIRED, and it is the only reason this row will ever have. An
 * award points at the return it paid for; this points at somebody's judgement.
 * The UI's preset Select prefills it and still cannot submit it empty.
 */
const AdjustBody = z
  .object({
    email: str().trim().min(1).max(MAX_QUERY_LENGTH),
    delta: z
      .number()
      .int()
      .min(-INT4_MAX)
      .max(INT4_MAX)
      .refine((value) => value !== 0, 'zero'),
    reason: str().trim().min(1).max(500),
    /** Optional: a manual adjustment belongs to no program unless the admin says
     *  it does (`marketing_ledger_award_sign_ck` only demands one for an award). */
    programId: str().min(1).max(200).optional(),
    /** The shop's id, when the screen knows one. TEXT, no FK (spec D10). */
    customerId: str().min(1).max(200).optional(),
  })
  .strict();

// ------------------------------------------------------------------- routes

/** Contract #15. Empty `query` is the "Recently active" list; a term searches
 *  the union of balance-holders and the shop's own customer directory. */
routes.get('/customers', auth, async (c) => {
  const q = readQuery(c, CustomerQuery);
  return c.json(await listCustomers(currentDb(c), q));
});

/**
 * Contract #16 — ZEROS FOR AN UNKNOWN ADDRESS, NEVER A 404.
 *
 * `foldEmail` normalises before the lookup, so `Dara@X` and `dara@x` are one
 * customer here exactly as they are one wallet in the database. It also refuses
 * an empty or over-long segment with a 400 on `email` rather than running a
 * query that can only miss.
 */
routes.get('/customers/:email', auth, async (c) => {
  const email = foldEmail(pathParam(c, 'email'));
  return c.json(await getCustomerSummary(currentDb(c), email));
});

/** Contract #17 — one customer's history, newest first. Append-only: there is
 *  no PATCH and no DELETE for a ledger row anywhere in this subsystem. */
routes.get('/customers/:email/ledger', auth, async (c) => {
  const email = foldEmail(pathParam(c, 'email'));
  const q = readQuery(c, LedgerQuery);
  return c.json(await listLedger(currentDb(c), email, q));
});

/**
 * Contract #18 — 201 with the entry AND the balance.
 *
 * BOTH, because the screen needs both and re-reading either would be a second
 * instant: the ledger list gains a row and the balance tile changes a number,
 * and a client that refetched the tile separately could render a total that
 * already includes somebody else's adjustment while its own row is still
 * missing. The balance is the counter's own value, read off the statement that
 * moved it.
 */
routes.post('/adjustments', owner, async (c) => {
  const body = await readJson(c, AdjustBody);
  const result = await adjust(currentDb(c), {
    ...body,
    /* WHO decided. `actor_id` is TEXT with no FK to `users` — the same choice
     * the timeline makes, so removing an account cannot make a customer's
     * history unreadable. */
    actorId: currentUser(c).id,
    now: Date.now(),
  });
  return c.json(result, 201);
});
