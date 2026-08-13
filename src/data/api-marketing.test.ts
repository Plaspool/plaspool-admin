import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, AuthExpiredError, NotFoundError, OfflineError, StaleWriteError } from './errors';
import {
  awardSentence,
  awardedSubject,
  deriveBannerStatus,
  fmtPoints,
  fmtUnits,
  marketingApi,
  type Program,
} from './api-marketing';
import * as everyFixture from './marketing-fixtures';
import {
  ALLOWED_ACTIONS,
  NOW,
  banners,
  capsLabels,
  capsProgram,
  collectedRow,
  customerSummary,
  goodwillLabels,
  ledgerWalk,
  receivedRow,
  requestedOld,
  returnCounts,
  returnDetails,
  returnRows,
  scheduledRow,
} from './marketing-fixtures';

/**
 * The marketing client, pinned on the three things that are silent when wrong.
 *
 * **A PATH, A METHOD AND A QUERY KEY HAVE NO COMPILER BEHIND THEM.** Every one
 * of the twenty-odd routes below is a string this module remembers on behalf of
 * a backend built in a different session against the same frozen contract, and
 * every schema on the other end is `.strict()` — so a `q` where the route wants
 * `query`, or a `?limit=` on a list that does not paginate, is a 400 raised a
 * long way from the line that caused it. Two of them are asserted character by
 * character because they are the ones a reader would "fix": the returns list
 * searches on `q` and the customer directory searches on `query`, deliberately,
 * because that is what the contract says.
 *
 * **AN EMPTY FIELD IS NOT AN ABSENT ONE.** A form's untouched optional input is
 * `''`, which a `str().min(1).optional()` schema refuses rather than ignores.
 * The counterpart matters more: `0` must survive, because `qtyAccepted: 0` is a
 * complete rejection — the one inspection that awards nothing — and a client
 * that treated it as "unfilled" would turn it into a 400 on the busiest form in
 * the section.
 *
 * **THE ERROR CLASSES ARE WHAT EVERY SCREEN BRANCHES ON.** `stale_write` becomes
 * `StaleWriteError` and carries its entity under the entity's OWN key (never
 * `post` — that field is the blog's and is null here); every other 409 stays an
 * `ApiError` whose `code` and `body` the auto-heal reads. Those are decisions
 * made in `api.ts` for a different surface, and this file is where marketing
 * finds out whether they still hold.
 *
 * `fetch` IS STUBBED, NOT `apiFetch` — mocking the request function would assert
 * none of the above. The idiom is `api-shop.test.ts`'s, next door.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function reply(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Every wrapper key any marketing route answers with, so one body serves them
 *  all — the routes are asserted here, the shapes by the screens' own suites. */
const ANY_BODY = {
  programs: [],
  program: { id: 'prg_1', revision: 2 },
  items: [],
  nextCursor: null,
  counts: {},
  request: { id: 'ret_1', revision: 2 },
  award: null,
  event: { id: 'mev_1' },
  entry: { id: 'pts_1' },
  balance: 0,
  settings: { revision: 3 },
  banners: [],
  banner: { id: 'bnr_1' },
  discounts: [],
  sent: 0,
  failed: 0,
  skipped: 0,
};

/** The last request's `[url, init]`. */
function lastCall(): [string, RequestInit] {
  return fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
}

/** The path and query of the last request — the assertion target for a route. */
function asked(): string {
  return lastCall()[0];
}

function method(): string {
  return String(lastCall()[1].method);
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(String(lastCall()[1].body)) as Record<string, unknown>;
}

function answers(status: number, body: unknown): void {
  // A FRESH `Response` PER CALL: a body can be read once, and reusing one makes
  // the second request fail inside `res.text()` for no reason a reader can see.
  fetchMock.mockImplementation(() => Promise.resolve(reply(status, body)));
}

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(reply(200, ANY_BODY)));
  vi.stubGlobal('fetch', fetchMock);
});

