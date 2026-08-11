import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { Dialog } from '../components/Dialog';
import { DocRenderer } from '../components/DocRenderer';
import { relative } from '../components/PostCard';
import type { Revision } from '../data/types';

const KIND_LABEL: Record<Revision['kind'], string> = {
  publish: 'Published',
  manual: 'Saved',
  autosave: 'Autosave',
  status: 'Status change',
};

/**
 * Revision history. Restoring writes a NEW revision rather than rewinding the
 * pointer, so nothing is ever lost by looking backwards — the version you were
 * on before the restore is still in the list.
 */
export function RevisionPanel({
  open,
  onClose,
  postId,
  onRestore,
}: {
  open: boolean;
  onClose: () => void;
  postId: string;
  onRestore: (rev: Revision) => void;
}) {
  const revisions = useLiveQuery(
    async () =>
      (await db.revisions.where('postId').equals(postId).toArray()).sort(
        (a, b) => b.createdAt - a.createdAt,
      ),
    [postId],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    revisions?.find((r) => r.id === selectedId) ?? revisions?.[0] ?? null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="History"
      description="Every save is kept. Restoring adds a new version — it never erases one."
      width="56rem"
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
          <button
            className="btn btn--primary"
            disabled={!selected}
            onClick={() => {
              if (selected) onRestore(selected);
              onClose();
            }}
          >
            Restore this version
          </button>
        </>
      }
    >
      <div className="revs">
        <ol className="revs__list">
          {(revisions ?? []).map((r) => (
            <li key={r.id}>
              <button
                className={`revs__item${selected?.id === r.id ? ' is-active' : ''}`}
                onClick={() => setSelectedId(r.id)}
              >
                <span className="revs__when">{relative(r.createdAt)}</span>
                <span className="revs__kind">
                  {r.note ?? KIND_LABEL[r.kind]} · r{r.revision}
                </span>
                <span className="revs__words">
                  {r.wordCount.toLocaleString()}{' '}
                  {r.wordCount === 1 ? 'word' : 'words'}
                </span>
              </button>
            </li>
          ))}
          {revisions?.length === 0 && (
            <li className="revs__empty">No history yet.</li>
          )}
        </ol>

        <div className="revs__preview">
          {selected ? (
            <>
              <h3 className="revs__preview-title">{selected.title || 'Untitled'}</h3>
              {selected.subtitle && (
                <p className="revs__preview-sub">{selected.subtitle}</p>
              )}
              <div className="prose revs__preview-body">
                <DocRenderer doc={selected.content} />
              </div>
            </>
          ) : (
            <p className="hint">Select a version to preview it.</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
