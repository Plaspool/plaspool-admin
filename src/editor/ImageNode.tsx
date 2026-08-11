import Image from '@tiptap/extension-image';
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import { useState } from 'react';
import { StoredImg } from '../components/StoredImg';
import { IDB_SCHEME } from '../data/doc';
import { Dialog } from '../components/Dialog';

/**
 * Images are stored as `idb:<blobId>` so a post survives a reload — an
 * object URL would be dead the moment the page unloads. The node view
 * resolves the blob and hosts the alt/caption editors inline.
 */
function ImageView({ node, updateAttributes, selected, deleteNode }: NodeViewProps) {
  const src = String(node.attrs.src ?? '');
  const alt = String(node.attrs.alt ?? '');
  const caption = String(node.attrs.title ?? '');
  const blobId = src.startsWith(IDB_SCHEME) ? src.slice(IDB_SCHEME.length) : null;

  const [altOpen, setAltOpen] = useState(false);
  const [altDraft, setAltDraft] = useState('');

  return (
    <NodeViewWrapper
      as="figure"
      className={`doc-figure editor-figure${selected ? ' is-selected' : ''}`}
    >
      <div className="editor-figure__frame">
        {blobId ? (
          <StoredImg blobId={blobId} alt={alt} className="doc-image" />
        ) : (
          <img className="doc-image" src={src} alt={alt} />
        )}
        <div className="editor-figure__tools" contentEditable={false}>
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
        {!alt && (
          <span className="cover__flag" contentEditable={false}>
            No alt text
          </span>
        )}
      </div>

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
