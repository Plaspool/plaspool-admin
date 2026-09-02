import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, readQuery, str } from '../middleware/errors';
import {
  clearSessionCookie,
  requireAdmin,
  requireAuth,
  sessionToken,
} from '../middleware/session';
import {
  INVITE_TTL_MS,
  createInvite,
  destroySession,
  findUserByEmail,
  listInvites,
  listSessions,
  revokeInvite,
  revokeSession,
  updateDisplayName,
} from '../repo/users';
import { ASSIGNABLE_ROLES, canAssign } from '../../shared/roles';
import { adminOrigin } from '../admin-url';
import { ForbiddenError } from '../middleware/errors';
import { getEnv } from '../env';
import { resendMailer } from '../mail/resend';
import type { Mailer } from '../mail/port';
import { BadRequestError, NotFoundError } from '../repo/errors';
import { currentDb, currentUser } from '../app-env';
import type { AppEnv } from '../app-env';
import { renderSystem } from '../email/system-templates';

/**
 * Sessions and invites (spec §5.1, §6).
 *
 * THIS FILE NO LONGER SIGNS ANYBODY IN (2026-09-01). Every credential the
 * admin used to hold — the password, the emailed six-digit second factor, the
 * reset token, the accept-invite form — was deleted the day Clerk became the
 * only door. `POST /api/auth/clerk/exchange` (`server/routes/clerk.ts`) is now
 * the ONLY route in the application that mints a session cookie, and it is the
 * only place `createSession` is called from a request.
 *
 * IF YOU ARE ABOUT TO ADD A SECOND WAY IN, DON'T — or if you must, know what
 * you are re-opening. The property this file used to exist to hold was that
 * login answered identically for an unknown email and a wrong password,
 * because on an invite-only instance knowing WHICH addresses have accounts is
 * most of what an attacker wants. Every password-shaped route has to rebuild
 * that from scratch. What survives here is deliberately enumeration-free: the
 * routes below all require a session or an admin role.
 *
 * WHAT REMAINS: the caller's own account and sessions, and the invite list
 * that decides who Clerk is allowed to let in.
 */
export const routes = new Hono<AppEnv>();

/**
 * Where `POST /api/invites` points the invitee: the front door, and nothing
 * else.
 *
 * THE TOKEN IS NO LONGER IN THE LINK, and that is the visible half of Clerk
 * becoming the only auth (2026-09-01). This used to be `/#/accept-invite`
 * carrying a 256-bit token to a form that set a password, because holding the
 * link was the only proof the invitee could offer. Clerk now takes a stronger
 * proof first — control of the address itself — and
 * `claimInviteForEmail` spends the invite against the address Clerk verified.
 * So the link has nothing to carry: the invitee opens the admin, signs in with
 * Google, and their account is created on the way through.
 *
 * A LINK THAT CARRIES NO CREDENTIAL CANNOT LEAK ONE. A forwarded invite used
 * to be a handover of the account; now it is a forwarded URL to a sign-in
 * screen that will refuse the wrong person.
 *
 * The `#` survives because the client is a `createHashRouter` app and a bare
 * origin is where it boots.
 */
export const INVITE_PATH = '/#/';

/**
 * 320 is the RFC 5321 maximum. The format itself is deliberately NOT
 * validated here: `POST /invites` is admin-only, so a malformed address is the
 * inviter's typo rather than a probe, and `EMAILISH` on the client already
 * catches it before the request is made.
 */
const Email = str().min(1).max(320);