// ============================================================================
// ROUTES
// ============================================================================

describe('programs', () => {
  it('reads the list out of `programs`', async () => {
    answers(200, { programs: [capsProgram] });
    expect(await marketingApi.listPrograms()).toEqual([capsProgram]);
    expect(asked()).toBe('/api/marketing/programs');
    expect(method()).toBe('GET');
  });

  it('sends the session cookie, without which every route answers 401', async () => {
    await marketingApi.listPrograms();
    expect(lastCall()[1].credentials).toBe('include');
  });

  it('creates a program and unwraps the one it made', async () => {
    answers(200, { program: capsProgram });
    const created = await marketingApi.createProgram({
      key: 'bottle-caps',
      kind: 'unit_return',
      name: 'Canister Returns',
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
      unitLabelSingular: 'canister',
      unitLabelPlural: 'canisters',
      minUnitsPerReturn: 4,
      pointsPerUnit: 7,
    });
    expect(created).toEqual(capsProgram);
    expect(asked()).toBe('/api/marketing/programs');
    expect(method()).toBe('POST');
  });

  it('patches by id with the CAS token', async () => {
    answers(200, { program: everyFixture.renamedProgram });
    const patched = await marketingApi.patchProgram('prg_caps', {
      expectedRevision: 3,
      name: 'Canister Returns',
    });
    // Unwrapped from `{program}` exactly as the POST is. Read as a bare row this
    // hands the editor `undefined` and the bumped revision goes missing, so the
    // next save CASes against a number the store has already passed.
    expect(patched).toEqual(everyFixture.renamedProgram);
    expect(asked()).toBe('/api/marketing/programs/prg_caps');
    expect(method()).toBe('PATCH');
    expect(sentBody()).toEqual({ expectedRevision: 3, name: 'Canister Returns' });
  });

  it('NEVER SENDS `key` OR `kind`, even when the editor holds a whole program', async () => {
    /*
     * The rename-safety wall from this side. The editor's state is a program
     * row, so the tempting save is "post the row back"; the server's `.strict()`
     * schema would 400 it, and the field it would name is the one column no
     * rename is allowed to touch.
     */
    const { revision, name, pointsLabelSingular, pointsLabelPlural } = capsProgram;
    await marketingApi.patchProgram(capsProgram.id, {
      expectedRevision: revision,
      name,
      pointsLabelSingular,
      pointsLabelPlural,
    });
    expect(sentBody()).not.toHaveProperty('key');
    expect(sentBody()).not.toHaveProperty('kind');
  });
});

