import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../../test/harness';
import type { TestCtx } from '../../../test/harness';
import { loadShippingZonesForCheckout } from './shipping-zones-repo';
import { zoneFor } from './shipping';

/**
 * THE REGRESSION GUARD FOR MIGRATION 0900, AND IT HAD TO BE A NEW FILE.
 *
 * `repo.test.ts` already asserts that an unmatched country falls to the
 * declared fallback — but it does so against a SYNTHETIC three-zone config
 * built inside the test, which is exactly why it stayed green for the entire
 * life of the bug. The zones this shop actually ships come out of the
 * migrations, and until 0900 the one that caught every foreign address was
 * `zone_rest_of_nigeria`, whose empty `countries` array means "everything
 * nobody else claims" (0240's own comment). London was therefore priced as
 * domestic Nigerian delivery and charged 7.5% Nigerian VAT, and no test
 * anywhere read the seeded rows to notice.
 *
 * So every assertion below loads the REAL seeded zones through the same
 * function checkout uses, and none of them constructs a zone. That is the
 * whole point of the file: it is a test about the DATA, driven through the
 * production code path.
 */

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

describe('the seeded zones, as checkout actually loads them', () => {
  it('sends a foreign address to the international zone, not Rest of Nigeria', async () => {
    const zones = await loadShippingZonesForCheckout(ctx.db);

    // The bug, stated as three countries on three continents. Before 0900
    // every one of these answered `zone_rest_of_nigeria`.
    for (const country of ['GB', 'US', 'GH']) {
      expect(zoneFor(zones, country, null).id, country).toBe('zone_international');
    }
  });

  it('still prices every Nigerian address exactly as it did before', async () => {
    const zones = await loadShippingZonesForCheckout(ctx.db);

    expect(zoneFor(zones, 'NG', 'Lagos').id).toBe('zone_lagos');
    expect(zoneFor(zones, 'NG', 'Abuja').id).toBe('zone_abuja');
    expect(zoneFor(zones, 'NG', 'FCT').id).toBe('zone_abuja');

    /*
     * THE ONE THAT CHANGED MECHANISM WITHOUT CHANGING ANSWER, which is the
     * assertion most worth having. Kano used to reach Rest of Nigeria by
     * falling through to the fallback branch; it now matches by country,
     * because 0900 gave that zone `countries = {NG}`. Same zone, same rate,
     * different route through `zoneFor` — and if 0900 had set the country list
     * wrongly this is where it would show up as an international quote for a
     * domestic order.
     */
    expect(zoneFor(zones, 'NG', 'Kano').id).toBe('zone_rest_of_nigeria');
    expect(zoneFor(zones, 'NG', null).id).toBe('zone_rest_of_nigeria');
  });

  it('keeps exactly one fallback, and it is the international one', async () => {
    const zones = await loadShippingZonesForCheckout(ctx.db);
    const fallbacks = zones.filter((z) => z.fallback);

    // `zoneFor` throws when there is none, and silently prefers the first when
    // there are two. The partial unique index enforces this in the database;
    // asserting it here is what proves the seed did not fight it.
    expect(fallbacks.map((z) => z.id)).toEqual(['zone_international']);
  });
});
