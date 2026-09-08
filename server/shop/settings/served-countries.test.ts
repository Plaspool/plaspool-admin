import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { loadDeliveryRules, serviceRefusal } from './repo';
import type { DeliveryRules } from './repo';

/**
 * WHERE THE SHOP WILL SHIP — the seeded row, and the rule that reads it.
 *
 * A NEW FILE FOR THE SAME REASON `international-zone.test.ts` IS ONE. The
 * checkout's own `repo.test.ts` builds a SYNTHETIC config, and that is exactly
 * why it stayed green through the whole life of the international-pricing bug.
 * The country gate is a fact about DATA — one column, in one seeded row — so
 * the half of this file that matters loads that row through the same function
 * checkout calls and asserts on what came back.
 *
 * The other half unit-tests `serviceRefusal`, which is where the one subtle
 * rule lives: a REGION restriction is a Nigerian tool and must not refuse a
 * foreign address. See its own comment for why that is not merely convenient.
 */

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

describe('the seeded row, as checkout actually loads it', () => {
  /*
   * THE MIGRATION MUST CHANGE NOTHING. Adding the column opens the door; it
   * does not walk through it. A deployment that never touches the settings
   * screen ships to Nigeria and nowhere else, exactly as it did yesterday.
   */
  it('serves Nigeria and nothing else until an owner says otherwise', async () => {
    const rules = await loadDeliveryRules(ctx.db);
    expect(rules.servedCountries).toEqual(['NG']);
  });

  it('refuses a foreign address on the seeded row, through the real rule', async () => {
    const rules = await loadDeliveryRules(ctx.db);
    for (const country of ['GB', 'US', 'GH']) {
      expect(serviceRefusal(rules, country, null), country).toBe('country');
    }
    expect(serviceRefusal(rules, 'NG', 'Lagos')).toBeNull();
  });
});

describe('serviceRefusal', () => {
  const NG_ONLY: DeliveryRules = { addressMode: 'simple', servedRegions: null, servedCountries: ['NG'] };

  it('accepts a country the shop has named, in any case or padding', () => {
    const rules: DeliveryRules = { ...NG_ONLY, servedCountries: ['NG', 'GB'] };
    expect(serviceRefusal(rules, 'GB', null)).toBeNull();
    expect(serviceRefusal(rules, ' gb ', null)).toBeNull();
  });

  it('names the COUNTRY as the reason, so the storefront can say the right sentence', () => {
    expect(serviceRefusal(NG_ONLY, 'CA', null)).toBe('country');
  });

  /*
   * ═══════════════════════════════════════════════════════════════════════
   * A REGION RESTRICTION IS A NIGERIAN TOOL AND STOPS AT THE BORDER.
   *
   * `served_regions` holds Nigerian STATES — it exists so simple mode can say
   * "we do not drive to Kano". Applied to a foreign address it refuses every
   * one of them, because "England" is not in a list of Nigerian states. An
   * owner who opened a second country would then watch international checkout
   * fail for a reason named after a domestic setting, and the fix would be to
   * clear a restriction that was protecting something real.
   *
   * So the region list is consulted only for the DEFAULT country — the head of
   * `servedCountries`, the same value the form pre-selects.
   * ═══════════════════════════════════════════════════════════════════════
   */
  it('does not let a Nigerian region list refuse a foreign address', () => {
    const rules: DeliveryRules = {
      addressMode: 'simple',
      servedRegions: ['Abuja', 'Lagos'],
      servedCountries: ['NG', 'GB'],
    };
    expect(serviceRefusal(rules, 'GB', 'England')).toBeNull();
    expect(serviceRefusal(rules, 'GB', null)).toBeNull();
  });

  it('still applies the region list to the home country', () => {
    const rules: DeliveryRules = {
      addressMode: 'simple',
      servedRegions: ['Abuja', 'Lagos'],
      servedCountries: ['NG', 'GB'],
    };
    expect(serviceRefusal(rules, 'NG', 'Lagos')).toBeNull();
    expect(serviceRefusal(rules, 'NG', 'Kano')).toBe('region');
  });

  it('refuses on country before region, so the message names the outer fact', () => {
    const rules: DeliveryRules = {
      addressMode: 'simple',
      servedRegions: ['Lagos'],
      servedCountries: ['NG'],
    };
    expect(serviceRefusal(rules, 'CA', 'Ontario')).toBe('country');
  });
});
