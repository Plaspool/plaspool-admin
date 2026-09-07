import type { FezEnv } from '../config';
import { fezStateName, oneLine } from '../address';
import {
  LogisticsError,
  type BookingResult,
  type LogisticsProvider,
  type ParcelInput,
  type QuoteOption,
  type QuoteResult,
  type TrackResult,
  type WebhookEvent,
} from '../port';
import { fezState } from '../status';
import { declaredValueMinor, fezKg, missingWeights, totalGrams } from '../weights';
import { FezClient, type FezClientOptions } from './client';
import { verifyFezWebhook } from './webhook';

export const FEZ_LABEL = 'Fez Delivery';

const toMinor = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * The Fez Delivery adapter. THE ONLY FILE OUTSIDE `fez/` THAT SHOULD EVER SEE
 * `FezClient` — `deps.ts` wires this in as the `fez` provider and nothing else
 * reaches into `fez/client.ts` directly.
 */
export function createFezProvider(env: FezEnv, opts: FezClientOptions = {}): LogisticsProvider {
  const client = new FezClient(env, opts);

  return {
    id: 'fez',
    label: FEZ_LABEL,

    async quote(input: ParcelInput): Promise<QuoteResult> {
      const missing = missingWeights(input.items);
      const kg = fezKg(totalGrams(input.items));
      const dropState = fezStateName(input.to.region || input.to.city);
      const pickState = input.from ? fezStateName(input.from.region) : null;

      const cost = await client.call('POST', '/order/cost', {
        state: dropState,
        weight: kg,
        ...(pickState ? { pickUpState: pickState } : {}),
      });
      const amountMinor = toMinor(cost.totalCost) ?? toMinor((cost.cost as Record<string, unknown> | undefined)?.cost);
      if (amountMinor === null) throw new LogisticsError('bad_response', 'Fez Delivery returned no price');

      let eta: string | undefined;
      try {
        const est = await client.call('POST', '/delivery-time-estimate', {
          delivery_type: 'local',
          ...(pickState ? { pick_up_state: pickState } : {}),
          drop_off_state: dropState,
        });
        const e = (est.data as Record<string, unknown> | undefined)?.eta;
        if (typeof e === 'string') eta = e;
      } catch {
        /* An ETA is a nicety; the price is the quote. */
      }

      return {
        providerRef: null,
        weightKg: kg,
        options: [{ id: 'fez', carrier: FEZ_LABEL, label: FEZ_LABEL, amountMinor, currency: 'NGN', ...(eta ? { eta } : {}) }],
        note: missing.length === 0 ? null : `${missing.length} item${missing.length === 1 ? ' has' : 's have'} no weight; Fez will be told ${kg} kg`,
      };
    },

    async book(input: ParcelInput, _optionId: string, _quoteRef: string | null, chosen: QuoteOption | null): Promise<BookingResult> {
      const order: Record<string, unknown> = {
        recipientAddress: oneLine(input.to),
        recipientState: fezStateName(input.to.region || input.to.city),
        recipientName: input.to.name,
        recipientPhone: input.to.phone ?? '',
        ...(input.to.email ? { recipientEmail: input.to.email } : {}),
        uniqueID: input.fulfillmentId,
        BatchID: input.orderNumber,
        itemDescription: input.items.map((i) => `${i.qty}× ${i.title}`).join(', ').slice(0, 200),
        valueOfItem: String(declaredValueMinor(input.items) / 100),
        weight: fezKg(totalGrams(input.items)),
        fragile: false,
        ...(input.from
          ? { pickUpAddress: oneLine({ line1: input.from.line1, line2: input.from.line2 ?? null, city: input.from.city }), pickUpState: fezStateName(input.from.region) }
          : {}),
      };
      const res = await client.call('POST', '/order', [order]);
      const nos = res.orderNos as Record<string, unknown> | undefined;
      const orderNo = nos ? Object.values(nos).find((v): v is string => typeof v === 'string') : undefined;
      if (!orderNo) throw new LogisticsError('bad_response', 'Fez Delivery created no order number', { detail: res });

      let labelUrl: string | null = null;
      try {
        const m = await client.call('GET', `/orders/${encodeURIComponent(orderNo)}/manifest-url`);
        const url = (m.data as Record<string, unknown> | undefined)?.url;
        if (typeof url === 'string') labelUrl = url;
      } catch {
        /* The manifest often exists only later; a track() refresh fetches it then. */
      }

      return {
        providerRef: orderNo,
        carrier: FEZ_LABEL,
        trackingNumber: orderNo,
        trackingUrl: null,
        labelUrl,
        costMinor: chosen?.amountMinor ?? null,
        rawStatus: 'Pending Pick-Up',
        state: 'booked',
      };
    },

    async track(providerRef: string): Promise<TrackResult> {
      const res = await client.call('GET', `/order/track/${encodeURIComponent(providerRef)}`);
      const order = res.order as Record<string, unknown> | undefined;
      const raw = typeof order?.orderStatus === 'string' ? order.orderStatus : null;
      if (!raw) throw new LogisticsError('bad_response', 'Fez Delivery returned no status');
      const history = Array.isArray(res.history) ? (res.history as Record<string, unknown>[]) : [];
      const desc = history[0]?.statusDescription;

      let labelUrl: string | null | undefined;
      try {
        const m = await client.call('GET', `/orders/${encodeURIComponent(providerRef)}/manifest-url`);
        const url = (m.data as Record<string, unknown> | undefined)?.url;
        labelUrl = typeof url === 'string' ? url : undefined;
      } catch {
        labelUrl = undefined;
      }

      return { rawStatus: raw, state: fezState(raw), description: typeof desc === 'string' ? desc : null, labelUrl };
    },

    async cancel(providerRef: string, reason: string): Promise<void> {
      await client.call('POST', '/order/cancel', { orderNo: providerRef, reason: reason.slice(0, 255) || 'Cancelled from the admin' });
    },

    async registerWebhook(url: string): Promise<void> {
      await client.call('POST', '/webhooks/store', { webhook: url });
    },

    /**
     * `now` IS TAKEN FROM THE CALLER, per `port.ts`'s `LogisticsProvider`
     * contract — not from `opts.now` this adapter was built with. The webhook
     * route learns the request's instant when the request arrives, and a
     * provider built once at process start has no way to know that; threading
     * it through the call is what lets `verifyFezWebhook`'s replay window judge
     * against the actual delivery time rather than the adapter's construction
     * time.
     */
    parseWebhook(rawBody: Uint8Array, headers: Headers, now: number): WebhookEvent | null {
      const key = client.secretKey;
      if (!key) throw new LogisticsError('bad_signature', 'Fez Delivery secret key is missing');
      const parsed = verifyFezWebhook(rawBody, headers, key, now);
      if (!parsed) throw new LogisticsError('bad_signature', 'Fez Delivery signature did not verify');
      return { providerRef: parsed.orderNumber, rawStatus: parsed.status, state: fezState(parsed.status), description: null };
    },
  };
}
