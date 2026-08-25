import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CloudOff, HardDrive, Lock } from 'lucide-react';
import { api } from '../data/api';
import { cachePost, cachedPost, evictPost, writeOverlay } from '../data/cache';
import { db, type CachedPost, type LocalPost, type PendingWrite } from '../data/db';
import { isValidDoc } from '../data/doc';
import { ApiError, ForbiddenError } from '../data/errors';
import { download } from '../data/backup';
import { resolvePending, takePending } from '../data/pending';
import { whenReplayed } from '../data/session';
import { syncPost, syncRevisions, type SyncPostResult } from '../data/sync';
import { DocRenderer } from './DocRenderer';
import { useSession } from './RequireAuth';
import type { AuthUser, DocNode, Post } from '../data/types';
import '../routes/auth.css';

/**
 * What may be rendered for one post id, and in WHICH ORDER the question is
 * asked (plan §3).
 *
 * The order is the whole finding, not a detail of it. Store membership is
 * decided before any network verdict, because an un-migrated post has no
 * server row at all: ask the server first and it answers 404, the "gone" arm
 * fires, and the frozen editor renders *"This post no longer exists — it may
 * have been permanently deleted from this browser"* over the writer's entire
 * pre-backend library. **A 404 for an id the server was never given is not
 * evidence that anything was destroyed.**
 *
 *   1. in `localPosts` with `migratedAt == null` → "on this device only". No
 *      fetch is made and no network state can change the answer.
 *   2. an `unresolved` or `blocked` pending row for this id AND THIS USER →
 *      the resolution screen.
 *   3. the post exists and was written by someone else → read-only (F14).
 *   4. a full cached row → the child.
 *   5. `syncPost` said `gone` → the child, which renders its own deletion
 *      screen — correctly, because the server was asked about an id it had
 *      once issued.
 *   6. offline with no cached full row → "can't load this post", never the
 *      deletion message.
 *
 * 1–3 are decided from local state alone; 4–6 are the three possible outcomes
 * of `syncPost`, so the arms are exhaustive and mutually exclusive.
 *
 * And nothing is released until `replayPending` has settled. Otherwise the
 * editor opens on the server's version of a post while the writer's newer
 * words sit in a `pending` row nothing has looked at yet.
 */

type Gate =
  | { arm: 'waiting' }
  | { arm: 'local-only'; post: LocalPost }
  | { arm: 'resolve'; row: PendingWrite }
  | { arm: 'readonly'; post: CachedPost }
  | { arm: 'child' }
  | { arm: 'offline' }
  | { arm: 'forbidden' };

