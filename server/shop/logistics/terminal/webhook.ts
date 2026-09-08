import { createHmac, timingSafeEqual } from 'node:crypto';

const same = (a: string, b: string) => { const x = Buffer.from(a, 'utf8'); const y = Buffer.from(b, 'utf8'); return x.length === y.length && timingSafeEqual(x, y); };

/** X-Terminal-Signature = HMAC-SHA512 hex over the body (raw bytes first, then the re-serialised object their sample signs). */
export function verifyTerminalWebhook(rawBody: Uint8Array, headers: Headers, secretKey: string): Record<string, unknown> | null {
  const sig = headers.get('x-terminal-signature');
  if (!sig) return null;
  const raw = Buffer.from(rawBody);
  const given = sig.trim().toLowerCase();
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; } catch { return null; }
  const overRaw = createHmac('sha512', secretKey).update(raw).digest('hex');
  if (same(overRaw, given)) return parsed;
  const overJson = createHmac('sha512', secretKey).update(JSON.stringify(parsed)).digest('hex');
  return same(overJson, given) ? parsed : null;
}
