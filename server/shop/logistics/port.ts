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
}

export type LogisticsErrorCode =
  | 'not_configured' | 'provider_rejected' | 'provider_unavailable' | 'bad_response' | 'bad_signature' | 'address_incomplete';

export class LogisticsError extends Error {
  readonly code: LogisticsErrorCode;
  readonly status: number | undefined;
  readonly detail: unknown;
  constructor(code: LogisticsErrorCode, message: string, opts: { status?: number; detail?: unknown } = {}) {
    super(message);
    this.name = 'LogisticsError';
    this.code = code;
    this.status = opts.status;
    this.detail = opts.detail;
  }
}

export const PROVIDER_LABEL: Record<ProviderId | 'manual', string> = {
  manual: 'By hand', fez: 'Fez Delivery', terminal: 'Terminal Africa',
};
