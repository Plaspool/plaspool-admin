import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import DocImage from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
import {
  Bold,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Undo2,
  Underline as UnderlineIcon,
} from 'lucide-react';
import { IDB_SCHEME, imageIdFromSrc } from '../../../shared/doc';
import { isAllowedHref } from '../../data/docguards';
import { acquireImageURL, releaseImageURL, storeImageFile, ImageError } from '../../data/images';
import { Button } from './primitives';
import { useToast } from './Toast';

/**
 * v2's description editor — TipTap assembled FRESH from the npm packages,
 * importing nothing from `src/editor/` (v1 files stay unmounted; the packages
 * were already dependencies).
 *
 * THE NODE SET MIRRORS v1's DESCRIPTION SCHEMA, and that is a data-safety
 * decision rather than a feature list: existing descriptions were written
 * under the blog schema (headings 2–3, lists, quotes, code, tables, task
 * lists, links, and — in old documents — images), and a schema that cannot
 * represent a stored node either drops it or refuses the document. So every
 * node v1 could store parses here, while the TOOLBAR offers only what a
 * product description should gain: text, structure, links. Code blocks in a
 * spool listing survive; nothing here helps you write a new one.
 *
 * IF A DOCUMENT STILL CARRIES SOMETHING THIS SCHEMA CANNOT HOLD, EDITING
 * LOCKS. `enableContentCheck` reports the invalid node before TipTap would
 * silently strip it, and a save after a silent strip would overwrite the
 * stored description with the stripped copy — losing a customer-facing block
 * with no error anywhere. Read-only plus a sentence is the honest version.
 *
 * STORED IMAGES RESOLVE. The image node's `src` is a scheme id
 * (`idb:`/`asset:`) that no browser can load; the node view below resolves
 * it through `acquireImageURL` — the same refcounted contract `StoredImg`
 * uses — and releases on destroy. Blog posts are image-heavy, and an editor
 * that showed grey chips where the pictures are would be unusable for them.
 */
const ResolvedImage = DocImage.extend({
  addNodeView() {
    return ({ node }) => {
      const img = document.createElement('img');
      img.alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : '';
      if (typeof node.attrs.title === 'string' && node.attrs.title) img.title = node.attrs.title;
      const src = typeof node.attrs.src === 'string' ? node.attrs.src : '';
      const id = imageIdFromSrc(src);
      if (id) {
        let released = false;
        let acquired = false;
        void acquireImageURL(id).then((url) => {
          acquired = true;
          if (released) {
            releaseImageURL(id);
            return;
          }
          if (url) img.src = url;
        });
        return {
          dom: img,
          destroy() {
            released = true;
            if (acquired) releaseImageURL(id);
          },
        };
      }
      /* A remote src renders as-is — kept, never lost, same as v1's rule. */
      img.src = src;
      return { dom: img };
    };
  },
});

function buildExtensions(placeholder: string) {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      link: false,
      underline: false,
    }),
    Underline,
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      HTMLAttributes: { rel: 'noopener noreferrer nofollow' },
      /* The same gate v1 applies: TipTap's own `protocols` option only APPENDS
         to a baseline that already allows tel/ftp/xmpp — this predicate is the
         real one, shared with the reader via `docguards`. */
      isAllowedUri: (url, { defaultValidate }) => {
        if (!defaultValidate(url)) return false;
        return !/^[a-z][a-z0-9+.-]*:/i.test(url.trim()) || isAllowedHref(url);
      },
    }),
    TableKit.configure({
      table: { resizable: false },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    ResolvedImage.configure({ inline: false, allowBase64: false }),
    Placeholder.configure({ placeholder, showOnlyWhenEditable: true }),
  ];
}

