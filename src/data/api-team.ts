/**
 * The owner's team surface — the client half of HANDOFF §2 A2.
 *
 * A SEPARATE MODULE RATHER THAN A BLOCK IN `api.ts`, for the reason
 * `api-categories.ts` sets out: that file was being appended to by four agents
 * in the same hour, and a file four concurrent writers append to is a file that
 * loses a block. `apiFetch` below is `api.ts`'s own request function, so the
 * error envelope, `credentials: 'include'` and the §8 status table are still the
 * shared ones — this is a filing decision, not a second convention.
 *
 * IT SUPERSEDES `api.createInvite` / `listInvites` / `revokeInvite`
 * (`src/data/api.ts:372–384`), WHICH ARE NOW BOTH DEAD AND STALE. They were
 * called by no component when the invite routes grew `emailed` on the create
 * response and `acceptedAt` / `invitedByName` / `state` on the list — so their
 * types describe a shape the server stopped answering with. Deleting them
 * belongs to whoever next owns `api.ts`; until then, nothing new should call
 * them, and the shapes below are the ones read out of `server/routes/auth.ts`.
 */
import { apiFetch } from './api';
import { PreconditionFailedError } from './errors';

/**
 * One row of `GET /api/users`.
 *
 * `postCount` COUNTS TRASHED POSTS TOO, by design on the server: the question
 * the number exists to answer is "what does disabling this person leave
 * behind", and a trashed post is restorable until somebody empties the trash.
 */
export interface TeamUser {
  id: string;
  email: string;
  displayName: string;
  role: 'owner' | 'writer';
  createdAt: number;
  /** Non-null means revoked — every session they hold was destroyed with it. */
  disabledAt: number | null;
  postCount: number;
}

/**
 * One row of `GET /api/invites`.
 *
 * `state` IS THE SERVER'S VERDICT AND MUST NOT BE RE-DERIVED HERE. It is
 * computed from the same `Date.now()` the route's filter used; a client
 * comparing `expiresAt` against its own clock disagrees with that filter on any
 * row within a few seconds of expiry, and then labels "open" a row that
 * `acceptInvite` refuses.
 */
export interface TeamInvite {
  id: string;
  email: string;
  role: 'owner' | 'writer';
  createdAt: number;
  expiresAt: number;
  /** Non-null means spent — the account exists and the token is dead. */
  acceptedAt: number | null;
  invitedBy: string;
  /** Resolved server-side; `invitedBy` alone is a bare uuid nothing can name. */
  invitedByName: string;
  state: 'open' | 'accepted' | 'expired';
}

/**
 * What `POST /api/invites` answers with.
 *
 * THE URL IS PRESENT WHETHER OR NOT THE MAIL WENT, and a screen that hid it on
 * `emailed: true` would be throwing away the only copy of a token that is minted
 * exactly once. An invite is the sole way a second person ever gets into an
 * invite-only instance, so the route refuses to make that depend on a working
 * mail provider; `emailed` says which happened and nothing more.
 */
export interface MintedInvite {
  invite: {
    id: string;
    email: string;
    role: 'owner' | 'writer';
    expiresAt: number;
    /** Contains the raw token. There is no second chance to read it. */
    url: string;
  };
  emailed: boolean;
}

/** What disabling answers. The count is the only proof it was a live account. */
export interface DisableResult {
  sessionsEnded: number;
}

/**
 * The two refusals `POST /api/users/:id/disable` can answer with.
 *
 * TWO OPERATIONS AND NOT ONE, because the screen has to say two different
 * things: "ask another owner to do it" is useless advice on a blog with one
 * owner, and "promote somebody first" is the sentence that actually leads
 * somewhere. A client that told them apart by parsing prose would get it wrong
 * the first time the prose changed.
 */
export type TeamRefusal = 'disable_self' | 'disable_last_owner';

/**
 * The refusal an error carries, or `null` if it is not one of them.
 *
 * `api.ts` maps every 409 `precondition_failed` to `PreconditionFailedError`,
 * whose `post` field is undefined on this surface — there is no post, and the
 * shared class predates a refusal that is about a user. `operation` is the field
 * that survives the wire intact and is the one worth reading.
 */
export function refusalOf(err: unknown): TeamRefusal | null {
  if (!(err instanceof PreconditionFailedError)) return null;
  return err.operation === 'disable_self' || err.operation === 'disable_last_owner'
    ? err.operation
    : null;
}

const seg = (value: string): string => encodeURIComponent(value);

export const teamApi = {
  /**
   * Every account, oldest first. Owner-only, and unpaginated by design — an
   * invite-only blog with enough accounts to page is one where something has
   * gone wrong.
   */
  async listUsers(signal?: AbortSignal): Promise<TeamUser[]> {
    return (await apiFetch<{ items: TeamUser[] }>('/users', { signal })).items;
  },

  /**
   * Revoke an account: it is marked disabled AND every session it holds is
   * destroyed. Idempotent — disabling an already-disabled account is a 200 with
   * `sessionsEnded: 0` rather than a refusal.
   *
   * 409 for the two refusals; read them with `refusalOf`.
   */
  async disableUser(id: string): Promise<DisableResult> {
    const res = await apiFetch<{ ok: true; sessionsEnded: number }>(
      `/users/${seg(id)}/disable`,
      { method: 'POST', id, subject: 'User' },
    );
    return { sessionsEnded: res.sessionsEnded };
  },

  /**
   * Reinstate an account, and DELIBERATELY NOT THE MIRROR OF DISABLE: the
   * sessions destroyed on the way down do not come back. This restores the
   * ability to sign in, which is why the screen must not promise more.
   */
  async enableUser(id: string): Promise<void> {
    await apiFetch<{ ok: true }>(`/users/${seg(id)}/enable`, {
      method: 'POST',
      id,
      subject: 'User',
    });
  },

  /**
   * Mint an invite, and mail it if this deployment can.
   *
   * 201. 400 `detail: 'email'` means an account already exists for that
   * address — refused before the token is minted rather than after it is spent,
   * so the invitee never gets a link that dies on `users_email_unique`.
   */
  async createInvite(email: string, role: 'owner' | 'writer'): Promise<MintedInvite> {
    return await apiFetch<MintedInvite>('/invites', {
      method: 'POST',
      body: { email, role },
    });
  },

  /**
   * Outstanding invites; `history` opts in the accepted and expired buckets.
   *
   * The default is the short list an owner acts on. An unknown `include` member
   * is a 400 rather than a silently ignored word, so the two values below are
   * spelled by this module and never by a caller.
   */
  async listInvites(history = false, signal?: AbortSignal): Promise<TeamInvite[]> {
    const res = await apiFetch<{ items: TeamInvite[] }>('/invites', {
      query: history ? { include: 'accepted,expired' } : undefined,
      signal,
    });
    return res.items;
  },

  async revokeInvite(id: string): Promise<void> {
    await apiFetch<{ ok: true }>(`/invites/${seg(id)}`, {
      method: 'DELETE',
      id,
      subject: 'Invite',
    });
  },
};

export type TeamApi = typeof teamApi;
