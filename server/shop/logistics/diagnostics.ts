import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { str } from '../../middleware/errors';
import type { Db } from '../../db/client';
import { shipFromMissing } from './address';
import { logisticsEnv } from './config';
import type { ResolvedLogisticsDeps } from './deps';
import { newLogisticsId } from './ids';
import { LogisticsError } from './port';
import type { ParcelInput, ParcelLine, ProviderId, QuoteResult } from './port';
import { getLogisticsSettings, setTerminalPackagingId } from './repo';
import { naira } from './service';

/**
 * COURIER DIAGNOSTICS — the four questions that until now could only be asked
 * from a throwaway script, moved behind one admin button.
 *
 * ═══ WHY EVERY CHECK ANSWERS `{ ok }` INSTEAD OF THROWING ═══
 *
 * A diagnostic that cannot fail is useless. Each of these was written because
 * a courier said NO in a way nothing on screen could explain:
 *
 *   - Terminal accepts 46 cities in Lagos and 10 in Abuja and refuses every
 *     other name, so a real Abuja order is usually refused. The only way an
 *     operator could discover that was to fail a live booking. `quote` returns
 *     the refusal VERBATIM and, where the courier listed what it would accept,
 *     those names in `detail.accepted`.
 *   - Terminal's `POST /webhooks/simulate` answers "queued" and never delivers,
 *     and its own `GET /webhooks/deliveries` answers an error. `provider_simulate`
 *     reports both halves honestly, because that pair is the evidence for a
 *     support ticket.
 *   - The inbound half was only ever proved by signing a payload with the
 *     provider's key and POSTing it at our public webhook URL by hand.
 *     `webhook_self_test` is that, as a button.
 *
 * So a provider refusing is a SUCCESSFUL diagnostic and comes back `ok: false`
 * with a 200. Only a request that cannot be run at all — an unknown courier,
 * one with no credentials here, a Terminal quote with no ship-from — is a 4xx,
 * and `routes.ts` maps the refusals below onto codes it already spends.
 *
 * ═══ WHAT IT IS ALLOWED TO WRITE ═══
 *
 * ONE ROW, ONE COLUMN: `shop_logistics_settings.terminal_packaging_id`, and
 * only because Terminal MINTS a packaging record during a quote whether we
 * wanted one or not. Dropping that id would leak a record at Terminal on every
 * diagnostic — the leak `quoteParcel` already fixed for the booking path, taken
 * the identical way out here (both doors: the success and the failure).
 * Nothing else about a diagnostic is persisted: no parcel, no draft shipment on
 * a fulfillment, no webhook registration.
 *
 * NO SECRET EVER LEAVES THIS FILE. The keys are read for one purpose — to sign
 * the self-test the way the courier itself signs — and what goes into a summary
 * is the courier's own words about OUR request, never a credential. The one
 * variable name that does reach the screen (`FEZ_SECRET_KEY`) is a name, which
 * is the whole point of naming it.
 */

// ------------------------------------------------------------------- request

const ProviderName = z.enum(['fez', 'terminal']);

/**
 * A discriminated union on `check`, so an unknown check, a missing
 * `shipmentId`, or `provider_simulate` asked of Fez are all one thing: a 400
 * carrying Zod's own detail. `.strict()` throughout, per the project's rule
 * that an unknown key is a permanent refusal rather than a silent drop.
 */
export const DiagnosticsBody = z.discriminatedUnion('check', [
  z.object({ check: z.literal('connection'), provider: ProviderName }).strict(),
  z
    .object({
      check: z.literal('quote'),
      provider: ProviderName,
      /* No name and no phone: a diagnostic quote is about an ADDRESS. The
         recipient is synthesised below from the shop's own ship-from. */
      to: z
        .object({
          line1: str().min(1).max(300),
          city: str().min(1).max(120),
          region: str().min(1).max(120),
          postalCode: str().min(1).max(20).optional(),
        })
        .strict(),
      weightGrams: z.number().int().positive().max(100_000).optional(),
    })
    .strict(),
  z.object({ check: z.literal('webhook_self_test'), provider: ProviderName }).strict(),
  /* `z.literal('terminal')` AND NOT A BRANCH: Fez has no simulator, so asking
     for one is a malformed request rather than an unlucky one, and the 400 then
     names the field. */
  z
    .object({
      check: z.literal('provider_simulate'),
      provider: z.literal('terminal'),
      shipmentId: str().min(1).max(200),
    })
    .strict(),
]);

