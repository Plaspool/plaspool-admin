/**
 * Customers, balances and the ledger on the wire — contract #15-18, driven
 * through the REAL app.
 *
 * ROUTE SUITES GO THROUGH THE WHOLE STACK — router, origin guard, session
 * middleware, marketing's own `onError`, the global error handler — because the
 * seam between the repository and HTTP is what this task adds and therefore
 * where its defects are. `repo.test.ts` already proves the arithmetic; what is
 * only provable here is the guard attached per route, the `.strict()` on a query
 * string, the exact JSON `insufficient_balance` becomes, and the fact that an
 * address nobody has heard of answers zeros rather than `gone`.
 *
 * NO NOUN FROM THE SEEDED PRESET APPEARS IN THIS FILE (spec D11). Every fixture
 * uses absurd labels — "Bottle Cap" / "canister" — so a label that was read from
 * a row cannot be mistaken for one written in source.
 *
 * NOTHING IS TRUNCATED BETWEEN TESTS, because the sessions logged in by
 * `beforeAll` live in a table that a truncate would empty. Every test uses its
 * own addresses instead — which is also closer to the real thing, where a
 * directory has other people's rows in it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { TestCtx } from '../../test/harness';
import type { HttpClient } from '../../test/http';
import type { AuthUser } from '../../../shared/types';
import type { CustomerPage, CustomerRow, CustomerSummary, LedgerEntry, LedgerPage } from './repo';

let ctx: TestCtx;
let owner: HttpClient;
let writer: HttpClient;
let marketing: HttpClient;
/** No session at all — a fresh browser, not a logged-out one. */
let anon: HttpClient;

/** The program a couple of adjustments are attributed to. */
let capsProgramId: string;

const API = '/api/marketing';

async function login(user: AuthUser): Promise<HttpClient> {
  const client = httpClient(ctx.db);
  await client.signIn(user);
  return client;
}

beforeAll(async () => {
  ctx = await freshDb();
  owner = await login(ctx.users.owner);
  writer = await login(ctx.users.writer);
  marketing = await login(ctx.users.marketing);
  anon = httpClient(ctx.db);

  const res = await owner.post(`${API}/programs`, {
    key: 'bottle-caps',
    kind: 'unit_return',
    name: 'Cap Returns',
    pointsLabelSingular: 'Bottle Cap',
    pointsLabelPlural: 'Bottle Caps',
    unitLabelSingular: 'canister',
    unitLabelPlural: 'canisters',
    minUnitsPerReturn: 4,
    pointsPerUnit: 7,
  });
  expect(res.status).toBe(201);
  capsProgramId = (await json<{ program: { id: string } }>(res)).program.id;
});

afterAll(async () => {
  await ctx?.close();
});

// ------------------------------------------------------------------ fixtures

/** A DISTINCT address per test, so one test's wallet is never another's
 *  surprise row — the directory reads every wallet in the database. */
let emailSeq = 0;
const nextEmail = (prefix = 'dara'): string => `${prefix}-${(emailSeq += 1)}@example.test`;

interface AdjustResult {
  entry: LedgerEntry;
  balance: number;
}

/** One adjustment, as the Adjust dialog fires it. */
async function post(
  body: Record<string, unknown>,
  client: HttpClient = owner,
): Promise<Response> {
  return client.post(`${API}/adjustments`, body);
}

async function adjustOk(body: Record<string, unknown>): Promise<AdjustResult> {
  const res = await post(body);
  expect(res.status).toBe(201);
  return json<AdjustResult>(res);
}

const seg = encodeURIComponent;

/**
 * Written as an escape rather than as a literal, the `server/repo/cursor.ts`
 * rule: a raw U+0000 in a source file is invisible in every editor, survives a
 * copy-paste as whitespace, and makes git treat the file as BINARY — which is
 * how a test suite stops being reviewable in a diff. This file had two of them
 * before the byte count gave it away.
 */
const NUL = String.fromCharCode(0);

