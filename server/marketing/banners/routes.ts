import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, str } from '../../middleware/errors';
import { requireAuth } from '../../middleware/session';
import { currentDb, currentUser } from '../../app-env';
import { createBanner, listBanners, patchBanner } from './repo';
import type { AppEnv } from '../../app-env';

/**
 * Banners on the wire — contract #21-23.
 *
 * EVERY ROUTE IS `requireAuth`, INCLUDING THE ONE THAT PUBLISHES. The frozen
 * role matrix (spec D12) files banner work under content rather than under
 * configuration — the posts precedent, where a writer writes and publishes —
 * and reserves `requireOwner` for the things that change what the business PAYS:
 * program rates, redemption economics, manual adjustments. A banner is words on
 * a page that any staff member may already write elsewhere in this application.
 *
 * THE GUARDS ARE ATTACHED PER ROUTE, NEVER AS `routes.use('*', …)` — the long
 * version is in `../programs/routes.ts`. `app.route(prefix, router)` flattens a
 * router into its parent, so a blanket guard would apply to every path under
 * `/api/marketing` including ones no file has heard of, and would turn an
 * unrouted path into a 401 instead of a 404.
 *
 * THE PUBLIC HALF IS NOT HERE. `GET /api/public/marketing/banners` lives in
 * `../public.ts`, mounted ABOVE `sessionMiddleware` so it cannot read a cookie
 * and its `Cache-Control: public` is therefore safe by construction (spec D8).
 * The two surfaces share `./repo.ts` and nothing else.
 *
 * EVERY STRING FIELD USES `str()`, NOT `z.string()`: a U+0000 in a `text` bind
 * is SQLSTATE 22021, which has no row in the error table and answers 500 for
 * input that can never be accepted. `server/nul-bytes.test.ts` walks every
 * registered route and fails if a NUL in a path segment or a string body field
 * produces a 5xx.
 */
export const routes = new Hono<AppEnv>();

const auth = requireAuth();

// ------------------------------------------------------------------ schemas

/** `priority` is `integer`; past this is SQLSTATE 22003, i.e. a 500 for a
 *  number somebody typed. The ceiling is the COLUMN's, not a business rule. */
const INT4_MAX = 2_147_483_647;

/**
 * The largest instant a JavaScript `Date` can hold.
 *
 * The columns are `bigint` and could hold far more, so this is not about
 * overflow: it is about a campaign scheduled for the year 300 000 rendering as
 * `Invalid Date` in the editor, the list and the preview at once, with nothing
 * on the wire to say which side got it wrong.
 */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/**
 * Trimmed rather than refused for surrounding space — `marketing_banners_title_ck`
 * requires `title = btrim(title)`, so " Sale " is otherwise a CHECK violation and
 * therefore a 500 for a stray keystroke — and `.min(1)` AFTER the trim, so a
 * field of spaces is the empty field it actually is rather than a heading that
 * renders as nothing on the storefront.
 */
const TITLE = str().trim().min(1).max(200);

/** OPTIONAL BY VALUE, not by absence: `''` is the column's own default and a
 *  banner that is a headline and nothing else is an ordinary banner. */
const BODY = str().trim().max(2000);

/**
 * An optional field where BLANK MEANS "CLEAR IT", not "an empty value".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE STATES ARE REAL AND DIFFERENT. `undefined` (absent) leaves the
 * stored value alone, `null` clears it, and a string sets it — which is what
 * lets an editor remove an end date to extend a campaign indefinitely, or drop
 * a CTA to turn a button back into a sentence.
 *
 * The blank normalisation is what makes the pair rule survive an empty form.
 * `ctaText` and `ctaUrl` are two inputs an admin who wants no button simply
 * leaves alone, and a controlled React input posts `""` rather than nothing —
 * so without this, "no CTA at all" arrives as two empty strings, fails
 * `.min(1)`, and returns a field error for a field nobody touched. Normalised,
 * the empty pair is the absent pair and `assertCoherent` never sees it.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function blankToNull(max: number) {
  return str()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();
}

const CTA_TEXT = blankToNull(120);

/**
 * THE SCHEME LIST IS A SECURITY CONSTRAINT, not tidiness, and it mirrors
 * `marketing_banners_cta_url_ck` rather than trusting it.
 *
 * This value is served by a cookieless public endpoint and rendered into an
 * anchor on the storefront, so a `javascript:` destination here is stored XSS
 * with a publish button in front of it. The CHECK says the same thing in the
 * database — but unrendered it is SQLSTATE 23514, which has no row in the error
 * table and answers 500 for a URL a human typed. Mirrored here it is an inline
 * field error saying which link shapes are allowed.
 *
 * A leading `/` is admitted because the storefront's own paths are the common
 * case ("/shop/sale"), and it cannot name a scheme at all.
 */
