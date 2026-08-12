import { Hono } from 'hono';
import { z } from 'zod';
import { readJson, str } from '../middleware/errors';
import {
  clearSessionCookie,
  requireAuth,
  requireOwner,
  sessionToken,
  setSessionCookie,
} from '../middleware/session';
import { UnauthenticatedError } from '../middleware/errors';
import { clientIp, limit } from '../middleware/ratelimit';
import { forget } from '../repo/ratelimit';
import {
  LOGIN_IP_LIMIT,
  LOGIN_LIMIT,
  LOGIN_WINDOW_MS,
} from '../repo/ratelimit';
import { verifyPassword } from '../repo/password';
import {
  acceptInvite,
  createInvite,
  createSession,
  destroySession,
  findUserByEmail,
  listInvites,
  revokeInvite,
} from '../repo/users';
import { consumePasswordReset, createPasswordReset } from '../repo/password-reset';
import { resendMailer } from '../mail/resend';
import type { Mailer } from '../mail/port';
import { BadRequestError, NotFoundError } from '../repo/errors';
import { currentDb, currentUser } from '../app-env';
import type { AppEnv } from '../app-env';

/**
 * Auth, sessions and invites (spec §5.1, §6).
 *
 * THE ONE PROPERTY THIS FILE EXISTS TO HOLD: login answers identically for an
 * unknown email and a wrong password — same status, same body, and the same
 * work. Anything else makes the endpoint a user-enumeration oracle for an
 * invite-only instance, where knowing WHICH addresses have accounts is most of
 * what an attacker wants.
 */
export const routes = new Hono<AppEnv>();

/**
 * A real scrypt hash at the production parameters, of a password nothing will
 * ever supply.
 *
 * The unknown-email branch verifies against this so the path costs one scrypt
 * derivation, exactly as the found-user branch does. `verifyPassword` reads N,
 * r and p out of the stored string, so the cost is carried by the constant
 * rather than by a second code path that could drift from the first.
 *
 * A CONSTANT AND NOT A HASH COMPUTED AT BOOT. Computing one at import time
 * costs ~200 ms on every cold start of a serverless function — paid by the
 * first request of every instance, which is the request most likely to be a
 * real person waiting. Computing it lazily on first use makes the FIRST
 * unknown-email login pay two derivations instead of one, which is the very
 * timing difference this exists to remove.
 */
export const DUMMY_PASSWORD_HASH =
  'scrypt$32768$8$1$u6l3a2HntF0KoKSbIXU6Zr6RGAcrANS9Ul852acaa/E=$cBZrwDKdPAuVJZ7WGJhoIQFWoy++nUGWCREXuGtrJ4M=';

/**
 * Where `POST /api/invites` points the invitee.
 *
 * THE `#` IS LOAD-BEARING AND IS NOT A STYLE CHOICE. The client is a static
 * app served under `createHashRouter` (`src/main.tsx`), which reads the route
 * out of `location.hash` and never looks at `location.search`. With the old
 * `/accept-invite`, the token arrived in the query string of a path the router
 * does not route: every invite this server could mint was dead on arrival, and
 * the invitee landed on the dashboard's catch-all with no way to claim their
 * account.
 *
 * `#/accept-invite?token=…` puts it where the router can see it: react-router's
 * `createHashLocation` runs `parsePath(location.hash.substring(1))`, which
 * yields `{ pathname: '/accept-invite', search: '?token=…' }`. (Parsing the
 * whole href instead returns only `{ hash }` — that mistake is why this took a
 * second look.)
 *
 * Links already sent still work: `src/main.tsx` rewrites the old path form
 * before the router mounts.
 */
export const INVITE_PATH = '/#/accept-invite';

/**
 * Where the reset mail points, and the `#` is load-bearing for exactly the
 * reason `INVITE_PATH` above spells out: the client is a `createHashRouter`
 * app, so a token in `location.search` reaches no route and every link would be
 * dead on arrival.
 */
export const RESET_PATH = '/#/reset';

/**
 * The narrow forgot-password bucket: five per fifteen minutes per ip+email.
 *
 * The same numbers as `LOGIN_LIMIT`/`LOGIN_WINDOW_MS`, and named separately
 * rather than reused so that tuning the login limiter does not silently retune
 * how many reset mails one host can aim at one address — this bucket is the
 * only thing standing between an attacker and an inbox full of mail the account
 * holder did not ask for.
 */
export const FORGOT_LIMIT = 5;
export const FORGOT_WINDOW_MS = 15 * 60_000;