async function summary(email: string, client: HttpClient = owner): Promise<CustomerSummary> {
  const res = await client.get(`${API}/customers/${seg(email)}`);
  expect(res.status).toBe(200);
  return json<CustomerSummary>(res);
}

async function directory(query = '', client: HttpClient = owner): Promise<CustomerPage> {
  const suffix = query === '' ? '' : `?query=${seg(query)}`;
  const res = await client.get(`${API}/customers${suffix}`);
  expect(res.status).toBe(200);
  return json<CustomerPage>(res);
}

/** An account in the SHOP's table — the population the directory's second arm
 *  searches. Written by SQL because marketing never imports shop code (D9). */
async function makeAccount(
  id: string,
  email: string | null,
  displayName: string | null = null,
): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO shop_customers (id, email, display_name, created_at)
    VALUES (${id}, ${email}, ${displayName}, ${Date.now()})`);
}

// --------------------------------------------------------------------- mount

describe('mounting and the guards', () => {
  it('answers 401 without a session on every route, and 404 for a path it does not have', async () => {
    expect((await anon.get(`${API}/customers`)).status).toBe(401);
    expect((await anon.get(`${API}/customers/x%40y.test`)).status).toBe(401);
    expect((await anon.get(`${API}/customers/x%40y.test/ledger`)).status).toBe(401);
    expect((await anon.post(`${API}/adjustments`, { email: 'x@y.test' })).status).toBe(401);

    /*
     * The reason the guards are attached PER ROUTE. A blanket
     * `routes.use('*', requireAuth())` would answer 401 here too — the guard
     * would refuse a request that had no handler to reach — and an unrouted path
     * has to stay a 404 so a client can tell "you may not" from "there is no
     * such thing".
     */
    const missing = await owner.get(`${API}/customers/x%40y.test/nothing-here`);
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({ error: 'gone' });
  });

  it('is the marketing domain’s: marketing reads and adjusts, a writer is refused', async () => {
    /*
     * THE ROLE MATRIX SINCE MIGRATION 0680 (shared/roles.ts): the points
     * ledger belongs to the marketing domain, so the marketing role holds the
     * whole surface — reads AND the adjustment the owner alone used to sign —
     * and a content writer no longer reaches any of it.
     */
    const email = nextEmail('role');
    await adjustOk({ email, delta: 30, reason: 'Goodwill' });

    expect((await summary(email, marketing)).balance).toBe(30);
    expect((await marketing.get(`${API}/customers?query=role`)).status).toBe(200);
    expect((await writer.get(`${API}/customers?query=role`)).status).toBe(403);
    expect((await writer.get(`${API}/customers/${seg(email)}/ledger`)).status).toBe(403);

    const refused = await post({ email, delta: 1000, reason: 'Writer was here' }, writer);
    expect(refused.status).toBe(403);
    // And the refusal actually refused.
    expect((await summary(email)).balance).toBe(30);
  });

  it('refuses a NUL in the address segment with 400, never a 5xx', async () => {
    /* `server/nul-bytes.test.ts` walks every registered route for this; asserted
     * here too because these two paths are the ones this task adds and a 500 on
     * `%00` is a request the client retries five times. */
    expect((await owner.get(`${API}/customers/${seg(NUL)}`)).status).toBe(400);
    expect((await owner.get(`${API}/customers/${seg(NUL)}/ledger`)).status).toBe(400);
  });
});

// --------------------------------------------------------------- adjustments

describe('POST /adjustments — contract #18', () => {
  it('credits an address with no history at all and answers the entry and the balance', async () => {
    const email = nextEmail('walkin');
    const body = await adjustOk({
      email,
      delta: 60,
      reason: 'Walk-in return — 6 canisters',
      programId: capsProgramId,
      customerId: 'cus_walkin',
    });

    expect(body.balance).toBe(60);
    expect(body.entry).toMatchObject({
      kind: 'manual',
      delta: 60,
      balanceAfter: 60,
      reason: 'Walk-in return — 6 canisters',
      programId: capsProgramId,
      programName: 'Cap Returns',
      returnRequestId: null,
      orderId: null,
      actorType: 'admin',
      actorId: ctx.users.owner.id,
    });
    expect(body.entry.id.startsWith('pts_')).toBe(true);
    /* The walk-in escape, end to end: an address the shop had never heard of now
     * has a wallet, which is the brief's "any customer for whatever reason". */
    expect(await summary(email)).toMatchObject({ balance: 60, lifetimeEarned: 60 });
  });

  it('debits by the sign of delta and refuses to go below zero, quoting the live balance', async () => {
    const email = nextEmail('spend');
    await adjustOk({ email, delta: 40, reason: 'Goodwill' });

    const refused = await post({ email, delta: -60, reason: 'Correction' });
    expect(refused.status).toBe(409);
    const body = await json(refused);
    /*
     * BY EQUALITY MINUS THE REQUEST ID, not by containment. Spec §Error
     * catalogue freezes the extras as `balance` alone, and the client's copy
     * quotes it ("Balance is 40 Bottle Caps — a 60 debit would go below zero"),
     * so a dropped key is a screen that degrades to "something went wrong" and an
     * added one is contract drift no frontend test would notice.
     */
    const { requestId, ...rest } = body;
    expect(typeof requestId).toBe('string');
    expect(rest).toEqual({ error: 'insufficient_balance', balance: 40 });

    // Nothing was written: the guard is the statement's, not a check before it.
    expect((await summary(email)).balance).toBe(40);
    expect((await ledger(email)).items).toHaveLength(1);

    // And the debit that DOES fit is applied.
    const ok = await adjustOk({ email, delta: -40, reason: 'Correction' });
    expect(ok.balance).toBe(0);
    expect(ok.entry.delta).toBe(-40);
  });

  it('refuses a zero delta and an empty reason with 400 naming the field', async () => {
    const email = nextEmail('bad');

    const zero = await post({ email, delta: 0, reason: 'Goodwill' });
    expect(zero.status).toBe(400);
    /* `detail` is what the catalogue's `bad_request` treatment keys its inline
     * error on — the message goes under the amount input and the focus moves
     * there. Reaching `marketing_ledger_delta_ck` instead would be a 500. */
    expect(await json(zero)).toMatchObject({ error: 'bad_request', detail: 'delta' });

    const blank = await post({ email, delta: 10, reason: '   ' });
    expect(blank.status).toBe(400);
    expect(await json(blank)).toMatchObject({ error: 'bad_request', detail: 'reason' });

    const missing = await post({ email, delta: 10 });
    expect(missing.status).toBe(400);
    expect(await json(missing)).toMatchObject({ error: 'bad_request', detail: 'reason' });

    // Nothing of the three was written.
    expect(await summary(email)).toMatchObject({ balance: 0, lifetimeEarned: 0 });
  });

  it('refuses an unknown programId as a field error, not a foreign-key 500', async () => {
    const res = await post({
      email: nextEmail('prog'),
      delta: 10,
      reason: 'Goodwill',
      programId: 'prg_not_here',
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'programId' });
  });

  it('refuses a body carrying a field the schema does not have', async () => {
    /* `.strict()`, like every other body in this subsystem: a field that is
     * accepted and silently ignored is worse than a refusal — a caller would
     * believe it had set something. */
    const res = await post({
      email: nextEmail('strict'),
      delta: 10,
      reason: 'Goodwill',
      kind: 'return_award',
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'kind' });
  });

  it('folds the address, so one customer is never two wallets', async () => {
    const email = nextEmail('fold');
    await adjustOk({ email: email.toUpperCase(), delta: 25, reason: 'Goodwill' });
    /* `DARA@X` and `dara@x` are one person. The balance, the ledger and the
     * open-return index all key on the folded address, so anything else is two
     * wallets and neither is right. */
    expect((await summary(email)).balance).toBe(25);
  });
});

// ------------------------------------------------------------- the summary

async function ledger(
  email: string,
  query = '',
  client: HttpClient = owner,
): Promise<LedgerPage> {
  const res = await client.get(`${API}/customers/${seg(email)}/ledger${query}`);
  expect(res.status).toBe(200);
  return json<LedgerPage>(res);
}

describe('GET /customers/:email — contract #16', () => {
  it('answers zeros for an address nobody has ever heard of, never 404', async () => {
    /*
     * The walk-in escape depends on this. The no-match empty state offers an
     * owner-only "Credit <typed email> anyway →" that links straight here, and a
     * `gone` would render a whole-screen "no longer exists" for the person the
     * admin is about to create a wallet for.
     */
    const res = await owner.get(`${API}/customers/${seg('nobody@example.test')}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      email: 'nobody@example.test',
      customerId: null,
      displayName: null,
      balance: 0,
      lifetimeEarned: 0,
      openReturn: null,
    });
    // And its ledger is an empty page, not a miss either.
    expect(await ledger('nobody@example.test')).toEqual({ items: [], nextCursor: null });
  });

  it('carries the account behind the address, and the guest flag follows it', async () => {
    const email = nextEmail('acct');
    await makeAccount('cus_acct', email.toUpperCase(), 'Acct Holder');
    await adjustOk({ email, delta: 15, reason: 'Goodwill' });

    /* Resolved through the join on the FOLDED address: the wallet was created by
     * an adjustment that carried no id, and the address has an account. */
    expect(await summary(email)).toMatchObject({
      customerId: 'cus_acct',
      displayName: 'Acct Holder',
      balance: 15,
    });
    /*
     * ONE LINE, NOT TWO. This address is in BOTH populations the directory
     * unions — it has a wallet and it has a shop account — and the second arm's
     * `NOT EXISTS` is the only thing stopping it being listed twice, once with
     * its real balance and once with a zero. Two rows for one customer is also a
     * page-limit slot spent on a duplicate.
     */
    const found = await directory(email.split('@')[0]);
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({
      customerId: 'cus_acct',
      guest: false,
      balance: 15,
    });
  });

  it('refuses an empty address segment rather than querying for nothing', async () => {
    const res = await owner.get(`${API}/customers/${seg('   ')}`);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'email' });
  });
});

