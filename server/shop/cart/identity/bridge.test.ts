import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ASSERTION_TTL_MS, BadAssertionError, signAssertion, verifyAssertion } from './bridge';
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

  it('refuses an assertion whose own window outlives ASSERTION_TTL_MS, even with a valid MAC and unexpired exp', () => {
    // A valid MAC only proves the payload wasn't tampered with in transit —
    // it says nothing about whether the MINTER kept its promise to issue a
    // narrow window. This is what makes the 60s the verifier's own rule.
    const raw = signAssertion(SECRET, make({ iat: NOW, exp: NOW + ASSERTION_TTL_MS + 1 }));
    try {
      verifyAssertion(SECRET, raw, NOW);
      throw new Error('should not reach');
    } catch (e) {
      expect(e).toBeInstanceOf(BadAssertionError);
      expect((e as BadAssertionError).reason).toBe('malformed');
    }
  });

  it('accepts an assertion whose window is exactly ASSERTION_TTL_MS', () => {
    const raw = signAssertion(SECRET, make({ iat: NOW, exp: NOW + ASSERTION_TTL_MS }));
    expect(() => verifyAssertion(SECRET, raw, NOW)).not.toThrow();
  });

  it('refuses garbage', () => {
    for (const bad of ['', '.', 'a.b.c', 'notbase64!!.x', 'onlyonepart']) {
      expect(() => verifyAssertion(SECRET, bad, NOW)).toThrow(BadAssertionError);
    }
  });
});

describe('the trust boundary: a VALID MAC over a hostile payload', () => {
  /*
   * A valid MAC only proves the storefront signed these bytes — not that the
   * bytes are an assertion. Everything after the MAC check is parsing
   * attacker-shaped input on the strength of one shared secret, so each case
   * here signs its garbage PROPERLY and asserts the shape check still refuses
   * it. The `refuses garbage` cases above never get past the MAC; these are
   * the ones that do.
   */
  function signRaw(payloadBytes: string): string {
    const payload = Buffer.from(payloadBytes).toString('base64url');
    const mac = createHmac('sha256', SECRET).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  function reasonOf(raw: string): BadAssertionError['reason'] {
    try {
      verifyAssertion(SECRET, raw, NOW);
      throw new Error('should not reach');
    } catch (e) {
      expect(e).toBeInstanceOf(BadAssertionError);
      return (e as BadAssertionError).reason;
    }
  }

  it('refuses base64url that is not JSON', () => {
    expect(reasonOf(signRaw('not json at all'))).toBe('malformed');
  });

  it('refuses JSON null', () => {
    // `JSON.parse('null')` is a legal parse whose result has no fields — the
    // optional-chained shape check must land on `malformed`, not throw a
    // TypeError that surfaces as a 500.
    expect(reasonOf(signRaw('null'))).toBe('malformed');
  });

  it('refuses non-object JSON', () => {
    for (const raw of ['42', '"a string"', 'true', '[1,2,3]']) {
      expect(reasonOf(signRaw(raw))).toBe('malformed');
    }
  });

  it('a __proto__ key neither pollutes nor rides into the result prototype', () => {
    // `JSON.parse` makes `__proto__` an ordinary OWN property, and the
    // verifier's spread copies own properties as data — so the global
    // `Object.prototype` must be untouched and the returned assertion's
    // actual prototype must still be the ordinary one.
    const evil = JSON.stringify({
      v: 1,
      sub: 's',
      email: 'Mixed@Case.example',
      iat: NOW,
      exp: NOW + 1000,
      jti: 'j',
    }).replace('{', '{"__proto__":{"polluted":true},');
    const got = verifyAssertion(SECRET, signRaw(evil), NOW);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
    expect(got.email).toBe('mixed@case.example');
  });
});