export type DiagnosticsRequest = z.infer<typeof DiagnosticsBody>;

// -------------------------------------------------------------------- answer

/** The envelope every check answers with, whatever it found. */
export interface DiagnosticResult {
  check: DiagnosticsRequest['check'];
  ok: boolean;
  /** One sentence an operator can act on. A courier's refusal appears here VERBATIM. */
  summary: string;
  detail?: Record<string, unknown>;
}

/** The two states that make a diagnostic un-runnable rather than merely failed. */
export type DiagnosticRefusal =
  | { refused: 'provider_not_configured'; provider: ProviderId }
  | { refused: 'ship_from_incomplete'; missing: string[] };

export interface DiagnosticContext {
  /** OUR own public webhook address, derived by the route from the allow-listed origin. */
  webhookUrl: string;
}

// ------------------------------------------------------------------- helpers

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;

/** How many acceptable values are worth putting on a screen. Lagos alone has 46 cities. */
const ACCEPTED_CAP = 200;

/**
 * The names a courier listed as acceptable, out of its own error body.
 *
 * THIS IS THE PAYLOAD THE WHOLE `quote` CHECK EXISTS FOR. Terminal answers an
 * invalid state or city with `data` carrying the list it would have taken, and
 * an operator who can read that list stops guessing. NAMES ONLY — the entries
 * carry ids and country codes we have no business rendering — and capped, so a
 * courier answering a thousand rows cannot make the response unusable.
 */
export function acceptedNames(detail: unknown): string[] | null {
  const data = rec(detail).data;
  if (!Array.isArray(data)) return null;
  const names = data.flatMap((entry): string[] => {
    const name = typeof entry === 'string' ? entry : rec(entry).name;
    const value = text(name);
    return value ? [value.trim()] : [];
  });
  return names.length > 0 ? names.slice(0, ACCEPTED_CAP) : null;
}

/** What a `LogisticsError` contributes to a `detail`, minus anything a screen should not see. */
const failureDetail = (err: LogisticsError): Record<string, unknown> => ({
  code: err.code,
  status: err.status ?? null,
});

// ------------------------------------------------------------------ 1. connection

/**
 * The cheapest real authenticated call each courier has, and nothing more.
 *
 * A REFUSAL IS THE ANSWER, NOT A FAILURE — `ok: false` carrying the courier's
 * own message. The environment is reported either way, because "it works" and
 * "it works, against the SANDBOX" are different findings and the second is the
 * one that gets missed.
 */
async function connectionCheck(
  deps: ResolvedLogisticsDeps,
  provider: ProviderId,
): Promise<DiagnosticResult | DiagnosticRefusal> {
  const adapter = deps.providerFor(provider);
  if (!adapter) return { refused: 'provider_not_configured', provider };
  const diagnostics = adapter.diagnostics;
  if (!diagnostics) {
    return {
      check: 'connection',
      ok: false,
      summary: `${adapter.label} cannot be tested from here on this deployment.`,
      detail: { provider },
    };
  }

  const environment = diagnostics.environment;
  try {
    const response = await diagnostics.ping();
    return {
      check: 'connection',
      ok: true,
      summary: `${adapter.label} accepted the credentials (${environment}).`,
      detail: { provider, environment, response },
    };
  } catch (err) {
    if (!(err instanceof LogisticsError)) throw err;
    return {
      check: 'connection',
      ok: false,
      summary: err.message,
      detail: { provider, environment, ...failureDetail(err) },
    };
  }
}

// ----------------------------------------------------------------- 2. quote

/** A diagnostic parcel weighs this unless the operator says otherwise. */
const DEFAULT_DIAGNOSTIC_GRAMS = 1000;
/** ₦10,000 declared. High enough to be a real insurance figure, low enough to be a plausible one. */
const DEFAULT_DIAGNOSTIC_VALUE_MINOR = 1_000_000;
/**
 * The recipient phone used when the shop has saved no ship-from to borrow one
 * from. Terminal refuses an address with no usable phone, and a Fez quote never
 * sends one at all, so this is only ever reached on a Fez quote.
 */
const FALLBACK_PHONE = '08000000000';

