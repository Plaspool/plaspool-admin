import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PaystackProvider, providerEventIdOf, verifyPaystackSignature } from './paystack';
import { ProviderError, scrubbedProvider } from './scrub';
import type { PaymentProvider } from './types';

/**
 * The Paystack adapter, and above all the signature check.
 *
 * `03-payments.md` §4 calls the webhook "the single highest-severity line of
 * code in the commerce system", and §9 asks for it to be tested "with a valid
 * signature, an invalid one, a replayed one, and a body mutated after signing".
 * All four are below, plus the two Paystack's own documentation gets wrong.
 *
 * EVERY SIGNATURE IN THIS FILE IS COMPUTED INDEPENDENTLY, with a bare
 * `createHmac` call rather than by asking the module under test for one. A test
 * that signs with the same helper it verifies with proves the helper agrees
 * with itself, which is true of a helper that hashes nothing at all.
 */

const SECRET = 'sk_test_0123456789abcdef0123456789abcdef';

/**
 * The `ProviderError` a call rejected with.
 *
 * NOT `promise.catch(e => e as ProviderError)`, which is what this was first:
 * TypeScript types that expression as `ProviderIntent | ProviderError` — the
 * resolve type unioned with the cast — so every `err.code` was a TS2339 and the
 * cast was quietly doing nothing. Awaiting inside and throwing on success gives
 * the assertion a type that cannot be the success value, and fails loudly if the
 * call unexpectedly resolves instead of silently asserting on `undefined`.
 */
async function failureOf(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (err) {
    return err as ProviderError;
  }
  throw new Error('expected the call to reject, and it resolved');
}


/** What Paystack does, expressed independently of what `paystack.ts` does. */
function signAsPaystackWould(body: string | Uint8Array, secret = SECRET): string {
  return createHmac('sha512', secret).update(Buffer.from(body as never)).digest('hex');
}

