import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FezEnv } from '../config';
import { LogisticsError } from '../port';
import { createFezProvider } from './adapter';
import { FEZ_REPLAY_WINDOW_MS, verifyFezWebhook } from './webhook';

/**
 * Fez signs `orderNumber + status + timestamp` with HMAC-SHA256 under the org
 * secret key, in `X-Signature` / `X-Timestamp`. Every case here is signed
 * independently with a bare `createHmac` call rather than by asking
 * `verifyFezWebhook` for a signature — a test that signs with the function it
 * verifies with only proves the function agrees with itself.
 */

const KEY = 'org-secret-key-abc123';
const NOW = 1_800_000_000_000; // fixed instant, so the replay window is an assertion and not a race

function sign(orderNumber: string, status: string, timestamp: string, key = KEY): string {
  return createHmac('sha256', key).update(orderNumber + status + timestamp).digest('hex');
}

function bodyOf(orderNumber: string, status: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ orderNumber, status }));
}

function headersOf(signature: string | null, timestamp: string | null): Headers {
  const h = new Headers();
  if (signature !== null) h.set('X-Signature', signature);
  if (timestamp !== null) h.set('X-Timestamp', timestamp);
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

describe('verifyFezWebhook', () => {
  it('accepts a correctly signed delivery', () => {
    const ts = String(Math.floor(NOW / 1000));
    const raw = bodyOf('ASAC1', 'Delivered');
    const sig = sign('ASAC1', 'Delivered', ts);
    expect(verifyFezWebhook(raw, headersOf(sig, ts), KEY, NOW)).toEqual({
      orderNumber: 'ASAC1',
      status: 'Delivered',
    });
  });

  it('rejects a signature made with the wrong key', () => {
    const ts = String(Math.floor(NOW / 1000));
    const raw = bodyOf('ASAC1', 'Delivered');
    const sig = sign('ASAC1', 'Delivered', ts, 'a-different-secret');
    expect(verifyFezWebhook(raw, headersOf(sig, ts), KEY, NOW)).toBeNull();
  });

  it('rejects a body edited after signing', () => {
    const ts = String(Math.floor(NOW / 1000));
    const sig = sign('ASAC1', 'Delivered', ts);
    const tampered = bodyOf('ASAC1', 'Cancelled'); // status changed after the signature was computed
    expect(verifyFezWebhook(tampered, headersOf(sig, ts), KEY, NOW)).toBeNull();
  });

  it('rejects a timestamp older than the 10-minute replay window', () => {
    expect(FEZ_REPLAY_WINDOW_MS).toBe(10 * 60_000);
    const staleTs = String(Math.floor((NOW - FEZ_REPLAY_WINDOW_MS - 1_000) / 1000));
    const raw = bodyOf('ASAC1', 'Delivered');
    const sig = sign('ASAC1', 'Delivered', staleTs);
    expect(verifyFezWebhook(raw, headersOf(sig, staleTs), KEY, NOW)).toBeNull();
  });

  it('accepts a timestamp already given in milliseconds', () => {
    const tsMs = String(NOW);
    const raw = bodyOf('ASAC1', 'Delivered');
    const sig = sign('ASAC1', 'Delivered', tsMs);
    expect(verifyFezWebhook(raw, headersOf(sig, tsMs), KEY, NOW)).toEqual({
      orderNumber: 'ASAC1',
      status: 'Delivered',
    });
  });

  it('rejects a delivery missing either header', () => {
    const ts = String(Math.floor(NOW / 1000));
    const raw = bodyOf('ASAC1', 'Delivered');
    const sig = sign('ASAC1', 'Delivered', ts);
    expect(verifyFezWebhook(raw, headersOf(null, ts), KEY, NOW)).toBeNull();
    expect(verifyFezWebhook(raw, headersOf(sig, null), KEY, NOW)).toBeNull();
    expect(verifyFezWebhook(raw, headersOf(null, null), KEY, NOW)).toBeNull();
  });

  it('reads the signature headers case-insensitively', () => {
    const ts = String(Math.floor(NOW / 1000));
    const raw = bodyOf('ASAC1', 'Delivered');
    const sig = sign('ASAC1', 'Delivered', ts);
    const h = new Headers();
    h.set('x-signature', sig);
    h.set('X-TIMESTAMP', ts);
    expect(verifyFezWebhook(raw, h, KEY, NOW)).toEqual({ orderNumber: 'ASAC1', status: 'Delivered' });
  });
});

describe('parseWebhook on the adapter', () => {
  const ENV: FezEnv = { userId: 'u', password: 'p', secretKey: KEY, baseUrl: 'https://fez.test/v1' };

  it('turns a verified delivery into a webhook event', () => {
    const ts = String(Math.floor(NOW / 1000));
    const raw = bodyOf('ASAC1', 'Dispatched');
    const sig = sign('ASAC1', 'Dispatched', ts);
    const provider = createFezProvider(ENV);
    expect(provider.parseWebhook(raw, headersOf(sig, ts), NOW)).toEqual({
      providerRef: 'ASAC1',
      rawStatus: 'Dispatched',
      state: 'in_transit',
      description: null,
    });
  });

  it('throws bad_signature when the signature does not verify', () => {
    const ts = String(Math.floor(NOW / 1000));
    const raw = bodyOf('ASAC1', 'Dispatched');
    const provider = createFezProvider(ENV);
    const err = throwsOf(() => provider.parseWebhook(raw, headersOf('d'.repeat(64), ts), NOW));
    expect(err).toBeInstanceOf(LogisticsError);
    expect(err.code).toBe('bad_signature');
  });

  it('throws bad_signature when there is no secret key to verify against', () => {
    const envNoSecret: FezEnv = { ...ENV, secretKey: null };
    const provider = createFezProvider(envNoSecret);
    const err = throwsOf(() => provider.parseWebhook(bodyOf('ASAC1', 'Dispatched'), headersOf('sig', '123'), NOW));
    expect(err).toBeInstanceOf(LogisticsError);
    expect(err.code).toBe('bad_signature');
  });
});
