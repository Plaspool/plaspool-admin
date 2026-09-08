import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TerminalEnv } from '../config';
import { LogisticsError } from '../port';
import { createTerminalProvider } from './adapter';
import { verifyTerminalWebhook } from './webhook';

/**
 * Terminal signs `X-Terminal-Signature` as HMAC-SHA512 hex over the request
 * body under the account's secret key. Every case here signs independently
 * with a bare `createHmac` call rather than by asking `verifyTerminalWebhook`
 * for a signature — a test that signs with the function it verifies with only
 * proves the function agrees with itself. This mirrors `fez/webhook.test.ts`'s
 * discipline exactly.
 */

const KEY = 'terminal-secret-key-abc123';
const NOW = 1_800_000_000_000; // fixed instant; Terminal's parseWebhook does not use it, but the port requires one

const EVENT_BODY = {
  event: 'shipment.updated',
  data: {
    shipment_id: 'SH-1',
    status: 'in-transit',
    carrier: 'DHL',
    events: [{ description: 'Left origin hub' }, { description: 'Arrived at destination hub' }],
    extras: {
      tracking_number: 'TRK-1',
      tracking_url: 'https://track.terminal.africa/TRK-1',
      shipping_label_url: 'https://cdn.terminal.africa/label.pdf',
    },
  },
};

/** Pretty-printed JSON bytes — deliberately NOT the same bytes as `JSON.stringify(obj)`, so the raw-bytes and re-serialised signatures are distinguishable. */
function prettyBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj, null, 2));
}

/** What `JSON.stringify(JSON.parse(raw))` produces — the compact re-serialisation Terminal's own sample signs. */
function compactOf(raw: Uint8Array): string {
  return JSON.stringify(JSON.parse(Buffer.from(raw).toString('utf8')));
}

function sign(key: string, data: string | Uint8Array): string {
  return createHmac('sha512', key).update(Buffer.from(data as Uint8Array)).digest('hex');
}

function headersOf(signature: string | null): Headers {
  const h = new Headers();
  if (signature !== null) h.set('X-Terminal-Signature', signature);
  return h;
}

/** The `LogisticsError` a synchronous call throws. */
function throwsOf(fn: () => unknown): LogisticsError {
  try {
    fn();
  } catch (err) {
    return err as LogisticsError;
  }
  throw new Error('expected the call to throw, and it did not');
}

describe('verifyTerminalWebhook', () => {
  it('accepts a signature computed over the raw bytes', () => {
    const raw = prettyBytes(EVENT_BODY);
    const sig = sign(KEY, raw);
    expect(verifyTerminalWebhook(raw, headersOf(sig), KEY)).toEqual(EVENT_BODY);
  });

  it('accepts a signature computed over the re-serialised (compact) body', () => {
    const raw = prettyBytes(EVENT_BODY); // pretty bytes differ from the compact form below
    const sig = sign(KEY, compactOf(raw));
    expect(verifyTerminalWebhook(raw, headersOf(sig), KEY)).toEqual(EVENT_BODY);
  });

  it('rejects a signature computed over neither the raw nor the re-serialised body', () => {
    const raw = prettyBytes(EVENT_BODY);
    const sig = sign(KEY, 'this-is-not-the-body-in-any-form');
    expect(verifyTerminalWebhook(raw, headersOf(sig), KEY)).toBeNull();
  });

  it('rejects a signature made with the wrong key', () => {
    const raw = prettyBytes(EVENT_BODY);
    const sig = sign('a-different-secret', raw);
    expect(verifyTerminalWebhook(raw, headersOf(sig), KEY)).toBeNull();
  });

  it('rejects a body edited after signing', () => {
    const raw = prettyBytes(EVENT_BODY);
    const sig = sign(KEY, raw);
    const tampered = prettyBytes({ ...EVENT_BODY, data: { ...EVENT_BODY.data, status: 'cancelled' } });
    expect(verifyTerminalWebhook(tampered, headersOf(sig), KEY)).toBeNull();
  });

  it('rejects a delivery missing the signature header', () => {
    const raw = prettyBytes(EVENT_BODY);
    expect(verifyTerminalWebhook(raw, headersOf(null), KEY)).toBeNull();
  });

  it('rejects a body that is not JSON', () => {
    const raw = new TextEncoder().encode('not json');
    const sig = sign(KEY, raw);
    expect(verifyTerminalWebhook(raw, headersOf(sig), KEY)).toBeNull();
  });

  it('reads an upper-case hex signature against the header case-insensitively', () => {
    const raw = prettyBytes(EVENT_BODY);
    const sig = sign(KEY, raw);
    const h = new Headers();
    h.set('x-terminal-signature', sig.toUpperCase());
    expect(verifyTerminalWebhook(raw, h, KEY)).toEqual(EVENT_BODY);
  });
});

describe('parseWebhook on the adapter', () => {
  const ENV: TerminalEnv = { secretKey: KEY, baseUrl: 'https://terminal.test/v1' };

  it('turns a verified shipment event into a webhook event', () => {
    const raw = prettyBytes(EVENT_BODY);
    const sig = sign(KEY, raw);
    const provider = createTerminalProvider(ENV);
    expect(provider.parseWebhook(raw, headersOf(sig), NOW)).toEqual({
      providerRef: 'SH-1',
      rawStatus: 'in-transit',
      state: 'in_transit',
      description: 'Arrived at destination hub',
      trackingNumber: 'TRK-1',
      trackingUrl: 'https://track.terminal.africa/TRK-1',
      labelUrl: 'https://cdn.terminal.africa/label.pdf',
      carrier: 'DHL',
    });
  });

  it('returns null for an event that is not about a shipment', () => {
    const body = { event: 'transaction.success', data: { shipment_id: 'SH-1', status: 'ok' } };
    const raw = prettyBytes(body);
    const sig = sign(KEY, raw);
    const provider = createTerminalProvider(ENV);
    expect(provider.parseWebhook(raw, headersOf(sig), NOW)).toBeNull();
  });

  it('returns null for a shipment event missing an id or a status', () => {
    const body = { event: 'shipment.created', data: {} };
    const raw = prettyBytes(body);
    const sig = sign(KEY, raw);
    const provider = createTerminalProvider(ENV);
    expect(provider.parseWebhook(raw, headersOf(sig), NOW)).toBeNull();
  });

  it('throws bad_signature when the signature does not verify', () => {
    const raw = prettyBytes(EVENT_BODY);
    const provider = createTerminalProvider(ENV);
    const err = throwsOf(() => provider.parseWebhook(raw, headersOf('d'.repeat(128)), NOW));
    expect(err).toBeInstanceOf(LogisticsError);
    expect(err.code).toBe('bad_signature');
  });

  it('throws bad_signature when the signature header is missing entirely', () => {
    const raw = prettyBytes(EVENT_BODY);
    const provider = createTerminalProvider(ENV);
    const err = throwsOf(() => provider.parseWebhook(raw, headersOf(null), NOW));
    expect(err.code).toBe('bad_signature');
  });
});
