import {
  ApiError,
  AuthExpiredError,
  FeaturedConflictError,
  ForbiddenError,
  NotFeaturableError,
  NotFoundError,
  OfflineError,
  PreconditionFailedError,
  StaleWriteError,
} from './errors';
import type { NotFeaturableReason } from './errors';
import type {
  AuthUser,
  Bundle,
  FeaturedItem,
  ListPost,
  Post,
  PostPatch,
  Revision,
  RevisionMeta,
  SaveOptions,
  SortKey,
  StatusFilter,
} from './types';

/**
 * The one place `src/` talks to the server.
 *
 * Every path, method, status and body shape below is copied from
 * `server/routes/*.ts` rather than remembered, and the ones that are easy to
 * get subtly wrong carry a note saying what goes wrong. The error mapping is
 * spec §8's table (`server/middleware/errors.ts`) turned into the classes in
 * `./errors`.
 *
 * Nothing here touches Dexie, and nothing here retries. Retry policy, caching
 * and the pending-write machinery live above this module (plan §2), so the
 * whole of what this file decides is: which request, and which error class.
 */

const API_BASE = '/api';

// ------------------------------------------------------------ session expiry

/**
 * Announced ONCE PER BURST, not once per failed request.
 *
 * A dashboard mount fires several requests at once — the list, the post, its
 * revisions, a replay — and an expired cookie 401s all of them within a few
 * milliseconds. One event per response is one re-auth flow per response: a
 * modal that reopens as fast as it is dismissed, or several stacked on top of
 * each other, depending on how the listener is written. The suppression window
 * makes the burst a single announcement.
 *
 * It does NOT suppress the errors themselves. Every caller still gets its own
 * `AuthExpiredError`, because each of them has its own request to decide about.
 */
export const AUTH_EXPIRED_EVENT = 'auth-expired';
const AUTH_EXPIRED_SUPPRESS_MS = 1000;

let lastAuthExpiredAt = 0;

function announceAuthExpired(): void {
  const now = Date.now();
  if (lastAuthExpiredAt !== 0 && now - lastAuthExpiredAt < AUTH_EXPIRED_SUPPRESS_MS) return;
  lastAuthExpiredAt = now;
  /*
   * The client suites run under `environment: 'node'` (vitest.config.ts), where
   * there is no `window`. Without this guard a 401 raised in any node-side test
   * is a ReferenceError that replaces the `AuthExpiredError` the test is about,
   * which is a confusing failure a long way from its cause.
   */
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
}

// ------------------------------------------------------------------- request

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Serialised as JSON, with the `content-type` the server's `readJson` demands. */
  body?: unknown;
  /** Empty and nullish values are omitted, because every query schema is `.strict()`. */
  query?: Record<string, string | number | null | undefined>;
  /** The resource id to name in a 404's message. See `NotFoundError`. */
  id?: string;
  /** What that id IS. 'Post' unless the route is about something else. */
  subject?: string;
  signal?: AbortSignal;
}

function url(path: string, query: RequestOptions['query']): string {
  if (!query) return `${API_BASE}${path}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${API_BASE}${path}?${qs}` : `${API_BASE}${path}`;
}

/** A path segment that cannot escape its position, whatever the id contains. */
const seg = (value: string): string => encodeURIComponent(value);

