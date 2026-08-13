/**
 * Spec §Error catalogue, pinned at the wire.
 *
 * WHY THIS SUITE EXISTS BEFORE ANY ROUTE DOES. The catalogue is a contract
 * between two streams building in parallel: every code and every payload key
 * below has a UI treatment written against it, and Stream B's screens are being
 * built against fixtures that key on these exact strings. A dropped `existingId`
 * is not a smaller payload — it is a dead-end where the admin was promised a
 * link to the return that is already open. So each row is asserted by EQUALITY
 * rather than by containment: an added key fails as loudly as a missing one.
 *
 * IT DRIVES THE REAL HANDLER THROUGH A REAL REQUEST rather than calling the
 * renderer directly. What is being tested is the seam — that `marketingApp()`'s
 * `onError` is attached, that mounting it into a parent does not shadow it, and
 * that what a client receives is the body plus a `requestId` plus the header.
 * A unit test of a pure function would pass with the handler never wired.
 *
 * NO DATABASE. Nothing here reaches one, and the mount assertions at the bottom
 * hand `createApp` a factory that THROWS if anything resolves a handle — which
 * is how "an unrouted path answers 404 without touching Postgres" is proved
 * rather than assumed (`server/app-env.ts` records what it cost to learn).
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../index';
import { TEST_ORIGIN } from '../test/http';
import { toResponse } from '../middleware/errors';
import {
  ForbiddenError,
  RateLimitedError,
  UnauthenticatedError,
} from '../middleware/errors';
import { BadRequestError, NotFoundError } from '../repo/errors';
import { MailNotConfiguredError } from '../mail/port';
import { MARKETING_PREFIX, createMarketingPublicRoutes, marketingApp } from './app';
import {
  AlreadyAwardedError,
  BelowMinimumError,
  DuplicateCodeError,
  DuplicateProgramKeyError,
  InsufficientBalanceError,
  InvalidTransitionError,
  ProgramPausedError,
  ProgramTypeMismatchError,
  RedemptionDisabledError,
  ReturnAlreadyOpenError,
  StaleMarketingWriteError,
} from './errors';
import type { MarketingEntity } from './errors';
import type { AppEnv } from '../app-env';
import type { Db } from '../db/client';

const RID = 'req-fixed-for-assertions';
const PROBE = `/api${MARKETING_PREFIX}/probe`;

/**
 * The re-read row a conflict carries. Absurd labels throughout (spec D11) — the
 * seeded preset's noun may not appear in a fixture any more than in source.
 */
const REQUEST = {
  id: 'ret_a1b2',
  status: 'received' as const,
  revision: 4,
  customerEmail: 'dara@example.test',
  qtyDeclared: 6,
  program: { id: 'prg_caps', name: 'Cap Returns' },
};

const PROGRAM = { id: 'prg_caps', key: 'bottle-caps', name: 'Cap Returns', revision: 4 };

/**
 * `marketingApp()` with one route that throws, mounted exactly as
 * `server/index.ts` mounts it: under a parent that mints the request id and
 * falls back to `toResponse`.
 *
 * The parent's own handler is deliberately the GLOBAL one, so a code that only
 * marketing knows about can only come from marketing's `onError` — which is the
 * property "mounted, and not shadowed" actually means.
 */
function probeApp(err: unknown): Hono<AppEnv> {
  const marketing = marketingApp();
  marketing.get('/probe', () => {
    throw err;
  });

  const parent = new Hono<AppEnv>();
  parent.use('*', async (c, next) => {
    c.set('requestId', RID);
    await next();
  });
  parent.onError((e, c) => toResponse(e, c.get('requestId') ?? ''));
  parent.route(`/api${MARKETING_PREFIX}`, marketing);
  return parent;
}

async function thrown(err: unknown): Promise<{ res: Response; body: Record<string, unknown> }> {
  const res = await probeApp(err).request(PROBE);
  return { res, body: (await res.json()) as Record<string, unknown> };
}

// ------------------------------------------------------------ the catalogue