// ------------------------------------------------------------ the directory

describe('GET /customers — contract #15', () => {
  it('lists balance-holders most-recently-moved first when nothing is typed', async () => {
    /* Named so alphabetical order matches creation order: two adjustments can
     * land in one millisecond, and the tiebreak is `email DESC` — with these
     * names the expected order is the same either way, so the assertion is about
     * the ordering rather than about the clock's resolution. */
    const one = nextEmail('recent1');
    const two = nextEmail('recent2');
    const three = nextEmail('recent3');
    for (const email of [one, two, three]) {
      await adjustOk({ email, delta: 5, reason: 'Goodwill' });
    }

    const page = await directory();
    expect(page.items.map((r) => r.email).slice(0, 3)).toEqual([three, two, one]);
    // The property, independent of which rows earlier tests left behind.
    const times = page.items.map((r) => r.lastEntryAt ?? 0);
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    expect(page.items[0]).toMatchObject({
      balance: 5,
      lifetimeEarned: 5,
      guest: true,
      customerId: null,
      /* The reason VERBATIM — the directory's summary line is what was written,
       * never a re-render through today's labels. */
      lastEntry: { kind: 'manual', delta: 5, reason: 'Goodwill' },
    });
  });

  it('finds a shop account with no points history and flags the guest correctly', async () => {
    const stranger = 'zz-stranger@example.test';
    const holder = 'zz-holder@example.test';
    await makeAccount('cus_zz_stranger', 'ZZ-Stranger@Example.Test', 'Never Returned');
    await adjustOk({ email: holder, delta: 12, reason: 'Goodwill' });

    const rows = new Map((await directory('zz-')).items.map((r) => [r.email, r]));
    expect([...rows.keys()].sort()).toEqual([holder, stranger]);

    /* The account with no wallet: zeros, its own display name, and NOT a guest —
     * it has an id. This row is the whole reason the second union arm exists;
     * without it the walk-in customer at the counter is unfindable. */
    expect(rows.get(stranger)).toEqual({
      email: stranger,
      customerId: 'cus_zz_stranger',
      displayName: 'Never Returned',
      guest: false,
      balance: 0,
      lifetimeEarned: 0,
      lastEntryAt: null,
      lastEntry: null,
    } satisfies CustomerRow);
    /* The wallet with no account: a guest, which is the DEFAULT path (spec D10)
     * and not a degenerate case. */
    expect(rows.get(holder)).toMatchObject({ guest: true, balance: 12 });
  });

  it('matches a customer-id prefix as typed, and an address only by prefix', async () => {
    const email = nextEmail('idsearch');
    await adjustOk({ email, delta: 9, reason: 'Goodwill', customerId: 'cus_QZ7' });

    expect((await directory('cus_QZ7')).items.map((r) => r.email)).toEqual([email]);
    /* A PREFIX AND NOT A SUBSTRING (the `server/shop/admin/orders.ts` stance):
     * this box finds the customer you were given, it does not let one be
     * discovered by typing fragments of an address. */
    expect((await directory('example.test')).items).toEqual([]);
  });

  it('refuses an unknown query parameter rather than ignoring it', async () => {
    /* `?querry=dara` would otherwise return the whole directory and look like a
     * bug in the search box. */
    const res = await owner.get(`${API}/customers?querry=dara`);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'querry' });
  });

  it('pages by keyset, and the cursor it hands back is the one it accepts', async () => {
    const page = await directory();
    expect(page.items.length).toBeGreaterThan(1);

    const first = await json<CustomerPage>(await owner.get(`${API}/customers?limit=1`));
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();

    const second = await json<CustomerPage>(
      await owner.get(`${API}/customers?limit=1&cursor=${seg(first.nextCursor as string)}`),
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0].email).not.toBe(first.items[0].email);
    expect([first.items[0].email, second.items[0].email]).toEqual(
      page.items.slice(0, 2).map((r) => r.email),
    );
  });

  it('refuses a cursor minted under another ordering with 400', async () => {
    const foreign = Buffer.from(JSON.stringify(['ledger', [1], 'x']), 'utf8').toString(
      'base64url',
    );
    const res = await owner.get(`${API}/customers?cursor=${seg(foreign)}`);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'cursor' });
  });
});

