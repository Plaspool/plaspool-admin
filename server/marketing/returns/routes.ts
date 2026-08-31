import { Hono } from 'hono';
import { z } from 'zod';
import {
  ForbiddenError,
  pathParam,
  readJson,
  readQuery,
  str,
  toResponse,
  zodDetail,
} from '../../middleware/errors';
import { requireAuth } from '../../middleware/session';
import { isAdminRole } from '../../../shared/roles';
import { currentDb, currentUser } from '../../app-env';
import { loadTemplates } from '../../email/system-templates';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { renderMarketingError } from '../wire';
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
import { listEmailIntents, listReturns, readListItem, MAX_SEARCH_LENGTH } from './query';
import type { AppEnv } from '../../app-env';
import type { Db } from '../../db/client';
import type { ReturnAction } from '../errors';
import type { ReturnEventRow, ReturnRow } from './repo';
import type { EmailIntentState, EmbeddedProgram, ReturnListItem } from './query';

/**
 * The returns lifecycle on the wire — contract #4-14.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY ROUTE HERE IS `requireAuth` — STAFF ONLY, INCLUDING THE INSPECTION
 * THAT AWARDS THE POINTS. The frozen role matrix (spec D12) puts processing
 * returns in any staff member's hands and reserves `requireOwner` for the
 * things that change what a return is WORTH — the program's rate, the
 * settings' economics, a manual adjustment. A writer receiving a box and
 * counting what is in it is the ordinary path; making them fetch the owner to
 * record the count is how the count stops being recorded.
 *
 * THE GUARDS ARE ATTACHED PER ROUTE, NEVER AS `routes.use('*', …)` — see the
 * long version in `../programs/routes.ts`: a blanket `use` would turn every
 * unrouted path under this prefix into a 401 instead of a 404, because the
 * guard would run and refuse a request that had no handler to reach.
 * `routes.test.ts` pins the 404.
 *
 * A CUSTOMER ASKING FOR THEIR OWN RETURN IS NOT IN THIS FILE. That is
 * `POST /me/returns`, gated by a shop session rather than by `auth` here —
 * `./customer.ts`, mounted separately in `../app.ts`. This file is the desk,
 * not the storefront.
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
 * Refusing it instead would gain nothing over the two readers left here: the
 * admin client's own `filled()` already scrubs a blank field before it sends,
 * and the repository does the same for anything reaching it from somewhere
 * other than this file. So blank still normalises to absent — belt and braces
 * rather than a rule either of those two is currently relying on this schema
 * to enforce for them.
 *
 * The bounds keep a pasted document out of a history panel; none of them is a
 * business rule.
 * ═══════════════════════════════════════════════════════════════════════════
 */
/** Exported for `./customer.ts`'s `name` field — the identical blank-means-absent
 *  shape a shopper's own form needs, and this is the one implementation rather
 *  than a second copy of it. */
