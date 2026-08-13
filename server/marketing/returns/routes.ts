import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, readQuery, str } from '../../middleware/errors';
import { requireAuth } from '../../middleware/session';
import { clientIp, limit } from '../../middleware/ratelimit';
import { currentDb, currentUser } from '../../app-env';
import { NotFoundError } from '../../repo/errors';
import {
  addNote,
  allowedActionsFor,
  cancel,
  collect,
  createRequest,
  inspect,
  listEvents,
  readReturn,
  receive,
  reject,
  schedule,
} from './repo';
import { listEmailIntents, listReturns, MAX_SEARCH_LENGTH } from './query';
import type { AppEnv } from '../../app-env';
import type { Db } from '../../db/client';
import type { ReturnAction } from '../errors';
import type { ReturnEventRow, ReturnRow } from './repo';
import type { EmailIntentState, EmbeddedProgram } from './query';

/**
 * The returns lifecycle on the wire — contract #4-14.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY TRANSITION IS `requireAuth`, INCLUDING THE INSPECTION THAT AWARDS THE
 * POINTS. The frozen role matrix (spec D12) puts processing returns in any
 * staff member's hands and reserves `requireOwner` for the things that change
 * what a return is WORTH — the program's rate, the settings' economics, a
 * manual adjustment. A writer receiving a box and counting what is in it is the
 * ordinary path; making them fetch the owner to record the count is how the
 * count stops being recorded.
 *
 * THE GUARDS ARE ATTACHED PER ROUTE, NEVER AS `routes.use('*', …)` — see the
 * long version in `../programs/routes.ts`. It matters more here than anywhere
 * else in this subsystem, because ONE route in this file is deliberately
 * unguarded and a blanket `use` would silently close it.
 *
 * THE PUBLIC INTAKE IS IN THIS FILE AND NOT IN THE CACHEABLE PUBLIC ROUTER.
 * `POST /returns/request` is the brief's lifecycle step 1 — a customer asking
 * for a pickup — and it is a MUTATION, so it belongs under `originGuard` and a
 * rate budget rather than beside responses a shared cache may store and hand to
 * a different reader (spec D8). It grants nothing: an admin vets every request
 * before anything is awarded, which is why it needs no HMAC and no account.
 * It ships DARK — built and tested, undocumented to the storefront — so the
 * storefront form is a copy change later rather than a backend task.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const routes = new Hono<AppEnv>();

const auth = requireAuth();

// ------------------------------------------------------------------ schemas

/** The columns are `integer`; past this is SQLSTATE 22003, i.e. a 500 for a
 *  number somebody typed. */
const INT4_MAX = 2_147_483_647;

/**
 * The largest instant a JavaScript `Date` can hold.
 *
 * The column is `bigint` and could hold far more, so this is not about
 * overflow: it is about a pickup scheduled for the year 300 000 rendering as
 * `Invalid Date` in every screen that formats it, with nothing on the wire to
 * say which side got it wrong.
 */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/**
 * A customer's address, and the identity every balance and every ledger row in
 * this subsystem keys on (spec D10).
 *
 * NOT `z.string().email()`. The repository normalises and the COLUMN refuses
 * what it cannot store; a shape check here would refuse the perfectly valid
 * addresses that regex-based validators are famous for refusing, on the one
 * field where being turned away means a customer's points go to nobody. 320 is
 * RFC 5321's ceiling (`64 + @ + 255`).
 */
const EMAIL = str().trim().min(1).max(320);

