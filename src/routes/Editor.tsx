import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { EditorContent, useEditor } from '@tiptap/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { GripVertical } from 'lucide-react';
import { createEditorExtensions } from '../editor/extensions';
import { FindReplace } from '../editor/find';
import { BlockMenu } from '../editor/BlockMenu';
import { SlashMenu } from '../editor/SlashMenu';
import { CodeLangPicker } from '../editor/CodeLangPicker';
import { FindBar } from '../editor/FindBar';
import { publishWarnings, type PublishWarning } from '../editor/publishCheck';
import { isBlankDoc } from '../data/docguards';
import { SelectionMenu } from '../editor/SelectionMenu';
import { AutoTextarea } from '../editor/AutoTextarea';
import { CoverPicker } from '../editor/CoverPicker';
import { useAutosave } from '../editor/useAutosave';
import { MetaPanel } from '../editor/MetaPanel';
import { SaveIndicator } from '../editor/SaveIndicator';
import { RevisionPanel } from '../editor/RevisionPanel';
import { useToast } from '../components/Toast';
import { ConfirmDialog } from '../components/Dialog';
import {
  createPost,
  discardIfBlank,
  publishPost,
  restorePost,
  trashPost,
  unpublishPost,
} from '../data/posts';
import { ImageError, storeImageFile } from '../data/images';
import { IDB_SCHEME, countWords, docToText, readingTime } from '../data/doc';
import type { CoverImage, DocNode, Post } from '../data/types';
import '../editor/editor.css';

const TITLE_MAX = 160;
const SUBTITLE_MAX = 220;

