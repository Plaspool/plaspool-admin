export type ProviderId = 'fez' | 'terminal';
export type CourierState =
  | 'draft' | 'booked' | 'picked_up' | 'in_transit' | 'delivered'
  | 'returned' | 'cancelled' | 'failed' | 'unknown';

export interface ShipFrom {
  name: string; phone: string; email?: string; line1: string; line2?: string;
  city: string; region: string; postalCode: string; countryCode: 'NG';
}
export interface Packaging { name: string; lengthCm: number; widthCm: number; heightCm: number; weightKg: number }

export interface ParcelLine {
  orderLineId: string; variantId: string; title: string; sku: string; qty: number; unitMinor: number; weightGrams: number | null;
}
export interface ParcelInput {
  fulfillmentId: string;
  orderNumber: string;
  to: { name: string; phone: string | null; email: string | null; line1: string; line2: string | null; city: string; region: string; postalCode: string | null; countryCode: string };
  from: ShipFrom | null;
  items: ParcelLine[];
  valueMinor: number;
  packaging: Packaging;
  /** Terminal's cached packaging id, if one was created before. */
  packagingRef: string | null;
}

export interface QuoteOption { id: string; carrier: string; label: string; amountMinor: number; currency: 'NGN'; eta?: string; pickupEta?: string }
export interface QuoteResult {
  /** Terminal's draft shipment id; null for Fez. */
  providerRef: string | null;
  options: QuoteOption[];
  weightKg: number;
  note: string | null;
  /** A packaging record the adapter created during this quote, to be cached by the caller. */
  packagingRef?: string;
}
export interface BookingResult {
  providerRef: string; carrier: string; trackingNumber: string; trackingUrl: string | null; labelUrl: string | null;
  costMinor: number | null; rawStatus: string; state: CourierState;
}
export interface TrackResult {
  rawStatus: string; state: CourierState; description: string | null;
  trackingNumber?: string | null; trackingUrl?: string | null; labelUrl?: string | null; carrier?: string | null;
}
export interface WebhookEvent extends TrackResult { providerRef: string }

/** One half of a `provider_simulate`: what the courier said, without a throw. */
export interface SimulateLeg { ok: boolean; message: string | null }

/**
 * What asking a courier to send us a webhook actually produced. **Both halves
 * are reported and NEITHER throws**: Terminal's `POST /webhooks/simulate`
 * answers "queued" and then delivers nothing, while its own
 * `GET /webhooks/deliveries` answers an error — and that pair IS the finding.
 * An exception would collapse the two into one failure and lose the evidence.
 */
export interface ProviderSimulateOutcome {
  simulate: SimulateLeg;
  /** `count` is `null` when the courier answered but we could not tell how many. */
  deliveries: SimulateLeg & { count: number | null };
}

/**
 * WHAT AN OWNER CAN ASK A COURIER FROM THE ADMIN, rather than from a throwaway
 * script. Optional on `LogisticsProvider` so a fake in a suite that has no
 * business with diagnostics stays a valid provider; both real adapters
 * implement it.
 *
 * DELIBERATELY NARROW. This is not a second courier API — it is the two calls
 * `diagnostics.ts` cannot make for itself because they need the adapter's own
 * client, credentials and base URL. Quoting is not here: that is the ordinary
 * `quote()` against a synthetic parcel, which is the point.
 */
export interface ProviderDiagnostics {
  /** Sandbox or live, from the base URL this adapter was built with — known whether or not a call succeeds. */
  readonly environment: 'sandbox' | 'live';
  /**
   * The cheapest authenticated call that proves the credentials work.
   * Resolves with a SMALL, SECRET-FREE summary of what the courier answered;
   * throws a `LogisticsError` when it refuses.
   */
  ping(): Promise<Record<string, unknown>>;
  /** Terminal only. Ask the courier to send one itself, then read its delivery log. */
  simulateWebhook?(shipmentId: string): Promise<ProviderSimulateOutcome>;
}

export interface LogisticsProvider {
  readonly id: ProviderId;
  readonly label: string;
  quote(input: ParcelInput): Promise<QuoteResult>;
  book(input: ParcelInput, optionId: string, quoteRef: string | null, chosen: QuoteOption | null): Promise<BookingResult>;
  track(providerRef: string): Promise<TrackResult>;
  cancel(providerRef: string, reason: string): Promise<void>;
  registerWebhook(url: string): Promise<void>;
  /** Verify the signature and parse the body. Throws LogisticsError('bad_signature') when it does not verify. */
  parseWebhook(rawBody: Uint8Array, headers: Headers, now: number): WebhookEvent | null;
  /** The owner's test bench. Absent on a provider that has none — see `ProviderDiagnostics`. */
  readonly diagnostics?: ProviderDiagnostics;
}

export type LogisticsErrorCode =
  | 'not_configured' | 'provider_rejected' | 'provider_unavailable' | 'bad_response' | 'bad_signature' | 'address_incomplete';

export class LogisticsError extends Error {
  readonly code: LogisticsErrorCode;
  readonly status: number | undefined;
  readonly detail: unknown;
  /**
   * A packaging record the adapter DID create before this call failed — the
   * same id `QuoteResult.packagingRef` carries on the way out, taking the same
   * way out when there is no result to carry it.
   *
   * Terminal's `quote` creates a packaging record and only then asks for a
   * shipment and its rates. A failure after that point used to lose the id
   * completely: not returned, not thrown, never cached, so the next attempt
   * minted another and every failed quote leaked one record at Terminal.
   *
   * THE ONE FIELD HERE THAT IS NOT `readonly`, deliberately. `code`, `status`
   * and `detail` are the classification, fixed the moment the failure is
   * described. This is a receipt: what the call left behind, attached on the
   * way out by the frame that knows a record was created, without restating
   * — or losing the stack of — a failure something below already classified.
   */
  packagingRef: string | undefined;
  constructor(
    code: LogisticsErrorCode,
    message: string,
    opts: { status?: number; detail?: unknown; packagingRef?: string } = {},
  ) {
    super(message);
    this.name = 'LogisticsError';
    this.code = code;
    this.status = opts.status;
    this.detail = opts.detail;
    this.packagingRef = opts.packagingRef;
  }
}

export const PROVIDER_LABEL: Record<ProviderId | 'manual', string> = {
  manual: 'By hand', fez: 'Fez Delivery', terminal: 'Terminal Africa',
};
