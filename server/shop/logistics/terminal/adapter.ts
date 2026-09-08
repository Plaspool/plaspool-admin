import { TERMINAL_LIVE_URL, environmentOf, type TerminalEnv } from '../config';
import { splitName, terminalStateName, toE164, zipFor } from '../address';
import { LogisticsError, type BookingResult, type LogisticsProvider, type ParcelInput, type PlaceCity, type PlaceList, type PlaceRegion, type ProviderDiagnostics, type ProviderPlaces, type ProviderSimulateOutcome, type QuoteOption, type QuoteResult, type SimulateLeg, type TrackResult, type WebhookEvent } from '../port';
import { terminalState } from '../status';
import { terminalItemKg, totalGrams } from '../weights';
import { TerminalClient, type TerminalClientOptions } from './client';
import { verifyTerminalWebhook } from './webhook';

export const TERMINAL_LABEL = 'Terminal Africa';
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** A finite number, or a non-blank string that parses to one — null/''/false/[] are not a price, they are its absence. */
const toMinor = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

function address(a: { name: string; phone: string | null; email: string | null; line1: string; line2: string | null; city: string; region: string; postalCode: string | null; countryCode: string }, residential: boolean) {
  const { firstName, lastName } = splitName(a.name);
  const phone = a.phone ? toE164(a.phone) : null;
  if (!phone) throw new LogisticsError('address_incomplete', `Terminal Africa needs a phone number for ${a.name}`, { detail: ['phone'] });
  return {
    first_name: firstName, last_name: lastName, ...(a.email ? { email: a.email } : {}), phone,
    line1: a.line1, ...(a.line2 ? { line2: a.line2 } : {}), city: a.city,
    /* Terminal's OWN spelling, which is not ours and not Fez's — see terminalStateName. */
    state: terminalStateName(a.region || a.city),
    country: a.countryCode.toUpperCase(), zip: zipFor(a.postalCode, a.region), is_residential: residential,
  };
}

/**
 * HOW MANY CITY REQUESTS MAY BE IN FLIGHT AT ONCE.
 *
 * Nigeria is 37 states, so an unbounded `Promise.all` would open 37 sockets at
 * a courier in one breath and invite a rate limit, while a plain sequential
 * loop would spend 37 round trips. Four is the middle, and it is affordable
 * because this NEVER runs on a request path — `port.ts`'s `ProviderPlaces`
 * carries that rule and `places.ts` is the only caller.
 */
const PLACES_CONCURRENCY = 4;

/**
 * Run `job` over every item with at most `limit` outstanding.
 *
 * A fixed pool of workers pulling from a shared cursor rather than chunked
 * batches: a batch of four waits for its slowest member before starting the
 * next four, which against a courier that occasionally takes a second turns
 * ten rounds into ten worst cases.
 *
 * THE FIRST FAILURE STOPS THE REST. `Promise.all` rejects at once but does not
 * cancel anything, so without the flag a courier that just refused — or
 * rate-limited us — would still be sent the remaining thirty-odd requests for
 * an answer nobody is waiting for any more.
 */