describe('returns', () => {
  it('asks for a view and drops the filters nobody set', async () => {
    await marketingApi.listReturns('needs_action');
    expect(asked()).toBe('/api/marketing/returns?view=needs_action');
  });

  it('carries the search, the program filter and the cursor', async () => {
    await marketingApi.listReturns('all', {
      q: 'dara@example.com',
      programId: 'prg_caps',
      cursor: 'ret_9',
      limit: 50,
    });
    expect(asked()).toBe(
      '/api/marketing/returns?view=all&q=dara%40example.com&programId=prg_caps&cursor=ret_9&limit=50',
    );
  });

  it('sends no `?q=` at all when the search box is empty', async () => {
    // A blank filter is a present field with an unacceptable value to a
    // `.strict()` schema — a 400 where the operator meant "no filter".
    await marketingApi.listReturns('requested', { q: '', programId: '' });
    expect(asked()).toBe('/api/marketing/returns?view=requested');
  });

  it('posts an admin intake without the optional boxes the form left blank', async () => {
    answers(200, returnDetails.requested);
    const created = await marketingApi.createReturn({
      email: 'dara@example.com',
      qtyDeclared: 6,
      customerName: '',
      customerPhone: '',
      pickupAddress: '12 Adeola Odeku Street, Lagos',
      note: '',
    });
    // #5 answers the DETAIL BARE — no wrapper, unlike every other create on this
    // surface. Reaching for a key here would hand the queue `undefined` and call
    // it the row it just made.
    expect(created).toEqual(returnDetails.requested);
    expect(asked()).toBe('/api/marketing/returns');
    expect(method()).toBe('POST');
    expect(sentBody()).toEqual({
      email: 'dara@example.com',
      qtyDeclared: 6,
      pickupAddress: '12 Adeola Odeku Street, Lagos',
    });
  });

  it('reads a detail by id and escapes an id that would change the path', async () => {
    answers(200, returnDetails.received);
    expect(await marketingApi.getReturn(receivedRow.id)).toEqual(returnDetails.received);
    expect(asked()).toBe(`/api/marketing/returns/${receivedRow.id}`);

    await marketingApi.getReturn('ret/../../admin');
    expect(asked()).toBe('/api/marketing/returns/ret%2F..%2F..%2Fadmin');
  });

  it('posts every transition to its own path and unwraps `request`', async () => {
    answers(200, { request: returnDetails.scheduled.request });

    const scheduled = await marketingApi.schedule('ret_1', {
      expectedRevision: 1,
      pickupAt: NOW + DAY,
    });
    expect(scheduled).toEqual(returnDetails.scheduled.request);
    expect(asked()).toBe('/api/marketing/returns/ret_1/schedule');
    expect(method()).toBe('POST');

    await marketingApi.collect('ret_1', { expectedRevision: 2 });
    expect(asked()).toBe('/api/marketing/returns/ret_1/collect');

    await marketingApi.receive('ret_1', { expectedRevision: 3 });
    expect(asked()).toBe('/api/marketing/returns/ret_1/receive');

    await marketingApi.reject('ret_1', { expectedRevision: 1, reason: 'Not ours' });
    expect(asked()).toBe('/api/marketing/returns/ret_1/reject');
    expect(sentBody()).toEqual({ expectedRevision: 1, reason: 'Not ours' });

    await marketingApi.cancel('ret_1', { expectedRevision: 1 });
    expect(asked()).toBe('/api/marketing/returns/ret_1/cancel');
    // No reason given and none invented: cancel's is optional, reject's is not.
    expect(sentBody()).toEqual({ expectedRevision: 1 });
  });

  it('drops the driver fields nobody filled in on a schedule', async () => {
    await marketingApi.schedule('ret_1', {
      expectedRevision: 2,
      pickupAt: NOW + DAY,
      driverName: '',
      driverPhone: '',
      note: 'Back gate, ask for Musa',
    });
    expect(sentBody()).toEqual({
      expectedRevision: 2,
      pickupAt: NOW + DAY,
      note: 'Back gate, ask for Musa',
    });
  });

  it('sends the inspection exactly as the contract spells it', async () => {
    await marketingApi.inspect(receivedRow.id, {
      expectedRevision: 4,
      qtyAccepted: 5,
      qtyRejected: 1,
      rejectedReason: 'Damaged — one canister split',
      note: '',
    });
    expect(asked()).toBe(`/api/marketing/returns/${receivedRow.id}/inspect`);
    expect(method()).toBe('POST');
    expect(sentBody()).toEqual({
      expectedRevision: 4,
      qtyAccepted: 5,
      qtyRejected: 1,
      rejectedReason: 'Damaged — one canister split',
    });
  });

  it('KEEPS A ZERO ACCEPTED COUNT, which is a rejection and not an empty field', async () => {
    /*
     * "Reject everything" goes through `/inspect` with `qtyAccepted: 0` so the
     * quantities are still recorded. A client that pruned falsy values would
     * strip the number that makes it a rejection and send a body the server
     * refuses for a missing field.
     */
    await marketingApi.inspect(receivedRow.id, {
      expectedRevision: 4,
      qtyAccepted: 0,
      qtyRejected: 6,
      rejectedReason: 'Not ours — different brand entirely',
    });
    expect(sentBody().qtyAccepted).toBe(0);
    expect(sentBody().qtyRejected).toBe(6);
  });

  it('unwraps the award off an inspection', async () => {
    answers(200, { request: returnDetails.awarded.request, award: { points: 35, balance: 180 } });
    const result = await marketingApi.inspect(receivedRow.id, {
      expectedRevision: 4,
      qtyAccepted: 5,
      qtyRejected: 1,
      rejectedReason: 'Damaged — one canister split',
    });
    expect(result.award).toEqual({ points: 35, balance: 180 });
    expect(result.request.status).toBe('awarded');
  });

  it('appends a note and unwraps the event', async () => {
    answers(200, { event: returnDetails.received.events[4] });
    const event = await marketingApi.addNote(receivedRow.id, 'Left a voicemail.');
    expect(event.type).toBe('note');
    expect(asked()).toBe(`/api/marketing/returns/${receivedRow.id}/notes`);
    expect(method()).toBe('POST');
    // No `expectedRevision`: a note bumps nothing, so it cannot go stale.
    expect(sentBody()).toEqual({ note: 'Left a voicemail.' });
  });
});