export function PostGate({
  mode,
  children,
}: {
  /**
   * `/edit/:id` or `/read/:id`. Only two things depend on it: the read-only
   * arm, and whether revision history is worth fetching.
   */
  mode: 'edit' | 'read';
  children: ReactNode;
}) {
  const { id = '' } = useParams();
  const session = useSession();
  const user = session.status === 'unknown' ? null : session.user;
  const offline = session.status === 'offline';
  const [gate, setGate] = useState<Gate>({ arm: 'waiting' });
  /** Bumped by the resolution screen so the arms are re-asked after a choice. */
  const [attempt, setAttempt] = useState(0);
  const again = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!user || !id) return;
    let cancelled = false;
    const settle = (next: Gate) => {
      if (!cancelled) setGate(next);
    };

    void (async () => {
      setGate({ arm: 'waiting' });
      await whenReplayed();
      if (cancelled) return;

      // ---- 1. store membership, decided before anything is fetched --------
      const local = await db.localPosts.get(id);
      if (cancelled) return;
      if (local && local.migratedAt == null) {
        return settle({ arm: 'local-only', post: local });
      }

      // ---- 2. a row only a human can end, for this id AND THIS USER -------
      /*
       * Scoped to the user as hard as the store is. An id-only lookup here
       * would render one writer's unsaved draft to whoever opens that post
       * next — the disclosure the `[postId+ownerUserId]` primary key exists to
       * make impossible, given back one layer up.
       */
      const pending = await takePending(id, user.id);
      if (cancelled) return;
      if (pending && pending.state !== 'queued') {
        return settle({ arm: 'resolve', row: pending });
      }

      // ---- 4/5/6. the three outcomes of asking the server -----------------
      let verdict: SyncPostResult;
      if (offline) {
        /*
         * No request at all. `session.ts` already found out that this device
         * has no route to the server, and a second failing fetch would only
         * delay the screen by a timeout.
         */
        verdict = 'offline';
      } else {
        try {
          verdict = await syncPost(user.id, id);
        } catch (err) {
          if (cancelled) return;
          if (err instanceof ForbiddenError) return settle({ arm: 'forbidden' });
          /*
           * A 401 is not this component's to report: `api.ts` has already
           * announced `auth-expired`, and `RequireAuth` is about to render the
           * re-auth prompt over whatever is here. Falling through as `offline`
           * means the cached row — if there is one — still renders underneath
           * it, which is the behaviour I3 is built around.
           */
          if (err instanceof ApiError && err.status === 401) verdict = 'offline';
          else throw err;
        }
      }
      if (cancelled) return;

      // Read AFTER the sync, so this is the fresh row rather than the one the
      // navigation started with.
      const cached = await cachedPost(user.id, id);
      if (cancelled) return;

      if (cached) {
        // ---- 3. someone else's post ---------------------------------------
        if (isForeign(cached, user) && mode === 'edit') {
          /*
           * Reads are universal and writes are author-or-owner
           * (`server/middleware/authorize.ts`), so the read route is left
           * alone — refusing to show a colleague's post would be a permission
           * the server does not have. It is the EDITOR that has to be stopped:
           * without this a writer opens a colleague's post from the dashboard,
           * types into it, and every save 403s forever (F14).
           */
          return settle({ arm: 'readonly', post: cached });
        }
        // ---- 4. a complete document -----------------------------------------
        if (mode === 'edit' && verdict === 'ok') {
          /*
           * Deliberately NOT awaited. The frozen `RevisionPanel` live-queries
           * `db.revisions`, so history can arrive after the editor does; making
           * the writer wait on ~30 small GETs for a panel they may never open
           * would be the cost of the feature without the feature.
           */
          void syncRevisions(user.id, id);
        }
        return settle({ arm: 'child' });
      }

      // ---- 5. the server was asked, and the post is gone ------------------
      // The row is already evicted (`syncPost`), so the child's own deletion
      // screen is what renders — and it is telling the truth this time.
      if (verdict === 'gone') return settle({ arm: 'child' });

      // ---- 6. offline, and nothing cached to show -------------------------
      if (verdict === 'offline') return settle({ arm: 'offline' });

      /*
       * `ok` with nothing cached cannot happen — `syncPost` caches what it
       * fetched — but if it ever did, the child is the honest answer: it will
       * say the post is missing, which is at least about the right subject.
       */
      return settle({ arm: 'child' });
    })();

    return () => {
      cancelled = true;
    };
  }, [id, user, offline, mode, attempt]);

  if (!user || gate.arm === 'waiting') {
    /*
     * Nothing rather than a skeleton. The child draws its own loading state
     * (`Editor.tsx:343`, `Reader.tsx`), and stacking a second one under it made
     * a fast open flash two different placeholders.
     */
    return null;
  }

  if (gate.arm === 'local-only') return <LocalOnly post={gate.post} />;
  if (gate.arm === 'resolve') {
    return <Resolution row={gate.row} user={user} onResolved={again} />;
  }
  if (gate.arm === 'readonly') return <ReadOnly post={gate.post} />;
  if (gate.arm === 'offline') return <OfflinePost onRetry={again} />;
  if (gate.arm === 'forbidden') return <Forbidden />;
  return <>{children}</>;
}

function isForeign(post: Post, user: AuthUser): boolean {
  return post.authorId !== user.id && user.role !== 'owner';
}

// ------------------------------------------------------------------ screens

/** Arm 1. Written here before this browser had an account to write it to. */
function LocalOnly({ post }: { post: LocalPost }) {
  return (
    <div className="gate">
      <div className="gate__card empty">
        <HardDrive className="ui-ic gate__mark" aria-hidden="true" />
        <h1 className="empty__title">{post.title || 'Untitled'} is on this device only</h1>
        <p className="empty__body">
          You wrote this before this browser was connected to the blog, so the
          server has never seen it. It has not been lost and nothing has been
          deleted — it simply lives here until you upload it.
        </p>
        {/* v2 port: kept verbatim — v2 has no /migrate screen (the catch-all
            lands on Home). This arm only fires for a pre-backend local-only
            post, which nothing in v2 links to. */}
        <Link className="btn btn--primary" to="/migrate">
          Review and upload
        </Link>
        {/* v2 port: the posts list lives at /content/posts (v1: /dashboard). */}
        <Link className="btn btn--ghost" to="/content/posts">
          Back to your posts
        </Link>
      </div>
    </div>
  );
}