// -------------------------------------------------------------- the history

describe('GET /customers/:email/ledger — contract #17', () => {
  it('filters by kind and answers newest first', async () => {
    const email = nextEmail('hist');
    await adjustOk({ email, delta: 100, reason: 'Goodwill', programId: capsProgramId });
    await adjustOk({ email, delta: -40, reason: 'Correction' });

    const all = await ledger(email);
    expect(all.items.map((e) => e.delta)).toEqual([-40, 100]);
    expect(all.items[0]).toMatchObject({ balanceAfter: 60, programName: null });
    expect(all.items[1]).toMatchObject({ balanceAfter: 100, programName: 'Cap Returns' });

    expect((await ledger(email, '?kind=manual')).items).toHaveLength(2);
    /* No awards and no redemptions on this address — an empty page, and the tab
     * still renders. */
    expect((await ledger(email, '?kind=awards')).items).toEqual([]);
    expect((await ledger(email, '?kind=redemptions')).items).toEqual([]);
  });

  it('pages by keyset without skipping or repeating a row', async () => {
    const email = nextEmail('pager');
    for (let i = 0; i < 7; i += 1) {
      await adjustOk({ email, delta: 1, reason: `move ${i}` });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const suffix: string = cursor === null ? '?limit=3' : `?limit=3&cursor=${seg(cursor)}`;
      const page = await ledger(email, suffix);
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual((await ledger(email, '?limit=100')).items.map((e) => e.id));
  });

  it('refuses an unknown kind rather than silently listing everything', async () => {
    const res = await owner.get(`${API}/customers/${seg('x@y.test')}/ledger?kind=nope`);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'kind' });
  });
});
