import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, str } from '../../middleware/errors';
import { requireAuth } from '../../middleware/session';
import { currentDb, currentUser } from '../../app-env';
import { createDiscount, listDiscounts, patchDiscount } from './repo';
import type { AppEnv } from '../../app-env';

/**
 * Discount codes on the wire — contract #24-26.
 *
 * READ BY ANY STAFF, WRITTEN ONLY BY THE OWNER, per the frozen role matrix
 * (spec D12). A discount is money: it changes what an order costs, permanently,
 * for everybody who types it. That puts it beside the program rates and the
 * redemption economics rather than beside the banners, which any writer may
 * publish because they are words on a page. The read is not owner-gated because
 * the codes are also a list a writer answering "is SUMMER still on?" needs to
 * see.
 *
 * THE GUARDS ARE ATTACHED PER ROUTE, NEVER AS `routes.use('*', …)`. The long
 * version is in `../programs/routes.ts`: `app.route(prefix, router)` flattens a
 * router into its parent, so a blanket guard would apply to every path under
 * `/api/marketing` including ones no file has heard of, and would turn an
 * unrouted path into a 401 instead of a 404.
 *
 * NOTHING REDEEMS THESE YET. `computeTotals` never sees a discount row in v1 and
 * the Discounts screen is an honest placeholder (spec D1) — this is the model
 * landing ahead of the surface, so that when the surface arrives the shape it
 * needs already has rows in it and a migration is not the first step.
 *
 * EVERY STRING FIELD USES `str()`, NOT `z.string()`: a U+0000 in a `text` bind
 * is SQLSTATE 22021, which has no row in the error table and answers 500 for
 * input that can never be accepted. `server/nul-bytes.test.ts` walks every
 * registered route and fails if a NUL in a path segment or a string body field
 * produces a 5xx.
 */
export const routes = new Hono<AppEnv>();

const auth = requireAuth();
const staff = requireAuth();

// ------------------------------------------------------------------ schemas

/** `amount_minor` and `max_redemptions` are `integer`; past this is SQLSTATE
 *  22003, i.e. a 500 for a number somebody typed. The ceiling is the COLUMN's,
 *  not a business rule — what a sensible cap is belongs to the owner. */
const INT4_MAX = 2_147_483_647;

/** The largest instant a JavaScript `Date` can hold. Not about overflow — the
 *  columns are `bigint` — but about a campaign scheduled for the year 300 000
 *  rendering as `Invalid Date` in the editor and the list at once, with nothing
 *  on the wire to say which side got it wrong. (`banners/routes.ts`, same.) */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CODE, NORMALISED BEFORE IT IS VALIDATED — contract #25, and the order of
 * those two words is the whole of it.
 *
 * `.trim().toUpperCase()` are ZodString transforms and run in declaration order,
 * BEFORE the `.regex()` below. So `" save10 "` becomes `SAVE10` and is then
 * measured against the same pattern `marketing_discount_codes_code_ck` holds —
 * which means a lower-case code is ACCEPTED and stored upper, rather than
 * refused with a message about capital letters.
 *
 * That is the opposite of what `../programs/routes.ts` does to a program key,
 * and the difference is who types the value. A key is chosen once, by an owner,
 * at a form that shows the format as a hint, and silently rewriting it there
 * would mean the handle they were shown is not the handle they got. A discount
 * code is typed by a CUSTOMER at a checkout box, in whatever case their phone
 * decided on — so `save10` and `SAVE10` must be one row, or half the people
 * holding the flyer are told their code does not exist.
 *
 * Uppercasing first is also what makes the uniqueness real: the collision is
 * caught by `marketing_discount_codes_code_uq` on the normalised value and
 * rendered `409 duplicate_code`, instead of two rows that differ only in case.
 *
 * THE PATTERN IS THE COLUMN'S, mirrored rather than trusted: unrendered it is
 * SQLSTATE 23514, a 500 for a code with a space in it. `{2,31}` after the first
 * character is 3..32 in total — long enough to be memorable, short enough to be
 * read out over a phone.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const CODE = str()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{2,31}$/, 'code');

/** Epoch ms, nullable both ways: an empty start means "as soon as it is active"
 *  and an empty end means "until somebody turns it off". */
const WHEN = z.number().int().min(0).max(MAX_EPOCH_MS).nullable().optional();

/** `BETWEEN 1 AND 10000` in the column. Zero would be a discount that discounts
 *  nothing, and 10001 is more than the order is worth. */
const PERCENT_BPS = z.number().int().min(1).max(10_000);

/** `> 0` in the column, and minor units — 500 kobo, not ₦5. The whole
 *  application counts money in minor units (`shared/commerce/money.ts`); a
 *  major-unit field here would be the one place it did not. */
const AMOUNT_MINOR = z.number().int().min(1).max(INT4_MAX);

/**
 * SHAPE-CHECKED HERE AND NOT ONLY IN THE COLUMN, the `PriceBody` precedent that
 * `../settings/routes.ts` also follows: `str().length(3)` alone accepts `"ngn"`,
 * which `money()` then refuses by throwing a programming-error class with no row
 * in the error table — a measured 500 on the shop side for a lower-case currency
 * code.
 */
const CURRENCY = str().regex(/^[A-Z]{3}$/, 'iso4217');

/** Null means unlimited; `> 0` in the column, because a cap of zero is a code
 *  that exists and can never be used. */