function retryAfterFrom(res: Response, body: Record<string, unknown>): number | undefined {
  if (typeof body.retryAfter === 'number') return body.retryAfter;
  // The server sets the standard header as well as the body; read it as the
  // fallback so a 429 from anything in front of the app is still honoured.
  const header = res.headers?.get?.('retry-after');
  const parsed = header == null ? NaN : Number(header);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Spec §8's table, in the order the statuses are listed there.
 *
 * The rows that are not mechanical are 404 and the two 409s, and each has its
 * note on the class it builds in `./errors`.
 */
function toError(res: Response, body: unknown, opts: RequestOptions): ApiError {
  const rec = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const code = typeof rec.error === 'string' ? rec.error : `http_${res.status}`;
  const requestId = typeof rec.requestId === 'string' ? rec.requestId : undefined;
  /*
   * `detail` on a 400 and `path` on a 422 — one field for one role. A 422's
   * `reason` is deliberately left in `body`: plan §2.3's `blocked` rows quote
   * both, and inventing a second named field for a value only that screen reads
   * would spread the §8 table across two shapes.
   */
  const detail =
    typeof rec.detail === 'string'
      ? rec.detail
      : typeof rec.path === 'string'
        ? rec.path
        : undefined;
  const init = { body, requestId, detail };

  if (res.status === 401) return new AuthExpiredError(init);
  if (res.status === 403) return new ForbiddenError(init);
  if (res.status === 404) return new NotFoundError(opts.id ?? '', opts.subject ?? 'Post', init);

  if (res.status === 422 && code === 'not_featurable') {
    // Beside `invalid_document` on the same status, and never collapsed into
    // it: one is about a document the writer typed, the other about a post's
    // lifecycle state, and the sentences they produce share nothing.
    return new NotFeaturableError(rec.reason as NotFeaturableReason, init);
  }

  if (res.status === 409) {
    /*
     * THE RAIL'S TWO REFUSALS, CHECKED BEFORE THE POST'S TWO. All four share
     * this status, and these carry `items` where those carry `post` — mapped to
     * a bare `ApiError` the list the contract requires would be unreachable
     * without a cast at every call site.
     */
    if (code === 'featured_full' || code === 'featured_stale') {
      return new FeaturedConflictError(
        code,
        Array.isArray(rec.items) ? (rec.items as FeaturedItem[]) : [],
        Number(rec.limit),
        init,
      );
    }
    /*
     * TWO DIFFERENT ERRORS SHARE THIS STATUS AND THEY ARE NEVER THE SAME CLASS.
     * `precondition_failed` is "the post is already published"; `stale_write` is
     * "someone else got there first". Collapsed, the refusal reaches the banner
     * with `expected === actual`, which it cannot render — the server split them
     * for that reason (`server/repo/errors.ts`) and the split has to survive the
     * wire.
     */
    if (code === 'precondition_failed') {
      /*
       * `post` is present and complete. `server/repo/posts.ts` raises this only
       * from a read that found the row, and it carries `getPost`'s result —
       * `POST_COLUMNS` through `rowToPost`, `content` included
       * (`server/repo/mapping.ts`).
       */
      return new PreconditionFailedError(String(rec.operation ?? ''), rec.post as Post, init);
    }
    if (code === 'stale_write') {
      return new StaleWriteError(
        Number(rec.expected),
        Number(rec.actual),
        // Nullable on this one only: the row can be destroyed between the
        // losing CAS and the re-read, which is what the server's own type says.
        (rec.post as Post | undefined) ?? null,
        init,
      );
    }
  }

  return new ApiError({
    status: res.status,
    code,
    detail,
    body,
    requestId,
    retryAfter: res.status === 429 ? retryAfterFrom(res, rec) : undefined,
  });
}

/**
 * One request, one parsed body, one error class.
 *
 * `credentials: 'include'` IS ON EVERY REQUEST AND IS NOT OPTIONAL. The session
 * is a `__Host-` cookie; without it the browser sends nothing, every route
 * answers 401, and the app looks like it has been logged out while the cookie
 * is sitting in the jar.
 */
export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const hasBody = opts.body !== undefined;
  let res: Response;
  try {
    res = await fetch(url(path, opts.query), {
      method: opts.method ?? 'GET',
      credentials: 'include',
      headers: hasBody ? { 'content-type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch {
    /*
     * `fetch` rejects for DNS, a refused connection, a dropped link and CORS —
     * i.e. every case where the request got no answer at all. It is NOT a 5xx:
     * plan §2.2 I3 clears the cache on a 401 at boot and never on a network
     * failure, so a dropped connection reported as an authoritative refusal
     * would delete a writer's whole offline library.
     */
    throw new OfflineError();
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    // A non-JSON body is not a reason to lose the status. A proxy's HTML 502
    // still has to become a transient 502 rather than a parse crash.
    body = undefined;
  }

  if (!res.ok) {
    if (res.status === 401) announceAuthExpired();
    throw toError(res, body, opts);
  }
  return body as T;
}

// ------------------------------------------------------------------ queries

export interface ListPostsQuery {
  status?: StatusFilter;
  sort?: SortKey;
  search?: string;
  category?: string;
  tag?: string;
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface InviteSummary {
  id: string;
  email: string;
  role: 'owner' | 'writer';
  createdAt: number;
  expiresAt: number;
  invitedBy: string;
}

/** What `POST /api/invites` answers with. The token exists only inside `url`. */
export interface CreatedInvite {
  id: string;
  email: string;
  role: 'owner' | 'writer';
  expiresAt: number;
  url: string;
}

/**
 * A slot from `POST /api/images`. `uploadUrl` and `headers` are both inputs to
 * the signature, so both have to be replayed exactly or R2 answers 403.
 */
export interface ImageSlot {
  id: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresIn: number;
}

export interface ImageRecord {
  id: string;
  contentType: string;
  width: number | null;
  height: number | null;
  byteSize: number;
  createdAt: number;
  committedAt: number | null;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  /** What the server did NOT restore, counted rather than dropped. */
  ignored: { revisions: number; images: number };
}

const LIFECYCLE = ['publish', 'unpublish', 'archive', 'unarchive', 'trash', 'restore'] as const;

export type LifecycleOp = (typeof LIFECYCLE)[number];

async function transition(id: string, op: LifecycleOp): Promise<Post> {
  /*
   * NO `baseRevision`, because the routes take none: they re-read, re-derive
   * and re-CAS server-side. Each answers with the NEW post so the editor can
   * adopt the bumped revision without a second request — without that the next
   * autosave carries a base the server has already passed and 409s against
   * itself.
   */
  const res = await apiFetch<{ post: Post }>(`/posts/${seg(id)}/${op}`, { method: 'POST', id });
  return res.post;
}

export const api = {
  // ------------------------------------------------------------------ auth
  async me(): Promise<AuthUser> {
    return (await apiFetch<{ user: AuthUser }>('/auth/me')).user;
  },

  /**
   * The password step. Since migration 0700 a protected account answers with a
   * CHALLENGE instead of a session: the ticket proves the password verified,
   * and the six-digit code in the account's inbox is the second half —
   * `loginCode` below trades the pair for the session.
   */
  async login(
    email: string,
    password: string,
  ): Promise<
    | { kind: 'session'; user: AuthUser }
    | { kind: 'code'; ticket: string; expiresAt: number }
  > {
    const res = await apiFetch<
      { user: AuthUser } | { twoFactor: { ticket: string; expiresAt: number } }
    >('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    if ('twoFactor' in res) {
      return { kind: 'code', ticket: res.twoFactor.ticket, expiresAt: res.twoFactor.expiresAt };
    }
    return { kind: 'session', user: res.user };
  },

  /** The code step. 401 covers a wrong code, an expired challenge and a spent
   * one alike — the server refuses to split them (enumeration). */
  async loginCode(ticket: string, code: string): Promise<AuthUser> {
    const res = await apiFetch<{ user: AuthUser }>('/auth/login/code', {
      method: 'POST',
      body: { ticket, code },
    });
    return res.user;
  },

  /** Always 202 — the server never says whether the ticket was live. */
  async resendLoginCode(ticket: string): Promise<void> {
    await apiFetch<{ sent: true }>('/auth/login/resend', {
      method: 'POST',
      body: { ticket },
    });
  },

  /*
   * Deliberately NOT behind a session check, on either side. A logout that
   * fails for an expired session leaves the cookie in the browser, which is the
   * one outcome logout exists to prevent (`server/routes/auth.ts`).
   */
  async logout(): Promise<void> {
    await apiFetch<{ ok: true }>('/auth/logout', { method: 'POST' });
  },

  /** 201. The response also sets the session cookie, so this logs you in. */
  async acceptInvite(a: {
    token: string;
    password: string;
    displayName: string;
  }): Promise<AuthUser> {
    return (await apiFetch<{ user: AuthUser }>('/auth/accept-invite', { method: 'POST', body: a }))
      .user;
  },

  /**
   * 202 `{ sent: true }` FOR EVERY ADDRESS, known or not.
   *
   * The route answers identically either way on purpose (`server/routes/auth.ts`),
   * for the same reason `login` refuses to say which half was wrong: this is an
   * invite-only instance and knowing which addresses have accounts is most of
   * what an attacker wants. There is deliberately nothing in the return value
   * for a caller to branch on — a boolean here would be an enumeration oracle
   * rebuilt one layer up.
   *
   * 501 `not_implemented` is the exception and is not about this address: the
   * deployment has no mailer configured, which the route checks BEFORE the
   * lookup so that it fails the same way for everybody.
   */
  async forgotPassword(email: string): Promise<void> {
    await apiFetch<{ sent: true }>('/auth/forgot', { method: 'POST', body: { email } });
  },

  /**
   * 200 `{ ok: true }`, AND NO SESSION COOKIE — resetting does not sign you in.
   *
   * The route sweeps every session the account holds and deliberately hands
   * back nothing, so that a token read out of a mailbox cannot become a live
   * session without the new password being typed. Callers must send the writer
   * to sign in rather than adopting a user here; there is none to adopt.
   *
   * 400 `detail: 'token'` is the expected failure (expired, already used, or
   * simply wrong); 400 `detail: 'password'` mirrors the length rule.
   */
  async resetPassword(token: string, password: string): Promise<void> {
    await apiFetch<{ ok: true }>('/auth/reset', { method: 'POST', body: { token, password } });
  },

  // --------------------------------------------------------------- invites
  async createInvite(email: string, role: 'owner' | 'writer' = 'writer'): Promise<CreatedInvite> {
    const res = await apiFetch<{ invite: CreatedInvite }>('/invites', {
      method: 'POST',
      body: { email, role },
    });
    return res.invite;
  },

  async listInvites(): Promise<InviteSummary[]> {
    return (await apiFetch<{ items: InviteSummary[] }>('/invites')).items;
  },

  async revokeInvite(id: string): Promise<void> {
    await apiFetch<{ ok: true }>(`/invites/${seg(id)}`, { method: 'DELETE', id, subject: 'Invite' });
  },

  // ----------------------------------------------------------------- posts
  /** A page of `ListPost` — NO `content`, by construction on the server side. */
  async listPosts(query: ListPostsQuery = {}): Promise<Page<ListPost>> {
    return apiFetch<Page<ListPost>>('/posts', { query: { ...query } });
  },

  async getPost(id: string): Promise<Post> {
    return (await apiFetch<{ post: Post }>(`/posts/${seg(id)}`, { id })).post;
  },

  /** 201, not 200. */
  async createPost(patch: PostPatch = {}): Promise<Post> {
    const res = await apiFetch<{ post: Post }>('/posts', { method: 'POST', body: patch });
    return res.post;
  },

  /**
   * The CAS write. `baseRevision` is what makes a second tab a 409 instead of a
   * silent overwrite, and `kind` is restricted to the two a client may author —
   * `publish` and `status` snapshots are written by the lifecycle routes and
   * are never pruned, so a client naming one would forge history that survives
   * every sweep.
   */
  async savePost(id: string, patch: PostPatch, opts: SaveOptions = {}): Promise<Post> {
    const res = await apiFetch<{ post: Post }>(`/posts/${seg(id)}`, {
      method: 'PATCH',
      id,
      body: {
        patch,
        baseRevision: opts.baseRevision,
        kind: opts.kind === 'manual' ? 'manual' : 'autosave',
      },
    });
    return res.post;
  },

  publishPost: (id: string) => transition(id, 'publish'),
  unpublishPost: (id: string) => transition(id, 'unpublish'),
  archivePost: (id: string) => transition(id, 'archive'),
  unarchivePost: (id: string) => transition(id, 'unarchive'),
  trashPost: (id: string) => transition(id, 'trash'),
  restorePost: (id: string) => transition(id, 'restore'),

  /** 201, not 200. */
  async duplicatePost(id: string): Promise<Post> {
    const res = await apiFetch<{ post: Post }>(`/posts/${seg(id)}/duplicate`, {
      method: 'POST',
      id,
    });
    return res.post;
  },

  /** Owner-only (F7). A writer gets a 403 here and must not be stranded by it. */
  async destroyPost(id: string): Promise<void> {
    await apiFetch<{ ok: true }>(`/posts/${seg(id)}`, { method: 'DELETE', id });
  },

  async sweepBlankDrafts(exceptId?: string): Promise<number> {
    const res = await apiFetch<{ swept: number }>('/posts/sweep-blank', {
      method: 'POST',
      body: { exceptId },
    });
    return res.swept;
  },

  /** Owner-only. */
  async emptyTrash(): Promise<number> {
    return (await apiFetch<{ emptied: number }>('/trash/empty', { method: 'POST' })).emptied;
  },

  // ------------------------------------------------------------- revisions
  /** Metadata only — bodies come one at a time from `getRevision`. */
  async listRevisions(id: string, cursor?: string, limit?: number): Promise<Page<RevisionMeta>> {
    return apiFetch<Page<RevisionMeta>>(`/posts/${seg(id)}/revisions`, {
      id,
      query: { cursor, limit },
    });
  },

  async getRevision(revId: string): Promise<Revision> {
    const res = await apiFetch<{ revision: Revision }>(`/revisions/${seg(revId)}`, {
      id: revId,
      subject: 'Revision',
    });
    return res.revision;
  },

  /**
   * Restore-forward: the snapshot becomes a NEW revision.
   *
   * Unused by the frozen `RevisionPanel`, which restores through the autosave
   * queue and therefore restores forward anyway. Present because it is a route
   * and because the panel is frozen, not because anything calls it today.
   */
  async restoreRevision(id: string, revId: string): Promise<Post> {
    const res = await apiFetch<{ post: Post }>(
      `/posts/${seg(id)}/revisions/${seg(revId)}/restore`,
      { method: 'POST', id },
    );
    return res.post;
  },

  // ---------------------------------------------------------------- backup
  /** Owner-only, and rate-limited. Writers export through plan §8.1's rebuild. */
  async exportAll(): Promise<Bundle> {
    return apiFetch<Bundle>('/export');
  },

  /**
   * 5 per hour, and `limit()` runs BEFORE the body is parsed — so a body this
   * refuses still costs a slot (F8). Validate with `shared/bundle.ts` first.
   */
  async importBundle(bundle: unknown): Promise<ImportResult> {
    return apiFetch<ImportResult>('/import', { method: 'POST', body: bundle });
  },

  // ---------------------------------------------------------------- images
  async createImageSlot(a: {
    contentType: string;
    byteSize: number;
    checksum?: string | null;
  }): Promise<ImageSlot> {
    return apiFetch<ImageSlot>('/images', { method: 'POST', body: a });
  },

  async commitImage(id: string): Promise<ImageRecord> {
    const res = await apiFetch<{ image: ImageRecord }>(`/images/${seg(id)}/commit`, {
      method: 'POST',
      id,
      subject: 'Image',
    });
    return res.image;
  },

  /**
   * A URL, not a request. The route answers 302 to a signed URL with
   * `no-store`, so this belongs in an `<img>` src where the browser follows the
   * redirect and re-signs on every render — fetching it here would buy nothing
   * and lose the browser's own image handling.
   */
  imageUrl(id: string): string {
    return `${API_BASE}/images/${seg(id)}`;
  },

  /** Owner-only: it deletes bytes belonging to every writer. */
  async collectOrphanImages(dryRun = false): Promise<{ collected: number; swept: number }> {
    return apiFetch<{ collected: number; swept: number }>('/images/collect-orphans', {
      method: 'POST',
      query: { dryRun: dryRun ? '1' : undefined },
    });
  },

  // -------------------------------------------------------------- featured
  /*
   * THE CURATED RAIL, AND NONE OF IT IS QUEUED OFFLINE.
   *
   * Everything else about a post goes through `src/data/posts.ts`, which writes
   * to Dexie and leaves a `pending` row when the network refuses. Curation
   * deliberately does not, and the reason is the cap: "at most four featured" is
   * a global server invariant that cannot be evaluated against a local mirror,
   * so two tabs offline would each queue a feature and both believe they fit.
   * The 409 would then surface hours later with no editor open and nobody to
   * resolve it — which is the failure `pending` exists to prevent, reproduced.
   *
   * Curation is a deliberate, rare act. Offline the toggle is disabled and says
   * so, and nothing is lost.
   *
   * EVERY MUTATION ANSWERS WITH THE WHOLE RAIL, so a caller re-renders the
   * manager and the "n of 4" counter from the response — the same reason the
   * lifecycle routes each answer with the new post.
   */

  /** The rail in rank order. At most `MAX_FEATURED` items; never a document. */
  async listFeatured(): Promise<FeaturedItem[]> {
    return (await apiFetch<{ items: FeaturedItem[] }>('/featured')).items;
  },

  /**
   * Put a post on the rail. Owner-only; 422 `NotFeaturableError` while it is
   * not publicly visible, 409 `FeaturedConflictError` when the rail is full.
   *
   * `replace` names a post to take the slot OF, and the newcomer inherits its
   * RANK — which is what makes the swap land where the operator pointed instead
   * of at the end. Doing it as unfeature-then-feature would leave the live rail
   * three posts long in between, and would lose the position.
   */
  async featurePost(id: string, replace?: string): Promise<FeaturedItem[]> {
    const res = await apiFetch<{ items: FeaturedItem[] }>(`/posts/${seg(id)}/feature`, {
      method: 'POST',
      body: replace === undefined ? {} : { replace },
      id,
    });
    return res.items;
  },

  async unfeaturePost(id: string): Promise<FeaturedItem[]> {
    const res = await apiFetch<{ items: FeaturedItem[] }>(`/posts/${seg(id)}/unfeature`, {
      method: 'POST',
      body: {},
      id,
    });
    return res.items;
  },

  /**
   * The WHOLE order, never one row — invariant 4 of the storefront's contract.
   *
   * `ids` must be exactly what is featured now. Anything else is a 409
   * `featured_stale` carrying the truth, because a rail that moved between the
   * render and the drop cannot be partially reordered without dropping a post
   * nobody chose to remove.
   */
  async reorderFeatured(ids: string[]): Promise<FeaturedItem[]> {
    const res = await apiFetch<{ items: FeaturedItem[] }>('/featured', {
      method: 'PUT',
      body: { ids },
    });
    return res.items;
  },
};

export type Api = typeof api;