function headersWith(signature: string | null): Headers {
  const h = new Headers();
  if (signature !== null) h.set('x-paystack-signature', signature);
  return h;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const CHARGE_SUCCESS = JSON.stringify({
  event: 'charge.success',
  data: {
    id: 4099260516,
    status: 'success',
    reference: 'pi-01JABCDEF',
    amount: 40333,
    currency: 'NGN',
    customer: { email: 'buyer@example.com' },
  },
});

function provider(fetchImpl?: typeof fetch): PaymentProvider {
  return new PaystackProvider({ secretKey: SECRET, baseUrl: 'https://api.test', fetchImpl });
}

describe('webhook signature verification — the four cases §9 names', () => {
  it('ACCEPTS a valid signature over the exact bytes', async () => {
    const raw = bytes(CHARGE_SUCCESS);
    const event = await provider().parseWebhook(raw, headersWith(signAsPaystackWould(raw)));
    expect(event.type).toBe('charge.success');
    expect(event.providerIntentId).toBe('pi-01JABCDEF');
    expect(event.intentStatus).toBe('captured');
  });

  it('REFUSES an invalid signature, and refuses an absent one', async () => {
    const raw = bytes(CHARGE_SUCCESS);
    for (const signature of [
      null,
      '',
      'not-hex',
      signAsPaystackWould(raw, 'sk_test_the_wrong_secret_key_entirely'),
      // A correct-length hex string that is simply wrong.
      'a'.repeat(128),
    ]) {
      await expect(
        provider().parseWebhook(raw, headersWith(signature)),
        `signature ${JSON.stringify(signature)}`,
      ).rejects.toMatchObject({ code: 'signature_invalid' });
    }
  });

  it('REFUSES a body mutated after signing — one flipped digit is enough', async () => {
    /*
     * The attack this exists to stop: a stranger who can see a legitimate
     * payload edits the amount and replays it. Without verification on the raw
     * bytes they mark an order paid.
     */
    const original = CHARGE_SUCCESS;
    const signature = signAsPaystackWould(bytes(original));
    const tampered = original.replace('"amount":40333', '"amount":1');
    expect(tampered).not.toBe(original);
    await expect(
      provider().parseWebhook(bytes(tampered), headersWith(signature)),
    ).rejects.toMatchObject({ code: 'signature_invalid' });
  });

  it('ACCEPTS a REPLAY at the adapter, because replay is dedupe’s job and not the cipher’s', async () => {
    /*
     * A replayed delivery carries a genuinely valid signature — Paystack itself
     * sends the same bytes up to 25 times over 72 hours, and there is no
     * timestamp in the scheme to bound it with. So the adapter MUST accept it,
     * and the defence lives one layer up: `providerEventId` is stable across
     * replays and UNIQUE-constrained in `shop_payment_events`.
     *
     * Asserting the stability HERE is what makes that layer's guarantee real:
     * a derivation that varied per delivery would make the unique index useless
     * while every signature test still passed.
     */
    const raw = bytes(CHARGE_SUCCESS);
    const headers = headersWith(signAsPaystackWould(raw));
    const first = await provider().parseWebhook(raw, headers);
    const second = await provider().parseWebhook(raw, headers);
    expect(second.providerEventId).toBe(first.providerEventId);
  });
});

describe('the signature is verified on RAW BYTES, not a re-serialise', () => {
  /**
   * Paystack's own documented Node sample does
   * `createHmac('sha512', secret).update(JSON.stringify(req.body))` — it
   * verifies against bytes Node produced, not the bytes Paystack signed. It
   * survives while Express's parser and `JSON.stringify` happen to agree, and
   * fails silently in the direction of REJECTING GENUINE EVENTS when they do
   * not.
   *
   * These two cases are bodies where they do not agree.
   */
  it('accepts a payload whose JSON round trip is not byte-identical', async () => {
    // Escaped forward slashes and a \u escape: both re-serialise differently,
    // and both are things a merchant note or a product title can contain.
    const wire = '{"event":"charge.success","data":{"reference":"pi-1","note":"a\\/b \\u00e9"}}';
    expect(JSON.stringify(JSON.parse(wire))).not.toBe(wire);

    const raw = bytes(wire);
    const event = await provider().parseWebhook(raw, headersWith(signAsPaystackWould(raw)));
    expect(event.type).toBe('charge.success');

    // …and the documented method would have rejected this genuine event.
    const docMethod = signAsPaystackWould(JSON.stringify(JSON.parse(wire)));
    expect(docMethod).not.toBe(signAsPaystackWould(raw));
  });

  it('accepts a payload whose key order a round trip would preserve but whitespace would not', async () => {
    const wire = '{\n  "event": "charge.success",\n  "data": { "reference": "pi-2" }\n}';
    const raw = bytes(wire);
    await expect(
      provider().parseWebhook(raw, headersWith(signAsPaystackWould(raw))),
    ).resolves.toMatchObject({ type: 'charge.success' });
    expect(signAsPaystackWould(JSON.stringify(JSON.parse(wire)))).not.toBe(
      signAsPaystackWould(raw),
    );
  });

  it('verifies before parsing — an unsigned body that is not JSON is a signature failure', async () => {
    /*
     * ORDERING, asserted through the error code. If the parse ran first, this
     * would be `malformed_response`; because verification runs first, it is
     * `signature_invalid` and the bytes are never parsed at all.
     */
    await expect(
      provider().parseWebhook(bytes('not json at all'), headersWith('a'.repeat(128))),
    ).rejects.toMatchObject({ code: 'signature_invalid' });
  });

  it('a SIGNED body that is not JSON is malformed, not a signature failure', async () => {
    const raw = bytes('not json at all');
    await expect(
      provider().parseWebhook(raw, headersWith(signAsPaystackWould(raw))),
    ).rejects.toMatchObject({ code: 'malformed_response' });
  });
});

describe('verifyPaystackSignature, directly', () => {
  it('is length-checked before the constant-time compare, so a short hex cannot throw', () => {
    // `timingSafeEqual` throws on a length mismatch rather than returning false,
    // which would turn a malformed signature into a 500 the provider retries.
    expect(verifyPaystackSignature(bytes('x'), 'ab', SECRET)).toBe(false);
    expect(verifyPaystackSignature(bytes('x'), '', SECRET)).toBe(false);
    expect(verifyPaystackSignature(bytes('x'), null, SECRET)).toBe(false);
  });

  it('accepts the signature Paystack would actually send', () => {
    const raw = bytes(CHARGE_SUCCESS);
    expect(verifyPaystackSignature(raw, signAsPaystackWould(raw), SECRET)).toBe(true);
  });

  it('is keyed by the SECRET KEY — Paystack has no separate signing secret', () => {
    const raw = bytes(CHARGE_SUCCESS);
    expect(verifyPaystackSignature(raw, signAsPaystackWould(raw, 'sk_test_other'), SECRET)).toBe(
      false,
    );
  });
});

describe('providerEventIdOf — a dedupe key for an envelope that carries none', () => {
  const raw = (o: unknown) => bytes(JSON.stringify(o));

  it('is stable across redeliveries of the same event', () => {
    const body = { event: 'charge.success', data: { id: 1, reference: 'pi-1' } };
    expect(providerEventIdOf('charge.success', body.data, raw(body))).toBe(
      providerEventIdOf('charge.success', body.data, raw(body)),
    );
  });

  it('keys a charge on its reference, which is ours and unique per transaction', () => {
    const data = { id: 1, reference: 'pi-1' };
    expect(providerEventIdOf('charge.success', data, raw({ data }))).toBe(
      'charge.success:pi-1',
    );
  });

  it('keys a refund on the REFUND id, so two partials on one charge do not collide', () => {
    /*
     * THE BUG THIS PREVENTS, and it is silent: partial refunds are supported
     * (§6), so one transaction can produce two `refund.processed` events. Keyed
     * on the transaction reference they share, the second would be discarded as
     * a duplicate and that refund would never be recorded as succeeded.
     */
    const a = { id: 3018284, transaction_reference: 'pi-1', status: 'processed' };
    const b = { id: 3018285, transaction_reference: 'pi-1', status: 'processed' };
    const idA = providerEventIdOf('refund.processed', a, raw({ data: a }));
    const idB = providerEventIdOf('refund.processed', b, raw({ data: b }));
    expect(idA).not.toBe(idB);
    expect(idA).toBe('refund.processed:3018284');
  });

  it('falls back to a body digest for an id too large to survive JSON.parse', () => {
    /*
     * Paystack's docs warn that transaction ids are unsigned 64-bit. `JSON.parse`
     * rounds anything above 2^53: `…891` and `…892` both land on `…8000`, so two
     * distinct events would share one identity and the second would vanish. The
     * parsed number is therefore only trusted when it is a safe integer AND its
     * decimal form appears verbatim in the bytes that were signed.
     */
    const wire = '{"event":"refund.processed","data":{"id":12345678901234567891}}';
    const parsed = JSON.parse(wire) as { data: { id: number } };
    expect(Number.isSafeInteger(parsed.data.id)).toBe(false);

    const id = providerEventIdOf('refund.processed', parsed.data, bytes(wire));
    expect(id).toMatch(/^refund\.processed:body:[0-9a-f]{64}$/);

    // And two such events still get distinct identities, via their bytes.
    const other = '{"event":"refund.processed","data":{"id":12345678901234567892}}';
    expect(
      providerEventIdOf('refund.processed', JSON.parse(other) as never, bytes(other)),
    ).not.toBe(id);
  });

  it('falls back to a body digest for an event type it has no rule for', () => {
    const data = { customer_code: 'CUS_x' };
    expect(providerEventIdOf('customeridentification.failed', data, raw({ data }))).toMatch(
      /^customeridentification\.failed:body:[0-9a-f]{64}$/,
    );
  });

  it('never returns an empty or prefix-only key', () => {
    for (const [event, data] of [
      ['charge.success', {}],
      ['refund.processed', {}],
      ['', null],
    ] as const) {
      const id = providerEventIdOf(event, data, raw({ event, data }));
      expect(id.length).toBeGreaterThan(event.length + 1);
    }
  });
});

describe('the HTTP layer classifies without carrying', () => {
  const respond = (status: number, body: unknown): typeof fetch =>
    (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;

  it('turns a duplicate reference into its own code, because it usually means success', async () => {
    await expect(
      provider(
        respond(400, { status: false, message: 'Duplicate Transaction Reference' }),
      ).createIntent({ reference: 'pi-1', amount: 100, currency: 'NGN', email: 'a@b.co' }),
    ).rejects.toMatchObject({ code: 'duplicate_reference' });
  });

  it('maps auth, rate limit, provider fault and refusal onto distinct retry policies', async () => {
    const cases: [number, string, boolean][] = [
      [401, 'auth', false],
      [403, 'auth', false],
      [429, 'rate_limited', true],
      [500, 'provider_unavailable', true],
      [503, 'provider_unavailable', true],
      [422, 'invalid_request', false],
    ];
    for (const [status, code, retryable] of cases) {
      const err = await failureOf(
        provider(respond(status, { status: false, message: 'nope' })).fetchIntent('pi-1'),
      );
      expect(err.code, `http ${status}`).toBe(code);
      expect(err.retryable, `http ${status} retryable`).toBe(retryable);
    }
  });

  it('treats a 200 whose envelope says status:false as PERMANENT, not transient', async () => {
    /*
     * Contract §10 again: a 500 is retried five times. Paystack answers 200 with
     * `status: false` for a request it understood and refused, and calling that
     * transient would re-send a charge that can never be accepted.
     */
    const err = await failureOf(
      provider(respond(200, { status: false, message: 'Invalid currency' })).fetchIntent('pi-1'),
    );
    expect(err.code).toBe('invalid_request');
    expect(err.retryable).toBe(false);
  });

  it('classifies a timeout as INDETERMINATE, never as a plain failure', async () => {
    const timingOut = (() => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      return Promise.reject(err);
    }) as unknown as typeof fetch;
    const err = await failureOf(
      provider(timingOut).createIntent({
        reference: 'pi-1',
        amount: 100,
        currency: 'NGN',
        email: 'a@b.co',
      }),
    );
    expect(err.code).toBe('timeout');
    expect(err.indeterminate).toBe(true);
  });

  it('never lets a response body or the bearer token reach the error', async () => {
    /*
     * The end-to-end version of `scrub.test.ts`, through the REAL adapter: a
     * provider that echoes the request back — which is what an unlucky 400 from
     * a real gateway looks like — must not put any of it on the error.
     */
    const echoing = ((url: string, init: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: false,
            message: 'rejected',
            echo: { url, headers: init.headers, body: init.body },
          }),
          { status: 400 },
        ),
      )) as unknown as typeof fetch;

    const err = await scrubbedProvider(provider(echoing))
      .createIntent({
        reference: 'pi-1',
        amount: 100,
        currency: 'NGN',
        email: 'buyer@example.com',
      })
      .catch((e: unknown) => e);

    const printable = [
      inspect(err, { depth: 10, showHidden: true }),
      (err as Error).stack ?? '',
      JSON.stringify(err, Object.getOwnPropertyNames(Object(err))),
    ].join('\n');
    expect(printable).not.toContain(SECRET);
    expect(printable).not.toContain('Bearer');
    expect(printable).not.toContain('buyer@example.com');
  });

  it('sends the key in a header and never in the URL', async () => {
    let seenUrl = '';
    let seenAuth: string | null = null;
    const capturing = ((url: string, init: RequestInit) => {
      seenUrl = url;
      seenAuth = new Headers(init.headers).get('authorization');
      return Promise.resolve(
        new Response(JSON.stringify({ status: true, data: { reference: 'pi-1' } }), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch;

    await provider(capturing).createIntent({
      reference: 'pi-1',
      amount: 100,
      currency: 'NGN',
      email: 'a@b.co',
    });
    // A key in a query string reaches every proxy log and every trace between
    // here and the provider.
    expect(seenUrl).not.toContain('sk_');
    expect(seenAuth).toBe(`Bearer ${SECRET}`);
  });

  it('sends the amount unchanged — no unit conversion anywhere', async () => {
    /*
     * Paystack's subunit and contract §10's minor units are the same thing for
     * every currency it supports. A conversion here would be a recomputation,
     * and §1 forbids the amount being anything but the figure CheckoutPort
     * froze.
     */
    let body: unknown;
    const capturing = ((_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Promise.resolve(
        new Response(JSON.stringify({ status: true, data: { reference: 'pi-1' } }), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch;

    await provider(capturing).createIntent({
      reference: 'pi-1',
      amount: 40333,
      currency: 'NGN',
      email: 'a@b.co',
    });
    expect(body).toMatchObject({ amount: '40333', currency: 'NGN', reference: 'pi-1' });
  });
});

describe('capabilities are declared honestly rather than faked', () => {
  it('refuses capture and cancel instead of pretending they worked', async () => {
    /*
     * Paystack has no two-step capture. A `capture()` that returned success
     * would report money taken that no provider ever moved — the worst possible
     * lie for this subsystem to tell.
     */
    const p = provider();
    expect(p.capabilities.separateCapture).toBe(false);
    expect(p.capabilities.remoteCancel).toBe(false);
    await expect(p.capture('pi-1', 'k')).rejects.toMatchObject({ code: 'unsupported' });
    await expect(p.cancel('pi-1', 'k')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('maps every documented transaction status onto the ladder', async () => {
    const cases: [string, string][] = [
      ['success', 'captured'],
      ['failed', 'failed'],
      ['abandoned', 'failed'],
      ['reversed', 'failed'],
      ['pending', 'requires_payment'],
      ['ongoing', 'requires_payment'],
      ['processing', 'requires_payment'],
      // A status Paystack has not invented yet must not become `captured`.
      ['something_new', 'requires_payment'],
    ];
    for (const [paystackStatus, expected] of cases) {
      const p = provider(
        (() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                status: true,
                data: {
                  reference: 'pi-1',
                  status: paystackStatus,
                  amount: 100,
                  currency: 'NGN',
                },
              }),
              { status: 200 },
            ),
          )) as unknown as typeof fetch,
      );
      await expect(p.fetchIntent('pi-1'), paystackStatus).resolves.toMatchObject({
        status: expected,
      });
    }
  });
});
