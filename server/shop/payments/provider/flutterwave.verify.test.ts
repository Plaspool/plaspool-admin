import { describe, expect, it } from 'vitest';
import { FlutterwaveProvider } from './flutterwave';
import { ProviderError } from './scrub';

/**
 * `fetchIntent` AGAINST A REFERENCE NOBODY HAS PAID — the ordinary state of
 * every abandoned checkout, and the one Flutterwave answers differently from
 * Paystack.
 *
 * WHY THIS IS ITS OWN FILE AND WHY IT MATTERS. Paystack registers a transaction
 * at `/transaction/initialize`, so verifying an untouched reference returns a
 * real record reading `abandoned`. Flutterwave's `/v3/payments` only mints a
 * hosted LINK — no transaction exists under that `tx_ref` until somebody pays
 * one — so `verify_by_reference` has nothing to return and answers 404.
 *
 * `shop/payments/sync.ts` counts a thrown `fetchIntent` as "we asked and got no
 * answer": it writes the message onto the intent and reports the gateway as
 * unreachable. Without the 404 arm, a deployment whose active gateway is
 * Flutterwave — production's, since 2026-09-17 — would ask about every abandoned
 * cart inside the three-day window every fifteen minutes and record each one as
 * a gateway failure, making the sweep's "N couldn't be reached" a permanent
 * false alarm.
 *
 * THE TRANSPORT IS INJECTED rather than the global stubbed, because the adapter
 * takes one and a test that reached the real API would be a test that polls
 * somebody's live gateway. The field is `fetch` — Flutterwave's config spells it
 * differently from Paystack's `fetchImpl`, and passing the wrong name silently
 * falls back to the real network, which is how all four of these first failed
 * with `network` against `https://api.test`.
 */

const SECRET = 'FLWSECK_TEST-0123456789abcdef0123456789abcdef';

function provider(transport: typeof fetch): FlutterwaveProvider {
  return new FlutterwaveProvider({
    secretKey: SECRET,
    webhookHash: 'a-webhook-hash',
    baseUrl: 'https://api.test/v3',
    fetch: transport,
  });
}

/** One canned HTTP answer, and a record of what was asked. */
function answering(status: number, body: unknown): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (url: unknown) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: impl, urls };
}

async function failureOf(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (err) {
    return err as ProviderError;
  }
  throw new Error('expected the call to reject, and it resolved');
}

describe('a reference with no transaction behind it', () => {
  /*
   * 400 FIRST, BECAUSE IT IS THE ONE PRODUCTION ACTUALLY SENDS. Measured: the
   * live sweep asked about six real unpaid references and every one came back
   * `invalid_request (http 400)`. The first version of this fix guessed 404 and
   * would have left all six reported as "gateway unreachable" forever.
   */
  it.each([400, 404])('reads as requires_payment rather than throwing (http %i)', async (status) => {
    const { fetch, urls } = answering(status, {
      status: 'error',
      message: 'No transaction was found for this id',
      data: null,
    });

    const intent = await provider(fetch).fetchIntent('plaspool-abandoned-001');

    expect(intent).toEqual({
      providerIntentId: 'plaspool-abandoned-001',
      status: 'requires_payment',
      /* No transaction, so no amount and no currency to report — inventing the
         intent's own figures here would fabricate a gateway answer, and the
         charge check never runs on `requires_payment` anyway. */
      amount: 0,
      currency: '',
      authorizationUrl: null,
      failureReason: null,
      providerChargeId: null,
    });
    /* By OUR reference, as a query parameter — never by Flutterwave's numeric
       id, which does not exist for an unpaid checkout. */
    expect(urls[0]).toContain('/transactions/verify_by_reference?tx_ref=plaspool-abandoned-001');
  });

  it('still throws for every other refusal, which is what keeps this narrow', async () => {
    /*
     * The arm reads 400 and 404 and nothing else. A gateway that is down,
     * rate-limiting us, or refusing our credentials must still be a recorded
     * failure — turning those into "nobody has paid" would report a broken
     * integration as a shop with no sales, which is the opposite mistake and the
     * worse one.
     */
    for (const [status, code] of [
      [500, 'provider_unavailable'],
      [429, 'rate_limited'],
      [401, 'auth'],
      [403, 'auth'],
    ] as const) {
      const { fetch } = answering(status, { status: 'error', message: 'nope', data: null });
      const err = await failureOf(provider(fetch).fetchIntent('plaspool-ref-002'));
      expect(err.code, `status ${status}`).toBe(code);
    }
  });

  it('a 2xx whose envelope says error still throws, because no status code said 404', async () => {
    /* This adapter deliberately does not match on Flutterwave's message wording
       (`#classify` says why), so an error envelope served with 200 is outside
       what the 404 arm claims to know about. */
    const { fetch } = answering(200, { status: 'error', message: 'nope', data: null });
    expect((await failureOf(provider(fetch).fetchIntent('plaspool-ref-003'))).code).toBe(
      'invalid_request',
    );
  });
});

describe('a reference that HAS been paid', () => {
  it('still reads as captured, in minor units', async () => {
    /*
     * The happy path, here to prove the 404 arm did not swallow it. Flutterwave
     * charges in MAJOR units — 3000 where this system holds 300000 for ₦3,000 —
     * and `toMinorUnits` is the only place the adapter crosses that line.
     */
    const { fetch } = answering(200, {
      status: 'success',
      message: 'Transaction fetched',
      data: {
        id: 778899,
        tx_ref: 'plaspool-paid-004',
        status: 'successful',
        amount: 3000,
        currency: 'NGN',
      },
    });

    const intent = await provider(fetch).fetchIntent('plaspool-paid-004');

    expect(intent).toMatchObject({
      providerIntentId: 'plaspool-paid-004',
      status: 'captured',
      amount: 300_000,
      currency: 'NGN',
      providerChargeId: '778899',
    });
  });
});