describe('customers, ledger and adjustments', () => {
  it('searches the directory on `query`, not on `q`', async () => {
    await marketingApi.listCustomers({ query: 'dara' });
    expect(asked()).toBe('/api/marketing/customers?query=dara');
  });

  it('asks for the recently-active list when nothing was typed', async () => {
    // An empty query is not an empty result on this route — it is the idle list.
    await marketingApi.listCustomers();
    expect(asked()).toBe('/api/marketing/customers');
  });

  it('ESCAPES AN EMAIL IN THE PATH, `+` included', async () => {
    // `a+b@example.com` is a legal address, and an unescaped `+` in a path is a
    // different address by the time it reaches a bound parameter.
    await marketingApi.getCustomer('a+b@example.com');
    expect(asked()).toBe('/api/marketing/customers/a%2Bb%40example.com');
  });

  it('filters the ledger by kind under the same escaped email', async () => {
    await marketingApi.getLedger('a+b@example.com', { kind: 'manual', cursor: 'pts_3' });
    expect(asked()).toBe(
      '/api/marketing/customers/a%2Bb%40example.com/ledger?kind=manual&cursor=pts_3',
    );
  });

  it('posts an adjustment with its sign intact', async () => {
    answers(200, { entry: ledgerWalk[0], balance: 180 });
    const result = await marketingApi.adjust({
      email: 'dara@example.com',
      delta: -40,
      reason: 'Correction — counted twice',
      programId: '',
    });
    // #18 answers `{entry, balance}` BARE — the balance rides beside the row so
    // the tile and the ledger refetch together off one response.
    expect(result).toEqual({ entry: ledgerWalk[0], balance: 180 });
    expect(asked()).toBe('/api/marketing/adjustments');
    expect(method()).toBe('POST');
    expect(sentBody()).toEqual({
      email: 'dara@example.com',
      delta: -40,
      reason: 'Correction — counted twice',
    });
  });
});

