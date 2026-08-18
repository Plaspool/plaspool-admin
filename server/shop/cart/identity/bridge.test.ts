import { describe, expect, it } from 'vitest';
import { BadAssertionError, signAssertion, verifyAssertion } from './bridge';
import type { Assertion } from './bridge';

const SECRET = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const NOW = 1_787_000_000_000;

function make(over: Partial<Assertion> = {}): Assertion {
  return {
    v: 1,
    sub: '11111111-2222-3333-4444-555555555555',
    email: 'buyer@example.com',
    iat: NOW,
    exp: NOW + 60_000,
    jti: 'Zm9vYmFyYmF6cXV4MTIzNA',
    ...over,
  };
}

describe('assertion round trip', () => {
  it('verifies what it signed', () => {
    const got = verifyAssertion(SECRET, signAssertion(SECRET, make()), NOW);
    expect(got.email).toBe('buyer@example.com');
    expect(got.jti).toBe('Zm9vYmFyYmF6cXV4MTIzNA');
  });
});

describe('assertion refusals', () => {
  it('refuses a MAC made with a different secret', () => {
    const raw = signAssertion(OTHER, make());
    expect(() => verifyAssertion(SECRET, raw, NOW)).toThrow(BadAssertionError);
    try {
      verifyAssertion(SECRET, raw, NOW);
    } catch (e) {
      expect((e as BadAssertionError).reason).toBe('mac');
    }
  });

  it('refuses a tampered payload', () => {
    const raw = signAssertion(SECRET, make());
    const [, mac] = raw.split('.');
    const evil = Buffer.from(JSON.stringify(make({ email: 'attacker@example.com' })))
      .toString('base64url');
    expect(() => verifyAssertion(SECRET, `${evil}.${mac}`, NOW)).toThrow(BadAssertionError);
  });

  it('refuses a truncated MAC', () => {
    const raw = signAssertion(SECRET, make());
    const [payload, mac] = raw.split('.');
    expect(() => verifyAssertion(SECRET, `${payload}.${mac.slice(0, 10)}`, NOW))
      .toThrow(BadAssertionError);
  });

  it('refuses an expired assertion, and says so distinctly', () => {
    const raw = signAssertion(SECRET, make());
    try {
      verifyAssertion(SECRET, raw, NOW + 61_000);
      throw new Error('should not reach');
    } catch (e) {
      expect((e as BadAssertionError).reason).toBe('expired');
    }
  });

  it('does not tolerate clock skew backwards past exp', () => {
    const raw = signAssertion(SECRET, make({ exp: NOW - 1 }));
    expect(() => verifyAssertion(SECRET, raw, NOW)).toThrow(BadAssertionError);
  });

  it('refuses a version it does not know', () => {
    const raw = signAssertion(SECRET, make({ v: 2 as 1 }));
    expect(() => verifyAssertion(SECRET, raw, NOW)).toThrow(BadAssertionError);
  });

  it('refuses garbage', () => {
    for (const bad of ['', '.', 'a.b.c', 'notbase64!!.x', 'onlyonepart']) {
      expect(() => verifyAssertion(SECRET, bad, NOW)).toThrow(BadAssertionError);
    }
  });
});