const InviteBody = z
  .object({
    email: Email,
    /** `owner` is deliberately not in the enum: the singular account is never
     * minted through the API (shared/roles.ts, migration 0680). A body naming
     * it is a 400, the same wall the role-change route builds. */
    role: z.enum(ASSIGNABLE_ROLES).default('writer'),
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
routes.get('/invites', requireAdmin(), async (c) => {
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

routes.delete('/invites/:id', requireAdmin(), async (c) => {
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
      /*
       * RENDERED FROM THE `account.invite` SYSTEM TEMPLATE, so this message wears
       * the same masthead, card and button as every order email instead of the
       * three bare paragraphs it used to be — and so an owner can edit its wording
       * on the templates screen without a deploy.
       *
       * NOTE THE ESCAPING CHANGE THIS QUIETLY FIXES. The old HTML above
       * interpolated `inviterName` straight into markup: a writer whose display
       * name contained `<` produced broken markup, and one who chose an `<a>` tag
       * as their name produced a link in an email the application sent. The
       * renderer escapes every scalar into the HTML part
       * (`server/mail/transactional.ts`), so that is closed by construction now
       * rather than by remembering.
       *
       * `renderSystem` never throws: an unreadable template falls back to the
       * built-in, which matters here because this whole function answers `false`
       * rather than raising and the caller has already committed the invite row.
       */
      await mailer.send(
        await renderSystem(currentDb(c), 'account.invite', to, {
          inviter_name: inviterName,
          invite_url: url,
          expiry_days: String(days),
        }),
      );
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

  app.post('/invites', requireAdmin(), async (c) => {
    const db = currentDb(c);
    const { email, role } = await readJson(c, InviteBody);
    const address = normaliseEmail(email);

    /*
     * THE SENIORITY RULE (shared/roles.ts): the owner mints any assignable
     * role; a developer mints the four below developer. The enum already
     * refused `owner` for everybody, so this is only about developers minting
     * peers.
     */
    if (!canAssign(currentUser(c).role, role)) {
      throw new ForbiddenError();
    }

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
     * `adminOrigin()`, NOT `c.get('origins')[0]` and certainly not the request's
     * `Host` header.
     *
     * Not the header, because it is attacker-controlled on any deployment that
     * does not pin it, and an invite URL built from one points a teammate at a
     * domain the attacker chose.
     *
     * Not `origins[0]` either, and that half is a bug this route shipped: the
     * allow-list legitimately holds every alias of this deployment, its order
     * is nobody's decision, and its first entry was a `*.vercel.app` host where
     * Clerk's production key refuses to load — so the invitation rendered a
     * blank page for the one person who could not diagnose it.
     * `server/admin-url.ts` carries the full account.
     */
    const url = `${adminOrigin()}${INVITE_PATH}`;

    const emailed = await deliverInvite(c, address, url, inviter.displayName);

    /*
     * THE CLERK HALF, BEST-EFFORT (2026-08-31). When the deployment has a
     * Clerk secret, the address is also invited in Clerk, so their Google
     * sign-up is pre-authorised and lands them straight at the exchange. OUR
     * invite remains the authority — the account, the role and the invite-only
     * property all live here — so a Clerk failure costs a nicer onboarding
     * screen, never the invitation. Swallowed like a failed invite mail, and
     * logged the same way.
     */
    let clerkInvited = false;
    if (getEnv().CLERK_SECRET_KEY !== '') {
      try {
        const { createClerkClient } = await import('@clerk/backend');
        await createClerkClient({ secretKey: getEnv().CLERK_SECRET_KEY }).invitations.createInvitation({
          emailAddress: address,
          notify: false,
          ignoreExisting: true,
        });
        clerkInvited = true;
      } catch (err) {
        console.error(
          '[api]',
          JSON.stringify({
            requestId: c.get('requestId') ?? '',
            name: err instanceof Error ? err.name : 'Error',
            message: err instanceof Error ? err.message : 'clerk invitation failed',
            route: 'POST /api/invites',
          }),
        );
      }
    }

    return c.json(
      {
        /*
         * `url` IS NOT A CREDENTIAL ANY MORE — it is the admin's front door,
         * the same URL for every invitee (see INVITE_PATH). What makes it
         * work for THIS person is the row just written: the exchange spends
         * it against the address Clerk verifies. The invite token is still
         * minted and stored as an HMAC by `createInvite`, and nothing reads
         * it; it is left in place because dropping the column would be a
         * migration for no behaviour.
         */
        invite: { id: invite.id, email: address, role, expiresAt: invite.expiresAt, url },
        emailed,
        clerkInvited,
      },
      201,
    );
  });

  app.route('/', routes);
  return app;
}