describe('settings, banners, discounts', () => {
  it('unwraps settings on the read and on the write', async () => {
    answers(200, { settings: everyFixture.settings });
    expect(await marketingApi.getSettings()).toEqual(everyFixture.settings);
    expect(asked()).toBe('/api/marketing/settings');

    expect(await marketingApi.patchSettings({ expectedRevision: 4, minRedeemPoints: 50 })).toEqual(
      everyFixture.settings,
    );
    // Same path, and the singleton takes no id — there is one settings row.
    expect(asked()).toBe('/api/marketing/settings');
    expect(method()).toBe('PATCH');
  });

  it('sends a null defaultReturnProgramId rather than dropping it', async () => {
    // `null` is how the form CLEARS the default. Pruned, "unset this" would
    // become "leave it alone" — a save that reports success and changes nothing.
    await marketingApi.patchSettings({ expectedRevision: 4, defaultReturnProgramId: null });
    expect(sentBody()).toEqual({ expectedRevision: 4, defaultReturnProgramId: null });
  });

  it('lists every banner, archived included, and unwraps `banners`', async () => {
    answers(200, { banners });
    expect(await marketingApi.listBanners()).toEqual(banners);
    expect(asked()).toBe('/api/marketing/banners');
  });

  it('creates a banner and unwraps the draft it made', async () => {
    answers(200, { banner: everyFixture.draftBanner });
    const created = await marketingApi.createBanner({
      title: 'Half term sale',
      body: 'Two weeks of reductions across the shop.',
      placement: 'section',
    });
    expect(created).toEqual(everyFixture.draftBanner);
    expect(asked()).toBe('/api/marketing/banners');
    expect(method()).toBe('POST');
    // No `status` on the way out: what this screen creates is a draft, and the
    // server decides that rather than taking the client's word for it.
    expect(sentBody()).not.toHaveProperty('status');
  });

  it('archives through a status patch, because there is no delete route', async () => {
    answers(200, { banner: everyFixture.archivedBanner });
    const archived = await marketingApi.patchBanner('bnr_live', {
      expectedRevision: 3,
      status: 'archived',
    });
    // Unwrapped from `{banner}`, like the POST beside it.
    expect(archived).toEqual(everyFixture.archivedBanner);
    expect(asked()).toBe('/api/marketing/banners/bnr_live');
    expect(method()).toBe('PATCH');
    expect(sentBody()).toEqual({ expectedRevision: 3, status: 'archived' });
  });

  it('clears a banner window with an explicit null', async () => {
    await marketingApi.patchBanner('bnr_live', { expectedRevision: 3, endsAt: null });
    expect(sentBody()).toEqual({ expectedRevision: 3, endsAt: null });
  });

  it('lists discounts out of `discounts`', async () => {
    answers(200, { discounts: [] });
    expect(await marketingApi.listDiscounts()).toEqual([]);
    expect(asked()).toBe('/api/marketing/discounts');
  });
});

describe('summary and sweep', () => {
  it('reads the overview aggregate bare, with no wrapper', async () => {
    answers(200, everyFixture.summary);
    expect(await marketingApi.getSummary()).toEqual(everyFixture.summary);
    expect(asked()).toBe('/api/marketing/summary');
    expect(method()).toBe('GET');
  });

  it('posts an empty body to the sweep', async () => {
    answers(200, { sent: 2, failed: 0, skipped: 1 });
    expect(await marketingApi.sweep()).toEqual({ sent: 2, failed: 0, skipped: 1 });
    expect(asked()).toBe('/api/marketing/sweep');
    expect(method()).toBe('POST');
    expect(sentBody()).toEqual({});
  });
});

// ============================================================================
// ERRORS
// ============================================================================