/**
 * Bounded before it is used as a primary key.
 *
 * The rate-limit key is `login:<ip>|<email>`, so an unbounded email is an
 * unbounded row in `auth_attempts`. 320 is the RFC 5321 maximum; the format
 * itself is deliberately NOT validated, because a login that rejects a
 * malformed address with a different status from a valid unknown one is the
 * enumeration oracle again, one layer up.
 */
const Email = str().min(1).max(320);

const LoginBody = z
  .object({
    email: Email,
    // Bounded so an unauthenticated caller cannot hand scrypt a 10 MB input.
    password: str().min(1).max(1024),
  })
  .strict();

const AcceptInviteBody = z
  .object({
    token: str().min(1).max(512),
    password: str().min(1).max(1024),
    displayName: str().min(1).max(200),
  })
  .strict();

const ForgotBody = z.object({ email: Email }).strict();

const ResetBody = z
  .object({
    token: str().min(1).max(512),
    // Bounded like the login body: an unauthenticated caller must not be able
    // to hand scrypt a 10 MB input.
    password: str().min(1).max(1024),
  })
  .strict();

const InviteBody = z
  .object({
    email: Email,
    role: z.enum(['owner', 'writer']).default('writer'),
  })
  .strict();

/** Lowercased and trimmed exactly as `findUserByEmail` and `createUser` do. */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ------------------------------------------------------------------- login

routes.post('/auth/login', async (c) => {
  const db = currentDb(c);
  const ip = clientIp(c);

  /*
   * THE IP BUCKET IS CONSULTED BEFORE THE BODY IS READ.
   *
   * Parsing first meant an unauthenticated caller could make the process parse
   * a body up to the platform limit on every request, however many times it
   * had already been refused — the limiter cannot bound work it runs after.
   * The narrow bucket is keyed by the email and therefore cannot move above
   * the parse; the IP bucket is the one that has to.
   */
  await limit(c, `login:${ip}`, LOGIN_IP_LIMIT, LOGIN_WINDOW_MS);

  const { email, password } = await readJson(c, LoginBody);
  const address = normaliseEmail(email);

  /*
   * TWO BUCKETS, IP FIRST (spec §6).
   *
   * A single per-email limiter lets one host password-spray every account in an
   * invite-only instance without ever tripping. The IP bucket is checked FIRST
   * so a host that has already exhausted it cannot go on minting a new
   * `auth_attempts` row per address it guesses — which would make the limiter
   * itself the storage-exhaustion primitive.
   */
  const narrowKey = `login:${ip}|${address}`;
  await limit(c, narrowKey, LOGIN_LIMIT, LOGIN_WINDOW_MS);

  const found = await findUserByEmail(db, address);

  /*
   * THE HASH RUNS EITHER WAY.
   *
   * Returning early for an unknown address makes the two answers differ by ~200
   * milliseconds, which is trivially measurable over a handful of requests and
   * turns this endpoint into a list of who has an account here.
   */
  const ok = await verifyPassword(password, found?.passwordHash ?? DUMMY_PASSWORD_HASH);

  /*
   * A revoked writer gets the same refusal as a wrong password, and the check
   * is here rather than in the query so it costs the same either way.
   * `resolveSession` already refuses a disabled user's session; without this,
   * login would still succeed and hand back a cookie that 401s on the very next
   * request.
   */
  if (!ok || !found || found.disabledAt != null) throw new UnauthenticatedError();

  const { token, expiresAt } = await createSession(
    db,
    found.user.id,
    c.req.header('user-agent') ?? undefined,
  );
  setSessionCookie(c, token, expiresAt);

  /*
   * Only the NARROW bucket is cleared, never `login:<ip>` (see `forget`).
   * Clearing both would hand an attacker holding one valid account a reset
   * button for the spray limiter.
   */
  await forget(db, narrowKey);

  return c.json({ user: found.user });
});

// ------------------------------------------------------------------ logout

/**
 * Deliberately NOT behind `requireAuth`.
 *
 * A logout that 401s for an expired session leaves the cookie sitting in the
 * browser, which is the one outcome logout exists to prevent. It is still
 * `Origin`-checked, because it is a state change and a cross-site forced logout
 * is a real (if minor) nuisance.
 */