/** Arm 3. */
function ReadOnly({ post }: { post: CachedPost }) {
  return (
    <div className="gate">
      <div className="gate__card empty">
        <Lock className="ui-ic gate__mark" aria-hidden="true" />
        <h1 className="empty__title">{post.title || 'Untitled'}</h1>
        <p className="empty__body">
          {post.authorName || 'Someone else'} wrote this one. You can read it,
          but only its author or an owner can edit it — so opening it here would
          be an editor whose every save is refused.
        </p>
        {/* v2 port: v2 has no /read/:id reader; the post's own v2 screen is the
            closest readable surface. */}
        <Link className="btn btn--primary" to={`/content/posts/${post.id}`}>
          Read it
        </Link>
        {/* v2 port: the posts list lives at /content/posts (v1: /dashboard). */}
        <Link className="btn btn--ghost" to="/content/posts">
          Back to your posts
        </Link>
      </div>
    </div>
  );
}

/** Arm 6. NEVER the deletion message — nothing here says anything was lost. */
function OfflinePost({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="gate">
      <div className="gate__card empty">
        <CloudOff className="ui-ic gate__mark" aria-hidden="true" />
        <h1 className="empty__title">Can&rsquo;t load this post — you&rsquo;re offline</h1>
        <p className="empty__body">
          This device has no copy of it yet and the server can&rsquo;t be
          reached. Nothing has been deleted; the post is waiting on the
          connection.
        </p>
        <button className="btn btn--primary" onClick={onRetry}>
          Try again
        </button>
        {/* v2 port: the posts list lives at /content/posts (v1: /dashboard). */}
        <Link className="btn btn--ghost" to="/content/posts">
          Back to your posts
        </Link>
      </div>
    </div>
  );
}

