import { describe, expect, it } from 'vitest';

import { SYSTEM_TEMPLATE_STAGES } from './api-email';
/*
 * THE REAL KEY LIST, IMPORTED, NOT RETYPED.
 *
 * `SYSTEM_TEMPLATE_STAGES` is a `Record<string, string>` keyed by the same
 * strings `server/mail/defaults.ts` declares in `SYSTEM_KEYS`, and nothing
 * connects the two: the map's type admits any string, and
 * `EmailTemplates.tsx` falls back to a generic `'System message'` for a key it
 * does not know. So adding a system message and forgetting this file produces
 * no error, no warning and no failing test — the operator simply sees one
 * template in the list labelled nothing in particular, which is precisely the
 * silent mirror-drift CLAUDE.md §2 is about.
 *
 * The production module cannot import `server/` — a browser bundle must not
 * pull in the mail subsystem — but this SUITE can, because it runs under
 * Vitest's `client` project in a node environment. Same arrangement, and the
 * same reasoning, as `src/routes/orders/geography.test.ts`.
 */
import { SYSTEM_KEYS } from '../../server/mail/defaults';

describe('the admin’s stage labels for system templates', () => {
  it('names every key the application actually sends', () => {
    const missing = SYSTEM_KEYS.filter((key) => SYSTEM_TEMPLATE_STAGES[key] === undefined);
    expect(missing).toEqual([]);
  });

  it('and names nothing else — a stale label outlives the message it described', () => {
    const orphans = Object.keys(SYSTEM_TEMPLATE_STAGES).filter(
      (key) => !(SYSTEM_KEYS as readonly string[]).includes(key),
    );
    expect(orphans).toEqual([]);
  });
});