describe('errors', () => {
  it('turns a 401 into the class the app re-authenticates on', async () => {
    answers(401, { error: 'unauthenticated', requestId: 'req_1' });
    await expect(marketingApi.getSummary()).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('names the subject on a 404, so no screen says "Post ret_9 not found"', async () => {
    answers(404, { error: 'gone', requestId: 'req_2' });
    const err = (await marketingApi.getReturn('ret_9').catch((e: unknown) => e)) as NotFoundError;
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toBe('Return ret_9 not found');
  });

  it('turns the stale_write envelope into StaleWriteError with both revisions', async () => {
    answers(409, {
      error: 'stale_write',
      expected: 3,
      actual: 5,
      program: capsProgram,
      requestId: 'req_3',
    });
    const err = (await marketingApi
      .patchProgram('prg_caps', { expectedRevision: 3, name: 'Canister Returns' })
      .catch((e: unknown) => e)) as StaleWriteError;

    expect(err).toBeInstanceOf(StaleWriteError);
    expect(err.expected).toBe(3);
    expect(err.actual).toBe(5);
    /*
     * THE CARRIED ENTITY IS UNDER ITS OWN KEY AND `post` IS NULL. `api.ts` reads
     * `post` because the blog's conflicts carry one; marketing's carry a
     * program, a banner or a request. "Load theirs" therefore reads `err.body`,
     * and a screen that reached for `err.post` would render an empty form and
     * call it the server's copy.
     */
    expect(err.post).toBeNull();
    expect((err.body as { program: Program }).program).toEqual(capsProgram);
    expect(err.requestId).toBe('req_3');
  });

  it('leaves every other 409 an ApiError carrying its code and its payload', async () => {
    answers(409, {
      error: 'invalid_transition',
      status: 'awarded',
      action: 'collect',
      request: returnDetails.awarded.request,
      requestId: 'req_4',
    });
    const err = (await marketingApi
      .collect('ret_1', { expectedRevision: 2 })
      .catch((e: unknown) => e)) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(StaleWriteError);
    expect(err.code).toBe('invalid_transition');
    expect(err.status).toBe(409);
    // The auto-heal re-renders the true stage from this without a second fetch.
    expect((err.body as { request: { status: string } }).request.status).toBe('awarded');
    // 409 is never retried: the condition is permanent until somebody re-reads.
    expect(err.transient).toBe(false);
  });

  it('keeps already_awarded distinguishable, because the caller treats it as success', async () => {
    answers(409, { error: 'already_awarded', entryId: 'pts_1', requestId: 'req_5' });
    const err = (await marketingApi
      .inspect('ret_1', { expectedRevision: 4, qtyAccepted: 5, qtyRejected: 1 })
      .catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('already_awarded');
    expect((err.body as { entryId: string }).entryId).toBe('pts_1');
  });

  it('names the field on a below_minimum 400, and carries the minimum', async () => {
    answers(400, { error: 'below_minimum', detail: 'qtyDeclared', min: 4, requestId: 'req_6' });
    const err = (await marketingApi
      .createReturn({ email: 'dara@example.com', qtyDeclared: 2 })
      .catch((e: unknown) => e)) as ApiError;
    // The inline error is keyed by `detail` and its copy interpolates `min`.
    expect(err.detail).toBe('qtyDeclared');
    expect((err.body as { min: number }).min).toBe(4);
  });

  it('surfaces mail_not_configured as a 501 that is not worth retrying', async () => {
    answers(501, { error: 'mail_not_configured', requestId: 'req_7' });
    const err = (await marketingApi.sweep().catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('mail_not_configured');
    expect(err.status).toBe(501);
    /*
     * `transient` IS TRUE HERE — every 5xx is, by `isTransientStatus` — and the
     * screen ignores it: this is a setup banner, not a retry loop. Pinned so the
     * next reader knows the honest answer came from the code rather than from a
     * hope, and knows not to hand this error to a generic retry.
     */
    expect(err.transient).toBe(true);
  });

  it('is offline, not a 5xx, when fetch itself never answers', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('failed to fetch')));
    await expect(marketingApi.listReturns('needs_action')).rejects.toBeInstanceOf(OfflineError);
  });
});

// ============================================================================
// LABELS
// ============================================================================

describe('label formatters', () => {
  it('picks the singular for exactly one', () => {
    expect(fmtPoints(1, capsLabels)).toBe('1 Bottle Cap');
    expect(fmtPoints(2, capsLabels)).toBe('2 Bottle Caps');
    expect(fmtPoints(0, capsLabels)).toBe('0 Bottle Caps');
  });

  it('pluralises by MAGNITUDE, so a debit of one is not "-1 Bottle Caps"', () => {
    // Asserted as a suffix: the number's own rendering is `toLocaleString`'s and
    // would make this a test about the machine's locale rather than the words.
    expect(fmtPoints(-1, capsLabels)).toMatch(/1 Bottle Cap$/);
    expect(fmtPoints(-40, capsLabels)).toMatch(/40 Bottle Caps$/);
  });

  it('counts units in the program’s own word', () => {
    expect(fmtUnits(1, capsLabels)).toBe('1 canister');
    expect(fmtUnits(6, capsLabels)).toBe('6 canisters');
  });

  it('falls back to "unit" for a program that counts nothing', () => {
    // `adhoc` programs award points for a reason, not for a returned thing.
    expect(fmtUnits(1, goodwillLabels)).toBe('1 unit');
    expect(fmtUnits(3, goodwillLabels)).toBe('3 units');
  });

  it('re-exports the ONE award sentence the server also renders', () => {
    expect(awardSentence(capsLabels, 5, 7, 'dara@example.com')).toBe(
      '5 accepted × 7 = 35 Bottle Caps to dara@example.com',
    );
    expect(awardedSubject(capsLabels, 35)).toBe('You earned 35 Bottle Caps');
  });

  it('a stored reason is NOT what today’s labels would render', () => {
    /*
     * The whole snapshot rule in one assertion. The oldest ledger row was
     * written when the program said "Jar Lids"; rendering history through
     * `capsLabels` would silently rewrite what a customer was told they earned.
     */
    const stored = ledgerWalk[ledgerWalk.length - 1].reason;
    expect(stored).toContain('Jar Lids');
    expect(stored).not.toBe(awardSentence(capsLabels, 5, 7, 'dara@example.com'));
  });
});

describe('deriveBannerStatus', () => {
  it('derives all five states from the five fixtures', () => {
    expect(banners.map((banner) => deriveBannerStatus(banner, NOW))).toEqual([
      'draft',
      'scheduled',
      'live',
      'ended',
      'archived',
    ]);
  });

  it('lets archived and draft ignore the clock entirely', () => {
    /*
     * THE WINDOWS HERE ARE DELIBERATELY NOT OPEN, and that is the whole test.
     * An archived row measured against a window that happens to be running
     * answers 'archived' whichever order the checks run in — the clock branches
     * return nothing, so the fixture never reaches the precedence being claimed.
     * A future start would say 'scheduled' and a finished window would say
     * 'ended'; both are wrong for a row nobody switched on, and only a fixture
     * where the clock WOULD answer differently can prove the status wins.
     */
    const notYet = { startsAt: NOW + DAY, endsAt: NOW + 2 * DAY };
    const over = { startsAt: NOW - 2 * DAY, endsAt: NOW - DAY };
    expect(deriveBannerStatus({ status: 'archived', ...notYet }, NOW)).toBe('archived');
    expect(deriveBannerStatus({ status: 'archived', ...over }, NOW)).toBe('archived');
    expect(deriveBannerStatus({ status: 'draft', ...notYet }, NOW)).toBe('draft');
    expect(deriveBannerStatus({ status: 'draft', ...over }, NOW)).toBe('draft');
  });

  it('IS LIVE AT THE EXACT MOMENT IT STARTS', () => {
    // A banner scheduled for 09:00 is showing at 09:00. The SQL predicate is
    // `starts_at <= $now` for the same reason; a `<` on either side is an hour
    // of a sale nobody sees.
    expect(deriveBannerStatus({ status: 'live', startsAt: NOW, endsAt: null }, NOW)).toBe('live');
    expect(deriveBannerStatus({ status: 'live', startsAt: NOW + 1, endsAt: null }, NOW)).toBe(
      'scheduled',
    );
  });

  it('IS ENDED AT THE EXACT MOMENT IT ENDS', () => {
    // Half-open window, so a back-to-back pair never both show.
    expect(deriveBannerStatus({ status: 'live', startsAt: null, endsAt: NOW }, NOW)).toBe('ended');
    expect(deriveBannerStatus({ status: 'live', startsAt: null, endsAt: NOW + 1 }, NOW)).toBe(
      'live',
    );
  });

  it('shows a switched-on banner with no window at all', () => {
    expect(deriveBannerStatus({ status: 'live', startsAt: null, endsAt: null }, NOW)).toBe('live');
  });
});

// ============================================================================
// FIXTURES
// ============================================================================

describe('the fixtures themselves', () => {
  it('NEVER SAY THE WORD THE PROGRAM CAN BE RENAMED AWAY FROM', () => {
    // Every screen suite renders these. If the fixtures said it, a hardcoded
    // label in a screen would pass every assertion in the section.
    expect(JSON.stringify(everyFixture)).not.toMatch(/spool/i);
  });

  it('keep the balanceAfter chain consistent with the deltas', () => {
    // Oldest first. Each row's `balanceAfter` is what the ledger says the
    // balance became, and "120 → 180" on screen is this minus the delta.
    let balance = 0;
    for (const entry of [...ledgerWalk].reverse()) {
      balance += entry.delta;
      expect(entry.balanceAfter).toBe(balance);
    }
    expect(balance).toBe(customerSummary.balance);
  });

  it('offer the pipeline-advancing action FIRST on every open row', () => {
    // The queue renders exactly one button and it is `allowedActions[0]`.
    expect(requestedOld.allowedActions[0]).toBe('schedule');
    expect(scheduledRow.allowedActions[0]).toBe('collect');
    expect(collectedRow.allowedActions[0]).toBe('receive');
    expect(receivedRow.allowedActions[0]).toBe('inspect');
    // A note is legal in every state, terminal ones included.
    for (const item of returnRows) expect(item.allowedActions).toContain('note');
    expect(ALLOWED_ACTIONS.awarded).toEqual(['note']);
  });

  it('never hold two OPEN returns for one email', () => {
    // One open return per email is a partial unique index on the server, so a
    // fixture that broke it would describe a state the database refuses.
    const open = returnRows.filter((item) =>
      ['requested', 'scheduled', 'collected', 'received'].includes(item.status),
    );
    expect(new Set(open.map((item) => item.customerEmail)).size).toBe(open.length);
  });

  it('count what is actually there', () => {
    for (const [status, count] of Object.entries(returnCounts)) {
      if (status === 'needsAction') continue;
      expect(returnRows.filter((item) => item.status === status)).toHaveLength(count);
    }
    // The two stages where the admin is the blocker.
    expect(returnCounts.needsAction).toBe(returnCounts.requested + returnCounts.received);
  });

  it('give every status a detail whose timeline ends where the row is', () => {
    for (const [status, detail] of Object.entries(returnDetails)) {
      expect(detail.request.status).toBe(status);
      expect(detail.events.length).toBeGreaterThan(0);
      expect(detail.request.allowedActions).toEqual(ALLOWED_ACTIONS[detail.request.status]);
    }
    // The award is arithmetic, not a stored opinion: 5 accepted at 7 each.
    const awarded = returnDetails.awarded.request;
    expect(awarded.pointsAwarded).toBe(
      (awarded.qtyAccepted as number) * awarded.pointsPerUnitSnapshot,
    );
    // "Queued", never a fake "sent" — nothing schedules the sweep.
    expect(returnDetails.awarded.emailIntents[0]).toMatchObject({
      kind: 'return_awarded',
      sentAt: null,
    });
  });

  it('carry the label wording of the moment on the inspected event', () => {
    const inspected = returnDetails.awarded.events.find((event) => event.type === 'inspected');
    expect(inspected?.data).toMatchObject({
      qtyAccepted: 5,
      qtyRejected: 1,
      pointsAwarded: 35,
      outcome: 'awarded',
      pointsLabelPlural: 'Jar Lids',
    });
  });
});