describe('the marketing error catalogue', () => {
  const rows: [string, unknown, number, Record<string, unknown>][] = [
    [
      'below_minimum',
      new BelowMinimumError(4),
      400,
      { error: 'below_minimum', detail: 'qtyDeclared', min: 4 },
    ],
    [
      'invalid_transition',
      new InvalidTransitionError('received', 'schedule', REQUEST),
      409,
      { error: 'invalid_transition', status: 'received', action: 'schedule', request: REQUEST },
    ],
    [
      'stale_write',
      new StaleMarketingWriteError(3, 4, 'program', PROGRAM),
      409,
      { error: 'stale_write', expected: 3, actual: 4, program: PROGRAM },
    ],
    [
      'already_awarded',
      new AlreadyAwardedError('pts_seen'),
      409,
      { error: 'already_awarded', entryId: 'pts_seen' },
    ],
    [
      'return_already_open',
      new ReturnAlreadyOpenError('ret_open', 'scheduled'),
      409,
      { error: 'return_already_open', existingId: 'ret_open', status: 'scheduled' },
    ],
    ['program_paused', new ProgramPausedError(), 409, { error: 'program_paused' }],
    [
      'program_type_mismatch',
      new ProgramTypeMismatchError(),
      409,
      { error: 'program_type_mismatch' },
    ],
    [
      'insufficient_balance',
      new InsufficientBalanceError(40),
      409,
      { error: 'insufficient_balance', balance: 40 },
    ],
    ['redemption_disabled', new RedemptionDisabledError(), 409, { error: 'redemption_disabled' }],
    [
      'duplicate_program_key',
      new DuplicateProgramKeyError('bottle-caps'),
      409,
      { error: 'duplicate_program_key', key: 'bottle-caps' },
    ],
    [
      'duplicate_code',
      new DuplicateCodeError('SAVE10'),
      409,
      { error: 'duplicate_code', code: 'SAVE10' },
    ],
    [
      'mail_not_configured',
      new MailNotConfiguredError(['RESEND_API_KEY']),
      501,
      { error: 'mail_not_configured' },
    ],
  ];

  for (const [code, err, status, extras] of rows) {
    it(`answers ${code} with ${status} and exactly the payload the catalogue names`, async () => {
      const { res, body } = await thrown(err);
      expect(res.status).toBe(status);
      // EQUALITY, not containment: this is what makes a dropped key — or a
      // helpfully-added one the client never learns to read — a red test.
      expect(body).toEqual({ ...extras, requestId: RID });
    });
  }

  it('carries the request id in the header as well as the body', async () => {
    // Every response in this application does (spec §8). A domain error rendered
    // by a local handler is the easiest place to forget it, because the header is
    // set by `toResponse` for everything else.
    const { res } = await thrown(new ProgramPausedError());
    expect(res.headers.get('x-request-id')).toBe(RID);
    expect(res.headers.get('content-type')).toBe('application/json; charset=UTF-8');
  });

  it('is marketing’s own handler talking, not the global table', async () => {
    /*
     * THE MOUNT ASSERTION. `ProgramPausedError` subclasses
     * `PreconditionFailedError` on purpose, so the global handler answers it
     * 409 `precondition_failed` — a correct-status fallback and a code no
     * marketing screen knows. Seeing `program_paused` therefore proves the
     * sub-app's `onError` ran, and seeing the fallback below proves the two
     * really do differ (i.e. that the first assertion is not passing by
     * accident).
     */
    const { body } = await thrown(new ProgramPausedError());
    expect(body.error).toBe('program_paused');

    const global = (await toResponse(new ProgramPausedError(), RID).json()) as {
      error: string;
    };
    expect(global.error).toBe('precondition_failed');
  });

  it('names the stale entity by the field the client reads, never as a post', async () => {
    /*
     * Five revisioned entities and none of them is a blog post, so the payload
     * cannot use the shared `post` key (spec D7). The conflict notice's "Load
     * theirs" renders from THIS field, so `program` vs `programs` vs `post` is
     * the difference between a working banner and an empty one.
     */
    const entities: MarketingEntity[] = [
      'program',
      'settings',
      'request',
      'banner',
      'discount',
    ];
    for (const entity of entities) {
      const { body } = await thrown(
        new StaleMarketingWriteError(1, 2, entity, { id: 'x', revision: 2 }),
      );
      expect(body[entity]).toEqual({ id: 'x', revision: 2 });
      expect(body).not.toHaveProperty('post');
    }
  });

  it('renders 501 mail_not_configured where the global table says not_implemented', async () => {
    /*
     * THE DELIBERATE DEVIATION, and the reason this mapping is not redundant.
     * `server/middleware/errors.ts` answers `MailNotConfiguredError` with
     * `{error:'not_implemented', feature:'mail-delivery'}` — right for the
     * password-reset route, where the feature is simply unavailable. For the
     * sweep it means "there is queued mail this deployment cannot deliver yet",
     * which spec D6 makes a persistent setup banner counting the queue; Stream
     * B's fixtures key that banner on `mail_not_configured` and would render
     * nothing for `not_implemented`.
     *
     * Asserting BOTH renderings is the point: it fails if either half moves.
     */
    const { res, body } = await thrown(new MailNotConfiguredError(['RESEND_API_KEY']));
    expect(res.status).toBe(501);
    expect(body).toEqual({ error: 'mail_not_configured', requestId: RID });
    // No `feature`: a second field naming the same condition is a second thing
    // to keep in step, and A7 pins this body exactly.
    expect(body).not.toHaveProperty('feature');

    const global = await toResponse(new MailNotConfiguredError(['RESEND_API_KEY']), RID).json();
    expect(global).toEqual({
      error: 'not_implemented',
      feature: 'mail-delivery',
      requestId: RID,
    });
  });
});

