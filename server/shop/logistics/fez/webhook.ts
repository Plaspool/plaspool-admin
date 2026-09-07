import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A Fez webhook older than this is refused, not merely logged — it stops a
 * captured delivery being replayed hours later against a parcel whose state
 * has since moved on.
 */
export const FEZ_REPLAY_WINDOW_MS = 10 * 60_000;

/**
 * Verify `X-Signature` / `X-Timestamp` and, only if it verifies, read the body.
 *
 * VERIFY BEFORE PARSE: the body is only ever `JSON.parse`d once the HMAC over
 * the raw bytes has matched, so a byte an attacker changed after Fez signed it
 * is never trusted, whatever it says.
 *
 * `null` MEANS "DOES NOT VERIFY" and carries no reason — a wrong key, a
 * tampered body, a stale timestamp and a missing header are indistinguishable
 * to whoever sent this, on purpose.
 */
export function verifyFezWebhook(
  rawBody: Uint8Array,
  headers: Headers,
  secretKey: string,
  now: number,
): { orderNumber: string; status: string } | null {
  const sig = headers.get('x-signature');
  const ts = headers.get('x-timestamp');
  if (!sig || !ts) return null;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(rawBody).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const orderNumber = body.orderNumber ?? body.orderNo;
  const status = body.status ?? body.orderStatus;
  if (typeof orderNumber !== 'string' || typeof status !== 'string') return null;

  const n = Number(ts);
  if (!Number.isFinite(n)) return null;
  // Fez's own timestamp is documented in seconds; milliseconds are accepted too,
  // since nothing about the value below 1e12 vs above it is ambiguous today.
  const tsMs = n > 1e12 ? n : n * 1000;
  if (Math.abs(now - tsMs) > FEZ_REPLAY_WINDOW_MS) return null;

  const expected = createHmac('sha256', secretKey).update(orderNumber + status + ts).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig.trim().toLowerCase(), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return { orderNumber, status };
}