/**
 * An OPTIONAL human string, where blank means absent.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A FIELD OF SPACES IS NOT A VALUE, AND IT IS NOT AN ERROR EITHER.
 *
 * The third option — store it — is the one that hurts. `pickup_address` is the
 * field a driver is dispatched to, and `''` is not NULL: it satisfies
 * `schedule`'s "an address on the row or in the body" and sends somebody to a
 * blank doorstep, having overwritten the address the customer actually gave.
 * `customer_name` is milder and the same shape — a name that renders as nothing
 * where the email would have rendered.
 *
 * Refusing it instead would be hostile to the one client that matters here: the
 * public intake is a storefront form, and an empty optional input posting `""`
 * is what plain HTML does. So blank normalises to absent, which is also what
 * the admin client's own `filled()` does before it sends, and what the
 * repository does for anything reaching it from somewhere other than this file.
 * Three readers, one rule.
 *
 * The bounds keep a pasted document out of a history panel; none of them is a
 * business rule.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function optionalText(max: number) {
  return str()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? undefined : value))
    .optional();
}

const PERSON = optionalText(200);
const ADDRESS = optionalText(1000);
const REASON = str().trim().min(1).max(500);
/** The optional note every transition may carry. Required notes (#14) use the
 *  bare schema below, because a note route whose note is absent has nothing to
 *  write. */
const OPTIONAL_NOTE = optionalText(1000);
const NOTE = str().trim().min(1).max(1000);

const QTY = z.number().int().min(1).max(INT4_MAX);
/** Accepted and rejected counts may both be zero — a driver who came back
 *  empty-handed is a real inspection with nothing in it. */
const COUNT = z.number().int().min(0).max(INT4_MAX);

/**
 * REQUIRED on every transition, unlike the blog's optional `baseRevision`.
 * Every screen that moves a return has read one first, and without the token a
 * second tab silently overwrites the first — the failure the revision column
 * exists to prevent.
 */
const EXPECTED_REVISION = z.number().int().min(1);

const ListQuery = z
  .object({
    /**
     * DEFAULTS TO `all`, and the screen's default is NOT this one.
     *
     * The queue opens on `needs_action` and names its view on every request
     * (`marketingApi.listReturns` takes it as its first, required argument), so
     * a default here is only ever reached by a caller that did not ask for a
     * view — an export, a support script, a hand-typed URL — and the honest
     * answer to "list the returns" is all of them. A route that quietly
     * withheld five of seven statuses because one screen prefers it that way
     * would be a filter nobody asked for and nothing in the response admits to.
     */
    view: z
      .enum([
        'needs_action',
        'requested',
        'scheduled',
        'collected',
        'received',
        'done',
        'all',
      ])
      .default('all'),
    q: str().max(MAX_SEARCH_LENGTH).optional(),
    programId: str().min(1).max(200).optional(),
    cursor: str().optional(),
    /** `pageLimit` decides the range and answers 400 itself; this only makes a
     *  non-numeric `?limit=abc` a 400 here rather than a NaN there. */
    limit: z.coerce.number().int().optional(),
  })
  /*
   * STRICT, LIKE THE BODIES. A mistyped filter that is silently ignored is
   * worse than a refusal: `?vieww=done` would quietly return the whole queue
   * and look like a bug in the tab strip.
   */
  .strict();

/** Contract #5 — the admin's "Log a return…" dialog. */
const AdminIntakeBody = z
  .object({
    email: EMAIL,
    qtyDeclared: QTY,
    /** Absent means the shop's default (`settings.defaultReturnProgramId`) —
     *  the Select is rendered only when more than one program takes returns. */
    programId: str().min(1).max(200).optional(),
    customerName: PERSON,
    customerPhone: PERSON,
    pickupAddress: ADDRESS,
    note: OPTIONAL_NOTE,
  })
  .strict();

/**
 * Contract #6 — the customer's own request.
 *
 * `name`/`phone` RATHER THAN `customerName`/`customerPhone`, exactly as the
 * contract spells them: this body is filled in by a person on a storefront
 * form, where every field is already about them, and the admin body's prefix
 * exists only because that dialog also carries a program and a staff note.
 *
 * NO `programId` AND NO `note`. A customer cannot choose which program pays
 * them, and a note here would be a free-text field written by the public into a
 * history staff read as though staff wrote it. What they have to say arrives by
 * mail, and an admin adds it with #14 under their own name.
 */