const MAX_REDEMPTIONS = z.number().int().min(1).max(INT4_MAX).nullable().optional();

/**
 * An internal note — never shown to a customer — where BLANK MEANS "CLEAR IT".
 *
 * The three states are real and different: `undefined` (absent) leaves the
 * stored value alone, `null` clears it, and a string sets it. A controlled React
 * textarea posts `""` rather than nothing when an admin empties it, so without
 * this normalisation "I deleted the note" would be stored as an empty note —
 * a row that reads as having one until you open it. (`banners/routes.ts`
 * reached the same arrangement for the CTA pair.)
 */
const NOTE = str()
  .trim()
  .max(2000)
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional();

/** The fields both kinds share, so the union below differs only where it
 *  should — in what a code is worth. */
const CommonFields = {
  code: CODE,
  startsAt: WHEN,
  endsAt: WHEN,
  maxRedemptions: MAX_REDEMPTIONS,
  note: NOTE,
};

/**
 * Contract #25 — "kind couplings" (spec §Database 9) AS A SHAPE RATHER THAN AS
 * A CHECK.
 *
 * A discriminated union makes both halves of the rule structural: the `percent`
 * branch requires `percentBps` and has no `amountMinor` or `currency` keys at
 * all, so `.strict()` refuses them, and the `fixed_amount` branch is the mirror.
 * Written as a `superRefine` over one wide object the second half is the half
 * that gets forgotten — accepted-and-ignored, leaving the caller believing it
 * priced a discount two ways when `marketing_discount_codes_kind_fields_ck`
 * would have refused the row anyway, as a 500. `../programs/routes.ts` states
 * the same argument about unit fields; this is the same rule one column wider.
 *
 * NOTE WHAT IS ABSENT: `status`. The column defaults to `active` — a code does
 * nothing until somebody types it, unlike a banner, which is why banners are
 * created `draft` and these are not (`repo.ts#createDiscount` records the
 * difference). `redeemedCount` is absent for a sharper reason: it counts
 * promises already kept, so a settable one is a history anybody can invent.
 */
const CreateDiscountBody = z.discriminatedUnion('kind', [
  z
    .object({
      ...CommonFields,
      kind: z.literal('percent'),
      percentBps: PERCENT_BPS,
    })
    .strict(),
  z
    .object({
      ...CommonFields,
      kind: z.literal('fixed_amount'),
      amountMinor: AMOUNT_MINOR,
      /** REQUIRED beside the amount, not optional: "500 off" is not a price
       *  until it says 500 of what, and the column's CHECK ties the two
       *  together. */
      currency: CURRENCY,
    })
    .strict(),
]);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE IMMUTABILITY WALL, AND IT IS AN ABSENCE RATHER THAN A RULE.
 *
 * There is no `code` field here, no `kind`, no `percentBps`, no `amountMinor`
 * and no `currency` — so `.strict()` answers 400 `bad_request` naming whichever
 * one a body carries. That is the whole of it: nothing tests a flag, nothing
 * consults a list of protected fields, and there is no line to delete. A code
 * is printed on a flyer and read out on a podcast; every copy of it is a promise
 * made in the past tense, and a route that could turn 20% into 5% would let the
 * shop rewrite a promise it already made. To change what a code is worth you
 * disable it and create another, and the two rows say what each was worth.
 *
 * `redeemedCount` and `revision` are absent for the same reason — the first is
 * a count of promises kept and the second is the CAS token rather than a field.
 *
 * `routes.test.ts` pins this by asserting the 400 for each of the five, which is
 * exactly the assertion that goes red if the `.strict()` is ever dropped: a
 * widened schema does not fail loudly, it accepts the body and silently ignores
 * the field while telling the caller 200.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const DiscountPatchBody = z
  .object({
    /**
     * REQUIRED, unlike the blog's optional `baseRevision`. Every screen that
     * edits a code has read one first, and without the token a second tab
     * silently overwrites the first — the failure the revision column exists to
     * prevent.
     */
    expectedRevision: z.number().int().min(1),
    /** The honest way to stop a campaign: the customer is told the code has
     *  expired, rather than told it is worth less than the flyer said. */
    status: z.enum(['active', 'disabled']).optional(),
    startsAt: WHEN,
    endsAt: WHEN,
    maxRedemptions: MAX_REDEMPTIONS,
    note: NOTE,
  })
  .strict();

// ------------------------------------------------------------------- routes

routes.get('/discounts', auth, async (c) => {
  const discounts = await listDiscounts(currentDb(c));
  return c.json({ discounts });
});

routes.post('/discounts', staff, async (c) => {
  const draft = await readJson(c, CreateDiscountBody);
  const discount = await createDiscount(currentDb(c), draft, {
    actorId: currentUser(c).id,
    /* `Date.now()` at the route, like every other write in this subsystem: the
     * repository takes the instant as an argument so a test can name it. */
    now: Date.now(),
  });
  return c.json({ discount }, 201);
});

routes.patch('/discounts/:id', staff, async (c) => {
  const id = pathParam(c, 'id');
  const { expectedRevision, ...patch } = await readJson(c, DiscountPatchBody);
  const discount = await patchDiscount(currentDb(c), id, patch, {
    expectedRevision,
    actorId: currentUser(c).id,
    now: Date.now(),
  });
  return c.json({ discount });
});
