import { useRef, useState } from 'react';
import { StoredImg } from '../components/StoredImg';
import { Dialog } from '../components/Dialog';
import { ImageError, storeImageFile } from '../data/images';
import { useToast } from '../components/Toast';
import type { CoverImage } from '../data/types';

const FOCAL_PRESETS: { label: string; value: string }[] = [
  { label: 'Top', value: '50% 0%' },
  { label: 'Upper', value: '50% 25%' },
  { label: 'Center', value: '50% 50%' },
  { label: 'Lower', value: '50% 75%' },
  { label: 'Bottom', value: '50% 100%' },
];

export function CoverPicker({
  cover,
  onChange,
}: {
  cover: CoverImage | null;
  onChange: (c: CoverImage | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [altDraft, setAltDraft] = useState('');
  const { notify } = useToast();

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const rec = await storeImageFile(file);
      // Only after a fully successful store do we touch the post's cover.
      onChange({
        blobId: rec.id,
        alt: cover?.alt ?? '',
        focalPoint: cover?.focalPoint ?? '50% 50%',
        width: rec.width,
        height: rec.height,
      });
    } catch (err) {
      notify(
        err instanceof ImageError ? err.message : 'That image could not be added.',
        { tone: 'danger' },
      );
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const input = (
    <input
      ref={fileRef}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
      className="visually-hidden"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(e) => void pick(e.target.files?.[0])}
    />
  );

  if (!cover) {
    return (
      <div className="cover-empty">
        {input}
        <button
          className="cover-empty__btn"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          <svg viewBox="0 0 24 24" className="ic">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="8.5" cy="9.5" r="1.5" />
            <path d="m4 17 5-5 4 4 3-2 4 3" />
          </svg>
          {busy ? 'Adding…' : 'Add a cover image'}
        </button>
      </div>
    );
  }

  return (
    <figure className="cover">
      {input}
      <div className="cover__frame">
        <StoredImg
          blobId={cover.blobId}
          // Empty alt marks it decorative, which is honest. A generic
          // "Cover image" string reads to a screen reader as real description.
          alt={cover.alt}
          focalPoint={cover.focalPoint}
          className="cover__img"
          eager
        />
        <div className="cover__tools">
          <button
            className="cover__tool"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            Replace
          </button>
          <button
            className="cover__tool"
            onClick={() => {
              setAltDraft(cover.alt);
              setSettingsOpen(true);
            }}
          >
            {cover.alt ? 'Alt & framing' : 'Add alt text'}
          </button>
          <button className="cover__tool" onClick={() => onChange(null)}>
            Remove
          </button>
        </div>
        {!cover.alt && (
          <span className="cover__flag" title="Screen readers need a description">
            No alt text
          </span>
        )}
      </div>

      <Dialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Cover image"
        width="34rem"
        footer={
          <>
            <button className="btn btn--ghost" onClick={() => setSettingsOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn--primary"
              onClick={() => {
                onChange({ ...cover, alt: altDraft.trim() });
                setSettingsOpen(false);
              }}
            >
              Save
            </button>
          </>
        }
      >
        <div>
          <label className="label" htmlFor="cover-alt">
            Alt text
          </label>
          <input
            id="cover-alt"
            className="input"
            autoFocus
            value={altDraft}
            maxLength={280}
            placeholder="Describe the image for readers who can’t see it"
            onChange={(e) => setAltDraft(e.target.value)}
          />
        </div>
        <div>
          <span className="label">Framing</span>
          <div className="focal-row">
            {FOCAL_PRESETS.map((p) => (
              <button
                key={p.value}
                className={`focal${cover.focalPoint === p.value ? ' is-active' : ''}`}
                onClick={() => onChange({ ...cover, focalPoint: p.value })}
              >
                <StoredImg
                  blobId={cover.blobId}
                  alt=""
                  focalPoint={p.value}
                  className="focal__img"
                />
                <span>{p.label}</span>
              </button>
            ))}
          </div>
        </div>
      </Dialog>
    </figure>
  );
}