async function quoteCheck(
  db: Db,
  deps: ResolvedLogisticsDeps,
  req: Extract<DiagnosticsRequest, { check: 'quote' }>,
): Promise<DiagnosticResult | DiagnosticRefusal> {
  const provider = req.provider;
  const adapter = deps.providerFor(provider);
  if (!adapter) return { refused: 'provider_not_configured', provider };

  const settings = await getLogisticsSettings(db);
  /*
   * TERMINAL ONLY, exactly as the settings patch refuses it: Fez collects from
   * an address held in their own portal and prices a state and a weight, so a
   * Fez quote with nothing saved here is an ordinary question. Terminal quotes
   * FROM the address we send and refuses the shipment without one, so asking
   * anyway would spend a round trip to be told what we already knew.
   */
  if (provider === 'terminal') {
    const missing = shipFromMissing(settings.shipFrom);
    if (missing.length > 0) return { refused: 'ship_from_incomplete', missing };
  }

  const reference = newLogisticsId('diag_');
  const weightGrams = req.weightGrams ?? DEFAULT_DIAGNOSTIC_GRAMS;
  const items: ParcelLine[] = [
    {
      orderLineId: reference,
      variantId: reference,
      title: 'Courier diagnostic parcel',
      sku: 'DIAG',
      qty: 1,
      unitMinor: DEFAULT_DIAGNOSTIC_VALUE_MINOR,
      weightGrams,
    },
  ];
  const input: ParcelInput = {
    fulfillmentId: reference,
    orderNumber: reference,
    to: {
      name: 'Courier diagnostic',
      phone: settings.shipFrom?.phone ?? FALLBACK_PHONE,
      email: null,
      line1: req.to.line1,
      line2: null,
      city: req.to.city,
      region: req.to.region,
      postalCode: req.to.postalCode ?? null,
      countryCode: 'NG',
      /* NO ROUTING CITY, DELIBERATELY. The bench exists to find out whether the
       * courier accepts the city the operator TYPED — substituting a zone here
       * would answer a question nobody asked and hide the refusal this probe is
       * for. Real bookings get the shopper's own pick (migration 1020). */
      routingCity: null,
    },
    from: settings.shipFrom,
    items,
    valueMinor: DEFAULT_DIAGNOSTIC_VALUE_MINOR,
    packaging: settings.packaging,
    packagingRef: settings.terminalPackagingId,
  };

  let quote: QuoteResult;
  try {
    quote = await adapter.quote(input);
  } catch (err) {
    if (!(err instanceof LogisticsError)) throw err;
    /* A record Terminal minted before it refused. Kept for the same reason
       `quoteParcel` keeps it: the quotes most likely to fail are the ones an
       operator retries, and every retry would otherwise mint another. */
    if (err.packagingRef) await setTerminalPackagingId(db, err.packagingRef);
    const accepted = acceptedNames(err.detail);
    return {
      check: 'quote',
      ok: false,
      /* VERBATIM. This is how an operator learns Terminal will not take
         "Gwarinpa" — paraphrasing it would throw away the finding. */
      summary: err.message,
      detail: {
        provider,
        weightGrams,
        ...failureDetail(err),
        ...(accepted ? { accepted } : {}),
      },
    };
  }
  if (quote.packagingRef) await setTerminalPackagingId(db, quote.packagingRef);

  const cheapest = quote.options.reduce<(typeof quote.options)[number] | null>(
    (best, option) => (best === null || option.amountMinor < best.amountMinor ? option : best),
    null,
  );
  const detail = {
    provider,
    weightKg: quote.weightKg,
    weightGrams,
    note: quote.note,
    /* Terminal's draft shipment id, which `provider_simulate` is asked for
       next. Null for Fez, which holds nothing between a price and a booking. */
    shipmentId: quote.providerRef,
    reference,
    options: quote.options,
  };

  /*
   * ZERO OPTIONS IS `ok: false`, though nothing threw. The courier answered,
   * so the credentials and the address are fine — but the operator cannot ship
   * to that address today, which is the question they asked.
   */
  if (!cheapest) {
    return {
      check: 'quote',
      ok: false,
      summary: `${adapter.label} priced nothing for that address.`,
      detail,
    };
  }
  const count = quote.options.length;
  return {
    check: 'quote',
    ok: true,
    summary: `${count} option${count === 1 ? '' : 's'}, cheapest ${naira(cheapest.amountMinor)} (${cheapest.carrier})`,
    detail,
  };
}

// ------------------------------------------------------- 3. webhook self test

