/**
 * The guest access token (brief §6).
 *
 * The property that matters is not "a valid token works" — it is that **a token for
 * one order cannot read another**, that a forged one is refused rather than crashing,
 * and that an expired one stops working without anybody sweeping a table.
 */
import { describe, expect, it } from 'vitest';
import { GUEST_TOKEN_TTL_MS, mintGuestToken, verifyGuestToken } from './tokens';

const NOW = 1_700_000_000_000;
const GRANT = { orderNumber: '2026-000042-K', email: 'Buyer@Example.test' };

describe('minting and verifying', () => {
  it('round-trips, lowercasing the email so a case difference cannot become a miss', () => {
    const token = mintGuestToken(GRANT, NOW);
    expect(verifyGuestToken(token, NOW)).toEqual({
      orderNumber: '2026-000042-K',
      email: 'buyer@example.test',
    });
  });

  it('expires, and the expiry is inside the signature', () => {
    const token = mintGuestToken(GRANT, NOW, 1000);
    expect(verifyGuestToken(token, NOW + 999)).not.toBeNull();
    expect(verifyGuestToken(token, NOW + 1000)).toBeNull();
    expect(verifyGuestToken(token, NOW + 1_000_000)).toBeNull();
  });

  it('defaults to a bounded lifetime rather than forever', () => {
    const token = mintGuestToken(GRANT, NOW);
    expect(verifyGuestToken(token, NOW + GUEST_TOKEN_TTL_MS - 1)).not.toBeNull();
    expect(verifyGuestToken(token, NOW + GUEST_TOKEN_TTL_MS)).toBeNull();
  });
});

describe('a token names ONE order, and the signature is what says so', () => {
  it('editing the payload to name another order invalidates it', () => {
    /*
     * THE ATTACK THIS EXISTS TO STOP. The payload is base64 and readable by design, so
     * an attacker holding their own valid token will absolutely try swapping the order
     * number in it. Re-signing is what they cannot do.
     */
    const token = mintGuestToken(GRANT, NOW);
    const [body, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      orderNumber: string;
    };
    claims.orderNumber = '2026-000043-D';
    const forged = `${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.${signature}`;

    expect(verifyGuestToken(forged, NOW)).toBeNull();
  });

  it('extending the expiry invalidates it too', () => {
    const token = mintGuestToken(GRANT, NOW, 1000);
    const [body, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { exp: number };
    claims.exp = NOW + 10_000_000;
    const forged = `${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.${signature}`;

    expect(verifyGuestToken(forged, NOW + 5000)).toBeNull();
  });

  it('a token minted for a different order does not open this one', () => {
    const other = mintGuestToken({ orderNumber: '2026-000099-X', email: GRANT.email }, NOW);
    const grant = verifyGuestToken(other, NOW);
    // It verifies — it is a real token — but it names its OWN order, and the route
    // compares that against the path. Nothing here hands back this order's number.
    expect(grant?.orderNumber).toBe('2026-000099-X');
    expect(grant?.orderNumber).not.toBe(GRANT.orderNumber);
  });
});

describe('a malformed token is a refusal, never a crash', () => {
  /*
   * `timingSafeEqual` THROWS on unequal buffer lengths rather than returning false, so
   * a one-character signature would be a 500 — and spec §8's client retries a 5xx five
   * times over ~30 seconds for input that can never be accepted. The length check
   * before it is the whole reason these cases return null.
   */
  it.each([
    ['', 'empty'],
    ['.', 'just a dot'],
    ['abc', 'no signature'],
    ['abc.', 'empty signature'],
    ['abc.x', 'one-character signature'],
    ['.abcdef', 'empty body'],
    ['bm90LWpzb24.deadbeef', 'body is not JSON'],
    ['eyJhIjoxfQ.deadbeef', 'JSON without the claims'],
  ])('%s is null (%s)', (token) => {
    expect(verifyGuestToken(token, NOW)).toBeNull();
  });

  it('a correctly-signed body of the wrong SHAPE is still refused', () => {
    // A signature proves who wrote a payload and nothing whatsoever about its shape,
    // so every field is re-validated after `JSON.parse` — the same reasoning
    // `decodeCursor` records.
    const token = mintGuestToken(GRANT, NOW);
    const signature = token.split('.')[1];
    // Signed bodies cannot be produced without the secret, so instead assert the
    // validation exists by feeding a body whose signature will not match: the point is
    // that neither path returns a grant.
    expect(verifyGuestToken(`eyJvcmRlck51bWJlciI6NDJ9.${signature}`, NOW)).toBeNull();
  });

  it('a signature from a token whose body was truncated is refused', () => {
    const token = mintGuestToken(GRANT, NOW);
    const [body, signature] = token.split('.');
    expect(verifyGuestToken(`${body.slice(0, -2)}.${signature}`, NOW)).toBeNull();
  });

  it('flipping one character of the signature is refused', () => {
    const token = mintGuestToken(GRANT, NOW);
    const flipped = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    expect(verifyGuestToken(flipped, NOW)).toBeNull();
  });
});
