import Image from '@tiptap/extension-image';
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import { useState } from 'react';
import { StoredImg } from '../components/StoredImg';
import { ASSET_SCHEME, imageIdFromSrc } from '../data/doc';
import { isAllowedImageSrc } from '../data/docguards';
import { ImageError, storeImageFile } from '../data/images';
import { Dialog } from '../components/Dialog';
import { Spinner } from '../components/ui/Feedback';

/**
 * Images are stored as an opaque id — `idb:<id>` or `asset:<id>` — so a post
 * survives a reload; an object URL would be dead the moment the page unloads.
 * The node view resolves the id through `StoredImg` and hosts the alt/caption
 * editors inline.
 *
 * BOTH SCHEMES RESOLVE, and after the cutover the prefix stops telling the
 * truth about where the bytes are. `src/routes/Editor.tsx:262` is frozen and
 * writes `` `idb:${rec.id}` `` for a newly uploaded image, whose id is now a
 * SERVER id (plan §6.3). `imageIdFromSrc` strips either prefix and
 * `acquireImageURL` looks in the local store first and falls back to
 * `/api/images/<id>`, so the same node renders correctly whichever side of the
 * cutover wrote it. A hand-rolled `startsWith(IDB_SCHEME)` here would have
 * rendered "Image unavailable" over every migrated picture.
 */
function ImageView({ node, updateAttributes, selected, deleteNode }: NodeViewProps) {
  const src = String(node.attrs.src ?? '');
  const alt = String(node.attrs.alt ?? '');
  const caption = String(node.attrs.title ?? '');
  const blobId = imageIdFromSrc(src);

  const [altOpen, setAltOpen] = useState(false);
  const [altDraft, setAltDraft] = useState('');
  /** Only ever true because the writer pressed the button — see below. */
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // A pasted image that still lives on someone else's server. It is kept rather
  // than dropped (losing the picture is worse), but it is the one thing in a
  // local-first app that reaches off this device, so it says so.
  const remote = !blobId && isAllowedImageSrc(src);

  /**
   * Copy a remote image into this blog's own storage.
   *
   * Deliberately a button and never automatic: fetching on paste would put two
   * network calls — and a likely CORS failure — in the middle of a paste.
   *
   * `ASSET_SCHEME` AND NOT `IDB_SCHEME`. `storeImageFile` now returns a server
   * asset id (plan §6.1), and this is a surface that is free to say so.
   * `src/routes/Editor.tsx:262` is frozen and writes the same kind of id under
   * `idb:`, which still resolves — `imageIdFromSrc` strips either prefix and the
   * server's orphan-sweep extractor reads both — but a file that CAN write the
   * truthful prefix should (plan §6.3).
   */
  async function saveLocally() {
    setSaving(true);
    setSaveError('');
    try {
      const res = await fetch(src, { mode: 'cors', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const name = src.split('/').pop()?.split('?')[0] || 'image';
      const rec = await storeImageFile(new File([blob], name, { type: blob.type }));
      updateAttributes({ src: `${ASSET_SCHEME}${rec.id}` });
    } catch (err) {
      // `storeImageFile` wraps every failure it owns — including the upload's —
      // in `ImageError`, so a message that reaches the `else` here is a CORS
      // refusal from the other site rather than anything this app did.
      setSaveError(
        err instanceof ImageError
          ? err.message
          : 'That site won’t allow the image to be copied. Download it and add it from your device.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <NodeViewWrapper
      as="figure"
      className={`doc-figure editor-figure${selected ? ' is-selected' : ''}`}
    >
      <div className="editor-figure__frame">
        {blobId ? (
          <StoredImg blobId={blobId} alt={alt} className="doc-image" />
        ) : remote ? (
          // Matches DocRenderer exactly: same allow-list, same referrer policy,
          // so displaying it leaks nothing about the writer either.
          <img
            className="doc-image"
            src={src}
            alt={alt}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="img-missing" role="img" aria-label={alt || 'Image'}>
            <span>Image unavailable</span>
          </div>
        )}
        <div className="editor-figure__tools" contentEditable={false}>
          {remote && (
            <button className="cover__tool" onClick={saveLocally} disabled={saving}>
              {saving ? <Spinner size={12} label="Saving image" /> : null}
              {/*
                "…to this blog", not "…to this device". The bytes now go to the
                blog's own storage rather than to IndexedDB, and a label that
                promised a local copy would be describing the pre-cutover
                behaviour. The notice in `extensions.ts` quotes this string, so
                the two move together.
              */}
              {saving ? 'Saving…' : 'Save to this blog'}
            </button>
          )}
          <button
            className="cover__tool"
            onClick={() => {
              setAltDraft(alt);
              setAltOpen(true);
            }}
          >
            {alt ? 'Alt text' : 'Add alt text'}
          </button>
          <button className="cover__tool" onClick={() => deleteNode()}>
            Remove
          </button>
        </div>
        <div className="editor-figure__flags" contentEditable={false}>
          {remote && <span className="cover__flag">On another site</span>}
          {!alt && <span className="cover__flag">No alt text</span>}
        </div>
      </div>
      {saveError && (
        <p className="editor-figure__error" contentEditable={false}>
          {saveError}
        </p>
      )}

      <input
        className="editor-figure__caption"
        value={caption}
        placeholder="Add a caption (optional)"
        aria-label="Image caption"
        maxLength={200}
        onChange={(e) => updateAttributes({ title: e.target.value })}
      />

      <Dialog
        open={altOpen}
        onClose={() => setAltOpen(false)}
        title="Alt text"
        description="Describe what the image shows, for readers who can’t see it."
        footer={
          <>
            <button className="btn btn--ghost" onClick={() => setAltOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn--primary"
              onClick={() => {
                updateAttributes({ alt: altDraft.trim() });
                setAltOpen(false);
              }}
            >
              Save
            </button>
          </>
        }
      >
        <input
          className="input"
          autoFocus
          value={altDraft}
          maxLength={280}
          onChange={(e) => setAltDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              updateAttributes({ alt: altDraft.trim() });
              setAltOpen(false);
            }
          }}
        />
      </Dialog>
    </NodeViewWrapper>
  );
}

export const StudioImage = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});