/** Long enough for a cold lambda, short enough that a button does not hang. */
const SELF_TEST_TIMEOUT_MS = 8_000;

/** The env var each courier signs its callbacks with, named so a screen can name it. */
const SECRET_ENV: Record<ProviderId, string> = {
  fez: 'FEZ_SECRET_KEY',
  terminal: 'TERMINAL_SECRET_KEY',
};

/**
 * A payload signed the way the courier itself signs, ready to POST at our own
 * door.
 *
 * THE REFERENCE CANNOT MATCH A REAL PARCEL — `DIAG-…`, which is neither a Fez
 * waybill nor a Terminal shipment id — so the expected outcome is a 200
 * `{ok:true,unmatched:true}` and a `verified` row in the webhook log. A
 * reference that COULD match would make a diagnostic move a customer's parcel.
 */
function signedSelfTest(
  provider: ProviderId,
  secretKey: string,
  now: number,
): { reference: string; body: string; headers: Record<string, string> } {
  const reference = newLogisticsId('DIAG-');
  if (provider === 'fez') {
    /* HMAC-SHA256 over orderNumber + status + timestamp; the timestamp is in
       seconds and must sit inside `FEZ_REPLAY_WINDOW_MS` of the receiver's now. */
    const status = 'Pending Pick-Up';
    const timestamp = String(Math.floor(now / 1000));
    return {
      reference,
      body: JSON.stringify({ orderNumber: reference, status }),
      headers: {
        'x-signature': createHmac('sha256', secretKey)
          .update(reference + status + timestamp)
          .digest('hex'),
        'x-timestamp': timestamp,
      },
    };
  }
  /* HMAC-SHA512 over the body bytes exactly as sent — re-serialising would
     change them, which is the failure the receiver's raw-bytes read exists for. */
  const body = JSON.stringify({
    event: 'shipment.updated',
    data: { shipment_id: reference, status: 'in-transit' },
  });
  return {
    reference,
    body,
    headers: {
      'x-terminal-signature': createHmac('sha512', secretKey).update(body).digest('hex'),
    },
  };
}

/**
 * DOES OUR OWN WEBHOOK ADDRESS ACCEPT A CORRECTLY SIGNED UPDATE?
 *
 * The one check that proves the INBOUND half, and it proves it the only honest
 * way: by leaving this process and coming back in through the public door, past
 * whatever proxy, redirect or WAF sits in front of it. A unit test cannot find
 * a host that 301s to www, and that is exactly the failure that silently kills
 * a courier integration.
 *
 * THE KEY COMES FROM THE ENVIRONMENT ALONE, deliberately — never from a key a
 * Fez sign-in taught this process. `configured` and `webhookReady` are two
 * different questions for Fez (`routes.ts#settingsView` says why at length):
 * a self-test that passed because THIS lambda had signed in would tell the
 * operator the shop can hear back when the next cold start cannot.
 */
async function webhookSelfTest(
  deps: ResolvedLogisticsDeps,
  provider: ProviderId,
  url: string,
): Promise<DiagnosticResult | DiagnosticRefusal> {
  const adapter = deps.providerFor(provider);
  if (!adapter) return { refused: 'provider_not_configured', provider };

  const env = logisticsEnv();
  const secretKey = provider === 'fez' ? (env.fez?.secretKey ?? null) : (env.terminal?.secretKey ?? null);
  const variable = SECRET_ENV[provider];
  if (!secretKey) {
    /* NAME THE VARIABLE AND CALL NOBODY. Signing with nothing would produce a
       401 that means something else entirely, and the operator would go
       looking for a routing problem they do not have. */
    return {
      check: 'webhook_self_test',
      ok: false,
      summary: `${adapter.label} cannot verify a callback here: ${variable} is not set on this deployment.`,
      detail: { provider, url, missing: variable },
    };
  }

  const { reference, body, headers } = signedSelfTest(provider, secretKey, deps.now());

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      /* NEVER FOLLOW A REDIRECT. A signed body must not be replayed at whatever
         host a 30x names, and a redirect here is itself the finding — couriers
         do not follow them either. */
      redirect: 'manual',
      signal: AbortSignal.timeout(SELF_TEST_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return {
      check: 'webhook_self_test',
      ok: false,
      summary: timedOut
        ? `Your webhook address did not answer within ${SELF_TEST_TIMEOUT_MS / 1000} seconds.`
        : 'Your webhook address could not be reached.',
      detail: { provider, url, reference, error: name || 'unknown' },
    };
  }

  let answered: unknown = null;
  try {
    answered = await res.json();
  } catch {
    answered = null;
  }
  const detail = { provider, url, reference, status: res.status, response: answered };

  if (rec(answered).ok === true && res.status === 200) {
    return {
      check: 'webhook_self_test',
      ok: true,
      summary: 'Your webhook address accepted a correctly signed update.',
      detail,
    };
  }
  if (res.status >= 300 && res.status < 400) {
    return {
      check: 'webhook_self_test',
      ok: false,
      summary: `Your webhook address redirected (${res.status}) instead of accepting the update, and a courier will not follow it.`,
      detail,
    };
  }
  const code = text(rec(answered).error);
  return {
    check: 'webhook_self_test',
    ok: false,
    summary: `Your webhook address refused a correctly signed update (${res.status}${code ? ` ${code}` : ''}).`,
    detail,
  };
}