const PublicIntakeBody = z
  .object({
    email: EMAIL,
    qtyDeclared: QTY,
    name: PERSON,
    phone: PERSON,
    pickupAddress: ADDRESS,
  })
  .strict();

const ScheduleBody = z
  .object({
    expectedRevision: EXPECTED_REVISION,
    /**
     * NOT REFUSED FOR BEING IN THE PAST, and that is a decision.
     *
     * The UI's date input has `min=today` because a pickup being arranged is
     * normally in the future — but recording one that already happened is
     * ordinary too (a driver rang in, an import backfills last week), and a
     * server rule would turn that into a lie an admin has to type around. The
     * clock the client validates against is also not this one.
     */
    pickupAt: z.number().int().min(0).max(MAX_EPOCH_MS),
    driverName: PERSON,
    driverPhone: PERSON,
    /** Required only when the row carries no address yet — the repository
     *  checks the MERGED row, which is the only place the answer exists. */
    pickupAddress: ADDRESS,
    note: OPTIONAL_NOTE,
  })
  .strict();

/** Contract #9 and #10 — a step with nothing to say but that it happened. */
const StepBody = z
  .object({ expectedRevision: EXPECTED_REVISION, note: OPTIONAL_NOTE })
  .strict();

const InspectBody = z
  .object({
    expectedRevision: EXPECTED_REVISION,
    qtyAccepted: COUNT,
    /**
     * DERIVED IN THE UI (`received − accepted`) AND TYPED BY NOBODY, which is
     * what makes the classic sum-mismatch validation error impossible. It
     * arrives here as a number because the database records what happened, not
     * what the form looked like.
     */
    qtyRejected: COUNT,
    /** Required iff `qtyRejected > 0`, both ways — the repository holds that
     *  rule, because it is a rule about two fields rather than about one. */
    rejectedReason: REASON.optional(),
    note: OPTIONAL_NOTE,
  })
  .strict();

/** Contract #12. The reason is REQUIRED: a refusal a customer cannot be given a
 *  reason for is a support conversation nobody has the record for. */
const RejectBody = z
  .object({ expectedRevision: EXPECTED_REVISION, reason: REASON })
  .strict();

/** Contract #13. The reason is OPTIONAL, unlike a rejection: "the customer
 *  changed their mind" is the common case and inventing a sentence for it is
 *  how reason fields fill up with "n/a". */
const CancelBody = z
  .object({ expectedRevision: EXPECTED_REVISION, reason: REASON.optional() })
  .strict();

/** Contract #14. NO `expectedRevision`: a note is not a change to the return,
 *  and demanding a token would make an editor's stale tab unable to write down
 *  what a customer just said on the phone. */
const NoteBody = z.object({ note: NOTE }).strict();

// -------------------------------------------------------------- wire shapes

/**
 * The request as every response in this subsystem carries it — the row plus
 * what may legally be done to it next.
 *
 * IT IS THE SAME SHAPE THE 409 PAYLOADS CARRY. `invalid_transition` and
 * `stale_write` ship the re-read request so the UI can auto-heal without a
 * second fetch (spec D7), and the screen that renders a conflict is the screen
 * that just rendered a success — one shape, or the heal path is a second
 * renderer nobody exercises. `routes.test.ts` compares the key sets of a 200
 * and a 409 for exactly that reason.
 *
 * `programId` RIDES ALONG, though contract §Types puts the program under its
 * own key. It is on the row, the conflict payload already carries it, and a
 * client holding a request without it cannot tell which program's words to
 * render a stale row in.
 */
export type WireRequest = ReturnRow & { allowedActions: ReturnAction[] };

function wireRequest(row: ReturnRow): WireRequest {
  return { ...row, allowedActions: allowedActionsFor(row.status) };
}