function Forbidden() {
  return (
    <div className="gate">
      <div className="gate__card empty">
        <Lock className="ui-ic gate__mark" aria-hidden="true" />
        <h1 className="empty__title">You don&rsquo;t have access to this post</h1>
        <p className="empty__body">
          The server refused to hand it over. If you think that is wrong, ask an
          owner of this publication.
        </p>
        {/* v2 port: the posts list lives at /content/posts (v1: /dashboard). */}
        <Link className="btn btn--primary" to="/content/posts">
          Back to your posts
        </Link>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- resolution

/**
 * Arm 2, and the two choices are the only things that may delete a terminal
 * `pending` row.
 *
 * "Mine" is the unsent patch. "Theirs" is fetched here rather than read from
 * the cache, because which one the cache holds depends on why the row is
 * terminal: after a 409 the replay cached the server's post, but after a
 * permanent 4xx the cached row is still the writer's own overlay. Fetching
 * makes the screen mean one thing in both cases — and it is what makes "Load
 * theirs" safe, because the server's version is in hand before anything is
 * deleted.
 */
function Resolution({
  row,
  user,
  onResolved,
}: {
  row: PendingWrite;
  user: AuthUser;
  onResolved: () => void;
}) {
  const [theirs, setTheirs] = useState<Post | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .getPost(row.postId)
      .then((post) => {
        if (!cancelled) setTheirs(post);
      })
      .catch(() => {
        if (!cancelled) setFetchFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [row.postId]);

  const mine = row.patch.content;

  return (
    <div className="gate">
      <div className="gate__card gate__card--wide">
        <h1 className="gate__title">
          {row.state === 'blocked'
            ? 'This change could not be saved'
            : 'Two versions of this post exist'}
        </h1>
        <p className="gate__body">
          {row.state === 'blocked' ? (
            <>
              The server refused this change permanently, so retrying cannot
              help. Your text is here and has not been touched — keep it, export
              it, or discard it and go back to the saved version.
            </>
          ) : (
            <>
              Your changes were written while this post was being saved from
              somewhere else, so they were never sent. Nothing has been thrown
              away: pick which version to carry forward, and the other stays in
              the post&rsquo;s history on the server.
            </>
          )}
        </p>

        {row.state === 'blocked' && (row.detail || row.path) && (
          <p className="gate__reason">
            <span className="label">Why</span>
            {row.path ? `${row.path}: ` : ''}
            {row.detail ?? 'The server did not say.'}
          </p>
        )}

        <div className="gate__versions">
          <section className="gate__version" aria-label="Your version">
            <h2 className="gate__vtitle">Yours, unsent</h2>
            <p className="gate__vmeta">{whenLabel(row.updatedAt)}</p>
            <div className="prose gate__doc">
              {isValidDoc(mine) ? (
                <DocRenderer doc={mine as DocNode} />
              ) : (
                <p className="gate__vmeta">
                  This change was to the title or settings rather than the text.
                </p>
              )}
            </div>
          </section>

          <section className="gate__version" aria-label="The saved version">
            <h2 className="gate__vtitle">Saved on the server</h2>
            <p className="gate__vmeta">
              {theirs
                ? `Revision ${theirs.revision} · ${whenLabel(theirs.updatedAt)}`
                : fetchFailed
                  ? 'Could not be loaded'
                  : 'Loading…'}
            </p>
            <div className="prose gate__doc">
              {theirs && isValidDoc(theirs.content) ? (
                <DocRenderer doc={theirs.content} />
              ) : (
                <p className="gate__vmeta">
                  {fetchFailed
                    ? 'The server could not be reached, so this version cannot be shown — and cannot be chosen.'
                    : ''}
                </p>
              )}
            </div>
          </section>
        </div>

        <div className="gate__actions">
          <button
            className="btn btn--primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await keepMine(user.id, row);
              onResolved();
            }}
          >
            Keep mine
          </button>
          <button
            className="btn btn--outline"
            // Refusing rather than trying and failing: without the server's
            // version in hand, "load theirs" would delete the writer's only
            // copy and put nothing in its place.
            disabled={busy || !theirs}
            onClick={async () => {
              if (!theirs) return;
              setBusy(true);
              await loadTheirs(user.id, row, theirs);
              onResolved();
            }}
          >
            Load theirs
          </button>
          {row.state === 'blocked' && (
            <button className="btn btn--ghost" onClick={() => exportPending(row)}>
              Export mine to a file
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Overlay the unsent patch onto whatever the server currently holds, then let
 * the row go.
 *
 * `writeOverlay` keeps the CACHED row's revision, which after a 409 replay is
 * the server's current one — so the editor opens on the writer's text based on
 * the version that beat it, and the next save wins outright instead of 409ing
 * against the same stale number forever. The version being replaced is still in
 * the post's server-side history, so choosing here loses nothing.
 *
 * Exported because `#/recover` offers the same two choices for the same rows,
 * and two implementations of "keep mine" would eventually disagree.
 */
export async function keepMine(userId: string, row: PendingWrite): Promise<void> {
  await writeOverlay(userId, row.postId, row.patch);
  await resolvePending(row.postId, userId);
}

/**
 * Take the server's version and drop the unsent patch.
 *
 * `theirs` must be a post the caller has actually fetched, hence the argument:
 * for a `blocked` row the cached row IS the writer's overlay, and `cachePost`
 * alone cannot replace it — `reconcile` refuses an equal revision over a
 * `pendingAt` row, which is exactly the protection that keeps a background
 * revalidation from erasing recovered work. Evicting first is how this one
 * caller, acting on an explicit human choice, is allowed past it.
 */
export async function loadTheirs(
  userId: string,
  row: PendingWrite,
  theirs: Post,
): Promise<void> {
  await evictPost(row.postId);
  await cachePost(userId, theirs);
  await resolvePending(row.postId, userId);
}

/**
 * A `blocked` patch that can never be replayed is still the writer's words.
 * This is the escape hatch that makes "you cannot save this" survivable: the
 * whole patch, as JSON, on their disk.
 */
export function exportPending(row: PendingWrite): void {
  download(
    `unsent-${row.postId}-${new Date(row.updatedAt).toISOString().slice(0, 10)}.json`,
    JSON.stringify({ postId: row.postId, savedAt: row.updatedAt, patch: row.patch }, null, 2),
    'application/json',
  );
}

function whenLabel(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