async function pooled<T>(items: readonly T[], limit: number, job: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      try {
        await job(item);
      } catch (err) {
        stopped = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * The Terminal Africa adapter. THE ONLY FILE OUTSIDE `terminal/` THAT SHOULD
 * EVER SEE `TerminalClient` — `deps.ts` wires this in as the `terminal`
 * provider and nothing else reaches into `terminal/client.ts` directly.
 */
export function createTerminalProvider(env: TerminalEnv, opts: TerminalClientOptions = {}): LogisticsProvider {
  const client = new TerminalClient(env, opts);
  const extras = (data: Record<string, unknown>) => {
    const x = rec(data.extras);
    return {
      trackingNumber: str(x.tracking_number) ?? str(data.carrier_tracking_number),
      trackingUrl: str(x.tracking_url) ?? str(x.carrier_tracking_url),
      labelUrl: str(x.shipping_label_url),
    };
  };
  const lastEvent = (data: Record<string, unknown>): string | null => {
    const events = Array.isArray(data.events) ? (data.events as Record<string, unknown>[]) : [];
    return str(events.at(-1)?.description);
  };
  const carrierName = (data: Record<string, unknown>): string | null => str(data.carrier) ?? str(rec(data.carrier).name);

  /**
   * Run one diagnostic call and REPORT rather than throw.
   *
   * The whole value of `provider_simulate` is the pair of answers — accepted
   * here, errored there — so a rejection from either leg has to survive as
   * data. `client.call` promises every failure is a `LogisticsError`; anything
   * else really is ours and is left to escape.
   */
  const attempt = async (
    call: () => Promise<Record<string, unknown>>,
  ): Promise<SimulateLeg & { envelope: Record<string, unknown> | null }> => {
    try {
      const envelope = await call();
      return { ok: true, message: str(envelope.message), envelope };
    } catch (err) {
      if (!(err instanceof LogisticsError)) throw err;
      return { ok: false, message: err.message, envelope: null };
    }
  };

  /**
   * How many deliveries Terminal says it made, or `null` when it answered in a
   * shape we cannot count. **`null` is not zero** — "we could not tell" and
   * "there were none" send an operator to different places, and only the
   * second is evidence that their pipeline is down.
   */
  const deliveryCount = (envelope: Record<string, unknown> | null): number | null => {
    if (!envelope) return null;
    if (Array.isArray(envelope.data)) return envelope.data.length;
    const nested = rec(envelope.data).deliveries;
    return Array.isArray(nested) ? nested.length : null;
  };

  const diagnostics: ProviderDiagnostics = {
    environment: environmentOf(env.baseUrl, TERMINAL_LIVE_URL),

    /**
     * `GET /webhooks` — the cheapest authenticated read Terminal has. It
     * creates nothing, costs nothing, and the list it answers with doubles as
     * the answer to "is our callback URL registered over there at all", which
     * is the next question an operator asks. URLs only: nothing in a webhook
     * record is a credential, but there is no reason to render its ids either.
     */
    async ping(): Promise<Record<string, unknown>> {
      const res = await client.call('GET', '/webhooks');
      const list = Array.isArray(res.data) ? (res.data as Record<string, unknown>[]) : [];
      return {
        probe: 'GET /webhooks',
        webhooks: list.length,
        urls: list.flatMap((w) => {
          const u = str(w.url);
          return u ? [u] : [];
        }),
      };
    },

    /**
     * ASK TERMINAL TO SEND ONE, THEN READ WHAT IT THINKS IT SENT.
     *
     * BOTH LEGS ALWAYS RUN, and the second runs even when the first refused:
     * the delivery log is where the truth is, and on the sandbox it has been
     * answering an error while the simulator answered "queued". Reporting only
     * the first would have this call say everything was fine.
     */
    async simulateWebhook(shipmentId: string): Promise<ProviderSimulateOutcome> {
      const simulate = await attempt(() =>
        client.call('POST', '/webhooks/simulate', {
          event: 'shipment.updated',
          shipment_id: shipmentId,
        }),
      );
      const deliveries = await attempt(() =>
        client.call('GET', `/webhooks/deliveries?shipment_id=${encodeURIComponent(shipmentId)}`),
      );
      return {
        simulate: { ok: simulate.ok, message: simulate.message },
        deliveries: {
          ok: deliveries.ok,
          message: deliveries.message,
          count: deliveries.ok ? deliveryCount(deliveries.envelope) : null,
        },
      };
    },
  };

  /**
   * WHICH PLACES TERMINAL WILL ACCEPT, which is not a courtesy — it validates
   * `state` and `city` against these lists and refuses anything else with a 400
   * that kills the whole quote. Measured 2026-09-07: 37 states for NG (36 plus
   * the FCT, which Terminal names `Abuja` with isoCode `FC`), ten place names
   * inside the FCT and 46 in Lagos.
   *
   * REGIONS FIRST, THEN THEIR CITIES, four at a time. The region's `isoCode` is
   * both the key the city map is filed under and the `state_code` Terminal
   * wants back — the display name is not interchangeable with it.
   */
  const places: ProviderPlaces = {
    async list(country: string): Promise<PlaceList> {
      const code = country.toUpperCase();
      const res = await client.call('GET', `/states?country_code=${encodeURIComponent(code)}`);
      const rows = Array.isArray(res.data) ? (res.data as Record<string, unknown>[]) : [];
      /* A state with no name is not a place a shopper can pick; a state with no
         isoCode IS, it simply has no cities to ask for. Dropping the second
         would quietly shorten the list. */
      const regions: PlaceRegion[] = rows.flatMap((row) => {
        const name = str(row.name);
        return name ? [{ name, code: str(row.isoCode) }] : [];
      });

      const cities: Record<string, PlaceCity[]> = {};
      await pooled(
        regions.filter((region): region is PlaceRegion & { code: string } => region.code !== null),
        PLACES_CONCURRENCY,
        async (region) => {
          const answer = await client.call(
            'GET',
            `/cities?country_code=${encodeURIComponent(code)}&state_code=${encodeURIComponent(region.code)}`,
          );
          const list = Array.isArray(answer.data) ? (answer.data as Record<string, unknown>[]) : [];
          cities[region.code] = list.flatMap((row) => {
            const name = str(row.name);
            return name ? [{ name }] : [];
          });
        },
      );

      return { regions, cities };
    },
  };

  return {
    id: 'terminal', label: TERMINAL_LABEL, diagnostics, places,

    async quote(input: ParcelInput): Promise<QuoteResult> {
      if (!input.from) throw new LogisticsError('address_incomplete', 'Terminal Africa needs a ship-from address', { detail: ['shipFrom'] });
      const noWeight = input.items.find((i) => i.weightGrams == null);
      if (noWeight) throw new LogisticsError('address_incomplete', `${noWeight.title} has no weight`, { detail: ['weight'] });
      // Build both addresses — where an unusable phone throws — before creating anything at
      // Terminal, so a bad address never leaves an orphaned packaging record behind.
      const from = { ...input.from, phone: input.from.phone, email: input.from.email ?? null, line2: input.from.line2 ?? null, postalCode: input.from.postalCode };
      const pickupAddress = address(from, false);
      const deliveryAddress = address(input.to, true);
      let packagingRef = input.packagingRef;
      let created: string | undefined;
      if (!packagingRef) {
        const p = input.packaging;
        const res = await client.call('POST', '/packaging', { name: p.name, type: 'box', height: p.heightCm, width: p.widthCm, length: p.lengthCm, size_unit: 'cm', weight: p.weightKg, weight_unit: 'kg' });
        packagingRef = str(rec(res.data).packaging_id);
        if (!packagingRef) throw new LogisticsError('bad_response', 'Terminal Africa returned no packaging id');
        created = packagingRef;
      }
      /*
       * A PACKAGING RECORD WE MADE LEAVES BY BOTH DOORS.
       *
       * Everything past this point can fail — a state Terminal will not deliver
       * to, a shipment it will not price — and the id would then be lost: not
       * returned, not thrown, never cached, so the next attempt minted another
       * and every failed quote leaked one record at Terminal. The failure is
       * re-thrown UNCHANGED except for the receipt, so the caller still sees
       * the code, message, status, detail and stack of whatever actually went
       * wrong. `client.call` promises every failure below is a LogisticsError.
       */
      try {
        const shipment = await client.call('POST', '/shipments/quick', {
          pickup_address: pickupAddress, delivery_address: deliveryAddress,
          parcel: {
            description: `Order ${input.orderNumber}`,
            items: input.items.map((i) => ({ name: i.title, description: i.sku, currency: 'NGN', value: i.unitMinor / 100, quantity: i.qty, weight: terminalItemKg(i.weightGrams ?? 0) })),
            packaging: packagingRef, weight_unit: 'kg',
          },
          shipment_purpose: 'commercial', metadata: { fulfillmentId: input.fulfillmentId, orderNumber: input.orderNumber },
        });
        const shipmentId = str(rec(shipment.data).shipment_id);
        if (!shipmentId) throw new LogisticsError('bad_response', 'Terminal Africa returned no shipment id');
        const rates = await client.call('GET', `/rates/shipment?shipment_id=${encodeURIComponent(shipmentId)}&currency=NGN`);
        const list = Array.isArray(rates.data) ? (rates.data as Record<string, unknown>[]) : [];
        const options: QuoteOption[] = list.flatMap((r) => {
          const id = str(r.rate_id); const amountMinor = toMinor(r.amount);
          if (!id || amountMinor === null) return [];
          const carrier = str(r.carrier_name) ?? 'Courier';
          return [{ id, carrier, label: str(r.carrier_rate_description) ? `${carrier} · ${r.carrier_rate_description as string}` : carrier, amountMinor, currency: 'NGN' as const, ...(str(r.delivery_time) ? { eta: r.delivery_time as string } : {}), ...(str(r.pickup_time) ? { pickupEta: r.pickup_time as string } : {}) }];
        });
        return { providerRef: shipmentId, options, weightKg: Math.round(totalGrams(input.items)) / 1000, note: null, ...(created ? { packagingRef: created } : {}) };
      } catch (err) {
        /* Only when THIS call created it — a cached ref the caller already holds
           is not news, and claiming it would be a write for nothing. */
        if (created && err instanceof LogisticsError) err.packagingRef ??= created;
        throw err;
      }
    },

    async book(_input, optionId, quoteRef, chosen): Promise<BookingResult> {
      if (!quoteRef) throw new LogisticsError('provider_rejected', 'Get a Terminal quote before booking');
      const res = await client.call('POST', '/shipments/pickup', { rate_id: optionId, shipment_id: quoteRef });
      const data = rec(res.data);
      const x = extras(data);
      const carrier = carrierName(data) ?? chosen?.carrier ?? 'Courier';
      const raw = str(data.status) ?? 'confirmed';
      return { providerRef: str(data.shipment_id) ?? quoteRef, carrier, trackingNumber: x.trackingNumber ?? (str(data.shipment_id) ?? quoteRef), trackingUrl: x.trackingUrl, labelUrl: x.labelUrl, costMinor: chosen?.amountMinor ?? null, rawStatus: raw, state: terminalState(raw) === 'draft' ? 'booked' : terminalState(raw) };
    },

    async track(providerRef): Promise<TrackResult> {
      const res = await client.call('GET', `/shipments/track/${encodeURIComponent(providerRef)}`);
      const data = rec(res.data);
      const raw = str(data.status);
      if (!raw) throw new LogisticsError('bad_response', 'Terminal Africa returned no status');
      return { rawStatus: raw, state: terminalState(raw), description: lastEvent(data), ...extras(data), carrier: carrierName(data) };
    },

    async cancel(providerRef): Promise<void> { await client.call('POST', '/shipments/cancel', { shipment_id: providerRef }); },

    async registerWebhook(url): Promise<void> {
      await client.call('POST', '/webhooks', { name: 'PlaSpool admin', url, events: ['shipment.created', 'shipment.updated'], active: true, live: environmentOf(env.baseUrl, TERMINAL_LIVE_URL) === 'live' });
    },

    parseWebhook(rawBody, headers): WebhookEvent | null {
      const body = verifyTerminalWebhook(rawBody, headers, env.secretKey);
      if (!body) throw new LogisticsError('bad_signature', 'Terminal Africa signature did not verify');
      const event = str(body.event) ?? '';
      if (!event.startsWith('shipment.')) return null;
      const data = rec(body.data);
      const ref = str(data.shipment_id); const raw = str(data.status);
      if (!ref || !raw) return null;
      return { providerRef: ref, rawStatus: raw, state: terminalState(raw), description: lastEvent(data), ...extras(data), carrier: carrierName(data) };
    },
  };
}
