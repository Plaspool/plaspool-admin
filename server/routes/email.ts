import { Hono } from 'hono';
import { z } from 'zod';
import type { Context } from 'hono';
import {
  pathParam,
  readJson,
  readJsonOrEmpty,
  readQuery,
  str,
  toResponse,
} from '../middleware/errors';
import { requireOwner } from '../middleware/session';
import { clientIp, limit } from '../middleware/ratelimit';
import { BadRequestError, NotFoundError } from '../repo/errors';
import { pageLimit, requireCursor } from '../repo/cursor';
import { resendMailer } from '../mail/resend';
import { assertCronRequest } from '../shop/cart/cron-auth';
import {
  EmailPreconditionFailedError,
  MAX_IMPORT_ROWS,
  SUBSCRIBER_SORT,
  addSubscriber,
  audienceCounts,
  createBroadcast,
  createTemplate,
  deleteBroadcast,
  deleteTemplate,
  duplicateTemplate,
  enqueueAudience,
  findSubscriberByToken,
  getBroadcast,
  getTemplate,
  importSubscribers,
  listBroadcasts,
  listSubscribers,
  listTemplates,
  parseSubscriberCsv,
  recipientCounts,
  startBroadcast,
  tokenForEmail,
  unsubscribeByToken,
  updateTemplate,
} from '../email/repo';
import type { EmailBroadcast } from '../email/repo';
import {
  assertKnownVariables,
  escapeHtml,
  greetingName,
  hasUnsubscribeVariable,
} from '../email/render';
import {
  BROADCAST_BATCH,
  drainAll,
  drainBroadcast,
  renderMessage,
  unsubscribeUrl,
} from '../email/send';
import { ensureSystemTemplates, renderSystem } from '../email/system-templates';
import { storefrontOrigin } from '../shop/storefront-url';
import { baseUrl } from './public';
import { currentDb, currentUser } from '../app-env';
import type { AppEnv } from '../app-env';
import type { Db } from '../db/client';
import type { Mailer } from '../mail/port';

/**
 * Email marketing over HTTP (HANDOFF §2 A6).
 *
 * TWO ROUTERS, AND WHICH ONE A ROUTE BELONGS IN IS THE ONE DECISION ON THIS
 * SURFACE THAT IS EASY TO GET SUBTLY WRONG — see `createUnsubscribeRoutes` below,
 * which carries the whole argument.
 *
 * THE ADMIN SURFACE IS OWNER-ONLY THROUGHOUT, not `requireAuth()`. HANDOFF §2 A6
 * says so for templates; it is applied to subscribers and broadcasts as well
 * because of what they are. A writer publishing a bad post is a post that can be
 * unpublished; a writer pressing "send" is five thousand messages that cannot be
 * recalled, to a list whose consent the owner is answerable for. That is the same
 * line the shop draws — contract §HTTP puts anything money-adjacent behind owner —
 * and reputation is the money-adjacent thing here.
 *
 * `requireOwner()` IS ATTACHED PER ROUTE, NEVER AS `use('*', …)`. Measured in
 * `server/routes/posts.ts` and recorded there: `app.route('/api', …)` flattens a
 * router into its parent, so a blanket `use('*')` here becomes `use('/api/*')` and
 * applies to paths this file has never heard of — an unrouted `/api/nothing-here`
 * answered 401 instead of 404.
 */

export interface EmailRouteDeps {
  /**
   * Mail transport. Defaults to `resendMailer()`, which reads nothing at
   * construction — so building the app still demands no mail configuration and a
   * deployment with none still serves every other route.
   *
   * Injected rather than imported for the reason `server/mail/port.ts` states: a
   * route that delivers to an address cannot be tested by having it hand the
   * message back, so the suite drives the real route with a recorder.
   */
  mailer?: Mailer;
}

// ------------------------------------------------------------------ bounds

/**
 * A template body, in characters.
 *
 * Generous — a designed HTML email with inlined styles is routinely 40–60 KB —
 * and bounded anyway, because this is a `text` column that is read into memory,
 * scanned for placeholders and then substituted into once per recipient. Without
 * a ceiling a single 20 MB template is 20 MB × the audience of string building.
 */
const MAX_BODY_CHARS = 200_000;

/** The whole CSV, in characters. `MAX_IMPORT_ROWS` bounds the rows; this bounds
 * what reaches the parser at all, so a 50 MB paste is a refusal rather than an
 * allocation. */
const MAX_CSV_CHARS = 1_000_000;

/**
 * Five an hour, per owner. Not in any spec — the same choice
 * `server/repo/ratelimit.ts` makes for export/import, for the same reason:
 * generous for a human pressing a button, useless for a loop. An import is a bulk
 * write of attacker-shaped text through a parser.
 */
const IMPORT_LIMIT = 5;
const IMPORT_WINDOW_MS = 60 * 60_000;

/** A test send is a real message to a real inbox, and the owner's own inbox is
 * still an inbox somebody has to read. */
const TEST_SEND_LIMIT = 10;
const TEST_SEND_WINDOW_MS = 15 * 60_000;

/**
 * Deliberately generous, and per IP.
 *
 * An unsubscribe link is clicked by a person who has just decided they are done
 * with this sender; a 429 at that moment is the worst possible answer. It exists
 * only so an unauthenticated endpoint cannot be driven in a loop, and a corporate
 * NAT unsubscribing from a newsletter en masse must stay comfortably under it.
 */
const UNSUBSCRIBE_LIMIT = 120;
const UNSUBSCRIBE_WINDOW_MS = 15 * 60_000;

// ----------------------------------------------------------------- schemas

const TemplateBody = z
  .object({
    name: str().min(1).max(200),
    subject: str().min(1).max(400),
    html: str().min(1).max(MAX_BODY_CHARS),
    text: str().min(1).max(MAX_BODY_CHARS),
  })
  .strict();

/**
 * The same four fields, all optional — a real partial patch, merged onto the
 * stored row.
 *
 * NOT A FULL REPLACE UNDER A `PATCH` VERB. The composer saves the HTML pane and
 * the text pane independently, and a full replace would mean the pane that was not
 * open is sent back from whatever the client last read — which is how one editor's
 * stale copy of the text part silently overwrites another's.
 */