export function RichText({
  value,
  onChange,
  placeholder = 'What it is, what it is made of, who it is for…',
  ariaLabel = 'Description',
  allowImages = false,
}: {
  /** The stored ProseMirror document. Hydrated ONCE — remount (change `key`)
   *  to reset after a discard. */
  value: unknown;
  onChange: (doc: unknown) => void;
  placeholder?: string;
  ariaLabel?: string;
  /** Offers the insert-image button. OFF for product descriptions on
   *  purpose: the orphan collector's reference walk covers a product's
   *  cover and gallery ids and NOT images embedded in its description, so
   *  an embedded one would be deleted from under the page (v1's §1.10
   *  rule). Blog posts ARE walked, so the editor offers it there. */
  allowImages?: boolean;
}) {
  const toast = useToast();
  const imagePick = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const hydrated = useRef(false);
  const broken = useRef(false);
  const [locked, setLocked] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);

  const editor = useEditor({
    extensions: buildExtensions(placeholder),
    content: undefined,
    autofocus: false,
    enableContentCheck: true,
    onContentError: ({ editor }) => {
      broken.current = true;
      setLocked(true);
      editor.setEditable(false);
    },
    editorProps: {
      attributes: { 'aria-label': ariaLabel, spellcheck: 'true' },
    },
    onUpdate: ({ editor }) => {
      if (broken.current) return;
      onChange(editor.getJSON());
    },
  });

  /* Hydrated exactly once, outside the undo history — v1 spells out why:
     `setContent` is an ordinary undoable step, so hydrating as an edit puts
     "empty → whole description" on the stack and one Ctrl+Z blanks the field. */
  useEffect(() => {
    if (!editor || hydrated.current || value == null) return;
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * AN EMPTY DOCUMENT IS NEVER HYDRATED, AND SKIPPING IT IS THE WHOLE FIX.
     *
     * `{ type: 'doc', content: [] }` is what `createProduct` stores for every
     * new product (`server/shop/catalog/products.ts`) — and it is INVALID under
     * ProseMirror's schema, where `doc` is `block+` and therefore requires at
     * least one block. Handed to `setContent` with `enableContentCheck` on, it
     * fired `onContentError`, which locked the editor and showed "part of this
     * description uses blocks v2 cannot edit yet".
     *
     * So every newly created product had an UNEDITABLE description, and the
     * banner blamed unsupported blocks for a document that had no blocks at all.
     * Measured 2026-08-26: three of the five products in production were in this
     * state.
     *
     * There is nothing to hydrate here — a fresh editor is already an empty
     * document with the placeholder showing, which is exactly what an empty
     * description should look like. `hydrated` is still latched so that a later
     * real value does not overwrite what the user has since typed.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const doc = value as { content?: unknown[] } | null;
    if (!doc || !Array.isArray(doc.content) || doc.content.length === 0) {
      hydrated.current = true;
      return;
    }
    hydrated.current = true;
    try {
      editor
        .chain()
        .setContent(value as never, { emitUpdate: false })
        .setMeta('addToHistory', false)
        .run();
    } catch {
      broken.current = true;
      setLocked(true);
      editor.setEditable(false);
    }
  }, [editor, value]);

  const state = useEditorState({
    editor,
    selector: (ctx) => {
      const e: Editor | null = ctx.editor;
      if (!e) return null;
      return {
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        h2: e.isActive('heading', { level: 2 }),
        h3: e.isActive('heading', { level: 3 }),
        bullet: e.isActive('bulletList'),
        ordered: e.isActive('orderedList'),
        quote: e.isActive('blockquote'),
        link: e.isActive('link'),
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
      };
    },
  });

  function openLink() {
    if (!editor) return;
    const current = (editor.getAttributes('link').href as string | undefined) ?? '';
    setLinkDraft(current);
    setLinkError(null);
    setLinkOpen(true);
  }

  function applyLink() {
    if (!editor) return;
    const raw = linkDraft.trim();
    if (!raw) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      setLinkOpen(false);
      return;
    }
    const href = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    if (!isAllowedHref(href)) {
      setLinkError('That kind of link is not allowed here.');
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    setLinkOpen(false);
  }

  const disabled = !editor || locked;

  const tool = (
    label: string,
    icon: React.ReactNode,
    active: boolean,
    run: () => void,
    canRun = true,
  ) => (
    <button
      type="button"
      className="rte__btn"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled || !canRun}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {icon}
    </button>
  );

  return (
    <div className="rte">
      <div className="rte__bar" role="toolbar" aria-label="Text formatting">
        {tool('Bold', <Bold aria-hidden="true" />, Boolean(state?.bold), () =>
          editor?.chain().focus().toggleBold().run(),
        )}
        {tool('Italic', <Italic aria-hidden="true" />, Boolean(state?.italic), () =>
          editor?.chain().focus().toggleItalic().run(),
        )}
        {tool('Underline', <UnderlineIcon aria-hidden="true" />, Boolean(state?.underline), () =>
          editor?.chain().focus().toggleUnderline().run(),
        )}
        <span className="rte__sep" aria-hidden="true" />
        {tool('Heading', <Heading2 aria-hidden="true" />, Boolean(state?.h2), () =>
          editor?.chain().focus().toggleHeading({ level: 2 }).run(),
        )}
        {tool('Subheading', <Heading3 aria-hidden="true" />, Boolean(state?.h3), () =>
          editor?.chain().focus().toggleHeading({ level: 3 }).run(),
        )}
        <span className="rte__sep" aria-hidden="true" />
        {tool('Bulleted list', <List aria-hidden="true" />, Boolean(state?.bullet), () =>
          editor?.chain().focus().toggleBulletList().run(),
        )}
        {tool('Numbered list', <ListOrdered aria-hidden="true" />, Boolean(state?.ordered), () =>
          editor?.chain().focus().toggleOrderedList().run(),
        )}
        {tool('Quote', <Quote aria-hidden="true" />, Boolean(state?.quote), () =>
          editor?.chain().focus().toggleBlockquote().run(),
        )}
        <span className="rte__sep" aria-hidden="true" />
        {tool('Link', <Link2 aria-hidden="true" />, Boolean(state?.link), () =>
          linkOpen ? setLinkOpen(false) : openLink(),
        )}
        {allowImages ? (
          <>
            {tool(
              'Insert image',
              uploading ? <span className="spinner" aria-hidden="true" /> : <ImagePlus aria-hidden="true" />,
              false,
              () => imagePick.current?.click(),
              !uploading,
            )}
            <input
              ref={imagePick}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file || !editor) return;
                setUploading(true);
                void storeImageFile(file)
                  .then((stored) => {
                    /* Same representation v1 writes: the scheme id, resolved
                       at render by the node view above. */
                    editor
                      .chain()
                      .focus()
                      .setImage({ src: `${IDB_SCHEME}${stored.id}`, alt: '' })
                      .run();
                  })
                  .catch((err: unknown) => {
                    toast.show(
                      err instanceof ImageError ? err.message : 'That image could not be added.',
                      'critical',
                    );
                  })
                  .finally(() => setUploading(false));
              }}
            />
          </>
        ) : null}
        <span className="spacer" />
        {tool('Undo', <Undo2 aria-hidden="true" />, false, () => editor?.chain().focus().undo().run(), Boolean(state?.canUndo))}
        {tool('Redo', <Redo2 aria-hidden="true" />, false, () => editor?.chain().focus().redo().run(), Boolean(state?.canRedo))}
      </div>

      {linkOpen ? (
        <div className="rte__bar" style={{ gap: 'var(--s2)', padding: 'var(--s2)' }}>
          <input
            className="input"
            style={{ minHeight: '1.75rem', flex: 1 }}
            placeholder="example.com/page"
            value={linkDraft}
            aria-label="Link address"
            autoFocus
            onChange={(e) => {
              setLinkDraft(e.target.value);
              setLinkError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyLink();
              }
            }}
          />
          <Button onClick={applyLink}>{linkDraft.trim() ? 'Apply' : 'Remove'}</Button>
          <Button tone="plain" onClick={() => setLinkOpen(false)}>
            Cancel
          </Button>
          {linkError ? (
            <span className="field__error" style={{ flexBasis: '100%' }}>
              {linkError}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="rte__body">
        <EditorContent editor={editor} />
      </div>

      {locked ? (
        <div
          className="field__hint"
          style={{ padding: 'var(--s2) var(--s4)', borderTop: '1px solid var(--border-sub)' }}
          role="status"
        >
          Part of this description uses blocks v2 cannot edit yet, so editing is locked here to
          protect it. The current admin still edits it fully.
        </div>
      ) : null}
    </div>
  );
}
