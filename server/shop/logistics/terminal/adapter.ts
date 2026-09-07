import { TERMINAL_LIVE_URL, environmentOf, type TerminalEnv } from '../config';
import { splitName, toE164, zipFor } from '../address';
import { LogisticsError, type BookingResult, type LogisticsProvider, type ParcelInput, type QuoteOption, type QuoteResult, type TrackResult, type WebhookEvent } from '../port';
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
    line1: a.line1, ...(a.line2 ? { line2: a.line2 } : {}), city: a.city, state: a.region || a.city,
    country: a.countryCode.toUpperCase(), zip: zipFor(a.postalCode, a.region), is_residential: residential,
  };
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

  return {
    id: 'terminal', label: TERMINAL_LABEL,

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