const TemplatePatchBody = TemplateBody.partial();

const SubscriberBody = z
  .object({
    email: str().min(1).max(320),
    name: str().max(200).nullable().optional(),
    /**
     * Send the `account.welcome` message to this address.
     *
     * ⚠️  OPT-IN, AND DEFAULTING IT TO `true` WOULD BE A BUG RATHER THAN A
     *     FRIENDLIER DEFAULT.
     *
     * This route is not a public sign-up form — there is no public sign-up form
     * on this deployment. It is an OWNER typing an address in, and the reasons
     * they do that are mostly not "somebody just joined": migrating a list one
     * row at a time, re-adding an address to check whether it is there, adding a
     * customer who has been buying for a year. Welcoming all of those is mail
     * nobody asked for, sent to real people, with no way to stop it once the
     * request is in flight.
     *
     * So the screen asks, and the answer travels with the request. The one case
     * where it is genuinely a new subscriber is exactly the case where the person
     * pressing the button knows it.
     */
    welcome: z.boolean().optional(),
  })
  .strict();

/**
 * TWO SHAPES, AND BOTH ARE LOAD-BEARING.
 *
 * `{ csv }` is the file, parsed HERE. The server has to be able to do it, because
 * "the client validated it" is not a property a server may assume — anything can
 * POST to this route, and the row-level rules (a shape that looks like an address,
 * no duplicate inside one file) belong where they cannot be skipped.
 *
 * `{ emails }` is the same import after the composer has already parsed and
 * PREVIEWED it. HANDOFF §3 B4 asks that the writer see which rows would be refused
 * before anything is written, and a server that rejects a 900-row file whole gives
 * them a count where they need a list. Sending the already-approved addresses is
 * what makes "the preview you agreed to" and "the list you got" the same thing.
 *
 * `consent` IS OPTIONAL AND ITS ABSENCE IS MEANINGFUL, not a default. See the note
 * on `importSubscribers`: with it, the row records when the operator asserted that
 * these people agreed; without it, the row carries no consent timestamp at all.
 */
const ImportBody = z.union([
  z.object({ csv: str().min(1).max(MAX_CSV_CHARS), consent: z.literal(true).optional() }).strict(),
  z
    .object({
      emails: z.array(str().min(1).max(320)).min(1).max(MAX_IMPORT_ROWS),
      consent: z.literal(true).optional(),
    })
    .strict(),
]);

const BroadcastBody = z
  .object({
    templateId: str().min(1).max(64),
    /** An override for this send only. The template is not touched — the whole
     * point of the snapshot columns. */
    subject: str().min(1).max(400).optional(),
  })
  .strict();

/**
 * STRICT, like every other query schema in this application. A mistyped filter
 * that is silently ignored is worse than a refusal: `?fitler=unsubscribed` would
 * quietly list the whole audience while the screen said "unsubscribed only", which
 * on this table is a list of people who asked not to be here.
 */
const SubscriberQuery = z
  .object({
    filter: z.enum(['subscribed', 'unsubscribed', 'all']).optional(),
    cursor: str().max(512).optional(),
    /** `pageLimit` decides the range and answers 400 itself; this stops
     * `?limit=abc` NaN-ing its way into a query. */
    limit: z.coerce.number().int().optional(),
  })
  .strict();

/** A body every drain route accepts, so a cron or a button can both post `{}`. */
const DrainBody = z
  .object({ limit: z.number().int().positive().max(BROADCAST_BATCH).optional() })
  .strict();

/**
 * The same bound, reached over the query string, because the cron has no body.
 *
 * `z.coerce` and not `Number(...)`: a query value is always a string, and the
 * bare-`Number` version this replaced turned `?limit=abc` into `NaN || undefined`
 * — which silently became "the default" instead of a refusal.
 *
 * THE CEILING IS THE POINT. `vercel.json` gives this function `maxDuration: 30`
 * and Vercel does not re-run a cron it had to kill, so an uncapped `?limit=100000`
 * is not a slow drain; it is one that never finishes, never retries, and leaves
 * the queue for tomorrow. Only `CRON_SECRET` stood in front of it, and a secret
 * bounds WHO may call a route, never what the call costs.
 */
const DrainQuery = z
  .object({ limit: z.coerce.number().int().positive().max(BROADCAST_BATCH).optional() })
  .strict();

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The `:id` segment, or a 400.
 *
 * BOTH CHECKS, IN THIS ORDER, exactly as `server/routes/categories.ts` does.
 * `pathParam` is the NUL boundary every route in this codebase reads its segments
 * through and `server/nul-bytes.test.ts` walks the whole route table on that
 * assumption; the UUID shape is the second half, because every id on this surface
 * is a `uuid` column and a segment that is not one reaches the driver as SQLSTATE
 * 22P02 — scrubbed to a `DbError`, answered 500, and then retried five times by the
 * client's policy for a request that can never succeed.
 */
function emailId(c: Context<AppEnv>): string {
  const id = pathParam(c, 'id');
  if (!UUID.test(id)) throw new BadRequestError('id');
  return id;
}

/**
 * The origin every link in an outgoing message is built from, or a refusal.
 *
 * NEVER THE REQUEST'S `Host` OR `Origin` HEADER — the rule `server/routes/auth.ts`
 * follows for invite and reset URLs. A host header is attacker-controlled on any
 * deployment that does not pin it, and here the consequence is not one credential
 * going to the wrong domain but every subscriber receiving an unsubscribe link
 * pointing at a domain somebody else chose.
 *
 * A deployment with no `APP_ORIGINS` entry cannot build one, and refusing is the
 * only honest answer: the alternative is a broadcast whose unsubscribe link is a
 * relative path, which in a mail client is not a link at all — and an unsubscribe
 * link that does not work is the one defect on this surface with legal weight.
 */