const CTA_URL = str()
  .trim()
  /*
   * `^$` IS THE FIRST ALTERNATIVE AND IT IS LOAD-BEARING. A `ZodString`'s checks
   * run before the transform below, so a blank input — what an editor sends for
   * "no CTA at all" — would otherwise be refused HERE, by the scheme rule, and
   * an admin who never wanted a button would be told their link is not a full
   * https:// one. Empty passes the shape check and becomes `null` a line later;
   * `assertCoherent` then sees an absent pair rather than half of one.
   */
  .regex(/^$|^(https?:\/\/|\/)/, 'ctaUrl')
  .max(2000)
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional();

const PLACEMENT = z.enum(['top_bar', 'popup', 'section']);

/** Highest wins within a placement, and NEGATIVE IS LEGAL: "show this one last"
 *  is a real thing to want and the column has no CHECK forbidding it. */
const PRIORITY = z.number().int().min(-INT4_MAX).max(INT4_MAX);

/** Epoch ms, nullable both ways: an empty start means "immediately" and an
 *  empty end means "until somebody turns it off" (spec §UI Banners). */
const WHEN = z.number().int().min(0).max(MAX_EPOCH_MS).nullable().optional();

/**
 * Contract #22. NOTE WHAT IS ABSENT: `status`.
 *
 * Every banner is created a draft — the column's default — and switched on by
 * the PATCH below. The editor's whole shape assumes it (write it, look at the
 * preview, then flip the Switch), and a create that could name a status would be
 * one request away from publishing an unreviewed banner to every visitor.
 */
const CreateBannerBody = z
  .object({
    title: TITLE,
    body: BODY.optional(),
    ctaText: CTA_TEXT,
    ctaUrl: CTA_URL,
    placement: PLACEMENT,
    startsAt: WHEN,
    endsAt: WHEN,
    priority: PRIORITY.optional(),
  })
  .strict();

/**
 * Contract #23 — including the archive, which is a status and not a DELETE.
 *
 * THE CROSS-FIELD RULES ARE NOT IN THIS SCHEMA and that is deliberate: the pair
 * rule and the window rule are about the row as it will BE, and on a patch half
 * of each usually lives in the database rather than in the body. They are judged
 * once, on the merged row, in `repo.ts#assertCoherent` — see the argument there.
 */
const BannerPatchBody = z
  .object({
    /**
     * REQUIRED, unlike the blog's optional `baseRevision`. Every screen that
     * edits a banner has read one first, and without the token a second tab
     * silently overwrites the first — the failure the revision column exists to
     * prevent.
     */
    expectedRevision: z.number().int().min(1),
    title: TITLE.optional(),
    body: BODY.optional(),
    ctaText: CTA_TEXT,
    ctaUrl: CTA_URL,
    placement: PLACEMENT.optional(),
    status: z.enum(['draft', 'live', 'archived']).optional(),
    startsAt: WHEN,
    endsAt: WHEN,
    priority: PRIORITY.optional(),
  })
  .strict();

// ------------------------------------------------------------------- routes

routes.get('/banners', auth, async (c) => {
  const banners = await listBanners(currentDb(c));
  return c.json({ banners });
});

routes.post('/banners', auth, async (c) => {
  const draft = await readJson(c, CreateBannerBody);
  const banner = await createBanner(currentDb(c), draft, {
    actorId: currentUser(c).id,
    /* `Date.now()` at the route, like every other write in this subsystem: the
     * repository takes the instant as an argument so a test can name it. */
    now: Date.now(),
  });
  return c.json({ banner }, 201);
});

routes.patch('/banners/:id', auth, async (c) => {
  const id = pathParam(c, 'id');
  const { expectedRevision, ...patch } = await readJson(c, BannerPatchBody);
  const banner = await patchBanner(currentDb(c), id, patch, {
    expectedRevision,
    actorId: currentUser(c).id,
    now: Date.now(),
  });
  return c.json({ banner });
});
