import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, readQuery, str } from '../middleware/errors';
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
  INVITE_TTL_MS,
  acceptInvite,
  changePassword,
  createInvite,
  createSession,
  destroySession,
  findUserByEmail,
  findUserById,
  listInvites,
  listSessions,
  revokeInvite,
  revokeSession,
  updateDisplayName,
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
 * The signed-in password-change bucket: five per fifteen minutes per USER.
 *
 * Keyed on the account and not on the IP, because the thing worth bounding here
 * is not traffic — the caller is already authenticated — but guesses at the
 * CURRENT password. A stolen or borrowed session (an unlocked laptop, a shared
 * machine) is exactly the position from which someone would try to promote
 * temporary access into permanent control by finding the existing password, and
 * this route is the only place in the app that will tell them whether a guess is
 * right. Five tries a quarter-hour makes that useless while leaving room for the
 * ordinary typo.
 *
 * Named separately from `LOGIN_LIMIT` for the reason `FORGOT_LIMIT` is: tuning
 * the login limiter should not silently retune this.
 */
export const CHANGE_PASSWORD_LIMIT = 5;
export const CHANGE_PASSWORD_WINDOW_MS = 15 * 60_000;

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

/**
 * `PATCH /api/auth/me`.
 *
 * OPTIONAL, so `{}` is a no-op that returns the caller unchanged rather than a
 * 400. The field is optional in the contract because this is the account patch
 * and more of the account will land on it (an email change needs a
 * confirmation round trip and is deliberately not here yet) — a schema that
 * required the one field it currently has would have to loosen the day a
 * second arrives, and every client would have to be told.
 *
 * `.min(1)` refuses `''`; it does NOT refuse `'   '`, which is why
 * `updateDisplayName` calls `assertDisplayName` as well. 200 is the same
 * ceiling `AcceptInviteBody` sets, so a name cannot be created at one length
 * and edited to another.
 */
const MeBody = z
  .object({
    displayName: str().min(1).max(200).optional(),
  })
  .strict();

const ChangePasswordBody = z
  .object({
    // Bounded like the login body, and for the same reason: nothing should be
    // able to hand scrypt a 10 MB input, session or no session.
    currentPassword: str().min(1).max(1024),
    newPassword: str().min(1).max(1024),
  })
  .strict();

/** The two history buckets `GET /api/invites?include=` can opt in to. */
const INVITE_INCLUDES = ['accepted', 'expired'] as const;