function sendingOrigin(c: Context<AppEnv>, broadcast: EmailBroadcast): string {
  const origin = c.get('origins')?.[0] ?? '';
  if (origin === '') throw new EmailPreconditionFailedError('send', 'broadcast', broadcast);
  return origin;
}

// -------------------------------------------------------------- admin routes

export function createEmailRoutes(deps: EmailRouteDeps = {}): Hono<AppEnv> {
  const mailer = deps.mailer ?? resendMailer();
  const routes = new Hono<AppEnv>();

  /**
   * The refusals on this surface, rendered with the thing they are about.
   *
   * WHY A LOCAL HANDLER RATHER THAN AN EDIT TO `server/middleware/errors.ts`, in
   * the words `server/routes/categories.ts` already uses for the same arrangement:
   * `EmailPreconditionFailedError` extends `PreconditionFailedError`, so one
   * escaping this handler still lands on the global one and is still a correct 409
   * rather than a 500 — that fallback is the safety property, not a fork of the §8
   * table. What could not be reused is the payload: the shared class carries a
   * `Post`, and "this broadcast is already sending" wants the broadcast.
   *
   * EVERYTHING ELSE FALLS THROUGH TO `toResponse` UNTOUCHED, so 400, 401, 403, 404,
   * 429, 501 and 500 on this surface are the same implementation the whole
   * application shares and this file cannot grow its own dialect of them.
   */
  routes.onError((err, c) => {
    const requestId = c.get('requestId') ?? '';
    if (!(err instanceof EmailPreconditionFailedError)) return toResponse(err, requestId);

    return new Response(
      JSON.stringify({
        error: 'precondition_failed',
        operation: err.operation,
        // Under its own name — `broadcast`, `template` or `subscriber` — so a
        // client reads one shape per entity rather than a generic envelope it has
        // to introspect.
        [err.entity]: err.value,
        requestId,
      }),
      {
        status: 409,
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'x-request-id': requestId,
        },
      },
    );
  });

  // ---------------------------------------------------------------- templates

  /**
   * Every template, `html` and `text` in full rather than a preview.
   *
   * NO PAGINATION AND NO PROJECTION. Two screens need both bodies off the list —
   * the editor opens one without a second request, and the broadcast composer
   * decides which templates may be picked at all by looking for the unsubscribe
   * variable in each. A managed set of a few rows of a few KB is the same case
   * `GET /api/categories` makes for having no cursor: a page here would be a limit
   * the composer would immediately have to defeat.
   */
  routes.get('/admin/email/templates', requireOwner(), async (c) => {
    const db = currentDb(c);
    /*
     * SEED THE SYSTEM TEMPLATES BEFORE LISTING, AND THIS IS THE MAIN SEEDER.
     *
     * The messages the application sends by itself only become editable once
     * there are rows for them, and this is the first moment it can possibly
     * matter: an owner has just opened the screen to look at them. Doing it at
     * boot is not an option — this app has no boot, it is a lambda that starts on
     * a request, so a nine-row write would land in front of whatever request
     * happened to be first, which on a cold start is often a customer's checkout.
     *
     * IDEMPOTENT AND NEVER OVERWRITES: `ensureSystemTemplates` is
     * `INSERT ... WHERE NOT EXISTS`, so an edited template is invisible to it and
     * a deploy cannot silently revert an owner's wording. It also never throws —
     * a seed failure must not turn this screen into a 500, because the screen is
     * still perfectly useful for the operator's own templates.
     *
     * `runSweep` seeds too, so a deployment nobody opens this screen on still
     * ends up with the rows.
     */
    await ensureSystemTemplates(db, Date.now());
    return c.json({ items: await listTemplates(db) });
  });

  /**
   * Copy a template, including a system one.
   *
   * THIS IS WHAT MAKES "SYSTEM TEMPLATES CANNOT BE DELETED" TOLERABLE. An owner
   * who wants to experiment with the confirmation wording, or keep a seasonal
   * variant, duplicates it and gets an ordinary row: `system_key` is NOT carried
   * over (see `duplicateTemplate`), so the copy is editable, deletable, and
   * sendable as a broadcast, while the row the order pipeline renders from is
   * untouched.
   *
   * POST TO A SUB-PATH RATHER THAN A FLAG ON `POST /templates`. The body of a
   * create is the template; a duplicate has no body at all, and expressing it as
   * `{ duplicateOf: id }` on the create route would mean one handler where half
   * the fields are mutually exclusive with the other half.
   */
  routes.post('/admin/email/templates/:id/duplicate', requireOwner(), async (c) => {
    const id = emailId(c);
    const template = await duplicateTemplate(currentDb(c), id, currentUser(c).id, Date.now());
    if (!template) throw new NotFoundError(id);
    return c.json({ template }, 201);
  });

  routes.get('/admin/email/templates/:id', requireOwner(), async (c) => {
    const id = emailId(c);
    const template = await getTemplate(currentDb(c), id);
    if (!template) throw new NotFoundError(id);
    return c.json({ template });
  });

  routes.post('/admin/email/templates', requireOwner(), async (c) => {
    const body = await readJson(c, TemplateBody);
    const input = checkedTemplate(body);
    const template = await createTemplate(currentDb(c), input, currentUser(c).id, Date.now());
    return c.json({ template }, 201);
  });

  routes.patch('/admin/email/templates/:id', requireOwner(), async (c) => {
    const id = emailId(c);
    const db = currentDb(c);
    const patch = await readJson(c, TemplatePatchBody);
    // An empty patch would be a write that changes nothing except `updated_at` and
    // `updated_by`, i.e. a silent claim that somebody edited this. A refusal is
    // cheaper to explain than that row is.
    if (Object.keys(patch).length === 0) throw new BadRequestError('body');

    const existing = await getTemplate(db, id);
    if (!existing) throw new NotFoundError(id);

    /*
     * A SYSTEM TEMPLATE MAY BE EDITED FREELY BUT NOT RENAMED.
     *
     * Editing is the whole point of seeding them. The NAME is different: it is
     * what an operator finds the template by on this screen, and `system_key` is
     * what the renderer finds it by — so a rename does not break sending, it
     * breaks the human's ability to locate the message that is being sent. Worse,
     * renaming `Order confirmed` to `Old confirmation` and then creating a new
     * template called `Order confirmed` produces two rows where the one that
     * LOOKS canonical is the one nothing renders from.
     *
     * Refused rather than silently ignored: a PATCH that reports success while
     * discarding a field is how an operator concludes the screen is broken.
     */
    if (existing.systemKey !== null && patch.name !== undefined) {
      const wanted = patch.name.trim();
      if (wanted !== existing.name) throw new BadRequestError('name');
    }

    const input = checkedTemplate({
      name: patch.name ?? existing.name,
      subject: patch.subject ?? existing.subject,
      html: patch.html ?? existing.html,
      text: patch.text ?? existing.text,
    });
    const template = await updateTemplateOr404(db, id, input, currentUser(c).id);
    return c.json({ template });
  });

  routes.delete('/admin/email/templates/:id', requireOwner(), async (c) => {
    const id = emailId(c);
    if (!(await deleteTemplate(currentDb(c), id))) throw new NotFoundError(id);
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------- subscribers

  routes.get('/admin/email/subscribers', requireOwner(), async (c) => {
    const db = currentDb(c);
    const query = readQuery(c, SubscriberQuery);
    const limitValue = pageLimit(query.limit);
    /*
     * The cursor is bound to the ordering that minted it — `requireCursor` is the
     * shared codec and `SUBSCRIBER_SORT` is this list's key. Spending a post
     * cursor here would otherwise compare a bigint against a uuid and raise 22P02,
     * a 500 the client retries five times for a request that can never succeed.
     */
    const after = query.cursor
      ? decodeSubscriberCursor(requireCursor(query.cursor, SUBSCRIBER_SORT))
      : undefined;

    const page = await listSubscribers(db, {
      filter: query.filter ?? 'subscribed',
      limit: limitValue,
      after,
    });
    // The counts ride along because the confirm dialog before a broadcast has to
    // state the REAL recipient count, and a client that had to count the pages
    // itself would need every page to say it.
    return c.json({ ...page, counts: await audienceCounts(db) });
  });

  routes.post('/admin/email/subscribers', requireOwner(), async (c) => {
    const body = await readJson(c, SubscriberBody);
    const email = body.email.trim();
    if (!email.includes('@')) throw new BadRequestError('email');
    /*
     * `consentAt` IS `now` FOR A MANUAL ADD AND NULL FOR AN IMPORT. An owner
     * typing one address in has, by doing so, asserted that this person agreed;
     * a file of nine hundred rows asserts only that the owner has the file. The
     * difference is exactly what a consent record is for, and manufacturing one
     * for the import case would produce evidence that is not evidence.
     */
    const db = currentDb(c);
    const outcome = await addSubscriber(
      db,
      { email, name: body.name ?? null, source: 'manual', consentAt: Date.now() },
      Date.now(),
    );

    /*
     * THE WELCOME MESSAGE, AND ONLY FOR A GENUINELY NEW MANUAL ADD.
     *
     * TWO GUARDS, AND BOTH ARE NECESSARY.
     *
     * `body.welcome` is the operator's intent — see `SubscriberBody`, which
     * carries the argument for why this is opt-in.
     *
     * `outcome.created` is the correctness half. Re-adding an address that is
     * already on the list is an ordinary thing to do — it is how you check
     * whether somebody is on it — and welcoming them again every time would mail
     * the same person on every check. `addSubscriber` answers `created:false` for
     * that case, and it answers it from a UNIQUE INDEX rather than from a
     * read-then-write, so two simultaneous adds still send exactly one welcome.
     *
     * ⚠️  DELIBERATELY NOT WIRED INTO THE CSV IMPORT, and that is the important
     *     half of this decision. An import is up to `MAX_IMPORT_ROWS` addresses in
     *     one request; welcoming them inline would be a bulk send with no
     *     broadcast row, no queue, no per-recipient retry, no suppression check and
     *     no way to stop it once the request is in flight — every property
     *     `server/email/send.ts` exists to provide, discarded. A deliberate welcome
     *     to an imported list is a BROADCAST, which is a thing an owner composes
     *     and confirms.
     *
     * FAILURE IS SWALLOWED. The subscriber row is already committed; turning a
     * mail outage into a 500 here would tell the owner the add failed when it
     * did not, and they would add the address again. Logged with name and message
     * only, the shape `server/middleware/errors.ts` requires.
     */
    if (outcome.created && body.welcome === true) {
      try {
        /* Asked BEFORE the token read, so an unconfigured deployment does no
         * work at all here rather than discovering it one query later. */
        mailer.assertConfigured?.();
        const token = await tokenForEmail(db, email);
        if (token !== null) {
          await mailer.send(
            await renderSystem(db, 'account.welcome', outcome.subscriber.email, {
              name: greetingName(outcome.subscriber.email, body.name ?? null),
              shop_url: storefrontOrigin(),
              unsubscribe_url: unsubscribeUrl(baseUrl(c.get('origins') ?? []), token),
            }),
          );
        }
      } catch (err: unknown) {
        // eslint-disable-next-line no-console -- the add succeeded; only the mail did not
        console.error(
          '[api]',
          JSON.stringify({
            requestId: c.get('requestId') ?? '',
            name: err instanceof Error ? err.name : 'Error',
            message: err instanceof Error ? err.message : 'welcome send failed',
            route: 'POST /api/admin/email/subscribers',
          }),
        );
      }
    }

    return c.json(outcome, outcome.created ? 201 : 200);
  });

  routes.post('/admin/email/subscribers/import', requireOwner(), async (c) => {
    const user = currentUser(c);
    await limit(c, `emailimport:${user.id}`, IMPORT_LIMIT, IMPORT_WINDOW_MS);
    const body = await readJson(c, ImportBody);
    const now = Date.now();

    /*
     * The two forms converge on ONE list of rows before anything is validated, so
     * the file path and the already-previewed path are held to exactly the same
     * rules. A second validation path is a second set of rules, and the looser one
     * is always the one nobody remembers writing.
     */
    const rows =
      'csv' in body
        ? parseSubscriberCsv(body.csv)
        : body.emails.map((email, i) => ({ email, name: null, line: i + 1 }));
    if (rows.length > MAX_IMPORT_ROWS) throw new BadRequestError('csv');

    return c.json(
      await importSubscribers(currentDb(c), rows, now, body.consent === true ? now : null),
    );
  });

  // --------------------------------------------------------------- broadcasts

  routes.get('/admin/email/broadcasts', requireOwner(), async (c) => {
    const db = currentDb(c);
    return c.json({ items: await listBroadcasts(db), audience: await audienceCounts(db) });
  });

  /**
   * The two numbers the confirm dialog is built on, on their own route.
   *
   * IT CANNOT COME OFF THE SUBSCRIBER LIST, which is the reason this exists rather
   * than being a field there. That list is a keyset PAGE, so `items.length` is the
   * page size — which is the single most dangerous number this surface could put in
   * front of somebody about to email a few thousand people. Two counted aggregates
   * over one indexed column is the cheapest honest answer, and the dialog asks for
   * it at the moment it is needed rather than trusting a count fetched three screens
   * ago.
   */
  routes.get('/admin/email/audience', requireOwner(), async (c) =>
    c.json(await audienceCounts(currentDb(c))),
  );

  routes.get('/admin/email/broadcasts/:id', requireOwner(), async (c) => {
    const id = emailId(c);
    const db = currentDb(c);
    const broadcast = await getBroadcast(db, id);
    if (!broadcast) throw new NotFoundError(id);
    return c.json({ broadcast, recipients: await recipientCounts(db, id) });
  });

  /**
   * Create a draft from a template, SNAPSHOTTING it.
   *
   * The three snapshot columns are filled here and never again. Editing the
   * template afterwards changes nothing about this broadcast, which is what makes
   * "what did we send in March" answerable — see the note on `email_broadcasts` in
   * migration 0008.
   */
  routes.post('/admin/email/broadcasts', requireOwner(), async (c) => {
    const db = currentDb(c);
    const body = await readJson(c, BroadcastBody);
    if (!UUID.test(body.templateId)) throw new BadRequestError('templateId');

    const template = await getTemplate(db, body.templateId);
    if (!template) throw new BadRequestError('templateId');

    const subject = (body.subject ?? template.subject).trim();
    if (subject === '') throw new BadRequestError('subject');

    const broadcast = await createBroadcast(
      db,
      { templateId: template.id, subject, html: template.html, text: template.text },
      currentUser(c).id,
      Date.now(),
    );
    return c.json({ broadcast }, 201);
  });

  /**
   * Delete a draft nobody is going to send.
   *
   * DRAFTS ONLY, and the 409 carries the row so the screen can say WHY rather
   * than shrugging: a broadcast that has started is the record of what was (or
   * is being) sent to real inboxes, and the templates screen already holds the
   * matching precedent — system templates refuse deletion with the reason
   * attached. A draft, by contrast, has enqueued nothing and told nobody
   * anything; it is a snapshot the owner decided against.
   *
   * `deleteBroadcast` answers `false` for "not a draft" AND for "no such row";
   * the re-read tells them apart so a stale screen gets the honest one of 404
   * and 409 rather than whichever this route guessed.
   */
  routes.delete('/admin/email/broadcasts/:id', requireOwner(), async (c) => {
    const id = emailId(c);
    const db = currentDb(c);
    if (await deleteBroadcast(db, id)) return c.json({ ok: true });
    const existing = await getBroadcast(db, id);
    if (!existing) throw new NotFoundError(id);
    throw new EmailPreconditionFailedError('delete', 'broadcast', existing);
  });

  /**
   * Start it, and drain the first batch INLINE.
   *
   * INLINE BECAUSE THE ALTERNATIVE IS A LIE. Pressing "send" and being told the
   * broadcast is "sending" while nothing has left the building — until a cron runs
   * some time in the next 24 hours — is the failure shape this codebase keeps
   * finding: a mechanism wired to no caller. One batch inline means the owner
   * watches the first fifty land and can tell immediately whether the provider is
   * configured, whether the template renders, and whether the audience is who they
   * expected. The rest is drained by `/drain` and by the daily cron.
   */
  routes.post('/admin/email/broadcasts/:id/send', requireOwner(), async (c) => {
    const id = emailId(c);
    const db = currentDb(c);
    const body = await readJsonOrEmpty(c, DrainBody);

    const existing = await getBroadcast(db, id);
    if (!existing) throw new NotFoundError(id);
    assertSendable(existing);
    const origin = sendingOrigin(c, existing);
    /*
     * ASKED BEFORE THE AUDIENCE IS ENQUEUED, not discovered inside the first
     * `send`. On a deployment with no `RESEND_API_KEY` the alternative is five
     * thousand recipient rows each carrying eight attempts' worth of the same
     * configuration error, and a broadcast that ends `failed` for a reason nothing
     * in the UI can distinguish from a bad list. 501 `not_implemented`, once.
     */
    mailer.assertConfigured?.();

    const started = await startBroadcast(db, id, Date.now());
    // The CAS lost, so this broadcast is not a draft any more. Re-read rather than
    // guess: the row says whether somebody else started it or it has already run.
    if (!started) {
      throw new EmailPreconditionFailedError('send', 'broadcast', await getBroadcast(db, id));
    }

    await enqueueAudience(db, id);
    const drained = await drainBroadcast(
      db,
      started,
      mailer,
      origin,
      Date.now(),
      body.limit ?? BROADCAST_BATCH,
    );
    return c.json({ broadcast: await getBroadcast(db, id), drained });
  });

  /** Continue a send that is already under way. Idempotent; a broadcast with
   * nothing pending drains zero and is closed by the same call. */
  routes.post('/admin/email/broadcasts/:id/drain', requireOwner(), async (c) => {
    const id = emailId(c);
    const db = currentDb(c);
    const body = await readJsonOrEmpty(c, DrainBody);

    const broadcast = await getBroadcast(db, id);
    if (!broadcast) throw new NotFoundError(id);
    if (broadcast.status !== 'sending') {
      throw new EmailPreconditionFailedError('drain', 'broadcast', broadcast);
    }
    const origin = sendingOrigin(c, broadcast);
    mailer.assertConfigured?.();

    const drained = await drainBroadcast(
      db,
      broadcast,
      mailer,
      origin,
      Date.now(),
      body.limit ?? BROADCAST_BATCH,
    );
    return c.json({ broadcast: await getBroadcast(db, id), drained });
  });

  /**
   * The rendered message, to the CALLER'S OWN ADDRESS AND NOWHERE ELSE.
   *
   * THE RECIPIENT IS NOT IN THE BODY, AND THAT IS THE WHOLE DESIGN OF THIS ROUTE.
   * A `{ to }` field would make this an authenticated open relay: a route that
   * takes arbitrary HTML and an arbitrary address and sends the first to the second
   * over the shop's verified sending domain. The address comes from the session,
   * which is the one address the caller has already proved they control.
   */
  routes.post('/admin/email/broadcasts/:id/test', requireOwner(), async (c) => {
    const id = emailId(c);
    const db = currentDb(c);
    const user = currentUser(c);
    await readJsonOrEmpty(c, z.object({}).strict());
    await limit(c, `emailtest:${user.id}`, TEST_SEND_LIMIT, TEST_SEND_WINDOW_MS);

    const broadcast = await getBroadcast(db, id);
    if (!broadcast) throw new NotFoundError(id);
    const origin = sendingOrigin(c, broadcast);
    mailer.assertConfigured?.();

    /*
     * The caller's OWN unsubscribe token if they happen to be on the list, and a
     * marker otherwise — which `GET /api/public/unsubscribe` answers with "this
     * link is not recognised". That is the truth about a test message, and it is
     * better than the two alternatives: minting a real token for somebody who is
     * not a subscriber would put them on the list by previewing, and omitting the
     * link entirely would hide the one thing a test send most needs to prove is
     * present.
     */
    const token = (await tokenForEmail(db, user.email)) ?? 'test-send-not-a-subscriber';
    const message = renderMessage(
      broadcast,
      { email: user.email, name: user.displayName, token },
      origin,
    );

    /*
     * A FAILED SEND IS REPORTED, NOT THROWN — the shape `POST /api/invites` uses
     * for its invite mail, and for the same reason: the caller can act on
     * `sent: false` and a 500 would be retried five times by the client's policy
     * for a provider outage that is not going to clear in thirty seconds. Logged
     * with name and message only, never the error object and never the body.
     */
    try {
      await mailer.send(message);
      return c.json({ sent: true, to: user.email });
    } catch (err) {
      console.error(
        '[api]',
        JSON.stringify({
          requestId: c.get('requestId') ?? '',
          name: err instanceof Error ? err.name : 'Error',
          message: err instanceof Error ? err.message : 'mail send failed',
          route: 'POST /api/admin/email/broadcasts/:id/test',
        }),
      );
      return c.json({ sent: false, to: user.email });
    }
  });

  // -------------------------------------------------------------- the drain

  /**
   * Every sending broadcast, one batch each.
   *
   * TWO METHODS, ONE BEHAVIOUR, AND TWO DIFFERENT CREDENTIALS — the arrangement
   * `server/shop/cart/routes/checkout.ts` uses for the cart's maintenance route,
   * copied deliberately rather than reinvented. Vercel invokes a cron with an
   * **HTTP GET** and an `Authorization: Bearer $CRON_SECRET`; an operator wants to
   * run it by hand with the session they already have. Keeping the two credentials
   * separate is what stops a leaked session becoming a way to drive the mailer and
   * what stops the cron token becoming a general-purpose admin credential.
   *
   * `assertCronRequest` IS IMPORTED FROM `server/shop/cart/`, WHICH IS NOT THIS
   * SUBSYSTEM'S CODE. It is a pure function over one header with no shop state
   * behind it, and the alternative — a second constant-time comparison against a
   * second reading of `CRON_SECRET` — is the kind of duplication where one copy
   * quietly loses its length guard. It FAILS CLOSED: a deployment with no
   * `CRON_SECRET` answers 401 to everyone, because `originGuard` waves every GET
   * through and this token is the only thing in front of the endpoint.
   *
   * SCHEDULED DAILY AT 05:41 UTC (`vercel.json`), an hour after the cart's own
   * maintenance run rather than alongside it: both drains take the same database
   * and there is nothing to gain from contending for it, and Hobby's ±59 min
   * jitter means two jobs nominally an hour apart can still land together if they
   * are booked any closer.
   *
   * Adding that entry took one change elsewhere, recorded here because the reason
   * is not local: `server/shop/cart/cron.test.ts` walks EVERY cron in
   * `vercel.json` and asserts each names a registered route, but it built its
   * registered set from `shopApp()` alone — so this blog-side path was a
   * guaranteed red until the set widened to `createApp()`. Two crons is also the
   * Hobby ceiling; a third needs a plan, not a config line.
   */
  routes.get('/admin/email/drain', async (c) => {
    assertCronRequest(c.req.header('Authorization'));
    // Through `DrainQuery`, so this method carries the same ceiling the POST
    // has always had — see the schema for why an uncapped cron is the one that
    // never finishes.
    const { limit } = readQuery(c, DrainQuery);
    return c.json(await runDrain(c, mailer, limit));
  });

  routes.post('/admin/email/drain', requireOwner(), async (c) => {
    const body = await readJsonOrEmpty(c, DrainBody);
    return c.json(await runDrain(c, mailer, body.limit));
  });

  return routes;
}

/**
 * The work both drain methods share, so the two credentials cannot drift into two
 * behaviours.
 *
 * `mailer.assertConfigured?.()` IS NOT CALLED HERE. The cron runs unattended, and
 * a 501 from a scheduled job on a deployment that has no mailer is a daily alarm
 * about a decision somebody has already made. The per-recipient failures are
 * recorded on the rows either way, which is where an operator would look.
 */
async function runDrain(c: Context<AppEnv>, mailer: Mailer, limit?: number) {
  const origin = c.get('origins')?.[0] ?? '';
  return drainAll(currentDb(c), mailer, origin, Date.now(), limit ?? BROADCAST_BATCH);
}

// ------------------------------------------------------------ shared helpers

/**
 * A template body the database and the send path will both accept.
 *
 * `name` IS TRIMMED HERE because `email_templates_name_ck` requires
 * `name = btrim(name)` — a check that exists so ' Welcome' and 'Welcome' cannot
 * become two rows that look identical in the composer's picker, which the
 * case-insensitive unique index cannot see.
 *
 * THE VARIABLE SCAN IS AT SAVE TIME, which is the asymmetry HANDOFF §2 A6 asks for
 * from the other direction: a template missing `{{unsubscribe_url}}` may still be
 * SAVED (`assertSendable` refuses it later), but a template using a variable this
 * server cannot substitute may not be saved at all. The two rules point opposite
 * ways for one reason — a missing unsubscribe link is a decision the composer can
 * still be shown and asked about, while an unknown placeholder is a literal
 * `{{firstname}}` mailed to the whole list the moment somebody presses send.
 */
function checkedTemplate(body: {
  name: string;
  subject: string;
  html: string;
  text: string;
}): { name: string; subject: string; html: string; text: string } {
  const name = body.name.trim();
  if (name === '') throw new BadRequestError('name');
  const subject = body.subject.trim();
  if (subject === '') throw new BadRequestError('subject');

  assertKnownVariables(subject, 'subject');
  assertKnownVariables(body.html, 'html');
  assertKnownVariables(body.text, 'text');

  return { name, subject, html: body.html, text: body.text };
}

async function updateTemplateOr404(
  db: Db,
  id: string,
  input: { name: string; subject: string; html: string; text: string },
  actorId: string,
) {
  // The row was read a statement ago, so `null` here means it was deleted in
  // between rather than that it never existed — the same 404 either way, because
  // "gone" is spec §8's only answer for both.
  const template = await updateTemplate(db, id, input, actorId, Date.now());
  if (!template) throw new NotFoundError(id);
  return template;
}

/**
 * THE ACTIVATION GATE, AND THE ASYMMETRY IS DELIBERATE (HANDOFF §2 A6).
 *
 * A template with no `{{unsubscribe_url}}` SAVES. It does not SEND.
 *
 * Saving is refused nowhere because a template is written over several sittings —
 * the HTML pane first, the text pane later — and a save that failed until both
 * halves were finished would mean the composer could not store work in progress.
 * That is a real cost and it buys nothing: an unsent draft harms nobody.
 *
 * Sending is refused because a bulk message with no way out of the list is the one
 * thing on this surface that cannot be taken back and the one thing that is not
 * merely bad practice. It is required in BOTH parts, not either: a reader whose
 * client renders the text part — every plain-text client, every preview pane, every
 * screen reader configured that way — sees only that half, and an unsubscribe link
 * present solely in the HTML is not present for them.
 *
 * The check is against the BROADCAST'S SNAPSHOT and not the template, because the
 * snapshot is what will actually be sent; a template fixed after the broadcast was
 * created does not fix the broadcast.
 */
function assertSendable(broadcast: EmailBroadcast): void {
  if (!hasUnsubscribeVariable(broadcast.html) || !hasUnsubscribeVariable(broadcast.text)) {
    throw new EmailPreconditionFailedError('send', 'broadcast', broadcast);
  }
}

function decodeSubscriberCursor(decoded: {
  sortValues: (string | number | null)[];
  id: string;
}): { createdAt: number; id: string } {
  const value = decoded.sortValues[0];
  // A cursor whose components are the wrong TYPE for this sort is a 400 rather
  // than a bound parameter Postgres refuses as 22P02 — the rule
  // `server/repo/cursor.ts` states about spending one sort's cursor under another.
  if (typeof value !== 'number' || !UUID.test(decoded.id)) throw new BadRequestError('cursor');
  return { createdAt: value, id: decoded.id };
}

// -------------------------------------------------------- the public surface

/**
 * `GET` and `POST /api/public/unsubscribe?token=` — one click, from an email, with
 * no session and no account.
 *
 * ═══ WHY THIS IS A SEPARATE ROUTER, AND WHERE `server/index.ts` MOUNTS IT ═══
 *
 * **NOT in `createPublicRoutes`.** Every response under `/api/public/*` carries
 * `Cache-Control: public` precisely because that router is mounted ABOVE
 * `sessionMiddleware` and is therefore structurally incapable of varying by cookie
 * (plan threat T6). Both of those properties are about a router of cacheable GETs.
 * A `POST` that flips a column is a MUTATION, and putting one inside the app's
 * one cacheable router would make the next person to add a route there reason
 * about caching and mutation in the same file — which is exactly the confusion that
 * router exists to remove. It shares the `/api/public/` path prefix because that is
 * where "no credential of ours" lives on the wire; it does not share the router.
 *
 * **ABOVE `originGuard`, beside the payments webhook.** The guard refuses any
 * unsafe method without an allow-listed `Origin`, and this endpoint has two callers
 * that cannot supply one: RFC 8058 one-click unsubscribe, which mail providers send
 * as a server-to-server `POST` with no `Origin` at all, and any browser or
 * link-scanning gateway that strips it. The exemption costs nothing an attacker can
 * use, and the reasoning is the one `server/index.ts` already writes out for the
 * Paystack webhook: CSRF borrows a victim's AMBIENT authority — their cookie — and
 * this route reads no cookie, resolves no session and trusts nothing about the
 * caller. Its entire authority is a 256-bit HMAC in the query string, which a
 * cross-origin form post cannot produce; and somebody who already has the token can
 * simply call the endpoint directly, so the guard would protect nothing while
 * breaking every real unsubscribe path.
 *
 * **The mount is therefore ABOVE `sessionMiddleware` too**, which is a property
 * rather than a side effect: `c.get('user')` is `undefined` here, so this route
 * cannot come to depend on who is signed in — and the person clicking is, almost by
 * definition, not signed in to anything.
 *
 * ═══ WHY IT ANSWERS IN HTML ═══
 * The caller is a person in a mail client, not a program. A JSON error envelope is
 * the correct answer everywhere else in this application and a dead end here.
 */
export function createUnsubscribeRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/public/unsubscribe', async (c) => {
    const db = currentDb(c);
    await limit(c, `unsub:${clientIp(c)}`, UNSUBSCRIBE_LIMIT, UNSUBSCRIBE_WINDOW_MS);
    const token = unsubscribeToken(c);
    const subscriber = token ? await findSubscriberByToken(db, token) : null;

    if (!subscriber || token === null) return page(c, 404, unknownLinkPage());
    if (subscriber.unsubscribedAt !== null) return page(c, 200, donePage(subscriber.email));
    return page(c, 200, confirmPage(subscriber.email, token));
  });

  routes.post('/public/unsubscribe', async (c) => {
    const db = currentDb(c);
    await limit(c, `unsub:${clientIp(c)}`, UNSUBSCRIBE_LIMIT, UNSUBSCRIBE_WINDOW_MS);
    const token = unsubscribeToken(c);
    const subscriber = token ? await unsubscribeByToken(db, token, Date.now()) : null;

    if (!subscriber) return page(c, 404, unknownLinkPage());
    return page(c, 200, donePage(subscriber.email));
  });

  return routes;
}

