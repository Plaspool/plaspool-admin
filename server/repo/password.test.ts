import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('a hash verifies against its own password and no other', async () => {
    const stored = await hashPassword('correct horse battery staple');

    // Pins the cost. N=2^15 is 32 MiB per concurrent hash — the largest value
    // that leaves room for two of them in a 128 MB function. Anything lower
    // arriving here silently is a weakening, not a speed-up.
    expect(stored.split('$').slice(0, 4)).toEqual(['scrypt', '32768', '8', '1']);

    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
    expect(await verifyPassword('Correct Horse Battery Staple', stored)).toBe(false);
  });

  it('two hashes of the same password differ', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    // Distinct salts, so a stolen dump cannot be attacked once for everyone.
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('verifyPassword returns false rather than throwing on a malformed stored value', async () => {
    const malformed = [
      '',
      'not-a-hash',
      'scrypt$',
      'scrypt$16384$8$1$onlyfourparts',
      'scrypt$notanumber$8$1$AAAA$AAAA',
      'argon2$16384$8$1$AAAA$AAAA',
      'scrypt$16384$8$1$!!!not-base64!!!$AAAA',
      'scrypt$16384$8$1$AAAA$', // empty digest
      'scrypt$1099511627776$8$1$AAAA$AAAA', // absurd N — must not be attempted
    ];
    for (const stored of malformed) {
      expect(await verifyPassword('anything', stored)).toBe(false);
    }
  });

  it('hashPassword does not block the event loop', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 10);
    const started = Date.now();
    await Promise.all([
      hashPassword('a'),
      hashPassword('b'),
      hashPassword('c'),
      hashPassword('d'),
    ]);
    const elapsed = Date.now() - started;
    clearInterval(timer);

    // scryptSync would hold the loop for the whole run and Node coalesces the
    // missed interval fires into one, so `ticks` would be ~1.
    expect(elapsed).toBeGreaterThan(20);
    expect(ticks).toBeGreaterThanOrEqual(3);
    expect(ticks).toBeGreaterThan(Math.floor(elapsed / 10) * 0.4);
  });
});