const InviteQuery = z
  .object({
    /**
     * A comma-separated list, parsed below rather than by Zod.
     *
     * `z.enum` over a repeated `?include=a&include=b` would be the more Zod-ish
     * shape, but `readQuery` is fed `c.req.query()`, which collapses repeats to
     * the LAST value — so the second one would silently win and an owner asking
     * for both buckets would get one. Bounded because it is caller-supplied and
     * about to be split.
     */
    include: str().max(100).optional(),
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

/**
 * The account's own settings — one field today.
 *
 * NO BACKFILL RIDES ALONG WITH A RENAME, and that is a property of the schema
 * rather than a decision taken here: `posts` has no `author_name` column at
 * all. `server/repo/posts.ts:62`, `server/repo/query.ts:371`,
 * `server/repo/backup.ts:44` and `server/repo/public.ts:212` each read
 * `u.display_name AS author_name` through a live `JOIN users u ON u.id =
 * p.author_id`, so the new name is on every post, every list, the export bundle
 * and the public feed as soon as this UPDATE commits. Nothing is stale and there
 * is nothing to migrate. Had the name been denormalised onto `posts`, this route
 * would owe a second statement.
 *
 * The 404 is not reachable in practice — `requireAuth` resolved the row a
 * moment ago — and is written anyway rather than a `!`, for the reason
 * `currentUser` gives: a route that assumes a row it did not read is one schema
 * change away from a confusing 500.
 */
routes.patch('/auth/me', requireAuth(), async (c) => {
  const user = currentUser(c);
  const { displayName } = await readJson(c, MeBody);
  if (displayName === undefined) return c.json({ user });

  const updated = await updateDisplayName(currentDb(c), user.id, displayName);
  if (!updated) throw new NotFoundError(user.id);
  return c.json({ user: updated });
});

/**
 * `POST /api/auth/change-password` — the signed-in path the reset flow
 * deliberately is not.
 *
 * `POST /api/auth/reset` ends EVERY session, because a reset is what somebody
 * does when they think an intruder holds one and there is nobody worth keeping.
 * This route keeps exactly one — the caller's — and ends the rest. That
 * asymmetry is the entire reason it exists: a change that logged you out of the
 * tab you typed it in would be unusable, and one that left the other thirty-day
 * cookies alive would be cosmetic against precisely the person it is aimed at.
 *
 * A WRONG `currentPassword` IS A 400 NAMING THE FIELD, NOT A 401. The session is
 * valid — that is what `requireAuth` just established — so 401 would be a lie
 * about which credential failed, and an expensive one: `src/data/api.ts` turns
 * every 401 into an `AuthExpiredError` and fires `auth-expired`, which raises
 * the re-authentication overlay over whatever the writer was doing. A typo in
 * one field would look exactly like a dead session. 400 with
 * `detail: 'currentPassword'` is the §8 row for "a request the server can parse
 * but cannot honour", and it names the field and never the value.
 */
routes.post('/auth/change-password', requireAuth(), async (c) => {
  const db = currentDb(c);
  const user = currentUser(c);

  /*
   * ABOVE THE PARSE, like the login route's IP bucket and for the same reason:
   * a limiter cannot bound work it runs after itself. Unlike `forgot`'s narrow
   * bucket it is free to sit here, because the key comes from the session the
   * middleware has already resolved rather than from the body.
   */
  await limit(c, `chpw:${user.id}`, CHANGE_PASSWORD_LIMIT, CHANGE_PASSWORD_WINDOW_MS);

  const { currentPassword, newPassword } = await readJson(c, ChangePasswordBody);

  const found = await findUserById(db, user.id);
  if (!found) throw new UnauthenticatedError();

  /*
   * VERIFIED FIRST, THEN JUDGED — the opposite order from `createUser`, and the
   * swap is deliberate. `createUser` judges before hashing so a rejected
   * password does not cost 200 ms of scrypt; here the derivation happens anyway
   * (that is what verifying the CURRENT password is), so ordering by cost buys
   * nothing, and ordering by usefulness does: somebody who mistypes their
   * existing password AND picks a short new one should be told about the
   * mistyped one, because that is the field the next attempt has to get right.
   *
   * `assertCredentials` on the new value lives inside `changePassword`, so the
   * ten-character floor is enforced by the same function `acceptInvite` and the
   * reset flow are bound by rather than by a copy of the rule here.
   */
  if (!(await verifyPassword(currentPassword, found.passwordHash))) {
    throw new BadRequestError('currentPassword');
  }

  const otherSessionsEnded = await changePassword(db, {
    userId: user.id,
    newPassword,
    // The RAW cookie. `changePassword` derives the id it must not delete, so
    // this route never has to know that a session id is an HMAC.
    keepSessionToken: sessionToken(c),
  });

  /*
   * The narrow bucket is forgotten on success, exactly as a successful login
   * forgets `login:<ip>|<email>`: somebody who mistyped their old password four
   * times before getting it right must not then be locked out of changing it
   * again for a quarter of an hour.
   */
  await forget(db, `chpw:${user.id}`);

  // The count is in the body because the UI says "signed out N other devices",
  // and a client that had to count them itself would need the list route and a
  // second round trip to say anything more useful than "done".
  return c.json({ ok: true, otherSessionsEnded });
});

// ---------------------------------------------------------------- sessions

/**
 * The caller's own live sessions.
 *
 * `sessions.user_agent` and `sessions.last_seen_at` have been written since the
 * table was created, for a screen that did not exist — this is that screen's
 * route. `last_seen_at` in particular is written on EVERY resolve rather than
 * only when the sliding refresh fires (see `resolveSession`), precisely so the
 * "last used" column here can be trusted.
 *
 * OWN SESSIONS ONLY, with no owner override. An owner who needs to end
 * somebody else's sessions has `POST /api/users/:id/disable`, which is the
 * honest way to do it — it revokes the account as well, rather than quietly
 * signing a writer out and leaving them able to sign straight back in.
 */
routes.get('/auth/sessions', requireAuth(), async (c) =>
  c.json({
    items: await listSessions(currentDb(c), currentUser(c).id, sessionToken(c)),
  }),
);

/**
 * Revoke one of your own sessions, including the current one — which is a
 * logout that leaves the cookie in the browser, so the next request 401s and
 * the client clears it. Refusing to revoke the current one would be a rule the
 * user has to learn for no benefit.
 *
 * SOMEBODY ELSE'S SESSION ID AND AN ID THAT NEVER EXISTED ARE THE SAME 404.
 * `revokeSession` scopes the DELETE by `user_id`, so the two cases produce the
 * same zero rows — which is also what stops this route being a probe for
 * whether a given id belongs to somebody.
 *
 * `pathParam` and not `c.req.param`: a `%00` in the segment would otherwise
 * reach a bound parameter and `server/nul-bytes.test.ts` walks every registered
 * route looking for exactly that. No uuid check, because `sessions.id` is a
 * `text` primary key — a malformed value matches nothing rather than raising
 * SQLSTATE 22P02, so the 404 above already covers it.
 */
routes.delete('/auth/sessions/:id', requireAuth(), async (c) => {
  const id = pathParam(c, 'id');
  if (!(await revokeSession(currentDb(c), currentUser(c).id, id))) {
    throw new NotFoundError(id);
  }
  return c.json({ ok: true });
});

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
 * A path segment that is a uuid, or a 400.
 *
 * `invites.id` and `users.id` are `uuid` columns, so a segment that is not one
 * reaches the driver as SQLSTATE 22P02 — scrubbed to a `DbError`, answered 500,
 * and then retried five times by the client's policy for a request that can
 * never succeed (spec §8).
 *
 * EXPORTED, because `server/routes/users.ts` has the same three uuid path
 * params and the alternative is a second copy of this regex that nothing keeps
 * in step with this one. It goes through `pathParam` first rather than
 * `c.req.param` directly: the NUL check has to happen for every path parameter
 * in the app (`server/nul-bytes.test.ts` walks the route table to prove it),
 * and although this regex would reject a NUL anyway, a route that got its
 * boundary check by accident is one loosened pattern away from not having one.
 */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function uuidParam(c: Context<AppEnv>, name: string): string {
  const value = pathParam(c, name);
  if (!UUID.test(value)) throw new BadRequestError(name);
  return value;
}

/**
 * Outstanding invites by default; `?include=accepted,expired` for history.
 *
 * Until this, an invite that had been accepted or had expired was invisible to
 * every route in the app even though the row survived — so "did we ever invite
 * this address" was unanswerable through the API. The buckets are opt-in rather
 * than always-on so the default stays the short list an owner acts on.
 *
 * An unknown member is a 400 naming the parameter, not a silently ignored word.
 * The same rule `ListQueryParams` states for post filters: `?include=acepted`
 * quietly returning the default list looks like a bug in the screen.
 */
routes.get('/invites', requireOwner(), async (c) => {
  const { include } = readQuery(c, InviteQuery);
  const wanted = (include ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  for (const part of wanted) {
    if (!INVITE_INCLUDES.includes(part as (typeof INVITE_INCLUDES)[number])) {
      throw new BadRequestError('include');
    }
  }
  return c.json({
    items: await listInvites(currentDb(c), {
      accepted: wanted.includes('accepted'),
      expired: wanted.includes('expired'),
    }),
  });
});

routes.delete('/invites/:id', requireOwner(), async (c) => {
  const id = uuidParam(c, 'id');
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
 * The auth router, including the routes that need a mailer.
 *
 * A FACTORY WRAPPING `routes` rather than a rewrite of it: everything above is
 * dependency-free and stays registered at module scope, and this adds only the
 * three routes that are not. `POST /invites` joined them when the invite
 * started arriving by email — it is registered here and NOT in `routes` above,
 * so there is exactly one registration of it and no chance of the mailerless
 * copy shadowing this one.
 */
export function createAuthRoutes(deps: AuthRouteDeps = {}): Hono<AppEnv> {
  const mailer = deps.mailer ?? resendMailer();
  const app = new Hono<AppEnv>();

  /**
   * Mint an invite and, if this deployment can, mail it.
   *
   * THE URL STAYS IN THE RESPONSE WHETHER OR NOT THE MAIL WENT. An invite is
   * the only way a second person ever gets into an invite-only instance, so
   * making it depend on a working mail provider would mean a mail outage locks
   * the team out of growing. `emailed` says which happened, and the owner can
   * paste the link into whatever they like.
   *
   * @returns `true` if the provider accepted the message.
   */
  async function deliverInvite(
    c: Context<AppEnv>,
    to: string,
    url: string,
    inviterName: string,
  ): Promise<boolean> {
    /*
     * "NOT CONFIGURED" IS ASKED SEPARATELY FROM "THE SEND FAILED", and the two
     * get different treatment on purpose.
     *
     * A deployment with no `RESEND_API_KEY` is not having an incident; it is a
     * deployment that hands invites over by hand, and logging an error every
     * time an owner mints one would train whoever reads the logs to ignore
     * them. `POST /api/auth/forgot` asks this same question for the opposite
     * reason — there, an unconfigured mailer must surface as a 501 for EVERY
     * address alike or the failure mode itself becomes a user-enumeration
     * oracle. Here there is nobody to enumerate: the caller is the owner, they
     * chose the address, and `emailed: false` in the response tells them more
     * than a 501 could.
     */
    try {
      mailer.assertConfigured?.();
    } catch {
      return false;
    }

    const days = Math.round(INVITE_TTL_MS / (24 * 60 * 60 * 1000));
    try {
      await mailer.send({
        to,
        subject: 'You have been invited to write',
        text:
          `${inviterName} invited you to write on their blog.\n\n` +
          `${url}\n\n` +
          `The link works once and expires in ${days} days. If you were not ` +
          `expecting this, you can ignore this message.`,
        html:
          `<p>${inviterName} invited you to write on their blog.</p>` +
          `<p><a href="${url}">Set up your account</a></p>` +
          `<p>The link works once and expires in ${days} days. If you were not ` +
          `expecting this, you can ignore this message.</p>`,
      });
      return true;
    } catch (err) {
      /*
       * SWALLOWED FOR THE CALLER, NEVER FOR THE OPERATOR — the same shape
       * `POST /api/auth/forgot` logs, and the same reasoning about what may
       * appear in it: name and message only, because the URL carries the invite
       * token and an error object can carry the request that held it.
       *
       * Not a 500: the invite row is already committed and the URL is already
       * in the response, so failing the request would tell the owner to mint a
       * SECOND live token for an address that already has one.
       */
      console.error(
        '[api]',
        JSON.stringify({
          requestId: c.get('requestId') ?? '',
          name: err instanceof Error ? err.name : 'Error',
          message: err instanceof Error ? err.message : 'mail send failed',
          route: 'POST /api/invites',
        }),
      );
      return false;
    }
  }

  app.post('/invites', requireOwner(), async (c) => {
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

    const inviter = currentUser(c);
    const invite = await createInvite(db, {
      email: address,
      role,
      invitedBy: inviter.id,
    });

    /*
     * The URL is built from the FIRST configured origin, not from the request's
     * `Host` or `Origin` header. A host header is attacker-controlled on any
     * deployment that does not pin it, and an invite URL built from one is a
     * credential delivered to a domain the attacker chose.
     */
    const base = c.get('origins')[0] ?? '';
    const url = `${base}${INVITE_PATH}?token=${encodeURIComponent(invite.token)}`;

    const emailed = await deliverInvite(c, address, url, inviter.displayName);

    return c.json(
      {
        // The token is returned exactly once, here, inside the URL. It is stored
        // only as an HMAC, so there is no second chance to read it.
        invite: { id: invite.id, email: address, role, expiresAt: invite.expiresAt, url },
        emailed,
      },
      201,
    );
  });

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

      /*
       * A FAILED SEND MUST NOT BE VISIBLE TO THE CALLER, and this arm is here
       * because the uncaught version shipped and was measured in production:
       * a known address answered 500 while an unknown one answered 202. That
       * is the same enumeration oracle `assertConfigured` closes for the
       * unconfigured case, reopened by every OTHER way a send can fail — an
       * unverified domain, a revoked key, a provider outage, a malformed
       * value. Only a real account ever reaches the send, so any error that
       * escapes here confirms the account exists.
       *
       * Swallowed for the CALLER, never for the operator: the failure is
       * logged with the same shape `toResponse` uses, so a mail outage is
       * loud in the logs and silent on the wire. Deliberately not a 500 and
       * deliberately not a retry — the reset row is already committed, and
       * the writer can ask again.
       */
      try {
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
      } catch (err) {
        // Name and message only. The message never carries the token — see the
        // status-only rule in `server/mail/resend.ts`.
        console.error(
          '[api]',
          JSON.stringify({
            requestId: c.get('requestId') ?? '',
            name: err instanceof Error ? err.name : 'Error',
            message: err instanceof Error ? err.message : 'mail send failed',
            route: 'POST /api/auth/forgot',
          }),
        );
      }
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