/** Contract §Types `ReturnDetail`. */
export interface ReturnDetailBody {
  request: WireRequest;
  program: EmbeddedProgram & {
    status: 'active' | 'paused';
    pointsPerUnit: number;
    minUnitsPerReturn: number;
  };
  events: ReturnEventRow[];
  emailIntents: EmailIntentState[];
}

/**
 * One return, everything a detail panel draws it from, in three reads.
 *
 * `null` FOR AN UNKNOWN ID rather than a throw, so the GET can answer `gone`
 * and the two creates can treat the same `null` as the impossibility it is
 * there — a row that was just inserted and cannot be read back.
 */
async function readDetail(db: Db, id: string): Promise<ReturnDetailBody | null> {
  const read = await readReturn(db, id);
  if (!read) return null;
  const { request, program } = read;

  const [events, emailIntents] = await Promise.all([
    listEvents(db, id),
    listEmailIntents(db, id),
  ]);

  return {
    request: wireRequest(request),
    program: {
      id: program.id,
      name: program.name,
      pointsLabelSingular: program.pointsLabelSingular,
      pointsLabelPlural: program.pointsLabelPlural,
      unitLabelSingular: program.unitLabelSingular,
      unitLabelPlural: program.unitLabelPlural,
      status: program.status,
      /*
       * NON-NULL BY `marketing_programs_kind_fields_ck` on every row that can
       * reach here: a return is only ever created against a `unit_return`
       * program, and that CHECK ties the kind to these two columns. The
       * fallbacks are what a WIDENED check would get, and both are true
       * statements about this return rather than zeros — the rate the customer
       * was promised (which is what every award is computed from anyway), and a
       * minimum this request is already known to satisfy.
       */
      pointsPerUnit: program.pointsPerUnit ?? request.pointsPerUnitSnapshot,
      minUnitsPerReturn: program.minUnitsPerReturn ?? request.qtyDeclared,
    },
    events,
    emailIntents,
  };
}

/** The detail of a return this request has just written. */
async function readFreshDetail(db: Db, id: string): Promise<ReturnDetailBody> {
  const detail = await readDetail(db, id);
  /*
   * Unreachable: the insert either wrote the row or raised. Checked because the
   * alternative is a 200 with a `null` body on the screen that has just told an
   * admin their return was logged — a plain `Error` becomes a 500 with a
   * requestId, which is the correct answer to "the database did something this
   * code cannot explain".
   */
  if (!detail) throw new Error('marketing: the return was created and cannot be read back');
  return detail;
}

// ------------------------------------------------------------- rate budgets

/**
 * The public intake's two buckets, and the reason there are two.
 *
 * The IP bucket bounds a host; the narrow `ip|email` bucket is what stops one
 * host filling one customer's history with pickup requests. Keyed on the PAIR
 * rather than on the address alone, the `POST /api/auth/forgot` arrangement:
 * a per-email bucket with no IP in it is a denial-of-service primitive against
 * a named customer, since anybody could spend their whole allowance for them.
 *
 * The numbers are choices, not spec: a customer sends back a box occasionally,
 * so three requests an hour for one address is generous, and thirty from one
 * address block covers an office behind one NAT while being useless to a loop.
 * The partial unique index already caps the damage at one OPEN return per
 * email — this bounds the work done discovering that.
 */
export const INTAKE_IP_LIMIT = 30;
export const INTAKE_EMAIL_LIMIT = 3;
export const INTAKE_WINDOW_MS = 60 * 60_000;

// ------------------------------------------------------------------- routes

