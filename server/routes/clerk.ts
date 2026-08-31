import { Hono } from 'hono';
import { readJson, str } from '../middleware/errors';
import { UnauthenticatedError } from '../middleware/errors';
import { clientIp, limit } from '../middleware/ratelimit';
import { LOGIN_IP_LIMIT, LOGIN_WINDOW_MS } from '../repo/ratelimit';
import { createSession, findUserByEmail } from '../repo/users';
import { setSessionCookie } from '../middleware/session';
import { getEnv } from '../env';
import { currentDb } from '../app-env';
import { z } from 'zod';
import type { AppEnv } from '../app-env';

/**
 * THE CLERK BRIDGE (owner's 2026-08-31 batch): Google sign-in for the admin,
 * without surrendering the session model.
 *
 * WHAT IT IS. When the owner adds the two Clerk keys, the sign-in screen grows
 * a "Continue with Google" path rendered by Clerk's own components — Google,
 * email codes, and whatever second factors the Clerk dashboard turns on are
 * all Clerk's to run. What comes back to THIS server is one thing only: a
 * Clerk session token, which `POST /api/auth/clerk/exchange` verifies and
 * trades for the ordinary `__Host-studio_session` cookie. Every route past the
 * sign-in screen keeps exactly one session system, one middleware, one cookie.
 *
 * INVITE-ONLY SURVIVES, and that is the design's spine: the exchange resolves
 * the Clerk user's PRIMARY EMAIL and requires an EXISTING, enabled row in
 * `users`. Holding a Google account named on the team list gets you in;
 * holding any other Google account gets `not_invited`. Nothing is created,
 * so Clerk sign-ups are inert until an admin invites the address — the same
 * property the password flow has always had.
 *
 * OUR EMAIL 2FA IS DELIBERATELY NOT STACKED ON TOP. A Clerk login already
 * carried whatever factors the Clerk dashboard demands (that is where the
 * owner turns on Clerk 2FA); demanding our emailed code AFTER Clerk's own
 * would be two second factors for one login. The password path keeps ours.
 *
 * THE VERIFIER IS A SEAM, NOT AN IMPORT. The real one calls Clerk's SDK with
 * `CLERK_SECRET_KEY`; the suite injects a fake and drives the real route —
 * CLAUDE.md §2's rule. The seam's shape is the minimum the route needs: a
 * token in, a primary email out (or null for anything invalid).
 */

export interface ClerkVerifier {
  /** Resolve a Clerk session token to the account's primary email, or null. */
  verify(token: string): Promise<{ email: string } | null>;
}

/**
 * The real verifier: networked, lazy, and never constructed unless the
 * exchange route actually runs with a secret present.
 *
 * `verifyToken` checks the JWT against the instance's JWKS (fetched with the
 * secret key), then the user record supplies the primary email — the claim set
 * alone does not reliably carry one.
 */
function realVerifier(): ClerkVerifier {
  return {
    async verify(token) {
      const secretKey = getEnv().CLERK_SECRET_KEY;
      const { verifyToken, createClerkClient } = await import('@clerk/backend');
      try {
        const claims = await verifyToken(token, { secretKey });
        const sub = typeof claims.sub === 'string' ? claims.sub : '';
        if (!sub) return null;
        const clerk = createClerkClient({ secretKey });
        const user = await clerk.users.getUser(sub);
        const email =
          user.primaryEmailAddress?.emailAddress ??
          user.emailAddresses[0]?.emailAddress ??
          '';
        return email ? { email } : null;
      } catch {
        return null;
      }
    },
  };
}

const ExchangeBody = z
  .object({
    /** A Clerk session JWT. Bounded like every other token body. */
    token: str().min(1).max(4096),
  })
  .strict();

export interface ClerkRouteDeps {
  verifier?: ClerkVerifier;
}

/**
 * The test seam, shaped like `registerOrdersDeps` and for the same reason:
 * `server/index.ts` composes this router with no arguments, so a suite that
 * built a second, injected copy would be testing a router production never
 * mounts. The registry is read PER REQUEST; construction deps still win.
 * **Call `resetClerkVerifier()` in `beforeEach`.**
 */
let registered: ClerkVerifier | null = null;

export function registerClerkVerifier(verifier: ClerkVerifier | null): void {
  registered = verifier;
}

export function resetClerkVerifier(): void {
  registered = null;
}

export function createClerkRoutes(deps: ClerkRouteDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * Whether this deployment can exchange at all — the sign-in screen asks
   * before offering the button, so a half-configured deployment (publishable
   * key baked into the bundle, secret key missing) degrades to an honest
   * absence rather than a button that 501s.
   */
  app.get('/auth/clerk/status', (c) =>
    c.json({ enabled: getEnv().CLERK_SECRET_KEY !== '' }),
  );

  app.post('/auth/clerk/exchange', async (c) => {
    const db = currentDb(c);
    await limit(c, `clerk:${clientIp(c)}`, LOGIN_IP_LIMIT, LOGIN_WINDOW_MS);
    const { token } = await readJson(c, ExchangeBody);

    if (getEnv().CLERK_SECRET_KEY === '') {
      return c.json(
        { error: 'not_implemented', requestId: c.get('requestId') ?? '' },
        501,
      );
    }

    const verifier = deps.verifier ?? registered ?? realVerifier();
    const identity = await verifier.verify(token);
    if (!identity) throw new UnauthenticatedError();

    /*
     * THE TEAM LIST IS THE AUTHORITY. A verified Google identity that is not
     * an invited, enabled account gets a NAMED refusal rather than the bare
     * 401 — the screen has to tell a teammate-to-be "ask for an invite"
     * apart from "your Clerk session died", and neither leaks anything: the
     * caller already proved they hold the account in question.
     */
    const found = await findUserByEmail(db, identity.email);
    if (!found || found.disabledAt != null) {
      return c.json(
        { error: 'not_invited', requestId: c.get('requestId') ?? '' },
        403,
      );
    }

    const { token: session, expiresAt } = await createSession(
      db,
      found.user.id,
      c.req.header('user-agent') ?? undefined,
    );
    setSessionCookie(c, session, expiresAt);
    return c.json({ user: found.user });
  });

  return app;
}