export function optionalText(max: number) {
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
    /**
     * WHICH BOARD. An area id, or the literal `none` for the returns that belong
     * to no board at all.
     *
     * AN ID AND NOT A SPELLING, unlike the intake's `serviceAreaId`. That field
     * is filled in by a person and has to forgive how they write their own
     * neighbourhood; this one is filled in by the switcher the client just
     * rendered, so a token it cannot resolve is a bug rather than a customer.
     * An unknown id therefore returns an EMPTY board rather than an error —
     * which is the truth about a district with nothing in it.
     */
    district: str().min(1).max(200).optional(),
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

/**
 * The district this return belongs to — an area id from the picker, or any
 * spelling its aliases forgive.
 *
 * NOT `z.string().uuid()` OR AN `area_` PREFIX CHECK. The field is deliberately
 * forgiving (a key, a name, "wuse 2"), because the alternative is refusing a
 * customer for spelling their own neighbourhood their own way — and the
 * resolution happens against the database, which is the only thing that knows
 * what is served today. A shape check here would refuse valid input on the one
 * field where being turned away means "we will not collect from you".
 */
const SERVICE_AREA = str().trim().min(1).max(200);

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
    /**
     * OPTIONAL HERE AND REQUIRED ON THE PUBLIC ROUTE, and the asymmetry is the
     * decision rather than an oversight.
     *
     * A phone-in from out of town is a real request that staff must be able to
     * write down: refusing to record it would not make it stop existing, it
     * would make it exist only in somebody's memory. So the admin may log one
     * with no area, it lands in the switcher's out-of-area footer, and it can be
     * closed with a reason — but it can never be AWARDED, because
     * `marketing_return_requests_area_award_ck` refuses that in the database.
     * The gate is kept at the door for the customer and at the till for us.
     */
    serviceAreaId: SERVICE_AREA.optional(),
    note: OPTIONAL_NOTE,
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
    /**
     * OWNER-ONLY, enforced in the handler rather than by `requireOwner()` on the
     * route — inspecting is any staff member's work (spec D12) and only the
     * top-up is money. A writer sending one gets 403; a writer inspecting
     * without one is the ordinary path and succeeds.
     *
     * The UI does not render the stepper for a writer at all, so this is a
     * backstop rather than a workflow.
     */
    bonusPoints: z.number().int().min(1).max(INT4_MAX).optional(),
    /** Required iff `bonusPoints` is present — the repository holds that rule,
     *  because it is a rule about two fields rather than about one. */
    bonusReason: REASON.optional(),
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

/**
 * The board's multi-select — contract #6.4.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FIFTY, AND THE CEILING IS NOT ARBITRARY.
 *
 * There are no transactions in this application (spec §Global — the Neon HTTP
 * driver throws on `transaction()` while PGlite does not, so one would pass every
 * test here and 500 in production). A bulk call is therefore a LOOP OF SINGLE
 * STATEMENTS, and every one of them is a round trip. Fifty is a selection a
 * person made by clicking, and it is small enough that the slowest case still
 * answers inside a request; five hundred would be a script, and a script should
 * page.
 *
 * `expectedRevision` PER ITEM, not per request. Each card was read at its own
 * moment and each CAS is its own; a single token for the batch would either
 * refuse everything because one card moved, or — far worse — be checked against
 * nothing at all.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const BULK_MAX_ITEMS = 50;

const BulkBody = z
  .object({
    /**
     * NO `inspect`. Counting what arrived is a form per return — the quantities
     * differ by definition — so "inspect fifty returns with one body" is a
     * sentence with no meaning. The board greys it whenever a selection contains
     * a received card, and this schema is why that is a contract rather than a
     * UI convention.
     */
    action: z.enum(['schedule', 'collect', 'receive', 'cancel', 'reject', 'note']),
    items: z
      .array(
        z
          .object({ id: str().min(1).max(200), expectedRevision: EXPECTED_REVISION })
          .strict(),
      )
      .min(1)
      .max(BULK_MAX_ITEMS),
    /** The action's own fields, applied to every item. Validated per action
     *  below, against the SAME schema the single-item route uses — so a body the
     *  bulk path accepts is a body the single path would have accepted. */
    body: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * One action, one body schema — the same objects the single-item routes parse.
 *
 * SHARED RATHER THAN RESTATED, because the alternative is a bulk path that
 * accepts a `pickupAt` in the past, or a reject with no reason, on the day
 * somebody tightens the single-item rule and forgets this one.
 *
 * `note` REUSES THE TRANSITION SHAPE, not `NoteBody`: the bulk item already
 * carries `expectedRevision` for every action, and demanding that the note body
 * NOT carry one would make the client special-case a single verb.
 */
const BULK_BODIES = {
  schedule: ScheduleBody.omit({ expectedRevision: true }),
  collect: StepBody.omit({ expectedRevision: true }),
  receive: StepBody.omit({ expectedRevision: true }),
  cancel: CancelBody.omit({ expectedRevision: true }),
  reject: RejectBody.omit({ expectedRevision: true }),
  note: NoteBody,
} as const;

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

/** Contract #6.4's per-item outcome. `request` on success is the LIST shape, so
 *  the board can swap the card it just moved without a refetch; `error` on
 *  failure is a code from the frozen catalogue. */
export type BulkResult =
  | { id: string; ok: true; request: ReturnListItem }
  | { id: string; ok: false; error: string };

/**
 * What ONE failed item is called, in the vocabulary the catalogue already froze.
 *
 * MARKETING'S OWN TABLE FIRST, then the shared one — the exact order
 * `marketing/app.ts`'s `onError` uses, because a bulk item that fails has to be
 * given the same name it would have had on its own route or the client needs two
 * error vocabularies for one state machine.
 *
 * THE SHARED HALF IS READ OUT OF A REAL `Response`, and that is deliberate
 * rather than lazy: `toResponse` is the one implementation of the global table,
 * it is not otherwise exported as a code, and re-deriving `gone` / `bad_request`
 * / `stale_write` here would be a third copy of a mapping this application has
 * already written twice. Fifty items is fifty tiny Responses that are never
 * sent, which costs nothing measurable and cannot drift.
 */
async function codeOf(err: unknown, requestId: string): Promise<string> {
  const rendered = renderMarketingError(err);
  if (rendered) return String(rendered.body.error);
  const body = (await toResponse(err, requestId).json()) as { error?: string };
  return body.error ?? 'internal';
}

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

// ------------------------------------------------------------------- routes

routes.get('/returns', auth, async (c) => {
  const q = readQuery(c, ListQuery);
  return c.json(await listReturns(currentDb(c), q));
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONTRACT #6.4 — THE BOARD'S MULTI-SELECT. 200 EVEN WHEN SOME OF IT FAILED.
 *
 * PARTIAL SUCCESS IS THE TRUTH, so it is what the response says. There are no
 * transactions here (spec §Global), which means a bulk call IS a loop of single
 * statements and there is no honest way to roll the successful ones back. A
 * route that answered 409 because one of five cards had moved would leave four
 * transitions applied behind an error, and the screen would have to guess which.
 *
 * So every item reports its own outcome and the UI says "4 of 5 scheduled — Tolu
 * Bassey moved on while you were choosing", refreshes that one card from the
 * `request` the failure carries, and leaves the other four alone.
 *
 * EVERY ITEM RUNS THE REAL TRANSITION. Not a bulk `UPDATE … WHERE id IN (…)` —
 * that would skip the CAS, the timeline entry, the guard that says reject is
 * illegal after receipt, and every argument in `repo.ts`. Fifty calls to the
 * same functions the single-item routes call is the whole design: there is one
 * state machine, and the board is a second way to press its buttons.
 *
 * REGISTERED ABOVE THE `/:id` ROUTES: `bulk` is a legal value for `:id`, and
 * today nothing collides, so the ordering costs nothing and buys the
 * guarantee. `routes.test.ts` pins it.
 * ═══════════════════════════════════════════════════════════════════════════
 */
routes.post('/returns/bulk', auth, async (c) => {
  const db = currentDb(c);
  const { action, items, body } = await readJson(c, BulkBody);

  /*
   * THE SHARED BODY IS PARSED ONCE, BEFORE ANY WRITE. A malformed body is a 400
   * about the request rather than fifty identical per-item failures — and
   * parsing it inside the loop would apply the first N before discovering it.
   */
  const parsed = BULK_BODIES[action].safeParse(body ?? {});
  if (!parsed.success) throw new BadRequestError(zodDetail(parsed.error));
  const fields = parsed.data as Record<string, unknown>;

  const actorId = currentUser(c).id;
  /* ONE clock reading for the batch, so fifty rows scheduled together carry one
   * `updated_at` and the timeline reads as the single act it was. */
  const now = Date.now();

  const results: BulkResult[] = [];
  for (const item of items) {
    const cas = { expectedRevision: item.expectedRevision, actorId, now };
    try {
      switch (action) {
        case 'schedule':
          await schedule(db, item.id, { ...(fields as { pickupAt: number }), ...cas });
          break;
        case 'collect':
          await collect(db, item.id, { ...fields, ...cas });
          break;
        case 'receive':
          await receive(db, item.id, { ...fields, ...cas });
          break;
        case 'cancel':
          await cancel(db, item.id, { ...fields, ...cas });
          break;
        case 'reject':
          await reject(db, item.id, { ...(fields as { reason: string }), ...cas });
          break;
        case 'note':
          /* No CAS: a note is not a change to the return and bumps nothing. The
           * item's `expectedRevision` is accepted and ignored, because a client
           * that had to omit one field for one verb is a client that will send
           * it anyway. */
          await addNote(db, item.id, {
            note: String(fields.note),
            actorType: 'admin',
            actorId,
            now,
          });
          break;
      }
      /*
       * RE-READ IN THE LIST'S OWN SHAPE. The board replaces the card it just
       * moved from this, so it has to be the same object a refresh would give —
       * including the program's labels and the district's name, which the
       * transition's own return value does not carry.
       */
      const request = await readListItem(db, item.id);
      results.push(request ? { id: item.id, ok: true, request } : { id: item.id, ok: false, error: 'gone' });
    } catch (err) {
      /*
       * THE SAME CODES THE SINGLE-ITEM ROUTES ANSWER WITH, from the same table
       * (`../wire.ts`) — so a card that fails inside a selection of ten gets the
       * treatment the catalogue already froze for it, and the screen needs no
       * second vocabulary. An error the table does not know falls through to the
       * shared handler exactly as it would on its own route.
       */
      results.push({ id: item.id, ok: false, error: await codeOf(err, c.get('requestId') ?? '') });
    }
  }

  return c.json({ results });
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
  const user = currentUser(c);

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * THE BONUS IS THE OWNER'S; THE INSPECTION IS ANYBODY'S.
   *
   * `requireOwner()` on this route would be wrong — it would make a writer fetch
   * the owner to record what arrived in a box, and a count that needs a second
   * person is a count that stops being recorded (spec D12's role matrix). So the
   * guard is on the FIELD, not the route: minting points above the programme's
   * rate is money, and money is owner-only here as it is everywhere else in this
   * subsystem.
   *
   * REFUSED BEFORE ANYTHING IS WRITTEN, so a writer who somehow submitted a
   * bonus does not get an award recorded with the top-up silently dropped —
   * which would be the worst of the three outcomes, because the screen would say
   * 145 and the customer would have 120.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  if (body.bonusPoints !== undefined && !isAdminRole(user.role)) throw new ForbiddenError();

  const db = currentDb(c);
  /*
   * RESOLVED HERE, ONCE, exactly as `server/shop/orders/routes.ts` resolves
   * its own `TemplateSet` before a write: `loadTemplates` never throws, so a
   * template read that fails degrades the award letter's wording rather than
   * the inspection itself, and an owner's edit to "Return: points awarded"
   * only reaches a customer if this is threaded through — `inspect()`'s
   * default is the built-ins, for every caller that does not do this.
   */
  const templates = await loadTemplates(db);
  const { row, award, bonus } = await inspect(
    db,
    id,
    {
      ...body,
      actorId: user.id,
      now: Date.now(),
    },
    templates,
  );
  return c.json({ request: wireRequest(row), award, bonus });
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