routes.get('/returns', auth, async (c) => {
  const q = readQuery(c, ListQuery);
  return c.json(await listReturns(currentDb(c), q));
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONTRACT #6 — THE ONE PUBLIC MUTATION, AND IT IS REGISTERED HERE, ABOVE
 * EVERY `/:id` ROUTE, ON PURPOSE.
 *
 * Hono resolves two patterns claiming one path by registration order, and
 * `request` is a legal value for `:id`. Today nothing collides — there is no
 * `POST /returns/:id` — so the ordering costs nothing and buys the guarantee
 * that adding one later cannot silently swallow the customer-facing intake into
 * a route that would answer `gone` for every storefront submission.
 * `routes.test.ts` pins it by driving the real path.
 *
 * NO `auth`. That absence is the route, so it is stated rather than implied: a
 * customer has no session. What stands in its place is `originGuard` (the app
 * mounts this whole sub-app below it, so a cross-origin POST is a 403 — DEPLOY
 * NOTE: the storefront's origin must be in `APP_ORIGINS` or every customer sees
 * one), the rate budgets above, and the fact that the row this writes grants
 * nothing until an admin has scheduled, received and inspected it.
 * ═══════════════════════════════════════════════════════════════════════════
 */
routes.post('/returns/request', async (c) => {
  const ip = clientIp(c);
  /*
   * THE IP BUCKET BEFORE THE BODY IS READ, for the reason the login route gives
   * at length: a limiter cannot bound work that runs after it.
   */
  await limit(c, `mktreq:${ip}`, INTAKE_IP_LIMIT, INTAKE_WINDOW_MS);

  const body = await readJson(c, PublicIntakeBody);

  // The narrow bucket cannot move above the parse: the address it keys on is in
  // the body. Lower-cased here so `Dara@x` and `dara@x` share one budget, the
  // same folding `createRequest` applies before it becomes an identity.
  await limit(
    c,
    `mktreq:${ip}|${body.email.toLowerCase()}`,
    INTAKE_EMAIL_LIMIT,
    INTAKE_WINDOW_MS,
  );

  const db = currentDb(c);
  const row = await createRequest(db, {
    email: body.email,
    qtyDeclared: body.qtyDeclared,
    customerName: body.name,
    customerPhone: body.phone,
    pickupAddress: body.pickupAddress,
    /* The first timeline entry is attributed to the CUSTOMER, and there is no
     * actor id because there is no account. A history that credited every
     * request to whoever happened to be signed in could not answer "did they
     * ask, or did we log it for them". */
    source: 'customer',
    now: Date.now(),
  });

  const read = await readReturn(db, row.id);
  if (!read) throw new Error('marketing: the return was created and cannot be read back');
  const { program } = read;

  /*
   * A NARROW, LABEL-COMPLETE ANSWER — never the admin detail.
   *
   * The storefront renders its confirmation entirely out of this ("we will
   * collect your 6 canisters; each accepted one earns 7 Bottle Caps"), so every
   * word it needs travels, and NOTHING ELSE DOES: no revision, no timeline, no
   * internal ids, no other customer's anything. The label set is the one
   * contract #30 spells out for the public rewards endpoint, so the two public
   * surfaces are rendered from one shape.
   */
  return c.json(
    {
      requestId: row.id,
      qtyDeclared: row.qtyDeclared,
      program: {
        name: program.name,
        pointsLabelSingular: program.pointsLabelSingular,
        pointsLabelPlural: program.pointsLabelPlural,
        unitLabelSingular: program.unitLabelSingular,
        unitLabelPlural: program.unitLabelPlural,
        pointsPerUnit: program.pointsPerUnit ?? row.pointsPerUnitSnapshot,
        minUnitsPerReturn: program.minUnitsPerReturn ?? row.qtyDeclared,
      },
    },
    201,
  );
});

/** Contract #5 — staff logging a return a customer asked for by phone or at the
 *  counter. 201 with the full detail, so the dialog can navigate straight into
 *  the row it just created without a second read. */
routes.post('/returns', auth, async (c) => {
  const db = currentDb(c);
  const body = await readJson(c, AdminIntakeBody);
  const row = await createRequest(db, {
    ...body,
    source: 'admin',
    actorId: currentUser(c).id,
    now: Date.now(),
  });
  return c.json(await readFreshDetail(db, row.id), 201);
});

routes.get('/returns/:id', auth, async (c) => {
  const id = pathParam(c, 'id');
  const detail = await readDetail(currentDb(c), id);
  if (!detail) throw new NotFoundError(id);
  return c.json(detail);
});

/** Contract #8. Also the RESCHEDULE — `scheduled → scheduled` is legal and
 *  emits a second `scheduled` event, so a customer told Tuesday and then
 *  Thursday can see both. */
routes.post('/returns/:id/schedule', auth, async (c) => {
  const id = pathParam(c, 'id');
  const body = await readJson(c, ScheduleBody);
  const row = await schedule(currentDb(c), id, {
    ...body,
    actorId: currentUser(c).id,
    now: Date.now(),
  });
  return c.json({ request: wireRequest(row) });
});

/** Contract #9. The wire value is `collect`; the UI renders it "Picked up". */
routes.post('/returns/:id/collect', auth, async (c) => {
  const id = pathParam(c, 'id');
  const body = await readJson(c, StepBody);
  const row = await collect(currentDb(c), id, {
    ...body,
    actorId: currentUser(c).id,
    now: Date.now(),
  });
  return c.json({ request: wireRequest(row) });
});

/** Contract #10. */
routes.post('/returns/:id/receive', auth, async (c) => {
  const id = pathParam(c, 'id');
  const body = await readJson(c, StepBody);
  const row = await receive(currentDb(c), id, {
    ...body,
    actorId: currentUser(c).id,
    now: Date.now(),
  });
  return c.json({ request: wireRequest(row) });
});

/**
 * Contract #11 — THE write of this subsystem (spec D5).
 *
 * `award` IS NULL WHEN NOTHING WAS ACCEPTED, and that is a shape rather than a
 * zero: a rejection writes no ledger row and no balance, so there is no entry
 * to link to and no number to render. A `{points: 0}` would send the awarded
 * panel down a path where the ledger link 404s.
 */
routes.post('/returns/:id/inspect', auth, async (c) => {
  const id = pathParam(c, 'id');
  const body = await readJson(c, InspectBody);
  const { row, award } = await inspect(currentDb(c), id, {
    ...body,
    actorId: currentUser(c).id,
    now: Date.now(),
  });
  return c.json({ request: wireRequest(row), award });
});

/** Contract #12 — PRE-RECEIPT ONLY. Once the goods are in hand the refusal is
 *  an inspection with zero accepted, which records the quantities; a status
 *  flip there would close a return over a pile nobody counted. */
routes.post('/returns/:id/reject', auth, async (c) => {
  const id = pathParam(c, 'id');
  const body = await readJson(c, RejectBody);
  const row = await reject(currentDb(c), id, {
    ...body,
    actorId: currentUser(c).id,
    now: Date.now(),
  });
  return c.json({ request: wireRequest(row) });
});

/** Contract #13. Legal from `collected` on purpose — the lost-in-transit
 *  escape — and not from `received`. */
routes.post('/returns/:id/cancel', auth, async (c) => {
  const id = pathParam(c, 'id');
  const body = await readJson(c, CancelBody);
  const row = await cancel(currentDb(c), id, {
    ...body,
    actorId: currentUser(c).id,
    now: Date.now(),
  });
  return c.json({ request: wireRequest(row) });
});

/** Contract #14 — an entry in the history and nothing else: no CAS, no revision
 *  bump, legal in every status including the terminal ones. */
routes.post('/returns/:id/notes', auth, async (c) => {
  const id = pathParam(c, 'id');
  const { note } = await readJson(c, NoteBody);
  const event = await addNote(currentDb(c), id, {
    note,
    /* `admin`, not the row's `source`. This is a staff member writing in a
     * staff surface; a customer's own words reach the timeline as a note an
     * admin transcribed, under the name of the person who transcribed them. */
    actorType: 'admin',
    actorId: currentUser(c).id,
    now: Date.now(),
  });
  return c.json({ event }, 201);
});
