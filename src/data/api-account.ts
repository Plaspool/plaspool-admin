/**
 * The signed-in account's own settings — the client half of HANDOFF §2 A1.
 *
 * A SEPARATE MODULE RATHER THAN A BLOCK IN `api.ts`, for exactly the reason
 * `api-categories.ts` gives: four agents were appending to that file in the same
 * hour, and a file four concurrent writers append to is a file that loses a
 * block. Nothing about the convention changes — `apiFetch` below is `api.ts`'s
 * own request function, so `credentials: 'include'`, the §8 status table and the
 * error classes in `./errors` are all still the shared ones.
 *
 * Every path, status and body shape here was read from `server/routes/auth.ts`
 * rather than remembered, and the one that is easy to get catastrophically
 * wrong — what a mistyped current password answers with — carries a note saying
 * what goes wrong.
 */
import { apiFetch } from './api';
import type { AuthUser } from './types';

/**
 * One row of `GET /api/auth/sessions`.
 *
 * `userAgent` IS THE RAW HEADER AND IS NEVER PARSED, on either side. The
 * repo function says so and the screen honours it: a user-agent string is a
 * self-declared free-text field, and a client-side "Chrome on macOS" guess is a
 * confident sentence about a value nobody validated. Shown whole, it is at
 * worst ugly; summarised, it is at worst wrong about which device someone is
 * about to sign out.
 */
export interface SessionSummary {
  id: string;
  createdAt: number;
  /** Written on EVERY resolve, not only on refresh — so "last used" is honest. */
  lastSeenAt: number;
  expiresAt: number;
  userAgent: string | null;
  /** The session making this very request. Exactly one row carries it. */
  current: boolean;
}

const seg = (value: string): string => encodeURIComponent(value);

export const accountApi = {
  /**
   * Rename yourself.
   *
   * THE NEW NAME IS LIVE ON EVERY POST THE MOMENT THIS RESOLVES, with no
   * backfill and nothing to re-fetch: `posts` has no `author_name` column, and
   * the four queries that produce one each read `u.display_name` through a live
   * JOIN (`server/routes/auth.ts` documents which). The caller's only remaining
   * job is the session store, which is holding a now-stale copy of this user.
   *
   * 400 `detail: 'displayName'` for blank, whitespace-only, or over 200 chars.
   */
  async updateDisplayName(displayName: string): Promise<AuthUser> {
    const res = await apiFetch<{ user: AuthUser }>('/auth/me', {
      method: 'PATCH',
      body: { displayName },
    });
    return res.user;
  },

  /**
   * The caller's own live sessions, newest use first. Expired rows are already
   * excluded server-side, so nothing here needs filtering by a clock this side
   * — which would disagree with the server's about any row near expiry.
   */
  async listSessions(signal?: AbortSignal): Promise<SessionSummary[]> {
    return (await apiFetch<{ items: SessionSummary[] }>('/auth/sessions', { signal })).items;
  },

  /**
   * Revoke one of your own. Somebody else's session id and an id that never
   * existed are the same 404, deliberately — the route refuses to be a probe
   * for whether an id belongs to somebody.
   */
  async revokeSession(id: string): Promise<void> {
    await apiFetch<{ ok: true }>(`/auth/sessions/${seg(id)}`, {
      method: 'DELETE',
      id,
      subject: 'Session',
    });
  },
};

export type AccountApi = typeof accountApi;
