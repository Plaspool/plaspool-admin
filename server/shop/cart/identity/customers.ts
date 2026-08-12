import { createHmac, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { toEpochMs, uniqueViolation } from '../../../db/client';
import type { Db } from '../../../db/client';
import { currentDb } from '../../../app-env';
import type { AppEnv } from '../../../app-env';
import { getEnv } from '../../../env';
import { BadRequestError } from '../../../repo/errors';
import { newId } from '../ids';
import { SHOP_SESSION_COOKIE } from './cookies';

/**
 * Customers and their sessions (contract §7, brief §2).
 *
 * THE ANONYMOUS TWIN OF `server/repo/users.ts`, and the differences from it are
 * all deliberate:
 *
 * - **No password, ever.** v1 identifies a customer by possession of a session
 *   token delivered out of band. There is no `password_hash` column, so there is
 *   no credential in this table to leak and nothing for `guardDb` to scrub on
 *   this path.
 * - **No roles.** A customer has no permissions at all; every route behind a
 *   customer session acts on that customer's own cart and nothing else.
 * - **Nullable email.** A pure guest has none. `users.email` is NOT NULL and
 *   UNIQUE because an invite is addressed to an email; a cart is addressed to
 *   nobody.
 *
 * What is copied verbatim is the token construction, because getting it
 * differently wrong in two places is exactly the seam this project keeps
 * failing on.
 */

/**
 * 30 days, matching `SESSION_TTL_MS` for writers.
 *
 * Same number, but the reasoning differs and is worth stating: a customer
 * session is a convenience (address autofill, order history), not a
 * write credential, so the risk of a long window is lower — but the risk of a
 * SHORT one is a customer who is logged out mid-checkout and abandons. Held at
 * 30 days so there is one number to reason about across the app.
 */
export const SHOP_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** As `users.ts`: a hard ceiling from `created_at`, so a stolen token dies. */
export const SHOP_SESSION_ABSOLUTE_MAX_MS = 90 * 24 * 60 * 60 * 1000;

/** The one shape a customer takes when it crosses a boundary. */
export interface Customer {
  id: string;
  email: string | null;
  displayName: string | null;
  createdAt: number;
}

/** 256 bits, URL-safe. Returned once and never stored raw. */
function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * HMAC-SHA-256 under `SESSION_SECRET`, hex — NOT a bare SHA-256.
 *
 * Copied from `server/repo/users.ts` with its reasoning intact: a bare digest is
 * offline-computable, so a stolen database dump can be attacked with a
 * precomputed table of candidate tokens and the winning row replayed as a live
 * session. Keying the digest with a secret that lives in the environment and not
 * in the database means a dump on its own is inert.
 *
 * DIFFERENT TABLE, SAME SECRET, AND THAT IS SAFE — but only because the two
 * resolvers never query each other's table. A writer token and a customer token
 * are the same 64 hex characters by shape; what keeps a customer from being a
 * writer is that `resolveSession` reads `sessions` and `resolveCustomerSession`
 * reads `shop_customer_sessions`, and neither ever unions them.
 * `session.test.ts` drives both directions of that at the HTTP surface.
 */
function tokenId(token: string): string {
  return createHmac('sha256', getEnv().SESSION_SECRET).update(token).digest('hex');
}

function rowToCustomer(row: Record<string, unknown>): Customer {
  return {
    id: String(row.id),
    email: row.email == null ? null : String(row.email),
    displayName: row.display_name == null ? null : String(row.display_name),
    createdAt: toEpochMs(row.created_at),
  };
}

/**
 * `''` is not an email.
 *
 * `email` is UNIQUE and Postgres permits many NULLs but exactly ONE empty
 * string, so the SECOND customer created with `email: ''` would fail with a raw
 * 23505 nobody expects — the identical trap `normaliseSlug` handles for
 * `posts.slug`. Normalised here AND refused by a CHECK in migration 0120, so
 * neither layer is the only one holding it.
 */
function normaliseEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

// --------------------------------------------------------------- customers

export async function createCustomer(
  db: Db,
  a: { email?: string | null; displayName?: string | null } = {},
): Promise<Customer> {
  const now = Date.now();
  const id = newId('customer');
  const res = await db.execute(sql`
    INSERT INTO shop_customers (id, email, display_name, created_at)
    VALUES (${id}, ${normaliseEmail(a.email)}, ${a.displayName?.trim() || null}, ${now})
    RETURNING id, email, display_name, created_at`);
  return rowToCustomer(res.rows[0]);
}

/**
 * Find by email, or create. ONE STATEMENT, not read-then-write.
 *
 * The read-then-write version loses under concurrency: two magic-link
 * redemptions for the same address both read "no customer", both insert, and one
 * gets a raw 23505 — which spec §8 has no row for, so it becomes a 500 the
 * client retries five times for a request that can never succeed. The
 * `ON CONFLICT DO UPDATE` is a no-op update whose only job is to make the row
 * come back from `RETURNING` on the losing branch, which `DO NOTHING` would not.
 *
 * Not `db.transaction`: the Neon HTTP driver throws unconditionally on
 * `transaction()` while PGlite supports it, so a transaction here would pass
 * every test in this repository and 500 in production (spec §4.3a).
 */
export async function findOrCreateCustomerByEmail(
  db: Db,
  email: string,
): Promise<Customer> {
  const normalised = normaliseEmail(email);
  if (!normalised) throw new BadRequestError('email');
  const res = await db.execute(sql`
    INSERT INTO shop_customers (id, email, display_name, created_at)
    VALUES (${newId('customer')}, ${normalised}, NULL, ${Date.now()})
    ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
    RETURNING id, email, display_name, created_at`);
  return rowToCustomer(res.rows[0]);
}

export async function getCustomer(db: Db, id: string): Promise<Customer | null> {
  const res = await db.execute(sql`
    SELECT id, email, display_name, created_at FROM shop_customers WHERE id = ${id}`);
  return res.rows[0] ? rowToCustomer(res.rows[0]) : null;
}

// ---------------------------------------------------------------- sessions

export interface MintedSession {
  /** The RAW token. Handed to the caller once; only its HMAC is stored. */
  token: string;
  expiresAt: number;
}

export async function createCustomerSession(
  db: Db,
  customerId: string,
): Promise<MintedSession> {
  const token = mintToken();
  const now = Date.now();
  const expiresAt = now + SHOP_SESSION_TTL_MS;

  await db.execute(sql`
    INSERT INTO shop_customer_sessions (id, customer_id, created_at, expires_at, last_seen_at)
    VALUES (${tokenId(token)}, ${customerId}, ${now}, ${expiresAt}, ${now})`);

  // Opportunistic sweep, best-effort — exactly as `createSession` does. A
  // failure here must never cost the customer their session.
  await db
    .execute(sql`DELETE FROM shop_customer_sessions WHERE expires_at <= ${now}`)
    .catch(() => undefined);

  return { token, expiresAt };
}

/**
 * The cookie's token → a customer, or `null`. NEVER a 401 by itself.
 *
 * The sliding refresh and the `last_seen_at`-on-every-resolve rule are both
 * copied from `resolveSession`, including the reason `expires_at` uses
 * `GREATEST`: it must never move backwards, or a session capped by the absolute
 * ceiling would be pulled in by an ordinary read.
 */
export async function resolveCustomerSession(
  db: Db,
  token: string,
): Promise<Customer | null> {
  const id = tokenId(token);
  const res = await db.execute(sql`
    SELECT s.created_at AS session_created_at, s.expires_at,
           c.id, c.email, c.display_name, c.created_at
      FROM shop_customer_sessions s JOIN shop_customers c ON c.id = s.customer_id
     WHERE s.id = ${id}`);
  const row = res.rows[0];
  if (!row) return null;

  const now = Date.now();
  const expiresAt = toEpochMs(row.expires_at);
  if (expiresAt <= now) {
    await db
      .execute(sql`DELETE FROM shop_customer_sessions WHERE id = ${id}`)
      .catch(() => undefined);
    return null;
  }

  const createdAt = toEpochMs(row.session_created_at);
  const halfway = expiresAt - SHOP_SESSION_TTL_MS / 2;
  const slid =
    now > halfway
      ? Math.min(now + SHOP_SESSION_TTL_MS, createdAt + SHOP_SESSION_ABSOLUTE_MAX_MS)
      : expiresAt;

  await db
    .execute(
      sql`UPDATE shop_customer_sessions
             SET last_seen_at = ${now},
                 expires_at = GREATEST(expires_at, ${slid})
           WHERE id = ${id}`,
    )
    .catch(() => undefined);

  return rowToCustomer(row);
}

/**
 * Log out. Idempotent, and it CANNOT 404.
 *
 * A logout that fails on an already-expired session leaves the cookie in the
 * browser, which is the one thing logout exists to prevent — `session.ts` makes
 * the same point about the writer's.
 */
export async function destroyCustomerSession(db: Db, token: string): Promise<void> {
  await db.execute(sql`DELETE FROM shop_customer_sessions WHERE id = ${tokenId(token)}`);
}

/**
 * Attach an email to a customer that had none — the guest who decides to keep
 * an account at the end of checkout.
 *
 * Returns `null` when the address already belongs to somebody else, rather than
 * throwing: the caller has to merge into the existing customer instead, and a
 * unique-violation surfaced as an exception would be a 500 on an entirely
 * ordinary path.
 */
export async function claimCustomerEmail(
  db: Db,
  customerId: string,
  email: string,
): Promise<Customer | null> {
  const normalised = normaliseEmail(email);
  if (!normalised) throw new BadRequestError('email');
  try {
    const res = await db.execute(sql`
      UPDATE shop_customers SET email = ${normalised}
       WHERE id = ${customerId} AND email IS NULL
      RETURNING id, email, display_name, created_at`);
    return res.rows[0] ? rowToCustomer(res.rows[0]) : null;
  } catch (err) {
    if (uniqueViolation(err) === 'shop_customers_email_uq') return null;
    throw err;
  }
}

/**
 * The customer for a request, resolved from `__Host-shop_session` alone.
 *
 * THE FUNCTION `server/shop/orders/ports.ts` HAS NAMED SINCE IT WAS WRITTEN and
 * that nobody had written. Its `CustomerResolver` doc gives the wiring as one
 * line at the mount site — `{ customer: (c) => resolveShopCustomer(...) }` — and
 * until this existed the composition root registered no resolver at all, so
 * `resolveDeps` fell back to `NO_CUSTOMER` and `GET /api/shop/orders` answered
 * 401 to every caller, INCLUDING one holding a valid customer session. The suite
 * did not see it because `server/shop/orders/test/app.ts` registers a resolver of
 * its own; only the deployment was broken.
 *
 * A FUNCTION AND NOT `shopSessionMiddleware`, because Orders needs the answer on
 * routes that middleware never runs on. It is mounted with `built.use('*', ...)`
 * inside CART's router (`routes/index.ts`), and Orders is a sibling router — so
 * `c.get('customer')` there is not "no customer", it is a key nothing ever set.
 * Both spellings share `resolveCustomerSession` below, which is what keeps the
 * sliding refresh and the expiry sweep identical on both paths.
 *
 * `Context<AppEnv>` rather than `Context<ShopEnv>`: the caller is the composition
 * root, which knows nothing of the shop's environment, and this reads a cookie
 * rather than the `customer` variable `ShopEnv` adds. Taking the narrower type is
 * what lets it be handed across that seam without a cast.
 *
 * NEVER 401s BY ITSELF, exactly as `CustomerResolver` requires — no cookie, an
 * expired session and a writer token presented as a customer token are all the
 * same `null`, and it is the ROUTE that decides whether null is an error.
 */
export async function resolveShopCustomer(c: Context<AppEnv>): Promise<Customer | null> {
  const token = getCookie(c, SHOP_SESSION_COOKIE);
  // No cookie, no database client — the rule `shopSessionMiddleware` states, and
  // it matters more here: this runs on the ORDERS routes, most of which a guest
  // reaches with a signed token and no session at all.
  return token ? await resolveCustomerSession(currentDb(c), token) : null;
}