// ------------------------------------------------------- everything it does not render

describe('everything else falls through to the shared table', () => {
  const rows: [string, unknown, number, Record<string, unknown>][] = [
    ['unauthenticated', new UnauthenticatedError(), 401, { error: 'unauthenticated' }],
    ['forbidden', new ForbiddenError(), 403, { error: 'forbidden' }],
    ['gone', new NotFoundError('ret_nope'), 404, { error: 'gone' }],
    ['bad_request', new BadRequestError('email'), 400, { error: 'bad_request', detail: 'email' }],
  ];

  for (const [code, err, status, extras] of rows) {
    it(`answers ${code} exactly as every other router does`, async () => {
      const { res, body } = await thrown(err);
      expect(res.status).toBe(status);
      expect(body).toEqual({ ...extras, requestId: RID });
    });
  }

  it('keeps the Retry-After HEADER on a rate limit, which a local re-render would lose', async () => {
    /*
     * The concrete reason `render()` refuses to answer rows it was not asked to:
     * `toResponse` sets a header as well as a body here, and the public intake's
     * countdown reads it. A well-meaning `{error:'rate_limited', retryAfter}`
     * rendered locally would look identical in a body assertion and silently
     * drop the header.
     */
    const { res, body } = await thrown(new RateLimitedError(30));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(body).toEqual({ error: 'rate_limited', retryAfter: 30, requestId: RID });
  });

  it('answers an unexpected throw with the shared 500, leaking nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { res, body } = await thrown(new TypeError('undefined is not a function'));
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'internal', requestId: RID });
    vi.restoreAllMocks();
  });
});

// ------------------------------------------------------------ the escape hatch

