import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { api } from '../data/api';
import { isValidDoc } from '../data/doc';
import { listPendingForReview } from '../data/pending';
import { exportPending, keepMine, loadTheirs } from '../components/PostGate';
import { useSession } from '../components/RequireAuth';
import { DocRenderer } from '../components/DocRenderer';
import type { PendingWrite } from '../data/db';
import type { DocNode, Post } from '../data/types';
import './auth.css';

/**
 * `#/recover` — every unsent write that a human has to end.
 *
 * `PostGate` already stops the writer at the post itself, which is where most
 * of these get resolved. This screen exists for the ones nobody navigates back
 * to: a `blocked` row for a post the writer has moved on from is otherwise a
 * paragraph that exists in exactly one place, on one machine, listed nowhere —
 * and the first `clearCache` takes it with the overlay.
 *
 * Scoped to the current user, like every other reader of `pending`. The rows
 * are keyed `[postId+ownerUserId]` and `listPendingForReview` filters on the
 * user, so a shared machine cannot show one writer's draft to the next (I4).
 */
export default function Recover() {
  const session = useSession();
  const user = session.status === 'unknown' ? null : session.user;
  const [rows, setRows] = useState<PendingWrite[] | null>(null);

  const reload = useCallback(async () => {
    if (!user) return;
    setRows(await listPendingForReview(user.id));
  }, [user]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!user) return null;

  return (
    <div className="recover">
      <header className="recover__bar">
        <Link className="btn btn--ghost btn--sm" to="/dashboard">
          <ChevronLeft className="ui-ic" aria-hidden="true" />
          Posts
        </Link>
        <span className="recover__barTitle">Unsent work</span>
        <span aria-hidden="true" />
      </header>

      <main className="recover__page">
        {rows === null ? null : rows.length === 0 ? (
          <div className="empty">
            <h1 className="empty__title">Nothing is waiting</h1>
            <p className="empty__body">
              Every change you have made has reached the server. Anything that
              fails later shows up here, and stays until you decide what happens
              to it.
            </p>
            <Link className="btn btn--primary" to="/dashboard">
              Back to your posts
            </Link>
          </div>
        ) : (
          <>
            <h1 className="recover__title">
              {rows.length === 1
                ? 'One change needs your decision'
                : `${rows.length} changes need your decision`}
            </h1>
            <p className="recover__lede">
              These were written on this device and never reached the server.
              They are the only copy, so nothing here is deleted until you
              choose.
            </p>
            {rows.map((row) => (
              <RecoverRow
                key={`${row.postId}:${row.ownerUserId}`}
                row={row}
                userId={user.id}
                onResolved={reload}
              />
            ))}
          </>
        )}
      </main>
    </div>
  );
}

function RecoverRow({
  row,
  userId,
  onResolved,
}: {
  row: PendingWrite;
  userId: string;
  onResolved: () => void;
}) {
  /**
   * The server's current version, fetched per row.
   *
   * The same reason as `PostGate`'s resolution screen: for an `unresolved` row
   * the cache holds the server's post, but for a `blocked` one it holds the
   * writer's own overlay, so reading the cache would label the writer's text
   * "saved on the server" half the time. It also has to be in hand before
   * "Load theirs" can be offered at all — that action deletes the only copy of
   * the patch, and it may not do so on a promise.
   */
  const [theirs, setTheirs] = useState<Post | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .getPost(row.postId)
      .then((post) => !cancelled && setTheirs(post))
      .catch(() => !cancelled && setUnreachable(true));
    return () => {
      cancelled = true;
    };
  }, [row.postId]);

  const mine = row.patch.content;
  const title = row.patch.title ?? theirs?.title ?? '';

  return (
    <article className="recrow">
      <header className="recrow__head">
        <h2 className="recrow__title">{title || 'Untitled'}</h2>
        <span className={`chip ${row.state === 'blocked' ? 'chip--draft' : ''}`}>
          {row.state === 'blocked' ? 'Refused' : 'Two versions'}
        </span>
      </header>

      <p className="recrow__meta">
        Written {new Date(row.updatedAt).toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })}
        {row.baseRevision != null && ` · based on revision ${row.baseRevision}`}
      </p>

      {row.state === 'blocked' && (
        <p className="recrow__reason">
          {/* The server's own words. A `blocked` row is permanent — 422 or 400 —
              so "try again later" would be a lie, and without the reason the
              writer has nothing to act on. */}
          <span className="label">The server refused this</span>
          {row.path ? `${row.path}: ` : ''}
          {row.detail ?? 'No reason was given.'}
        </p>
      )}

      <div className="prose recrow__doc">
        {isValidDoc(mine) ? (
          <DocRenderer doc={mine as DocNode} />
        ) : (
          <p className="recrow__meta">
            This change was to the title or settings rather than the text.
          </p>
        )}
      </div>

      <div className="recrow__actions">
        <button
          className="btn btn--primary btn--sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await keepMine(userId, row);
            onResolved();
          }}
        >
          Keep mine
        </button>
        <button
          className="btn btn--outline btn--sm"
          disabled={busy || !theirs}
          onClick={async () => {
            if (!theirs) return;
            setBusy(true);
            await loadTheirs(userId, row, theirs);
            onResolved();
          }}
        >
          {unreachable ? 'Load theirs (offline)' : 'Load theirs'}
        </button>
        {row.state === 'blocked' && (
          <button className="btn btn--ghost btn--sm" onClick={() => exportPending(row)}>
            Export to a file
          </button>
        )}
        <Link className="btn btn--ghost btn--sm" to={`/edit/${row.postId}`}>
          Open the post
        </Link>
      </div>
    </article>
  );
}
