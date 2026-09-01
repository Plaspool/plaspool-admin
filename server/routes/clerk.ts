import { Hono } from 'hono';
import { readJson, str } from '../middleware/errors';
import { UnauthenticatedError } from '../middleware/errors';
import { clientIp, limit } from '../middleware/ratelimit';
import { LOGIN_IP_LIMIT, LOGIN_WINDOW_MS } from '../repo/ratelimit';
import { claimInviteForEmail, createSession, findUserByEmail } from '../repo/users';
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
 * the Clerk user's PRIMARY EMAIL and admits it only if this instance already
 * named that address — an enabled row in `users`, or an OPEN INVITE that the
 * exchange then spends. Any other Google account gets `not_invited`. Clerk
 * sign-ups stay inert until an admin invites the address, the same property
 * the password flow had.
 *
 * PROVISIONING FROM THE INVITE IS WHY THIS ROUTE CAN BE THE ONLY DOOR
 * (2026-09-01). `createUser` used to run in exactly one place — accept-invite,
 * behind a password form — so deleting the password routes without this
 * branch would have left every future teammate verifying with Google
 * perfectly and then bouncing off `not_invited` forever, with no screen able
 * to let them in. `claimInviteForEmail` is that branch: it claims the invite
 * by the address Clerk just verified. See its header for why the token is no
 * longer the thing being checked.
 *
 * THERE IS NO SECOND FACTOR HERE BECAUSE THERE IS NO SECOND SYSTEM. Clerk's
 * dashboard owns passwords, Google and every factor; `auth_login_challenges`
 * and the emailed six-digit code went with the password routes.
 *
 * THE VERIFIER IS A SEAM, NOT AN IMPORT. The real one calls Clerk's SDK with
 * `CLERK_SECRET_KEY`; the suite injects a fake and drives the real route —
 * CLAUDE.md §2's rule. The seam's shape is the minimum the route needs: a
 * token in, a primary email out (or null for anything invalid).
 */

export interface ClerkVerifier {
  /**
   * Resolve a Clerk session token to the account's identity, or null.
   *
   * `name` is BEST-EFFORT and may be absent: it is only ever used to seed the
   * display name of an account being provisioned for the first time, and
   * `claimInviteForEmail` falls back to the address's local part. A Google
   * account with no profile name is ordinary, so this must not be required.
   */
  verify(token: string): Promise<{ email: string; name?: string } | null>;
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
        if (!email) return null;
        /*
         * Whatever Clerk actually has, in descending order of how much a
         * person would recognise it. All three are nullable on a Clerk user,
         * which is why the caller still owns a fallback.
         */
        const name =
          [user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
          user.username ||
          '';
        return name ? { email, name } : { email };
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
     *
     * A DISABLED ACCOUNT IS REFUSED BEFORE THE INVITE IS CONSULTED, and the
     * order is the point: a revoked teammate whose old invite row somehow
     * survived must not be able to walk back in through provisioning. Only a
     * MISS falls through to the claim.
     */
    const found = await findUserByEmail(db, identity.email);
    if (found && found.disabledAt != null) {
      return c.json(
        { error: 'not_invited', requestId: c.get('requestId') ?? '' },
        403,
      );
    }

    /*
     * First sign-in for an invited address: spend the invite and create the
     * account. `claimInviteForEmail` answers null for "no open invite", which
     * is the same refusal an uninvited stranger gets — the caller cannot tell
     * an unspent invite from a spent one, and does not need to.
     */
    const user = found?.user ?? (await claimInviteForEmail(db, {
      email: identity.email,
      displayName: identity.name ?? '',
    }));

    if (!user) {
      return c.json(
        { error: 'not_invited', requestId: c.get('requestId') ?? '' },
        403,
      );
    }

    const { token: session, expiresAt } = await createSession(
      db,
      user.id,
      c.req.header('user-agent') ?? undefined,
    );
    setSessionCookie(c, session, expiresAt);
    return c.json({ user });
  });

  return app;
}
