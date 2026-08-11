import { promisify } from 'node:util';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

/**
 * `promisify` resolves `crypto.scrypt` to its three-argument overload, so the
 * options object — which is what carries N, r, p and maxmem — is a TS2554
 * without this annotation.
 */
const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * scrypt, ASYNC, never `scryptSync`.
 *
 * Deliberately not argon2: native modules on Vercel functions are a recurring
 * build failure, and scrypt at these parameters is sound with zero
 * dependencies. Two constraints come with that choice:
 *
 * - Memory is `128·N·r`, so N=2^15 costs **32 MiB per concurrent hash**.
 *   N=2^16 would be 64 MiB and two concurrent hashes would OOM a 128 MB
 *   function.
 * - `scryptSync` blocks the event loop for the full duration. On a path that
 *   hashes even for unknown emails — which login must, or it becomes a
 *   user-enumeration oracle — that turns unauthenticated traffic into a
 *   trivial denial-of-service primitive.
 */
const COST_LOG2 = 15;
const BLOCK_SIZE = 8; // r
const PARALLELISM = 1; // p
const KEY_LEN = 32;
const SALT_LEN = 32;

/**
 * Node's default `maxmem` is exactly 32 MiB, and OpenSSL's requirement for
 * N=2^15, r=8 works out at 33,557,504 bytes — just over it. Without an
 * explicit `maxmem`, every hash fails with `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`.
 */
const MAX_MEM = 96 * 1024 * 1024;

/** Refuse to spend unbounded memory on a stored value, however it got there. */
const MAX_ACCEPTED_COST_LOG2 = 20;

/**
 * At most two hashes in flight, so peak memory is bounded at ~64 MiB even if
 * a burst of logins arrives at one instance.
 */
const MAX_IN_FLIGHT = 2;
let inFlight = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  // Hand the slot straight over rather than decrementing and re-incrementing,
  // so the count can never transiently exceed the cap.
  if (next) next();
  else inFlight--;
}

async function derive(
  plain: string,
  salt: Buffer,
  costLog2: number,
  r: number,
  p: number,
  keyLen: number,
): Promise<Buffer> {
  await acquire();
  try {
    return await scrypt(plain, salt, keyLen, {
      N: 2 ** costLog2,
      r,
      p,
      maxmem: MAX_MEM,
    });
  } finally {
    release();
  }
}

/**
 * Returns `scrypt$N$r$p$salt$hash`, salt and hash base64.
 *
 * `costLog2` exists ONLY so the test harness can seed users without paying
 * ~200 ms per row; every production caller uses the default. Lowering it
 * anywhere else is a vulnerability, not an optimisation.
 */
export async function hashPassword(plain: string, costLog2 = COST_LOG2): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await derive(plain, salt, costLog2, BLOCK_SIZE, PARALLELISM, KEY_LEN);
  return [
    'scrypt',
    2 ** costLog2,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

/** Base64 round-trips only if the input really was base64. */
function decodeBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const buf = Buffer.from(value, 'base64');
  return buf.length > 0 ? buf : null;
}

/**
 * Never throws. A malformed stored value is a `false`, not a 500 — the caller
 * is a login route and an exception there is an availability bug.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [scheme, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  if (scheme !== 'scrypt') return false;

  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!isPowerOfTwo(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (r < 1 || p < 1 || r > 32 || p > 16) return false;
  if (n > 2 ** MAX_ACCEPTED_COST_LOG2) return false;

  const salt = decodeBase64(saltRaw);
  const expected = decodeBase64(hashRaw);
  if (!salt || !expected) return false;

  try {
    const actual = await derive(plain, salt, Math.log2(n), r, p, expected.length);
    // Length-checked first: timingSafeEqual THROWS on a length mismatch.
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