routes.post('/auth/logout', async (c) => {
  const token = sessionToken(c);
  if (token) await destroySession(currentDb(c), token);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------- me

routes.get('/auth/me', requireAuth(), (c) => c.json({ user: currentUser(c) }));

// ----------------------------------------------------------- accept invite

routes.post('/auth/accept-invite', async (c) => {
  const db = currentDb(c);
  /*
   * Rate-limited by IP alone: there is no account to key on yet, and the two
   * costs on this path — a scrypt derivation and a user insert — are both worth
   * bounding for an unauthenticated caller. The token itself is 256 bits, so
   * this is not what stands between an attacker and a guessed invite.
   */
  await limit(c, `accept:${clientIp(c)}`, LOGIN_IP_LIMIT, LOGIN_WINDOW_MS);

  const body = await readJson(c, AcceptInviteBody);
  // `acceptInvite` is the authority for email and role — the body has no room
  // for either, because accepting a caller-supplied role is privilege
  // escalation by HTTP request.
  const user = await acceptInvite(db, body);

  const { token, expiresAt } = await createSession(
    db,
    user.id,
    c.req.header('user-agent') ?? undefined,
  );
  setSessionCookie(c, token, expiresAt);
  return c.json({ user }, 201);
});

// ----------------------------------------------------------------- invites

/**
 * A uuid, or a 400.
 *
 * `invites.id` is a `uuid` column, so a path segment that is not one reaches
 * the driver as SQLSTATE 22P02 — scrubbed to a `DbError`, answered 500, and
 * then retried five times by the client's policy for a request that can never
 * succeed (spec §8).
 */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireUuid(value: string, field: string): string {
  if (!UUID.test(value)) throw new BadRequestError(field);
  return value;
}

routes.post('/invites', requireOwner(), async (c) => {
  const db = currentDb(c);
  const { email, role } = await readJson(c, InviteBody);
  const address = normaliseEmail(email);

  /*
   * Refused before the invite is minted rather than after it is spent. Without
   * this the owner gets a URL that looks fine, the invitee sets a password, and
   * `createUser` fails on `users_email_unique` — burning a round trip and a
   * scrypt derivation to say something knowable now.
   */
  if (await findUserByEmail(db, address)) throw new BadRequestError('email');

  const invite = await createInvite(db, {
    email: address,
    role,
    invitedBy: currentUser(c).id,
  });

  /*
   * The URL is built from the FIRST configured origin, not from the request's
   * `Host` or `Origin` header. A host header is attacker-controlled on any
   * deployment that does not pin it, and an invite URL built from one is a
   * credential delivered to a domain the attacker chose.
   */
  const base = c.get('origins')[0] ?? '';
  const url = `${base}${INVITE_PATH}?token=${encodeURIComponent(invite.token)}`;

  return c.json(
    {
      // The token is returned exactly once, here, inside the URL. It is stored
      // only as an HMAC, so there is no second chance to read it.
      invite: { id: invite.id, email: address, role, expiresAt: invite.expiresAt, url },
    },
    201,
  );
});

routes.get('/invites', requireOwner(), async (c) =>
  c.json({ items: await listInvites(currentDb(c)) }),
);

routes.delete('/invites/:id', requireOwner(), async (c) => {
  const id = requireUuid(c.req.param('id'), 'id');
  if (!(await revokeInvite(currentDb(c), id))) throw new NotFoundError(id);
  return c.json({ ok: true });
});

// --------------------------------------------------------- password resets

export interface AuthRouteDeps {
  /**
   * Mail transport. Defaults to `resendMailer()`, which reads nothing at
   * construction — so building the app still demands no mail configuration.
   *
   * Injected rather than imported so a suite can drive the real route with a
   * recorder and never touch the network. See `server/mail/port.ts`.
   */
  mailer?: Mailer;
}

/**
 * The auth router, including the reset routes that need a mailer.
 *
 * A FACTORY WRAPPING `routes` rather than a rewrite of it: everything above is
 * dependency-free and stays registered at module scope, and this adds only the
 * two routes that are not.
 */
export function createAuthRoutes(deps: AuthRouteDeps = {}): Hono<AppEnv> {
  const mailer = deps.mailer ?? resendMailer();
  const app = new Hono<AppEnv>();

  /**
   * `POST /api/auth/forgot` — ALWAYS 202, for any address.
   *
   * The same property login holds, one endpoint over: an unknown address and a
   * real one produce the same status, the same body and the same visible work.
   * A 404 for "no such account" would be a complete user list for an
   * invite-only instance, handed out unauthenticated at five requests a
   * quarter-hour.
   */
  app.post('/auth/forgot', async (c) => {
    const db = currentDb(c);
    const ip = clientIp(c);

    // The IP bucket BEFORE the body is read, for the reason the login route
    // gives at length: a limiter cannot bound work that runs after it.
    await limit(c, `forgot:${ip}`, LOGIN_IP_LIMIT, LOGIN_WINDOW_MS);

    const { email } = await readJson(c, ForgotBody);
    const address = normaliseEmail(email);

    // The narrow bucket, which is what stops one host mail-bombing one inbox.
    // It cannot move above the parse: the email it keys on is in the body.
    await limit(c, `forgot:${ip}|${address}`, FORGOT_LIMIT, FORGOT_WINDOW_MS);

    /*
     * THE CONFIGURATION CHECK RUNS HERE — BEFORE THE LOOKUP — AND THE ORDER IS
     * THE WHOLE POINT.
     *
     * The brief asks that an unconfigured mailer surface rather than be
     * swallowed, and separately that an unknown address must never fail
     * differently from a known one. Put the check where it naturally falls —
     * inside `mailer.send`, i.e. after the lookup — and those two requirements
     * collide: on an unconfigured deployment a KNOWN address 501s (it reached
     * the send) and an UNKNOWN one 202s (it never did). That is precisely the
     * enumeration oracle this route exists to avoid, rebuilt out of the failure
     * path instead of the success path, and it would be MORE reliable than a
     * timing side channel because it is a status code.
     *
     * Asking the question before there is a user to ask it about makes the
     * answer independent of whether the account exists: an unconfigured
     * deployment 501s for every address alike, and a configured one 202s for
     * every address alike. Loudly broken for everybody beats quietly broken
     * only for real accounts.
     */
    mailer.assertConfigured?.();

    const issued = await createPasswordReset(db, address);

    /*
     * `null` for "no account" AND for "disabled account", and the route cannot
     * tell which — `createPasswordReset` returns a type with no room to say.
     * Nothing is sent and the answer below is unchanged.
     */
    if (issued) {
      /*
       * Built from the FIRST CONFIGURED ORIGIN, never from `Host` or `Origin`.
       * A host header is attacker-controlled on any deployment that does not
       * pin it, and a reset URL built from one is a password-reset credential
       * delivered to a domain the attacker chose — the classic host-header
       * poisoning bug, and worse here than for invites because it takes over an
       * existing account rather than creating a new one.
       */
      const base = c.get('origins')[0] ?? '';
      const url = `${base}${RESET_PATH}?token=${encodeURIComponent(issued.token)}`;

      await mailer.send({
        to: issued.user.email,
        subject: 'Reset your password',
        text:
          `Someone asked to reset the password for this account.\n\n` +
          `${url}\n\n` +
          `The link works once and expires in an hour. If this was not you, ` +
          `nothing has changed and you can ignore this message.`,
        html:
          `<p>Someone asked to reset the password for this account.</p>` +
          `<p><a href="${url}">Choose a new password</a></p>` +
          `<p>The link works once and expires in an hour. If this was not you, ` +
          `nothing has changed and you can ignore this message.</p>`,
      });
    }

    /*
     * 202 AND NOT 200: the honest status. The server has accepted the request
     * and will act on it if there is anything to act on; it is deliberately not
     * telling the caller whether mail was sent, and 200 would imply it had.
     */
    return c.json({ sent: true }, 202);
  });

  /**
   * `POST /api/auth/reset` — spend the token, set the password, and destroy
   * every session the user holds.
   *
   * Rate-limited by IP alone. There is no account to key on (the token names
   * one, and looking it up to build a limiter key would mean consulting the
   * token before the limiter bounds the work), and the two costs on this path —
   * a scrypt derivation and a write — are both worth bounding for an
   * unauthenticated caller. The token is 256 bits, so this is not what stands
   * between an attacker and a guess.
   */
  app.post('/auth/reset', async (c) => {
    await limit(c, `reset:${clientIp(c)}`, LOGIN_IP_LIMIT, LOGIN_WINDOW_MS);
    const { token, password } = await readJson(c, ResetBody);
    await consumePasswordReset(currentDb(c), token, password);
    /*
     * NO COOKIE IS SET. Resetting does not log you in: the sweep inside
     * `consumePasswordReset` exists to end every session, and handing back a
     * fresh one in the same response would make this route the only way to turn
     * a token seen in a mailbox into a live session without ever typing the new
     * password.
     */
    return c.json({ ok: true });
  });

  app.route('/', routes);
  return app;
}