describe('a marketing error that escapes this handler', () => {
  /*
   * SPEC D7's LOAD-BEARING CLAIM: the domain errors subclass shared ones "so the
   * global handler still maps them". This is what that buys, and it is worth a
   * test because the cost of losing it is invisible until production — a repo
   * function called from a future route mounted elsewhere raises
   * `AlreadyAwardedError`, the global handler does not recognise it, and a
   * REPLAYED INSPECTION becomes a 500 that the client's retry policy re-sends
   * five times.
   */
  const errors: [string, unknown, number][] = [
    ['BelowMinimumError', new BelowMinimumError(4), 400],
    ['InvalidTransitionError', new InvalidTransitionError('received', 'schedule', REQUEST), 409],
    ['StaleMarketingWriteError', new StaleMarketingWriteError(3, 4, 'program', PROGRAM), 409],
    ['AlreadyAwardedError', new AlreadyAwardedError('pts_seen'), 409],
    ['ReturnAlreadyOpenError', new ReturnAlreadyOpenError('ret_open', 'scheduled'), 409],
    ['ProgramPausedError', new ProgramPausedError(), 409],
    ['ProgramTypeMismatchError', new ProgramTypeMismatchError(), 409],
    ['InsufficientBalanceError', new InsufficientBalanceError(40), 409],
    ['RedemptionDisabledError', new RedemptionDisabledError(), 409],
    ['DuplicateProgramKeyError', new DuplicateProgramKeyError('bottle-caps'), 400],
    ['DuplicateCodeError', new DuplicateCodeError('SAVE10'), 400],
  ];

  for (const [name, err, status] of errors) {
    it(`${name} is still a retry-stopping ${status} through the global table`, () => {
      const res = toResponse(err, RID);
      expect(res.status).toBe(status);
      // The property that actually matters, stated separately so a future
      // status change still fails the right assertion.
      expect(res.status).toBeLessThan(500);
    });
  }

  it('lands the duplicates and the minimum on the field the form would highlight', async () => {
    // `detail` survives the fallback because these three extend `BadRequestError`
    // with the field name — so even the degraded answer is inline-able.
    for (const [err, detail] of [
      [new BelowMinimumError(4), 'qtyDeclared'],
      [new DuplicateProgramKeyError('bottle-caps'), 'key'],
      [new DuplicateCodeError('SAVE10'), 'code'],
    ] as const) {
      const body = (await toResponse(err, RID).json()) as { detail: string };
      expect(body.detail).toBe(detail);
    }
  });
});

// ---------------------------------------------------------------- the mounts

describe('the mount in server/index.ts', () => {
  /**
   * A handle that fails loudly if anything resolves it.
   *
   * The assertions below are about paths that must answer WITHOUT a database:
   * an unrouted path and a cookieless public one. `createApp` publishes the
   * factory lazily and `sessionMiddleware` only calls it when a cookie is
   * present, so a throw here means a regression in one of those two — the
   * difference between a 404 and a 500 on a deployment whose `DATABASE_URL` is
   * wrong (`server/app-env.ts`).
   */
  const noDb = (): Db => {
    throw new Error('this path must answer without resolving a database handle');
  };

  const app = () => createApp({ db: noDb, origins: [TEST_ORIGIN] });

  it('answers an unknown /api/marketing path 404 gone, and never 401', async () => {
    /*
     * PER-ROUTE AUTH, ASSERTED FROM THE OUTSIDE. The shortcut for a subsystem
     * where nearly every route needs a session is `marketing.use('*',
     * requireAuth())` — and because `app.route()` flattens a router into its
     * parent, that guard would then run for every path under `/api/marketing`
     * INCLUDING ones no handler exists for. The blog side measured exactly this:
     * an unrouted path answered 401 instead of 404
     * (`server/shop/catalog/routes.ts`). This test goes red the day somebody
     * takes the shortcut.
     *
     * Mount PROOF — a route that exists and answers — is deferred to the tasks
     * that add routes: an unrouted path 404s identically whether or not the
     * sub-app is mounted, and inventing a route here to prove the mount would be
     * a route nothing else needs.
     */
    const res = await app().request('/api/marketing/no-such-thing');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'gone' });
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('answers an unknown public marketing path 404 gone, cookieless', async () => {
    // The public router is mounted ABOVE `sessionMiddleware` (spec D8), so this
    // request resolves no session and reads no cookie — which is what makes the
    // `Cache-Control: public` A9 adds safe by construction rather than by
    // review. The throwing handle above is the proof that nothing resolved.
    const res = await app().request('/api/public/marketing/no-such-thing');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'gone' });
  });

  it('mounts an app and a public router that are separate objects', () => {
    // Two routers, two mount positions, two different security postures. A
    // single object mounted twice would put the cookieless guarantee and the
    // session-bearing routes in one route table.
    expect(marketingApp()).not.toBe(createMarketingPublicRoutes());
    expect(MARKETING_PREFIX).toBe('/marketing');
  });
});