export default function EditorRoute() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { notify } = useToast();

  // Wrapped so we can tell "still loading" (undefined) from "no such post"
  // (result.post === undefined) — useLiveQuery collapses both otherwise.
  const result = useLiveQuery(async () => ({ post: await db.posts.get(id) }), [id]);
  const post = result?.post;
  const [loadedId, setLoadedId] = useState<string | null>(null);

  // Local mirrors: the editor owns these while mounted so live-query updates
  // from our own writes can't yank the cursor or clobber in-flight typing.
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [cover, setCover] = useState<CoverImage | null>(null);
  const [metaOpen, setMetaOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmTrash, setConfirmTrash] = useState(false);
  /** Non-null while the pre-publish checklist has something to say. */
  const [checks, setChecks] = useState<PublishWarning[] | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState({ words: 0, minutes: 0 });

  // The revision our editor buffer is based on. Fixed at hydration; every
  // write is checked against it so another tab can't be silently overwritten.
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const { state, queue, flush, rebase } = useAutosave(id, baseRevision, (saved) =>
    setBaseRevision(saved.revision),
  );
  const imageInput = useRef<HTMLInputElement>(null);

  // Built once per post: the extensions carry a notice hook so a plugin (a
  // paste that hotlinks an image, an upload that fails validation) can speak to
  // the writer through the same toast everything else uses.
  const extensions = useMemo(
    () => [...createEditorExtensions({ onNotice: (m, tone) => notify(m, { tone }) }), FindReplace],
    [notify],
  );

  const editor = useEditor(
    {
      extensions,
      content: undefined,
      autofocus: false,
      editorProps: {
        attributes: {
          class: 'prose editor__surface',
          'aria-label': 'Post content',
          spellcheck: 'true',
        },
      },
      onUpdate: ({ editor }) => {
        const json = editor.getJSON() as DocNode;
        const words = countWords(docToText(json));
        setStats({ words, minutes: readingTime(words) });
        queue({ content: json });
      },
    },
    [id],
  );

  // Hydrate exactly once per post id — never on subsequent live-query ticks.
  useEffect(() => {
    if (!post || !editor || loadedId === post.id) return;
    setTitle(post.title);
    setSubtitle(post.subtitle);
    setCover(post.coverImage);
    setStats({ words: post.wordCount, minutes: post.readingTime });
    // `addToHistory: false` is not optional here. TipTap's setContent is an
    // ordinary undoable step, so loading the post pushed "empty → your whole
    // document" onto the undo stack: Ctrl+Z on a freshly opened post emptied
    // the editor, and because undo is a real transaction, `onUpdate` then
    // autosaved that empty document over the post. History grouping made it
    // worse — typing within 500ms of hydration merged into the same event, so
    // a single undo could take the first sentence *and* the entire document.
    // Hydration is not an edit and must not be undoable.
    editor
      .chain()
      .setContent(post.content as never, { emitUpdate: false })
      .setMeta('addToHistory', false)
      .run();
    setBaseRevision(post.revision);
    setLoadedId(post.id);
  }, [post, editor, loadedId]);

  /**
   * Discard an abandoned blank draft however the writer leaves — browser Back,
   * closing the tab, or editing the URL, not just the in-app Posts button.
   * Guarded on the id so it can't run against a post we never opened.
   */
  // Mirrors what is on screen right now. The unmount cleanup below can run
  // while an autosave is still in flight, so we must NOT decide "blank" from
  // the store — it may not have caught up. The editor's own buffer is truth.
  const liveState = useRef({ title: '', subtitle: '', empty: true, hasCover: false });
  liveState.current = {
    title,
    subtitle,
    // NOT `words === 0`. An image or a divider is content with no words, and
    // asking the wrong question here destroyed drafts that held only a picture.
    // Same predicate `isBlankDraft` uses, so the two checks cannot disagree.
    empty: isBlankDoc(editor?.getJSON() as DocNode | undefined),
    hasCover: cover != null,
  };

  // NOT on unmount: StrictMode double-invokes effects, so an unmount-time
  // discard deletes the post the moment it is created. Leaving is handled by
  // the Posts button, by `pagehide`, and by the dashboard's own sweep of
  // stale blank drafts.
  useEffect(() => {
    const bail = () => {
      const s = liveState.current;
      if (s.title.trim() || s.subtitle.trim() || !s.empty || s.hasCover) return;
      void discardIfBlank(id);
    };
    window.addEventListener('pagehide', bail);
    return () => window.removeEventListener('pagehide', bail);
  }, [id]);

  /**
   * Belt and braces for the above: if the stored revision moves ahead while we
   * have nothing pending, our buffer is not in danger — adopt it silently
   * rather than accusing the writer of a conflict they didn't cause.
   */
  useEffect(() => {
    if (!post || baseRevision == null) return;
    if (post.revision <= baseRevision) return;
    if (state.kind === 'dirty' || state.kind === 'saving' || state.kind === 'conflict') return;
    setBaseRevision(post.revision);
    rebase(post.revision);
  }, [post, baseRevision, state.kind, rebase]);

  /** Pull the other tab's version in, discarding our unsaved buffer. */
  const reloadFromStore = useCallback(async () => {
    const fresh = await db.posts.get(id);
    if (!fresh || !editor) return;
    editor.commands.setContent(fresh.content as never, { emitUpdate: false });
    setTitle(fresh.title);
    setSubtitle(fresh.subtitle);
    setCover(fresh.coverImage);
    setStats({ words: fresh.wordCount, minutes: fresh.readingTime });
    setBaseRevision(fresh.revision);
    rebase(fresh.revision);
    notify('Loaded the newer version');
  }, [id, editor, rebase, notify]);

  /** Keep our buffer, adopt the newer revision, and let the next save win. */
  const keepMine = useCallback(async () => {
    const fresh = await db.posts.get(id);
    if (!fresh) return;
    rebase(fresh.revision);
    queue({ title, subtitle, content: editor?.getJSON() as DocNode });
    notify('Keeping your version — the other copy is in revision history');
  }, [id, rebase, queue, title, subtitle, editor, notify]);

  // Ctrl/Cmd+S = explicit save. Ctrl/Cmd+K = link (handled by the toolbar dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void flush().then(() => notify('Saved'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flush, notify]);

  const onTitle = useCallback(
    (v: string) => {
      setTitle(v);
      queue({ title: v.slice(0, TITLE_MAX) });
    },
    [queue],
  );
  const onSubtitle = useCallback(
    (v: string) => {
      setSubtitle(v);
      queue({ subtitle: v.slice(0, SUBTITLE_MAX) });
    },
    [queue],
  );
  const onCover = useCallback(
    (c: CoverImage | null) => {
      setCover(c);
      queue({ coverImage: c });
    },
    [queue],
  );

  const insertImage = useCallback(() => imageInput.current?.click(), []);

  /** Run an overflow-menu action and close the menu. */
  const act = useCallback((run: () => void | Promise<void>) => {
    setMoreOpen(false);
    void run();
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMoreOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  const handleInlineImage = useCallback(
    async (file: File | undefined) => {
      if (!file || !editor) return;
      try {
        const rec = await storeImageFile(file);
        // Persisted as idb:<id>, not an object URL — object URLs die on reload.
        editor
          .chain()
          .focus()
          .setImage({ src: `${IDB_SCHEME}${rec.id}`, alt: '', title: '' })
          .createParagraphNear()
          .run();
        notify('Image added — add alt text so readers aren’t left out');
      } catch (err) {
        notify(err instanceof ImageError ? err.message : 'That image could not be added.', {
          tone: 'danger',
        });
      } finally {
        if (imageInput.current) imageInput.current.value = '';
      }
    },
    [editor, notify],
  );

  const isPublished = post?.status === 'published';

  /**
   * Status changes bump the post's revision. The editor MUST adopt that new
   * revision, or its next autosave is based on a stale one and gets refused as
   * a conflict — against itself. That bug silently dropped every keystroke
   * typed after clicking Publish.
   */
  const adopt = useCallback(
    (next: Post) => {
      setBaseRevision(next.revision);
      rebase(next.revision);
    },
    [rebase],
  );

  const publishNow = useCallback(async () => {
    setChecks(null);
    await flush();
    try {
      const next = await publishPost(id);
      adopt(next);
      notify(`Published “${next.title || 'Untitled'}”`, {
        action: { label: 'View', run: () => navigate(`/read/${id}`) },
      });
    } catch {
      notify('Publishing failed. Your draft is safe.', { tone: 'danger' });
    }
  }, [flush, id, adopt, notify, navigate]);

  /**
   * Publishing runs the checklist first — and warns rather than blocks. A
   * writer who wants to publish without an excerpt has a reason, and an editor
   * that refuses is one people learn to route around. The point is to make the
   * cost visible while it is still cheap to pay. With nothing to say, this is
   * invisible and Publish behaves exactly as it always did.
   */
  const doPublish = async () => {
    // Flush first so the checklist reads the document that is about to ship,
    // not the one the store happens to be holding.
    await flush();
    const fresh = await db.posts.get(id);
    const warnings = fresh ? publishWarnings(fresh) : [];
    if (warnings.length) {
      setChecks(warnings);
      return;
    }
    await publishNow();
  };

  const doUnpublish = async () => {
    await flush();
    adopt(await unpublishPost(id));
    notify('Moved back to drafts');
  };

  const readingLabel = useMemo(
    () =>
      stats.words === 0
        ? 'Empty'
        : `${stats.words.toLocaleString()} ${stats.words === 1 ? 'word' : 'words'} · ${
            stats.minutes
          } min read`,
    [stats],
  );

  if (result === undefined) {
    return (
      <div className="editor">
        <div className="editor__loading" aria-busy="true">
          <div className="skeleton" style={{ height: 44, width: '60%' }} />
          <div className="skeleton" style={{ height: 20, width: '40%' }} />
          <div className="skeleton" style={{ height: 240, width: '100%' }} />
        </div>
      </div>
    );
  }

  if (!post) {
    return (
      <div className="empty">
        <h1 className="empty__title">This post no longer exists</h1>
        <p className="empty__body">
          It may have been permanently deleted from this browser.
        </p>
        <Link className="btn btn--primary" to="/">
          Back to your posts
        </Link>
      </div>
    );
  }

  return (
    <div className="editor">
      <header className="editor__bar">
        <div className="editor__bar-left">
          <button
            className="btn btn--ghost btn--sm"
            onClick={async () => {
              await flush();
              // Don't leave an empty Untitled row behind for a post that was
              // opened and abandoned without a single character typed.
              await discardIfBlank(id);
              navigate('/');
            }}
          >
            <svg viewBox="0 0 24 24" className="ic">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            Posts
          </button>
          <SaveIndicator state={state} />
        </div>

        <div className="editor__bar-right">
          <span className="editor__stats" aria-live="off">
            {readingLabel}
          </span>
          <button
            className="btn btn--ghost btn--sm editor__secondary"
            onClick={() => setHistoryOpen(true)}
            aria-haspopup="dialog"
          >
            History
          </button>
          <button
            className="btn btn--ghost btn--sm editor__secondary"
            onClick={() => setMetaOpen(true)}
            aria-haspopup="dialog"
          >
            Details
          </button>
          <button
            className="btn btn--outline btn--sm editor__secondary"
            onClick={async () => {
              await flush();
              navigate(`/read/${id}`);
            }}
          >
            Preview
          </button>
          {isPublished ? (
            <button className="btn btn--outline btn--sm" onClick={doUnpublish}>
              Unpublish
            </button>
          ) : (
            <button
              className="btn btn--primary btn--sm"
              onClick={doPublish}
              disabled={!title.trim() && stats.words === 0}
              aria-describedby={
                !title.trim() && stats.words === 0 ? 'publish-hint' : undefined
              }
            >
              Publish
            </button>
          )}
          {!isPublished && !title.trim() && stats.words === 0 && (
            <span id="publish-hint" className="visually-hidden">
              Add a title or some words before publishing
            </span>
          )}
          <button
            className="btn btn--ghost btn--sm editor__trash editor__secondary"
            onClick={() => setConfirmTrash(true)}
            aria-label="Move to trash"
            title="Move to trash"
          >
            <svg viewBox="0 0 24 24" className="ic">
              <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
            </svg>
          </button>

          {/* Narrow viewports only — keeps the header from overflowing. */}
          <div className="editor__more" ref={moreRef}>
            <button
              className="btn btn--ghost btn--sm"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              aria-label="More actions"
              onClick={() => setMoreOpen((o) => !o)}
            >
              <svg viewBox="0 0 24 24" className="ic">
                <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
              </svg>
            </button>
            {moreOpen && (
              <div className="editor__more-pop" role="menu">
                <button onClick={() => act(() => setHistoryOpen(true))}>History</button>
                <button onClick={() => act(() => setMetaOpen(true))}>Details</button>
                <button
                  onClick={() =>
                    act(async () => {
                      await flush();
                      navigate(`/read/${id}`);
                    })
                  }
                >
                  Preview
                </button>
                <button className="is-danger" onClick={() => act(() => setConfirmTrash(true))}>
                  Move to trash
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {state.kind === 'conflict' && (
        <div className="notice notice--warn" role="alert">
          <div>
            <strong>This post changed in another tab.</strong> Saving is paused so
            neither version is lost. Your text is still on screen, and the other
            version is safe in the store.
          </div>
          <div className="notice__actions">
            <button className="btn btn--outline btn--sm" onClick={reloadFromStore}>
              Load theirs
            </button>
            <button className="btn btn--primary btn--sm" onClick={keepMine}>
              Keep mine
            </button>
          </div>
        </div>
      )}

      {state.kind === 'gone' && (
        <div className="notice notice--danger" role="alert">
          <div>
            <strong>This post was deleted elsewhere.</strong> Your text is still on
            screen but has nowhere to save. Copy anything you need, or save it as a
            new post.
          </div>
          <div className="notice__actions">
            <button
              className="btn btn--primary btn--sm"
              onClick={async () => {
                const revived = await createPost({
                  title,
                  subtitle,
                  content: editor?.getJSON() as DocNode,
                  coverImage: cover,
                });
                notify('Saved as a new post');
                navigate(`/edit/${revived.id}`, { replace: true });
              }}
            >
              Save as a new post
            </button>
          </div>
        </div>
      )}

      {state.kind === 'error' && state.attempt >= 5 && (
        <div className="notice notice--danger" role="alert">
          <div>
            <strong>Couldn’t save after several attempts.</strong> {state.message}.
            Your text is still here — copy it somewhere safe before closing this tab.
          </div>
          <div className="notice__actions">
            <button
              className="btn btn--outline btn--sm"
              onClick={() => void flush('manual')}
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {checks && (
        <div className="notice notice--warn" role="alert">
          <div>
            <strong>Before you publish.</strong> None of this stops you — it is
            what a reader would notice.
            <ul className="notice__list">
              {checks.map((w) => (
                <li key={w.id}>{w.message}</li>
              ))}
            </ul>
          </div>
          <div className="notice__actions">
            <button className="btn btn--outline btn--sm" onClick={() => setChecks(null)}>
              Keep editing
            </button>
            <button className="btn btn--primary btn--sm" onClick={publishNow}>
              Publish anyway
            </button>
          </div>
        </div>
      )}

      {/* No docked toolbar. Formatting appears on selection; block insertion
          appears as a + beside the empty line the caret is on, or by typing /.
          The grip beside it is the pointer route for reordering; Alt+↑/↓ is the
          route that works without one, and on blocks a hover never reaches. */}
      {editor && (
        <>
          <SelectionMenu editor={editor} />
          <BlockMenu editor={editor} onInsertImage={insertImage} />
          <SlashMenu editor={editor} onInsertImage={insertImage} />
          <CodeLangPicker editor={editor} />
          <FindBar editor={editor} />
          <DragHandle editor={editor} className="draghandle">
            <span className="draghandle__grip" aria-hidden="true">
              <GripVertical className="ui-ic" />
            </span>
          </DragHandle>
        </>
      )}

      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => void handleInlineImage(e.target.files?.[0])}
      />

      <main className="editor__page">
        <CoverPicker cover={cover} onChange={onCover} />

        <AutoTextarea
          className="editor__title"
          value={title}
          onChange={onTitle}
          placeholder="Title"
          maxLength={TITLE_MAX}
          ariaLabel="Post title"
          autoFocus={!title && stats.words === 0}
          onEnter={() => editor?.commands.focus('start')}
        />
        <AutoTextarea
          className="editor__subtitle"
          value={subtitle}
          onChange={onSubtitle}
          placeholder="Add a subtitle"
          maxLength={SUBTITLE_MAX}
          ariaLabel="Post subtitle"
          onEnter={() => editor?.commands.focus('start')}
        />

        <EditorContent editor={editor} className="editor__content" />
      </main>

      {/* Mounted only while open: both panels run live queries that would
          otherwise re-read every post and revision on every autosave. */}
      {post && metaOpen && (
        <MetaPanel
          open={metaOpen}
          onClose={() => setMetaOpen(false)}
          post={post}
          onPatch={queue}
        />
      )}

      {historyOpen && (
      <RevisionPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        postId={id}
        onRestore={(rev) => {
          // Restore = write forward. The version we were on stays in history.
          editor?.commands.setContent(rev.content as never, { emitUpdate: false });
          setTitle(rev.title);
          setSubtitle(rev.subtitle);
          // emitUpdate:false means onUpdate never runs, so the header counters
          // must be refreshed here or they keep reporting the old document.
          const words = countWords(docToText(rev.content));
          setStats({ words, minutes: readingTime(words) });
          queue({ title: rev.title, subtitle: rev.subtitle, content: rev.content });
          void flush('manual');
          notify(`Restored the version from ${new Date(rev.createdAt).toLocaleString()}`);
        }}
      />
      )}

      <ConfirmDialog
        open={confirmTrash}
        onClose={() => setConfirmTrash(false)}
        title="Move this post to trash?"
        description="Nothing is deleted. You can restore it from Trash at any time."
        confirmLabel="Move to trash"
        danger
        onConfirm={async () => {
          await flush();
          await trashPost(id);
          notify('Moved to trash', {
            action: { label: 'Undo', run: () => void restorePost(id) },
          });
          navigate('/');
        }}
      />
    </div>
  );
}