/**
 * The token, or `null` — and UNKNOWN QUERY PARAMETERS ARE IGNORED HERE.
 *
 * THE ONE PLACE IN THIS APPLICATION THAT IS NOT `.strict()` ABOUT ITS QUERY, and
 * the reason is what this URL is: a link that sits in strangers' mailboxes for
 * years and is rewritten in transit by corporate link-protection gateways
 * (Outlook Safe Links, Proofpoint and their kind), which append their own tracking
 * parameters to every link they scan. A strict schema would turn one such gateway
 * into an unsubscribe outage for an entire company — a refusal the sender never
 * sees and the recipient reads as being ignored.
 *
 * The token itself is checked exactly rather than loosely: it is a hex SHA-256
 * HMAC, so 64 hex characters is the whole shape. That refuses a NUL byte before it
 * can reach a bound parameter (SQLSTATE 22021 → a 500 the client retries five times
 * for input that can never be accepted), which is the boundary `str()` and
 * `pathParam` hold everywhere else.
 */
const TOKEN = /^[0-9a-f]{64}$/;

function unsubscribeToken(c: Context<AppEnv>): string | null {
  const raw = c.req.query('token') ?? '';
  return TOKEN.test(raw) ? raw : null;
}

/**
 * `no-store`, and it is not superstition.
 *
 * This page names an email address. Without it a shared cache in front of the app
 * may store the body of a URL that is, by construction, forwarded and clicked from
 * mailboxes — and `/api/public/*` is the one path prefix in this application that
 * a cache has been told it MAY store. `noindex` for the same reason one step
 * further out: an unsubscribe link that reaches a crawler must not become a search
 * result carrying somebody's address.
 */