// -------------------------------------------------- 4. provider simulate

/**
 * ASK TERMINAL TO SEND ONE ITSELF, THEN READ ITS OWN DELIVERY LOG.
 *
 * REGISTERS NOTHING and books nothing — it names a shipment the operator
 * already has (from a `quote` check's `detail.shipmentId`) and asks Terminal to
 * replay an update for it.
 *
 * `ok` TURNS ON A DELIVERY BEING RECORDED, not on the simulation being
 * accepted, because those two have been diverging in Terminal's sandbox all
 * along: `POST /webhooks/simulate` answers "queued" and nothing ever arrives.
 * Both halves are reported so the operator can paste the pair into a support
 * ticket.
 */
async function providerSimulate(
  deps: ResolvedLogisticsDeps,
  provider: 'terminal',
  shipmentId: string,
): Promise<DiagnosticResult | DiagnosticRefusal> {
  const adapter = deps.providerFor(provider);
  if (!adapter) return { refused: 'provider_not_configured', provider };
  const simulate = adapter.diagnostics?.simulateWebhook;
  if (!simulate) {
    return {
      check: 'provider_simulate',
      ok: false,
      summary: `${adapter.label} cannot be asked to send a test webhook from here.`,
      detail: { provider, shipmentId },
    };
  }

  const outcome = await simulate(shipmentId);
  const detail = { provider, shipmentId, ...outcome };
  const delivered = outcome.deliveries.ok && (outcome.deliveries.count ?? 0) > 0;

  if (!outcome.simulate.ok) {
    return {
      check: 'provider_simulate',
      ok: false,
      summary: `${adapter.label} refused to simulate a webhook: ${outcome.simulate.message ?? 'no reason given'}`,
      detail,
    };
  }
  if (!outcome.deliveries.ok) {
    /* THE EVIDENCE FOR THE TICKET. Their simulator accepted the request and
       their own log cannot say what became of it — in their words, not ours. */
    return {
      check: 'provider_simulate',
      ok: false,
      summary: `${adapter.label} queued the simulation, but its delivery log answered: ${outcome.deliveries.message ?? 'nothing at all'}`,
      detail,
    };
  }
  const count = outcome.deliveries.count ?? 0;
  return {
    check: 'provider_simulate',
    ok: delivered,
    summary: delivered
      ? `${adapter.label} queued the simulation and recorded ${count} delivery attempt${count === 1 ? '' : 's'}.`
      : `${adapter.label} queued the simulation but has recorded no delivery attempt.`,
    detail,
  };
}

// ------------------------------------------------------------------ the door

/**
 * Run one check. **The whole surface of this module** — `routes.ts` reads the
 * body, derives the webhook URL from an allow-listed origin, and turns the two
 * refusals into the 409s the rest of that file already spends.
 */
export async function runDiagnostic(
  db: Db,
  deps: ResolvedLogisticsDeps,
  req: DiagnosticsRequest,
  ctx: DiagnosticContext,
): Promise<DiagnosticResult | DiagnosticRefusal> {
  switch (req.check) {
    case 'connection':
      return connectionCheck(deps, req.provider);
    case 'quote':
      return quoteCheck(db, deps, req);
    case 'webhook_self_test':
      return webhookSelfTest(deps, req.provider, ctx.webhookUrl);
    case 'provider_simulate':
      return providerSimulate(deps, req.provider, req.shipmentId);
  }
}
