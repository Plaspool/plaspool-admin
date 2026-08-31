import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The bell's read state, pinned on its one rule (the debt ledger's alerts
 * item): each alert is a standing FACT whose id names the fact and whose
 * `signature` encodes its current magnitude, and "read" is stored per
 * signature — so a read alert whose signature changes counts as unread
 * again. Three MORE stuck emails is news even if two were yesterday; store
 * "read" against the id alone and the bell goes quiet forever after the
 * first glance, which for the stuck-email alert means nobody is ever told
 * the pile grew.
 *
 * PLUS THE SCOPED-ROLE RULE (2026-08-31): stats sit in the analytics domain,
 * which a content writer does not hold, so `/shop/admin/stats` answers their
 * bell with a 403 BY DESIGN. `fetchAlerts` must swallow exactly that refusal
 * into an empty list — a writer's bell is quiet, not broken — while every
 * other failure still throws so a real outage keeps looking like one. The
 * second describe below stubs `fetch` to drive that path; the read-state
 * tests still never touch the network.
 *
 * NAMED `.test.tsx` DELIBERATELY, though it contains no JSX: `alerts.ts`
 * reads `window.localStorage`, so this file needs the `ui` project's jsdom
 * (the `client` node project has no `window`, under which every alert would
 * read as unread and the assertion below that marking works would fail).
 */

import { fetchAlerts, isUnread, markRead, type OpsAlert } from './alerts';

/** The stuck-email fact at a given magnitude — same id, moving signature. */
const stuckEmails = (signature: string): OpsAlert => ({
  id: 'emails-stuck',
  source: 'Emails',
  title: `${signature} emails will never send`,
  body: 'Out of retry attempts — nothing resends these without you.',
  at: 1_756_000_000_000,
  to: '/emails',
  tone: 'critical',
  signature,
});

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answer every route with one JSON verdict — the 403 tests need no routing
 *  table, because the refusal under test is the same for both endpoints. */
function stubAnswers(answer: (pathname: string) => { status: number; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'https://studio.test');
      const { status, body } = answer(url.pathname);
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

// ============================================================================

describe('the bell’s read state', () => {
  it('an alert whose signature changes reads as unread again', () => {
    const three = stuckEmails('3');
    // Never seen: unread.
    expect(isUnread(three)).toBe(true);

    // Seen at this magnitude: settled.
    markRead(three);
    expect(isUnread(three)).toBe(false);

    // Same fact, new magnitude: news again — the signature is what was read,
    // not the id.
    const six = stuckEmails('6');
    expect(isUnread(six)).toBe(true);

    // And acknowledging the new magnitude settles it at that level.
    markRead(six);
    expect(isUnread(six)).toBe(false);
  });
});

describe('a scoped role’s bell', () => {
  it('swallows the stats 403 into an empty list — quiet, not broken', async () => {
    /* A content writer: no analytics domain, so stats refuses — and their
       role holds no marketing either, so reviews refuses too. Both refusals
       together must resolve to [], never reject. */
    stubAnswers(() => ({
      status: 403,
      body: { error: 'forbidden', requestId: 'req_test' },
    }));

    await expect(fetchAlerts()).resolves.toEqual([]);
  });

  it('still lets the reviews alert ride when only stats is refused', async () => {
    /* A role that may moderate but not read analytics: the stats-fed alerts
       simply do not exist for them, while the reviews fact still shows. */
    stubAnswers((pathname) =>
      pathname === '/api/shop/reviews'
        ? {
            status: 200,
            body: {
              items: [{ id: 'rev_1', createdAt: 1_756_000_000_000 }],
              nextCursor: null,
            },
          }
        : { status: 403, body: { error: 'forbidden', requestId: 'req_test' } },
    );

    const alerts = await fetchAlerts();
    expect(alerts.map((a) => a.id)).toEqual(['reviews-pending']);
    expect(alerts[0]!.title).toBe('1 review awaiting moderation');
  });

  it('a real outage still throws — only the 403 is the system working', async () => {
    stubAnswers(() => ({ status: 500, body: { error: 'internal', requestId: 'req_test' } }));
    await expect(fetchAlerts()).rejects.toThrow();
  });
});