function page(c: Context<AppEnv>, status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=UTF-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'x-request-id': c.get('requestId') ?? '',
    },
  });
}

/**
 * The pages, inline and dependency-free.
 *
 * NO STYLESHEET, NO SCRIPT AND NO FONT. This is rendered in whatever browser a mail
 * client happens to open, frequently an in-app webview with no network beyond the
 * first request, and `Content-Security-Policy` is not something this application
 * sets. Two hundred bytes of inline style that works everywhere beats a design that
 * works in Chrome. The `<form>` is a real form and needs no JavaScript, which is
 * the whole reason the POST accepts a plain form submission.
 */
const SHELL = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
 body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 3rem 1.25rem;
        color: #1a1a1a; background: #fff; }
 main { max-width: 30rem; margin: 0 auto; }
 h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
 p { margin: 0 0 1rem; }
 button { font: inherit; padding: .6rem 1.1rem; border: 0; border-radius: .375rem;
          background: #1a1a1a; color: #fff; cursor: pointer; }
 @media (prefers-color-scheme: dark) {
   body { color: #f2f2f2; background: #121212; }
   button { background: #f2f2f2; color: #121212; }
 }
</style></head><body><main>${body}</main></body></html>`;

function confirmPage(email: string, token: string): string {
  /*
   * A CONFIRMATION STEP, NOT AN UNSUBSCRIBE ON THE GET. Mail clients, security
   * scanners and link previewers fetch every URL in a message before a human sees
   * it; a GET that unsubscribed would mean Outlook's own link scanner removes
   * people from the list on delivery. The mutation is behind the POST, which is
   * what the safe-method rule is for.
   */
  return SHELL(
    'Unsubscribe',
    `<h1>Unsubscribe</h1>
     <p>Stop sending email to <strong>${escapeHtml(email)}</strong>?</p>
     <form method="post" action="/api/public/unsubscribe?token=${encodeURIComponent(token)}">
       <button type="submit">Unsubscribe</button>
     </form>`,
  );
}

function donePage(email: string): string {
  return SHELL(
    'Unsubscribed',
    `<h1>Unsubscribed</h1>
     <p><strong>${escapeHtml(email)}</strong> will not receive any more marketing
     email from us.</p>
     <p>You can close this page.</p>`,
  );
}

function unknownLinkPage(): string {
  /*
   * DELIBERATELY VAGUE, AND IT IS NOT AN ENUMERATION DEFENCE — a 256-bit HMAC is
   * not guessable, so there is nothing to enumerate. It is vague because the four
   * ways to arrive here (a truncated link, a link a gateway rewrote badly, a link
   * from before `SESSION_SECRET` was rotated, and an address already removed from
   * the list entirely) are indistinguishable from the outside and the reader can
   * act on exactly one answer regardless.
   */
  return SHELL(
    'Link not recognised',
    `<h1>This link is not recognised</h1>
     <p>It may have been truncated by an email client, or it may be from a message
     that is no longer current.</p>
     <p>If you are still receiving email you did not ask for, reply to any message
     and ask to be removed.</p>`,
  );
}
