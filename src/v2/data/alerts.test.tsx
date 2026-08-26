import { beforeEach, describe, expect, it, vi } from 'vitest';

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
 * NAMED `.test.tsx` DELIBERATELY, though it contains no JSX: `alerts.ts`
 * reads `window.localStorage`, so this file needs the `ui` project's jsdom
 * (the `client` node project has no `window`, under which every alert would
 * read as unread and the assertion below that marking works would fail).
 * Nothing else is stubbed: `fetchAlerts`'s imports are plain fetch wrappers
 * with no import-time side effects, and the behavior under test never calls
 * the network.
 */

import { isUnread, markRead, type OpsAlert } from './alerts';

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
