import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Image as ImageIcon, ImagePlus, Star, Trash2, Upload } from 'lucide-react';
import { acquireImageURL, releaseImageURL, storeImageFile, ImageError } from '../../data/images';
import { Button, Spinner } from './primitives';
import { useToast } from './Toast';

/**
 * v2's stored-image pieces. `src/components/StoredImg.tsx` is a v1 file and
 * stays unmounted; this is the same acquire/release contract restated over
 * v2's classes. The contract is the part that matters: `acquireImageURL`
 * refcounts object URLs, so every acquire MUST be paired with a release —
 * including the acquire that resolves after the component is already gone.
 */
export function StoredImg({ id, alt = '' }: { id: string; alt?: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let acquired = false;
    setUrl(null);
    void acquireImageURL(id).then((resolved) => {
      acquired = true;
      if (cancelled) {
        releaseImageURL(id);
        return;
      }
      setUrl(resolved);
    });
    return () => {
      cancelled = true;
      if (acquired) releaseImageURL(id);
    };
  }, [id]);

  if (!url) return <ImageIcon aria-hidden="true" />;
  return <img src={url} alt={alt} />;
}

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/avif';

export interface MediaValue {
  coverImageId: string | null;
  imageIds: string[];
}

/**
 * The product media card: the cover as the big tile, the gallery small, the
 * add tile last. The server stores the cover SEPARATELY from the gallery
 * (`imageCount = cover + imageIds.length` in v1), so "set as cover" here is a
 * swap between the two lists, never a duplicate.
 *
 * Uploads go through `storeImageFile` — validate, strip EXIF by re-encode,
 * upload, commit — and nothing lands in the value until the server has
 * committed the object. A failed file reports and is skipped; the rest of the
 * batch continues.
 */
export function MediaManager({
  value,
  onChange,
  alt = '',
  disabled = false,
}: {
  value: MediaValue;
  onChange: (next: MediaValue) => void;
  /** Base alt text — the product title. */
  alt?: string;
  disabled?: boolean;
}) {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [over, setOver] = useState(false);

  /* The latest value, for a multi-file batch: each committed file emits a new
     value derived from the last EMITTED one, not from a stale render. */
  const live = useRef(value);
  live.current = value;

  async function addFiles(files: File[]) {
    if (!files.length || disabled) return;
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        const stored = await storeImageFile(file);
        const current = live.current;
        const next: MediaValue =
          current.coverImageId === null
            ? { coverImageId: stored.id, imageIds: current.imageIds }
            : { coverImageId: current.coverImageId, imageIds: [...current.imageIds, stored.id] };
        live.current = next;
        onChange(next);
      } catch (err) {
        toast.show(
          err instanceof ImageError ? err.message : 'That image could not be added.',
          'critical',
        );
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  function setCover(id: string) {
    const current = live.current;
    const rest = current.imageIds.filter((x) => x !== id);
    const next: MediaValue = {
      coverImageId: id,
      imageIds: current.coverImageId ? [current.coverImageId, ...rest] : rest,
    };
    live.current = next;
    onChange(next);
  }

  function remove(id: string) {
    const current = live.current;
    let next: MediaValue;
    if (current.coverImageId === id) {
      const [promoted, ...rest] = current.imageIds;
      next = { coverImageId: promoted ?? null, imageIds: rest };
    } else {
      next = { coverImageId: current.coverImageId, imageIds: current.imageIds.filter((x) => x !== id) };
    }
    live.current = next;
    onChange(next);
  }

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setOver(false);
    void addFiles([...event.dataTransfer.files].filter((f) => f.type.startsWith('image/')));
  }

  const dragProps = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop,
  };

  const hasAny = value.coverImageId !== null || value.imageIds.length > 0 || uploading > 0;

  const picker = (
    <input
      ref={fileInput}
      type="file"
      accept={ACCEPT}
      multiple
      hidden
      onChange={(e) => {
        void addFiles([...(e.target.files ?? [])]);
        e.target.value = '';
      }}
    />
  );

  if (!hasAny) {
    return (
      <div className={over ? 'drop is-over' : 'drop'} {...dragProps}>
        {picker}
        <Upload aria-hidden="true" style={{ width: 22, height: 22, color: 'var(--ink-muted)' }} />
        <div>
          <button
            type="button"
            className="btn btn--default"
            disabled={disabled}
            onClick={() => fileInput.current?.click()}
          >
            Upload images
          </button>
        </div>
        <span className="drop__hint">or drop files here — JPEG, PNG, WebP, GIF or AVIF, up to 12 MB</span>
      </div>
    );
  }

  const tiles: ReactNode[] = [];
  if (value.coverImageId) {
    tiles.push(
      <Tile
        key={value.coverImageId}
        id={value.coverImageId}
        alt={alt ? `${alt} — cover image` : 'Cover image'}
        cover
        disabled={disabled}
        onRemove={() => remove(value.coverImageId!)}
      />,
    );
  }
  for (const id of value.imageIds) {
    tiles.push(
      <Tile
        key={id}
        id={id}
        alt={alt}
        disabled={disabled}
        onCover={() => setCover(id)}
        onRemove={() => remove(id)}
      />,
    );
  }
  for (let i = 0; i < uploading; i++) {
    tiles.push(
      <div key={`busy-${i}`} className="imgg__tile" aria-label="Uploading image">
        <span className="imgg__busy">
          <Spinner />
        </span>
      </div>,
    );
  }

  return (
    <div className="imgg" {...dragProps}>
      {picker}
      {tiles}
      <button
        type="button"
        className={over ? 'imgg__add is-over' : 'imgg__add'}
        aria-label="Add images"
        disabled={disabled}
        onClick={() => fileInput.current?.click()}
      >
        <ImagePlus aria-hidden="true" />
      </button>
    </div>
  );
}

function Tile({
  id,
  alt,
  cover = false,
  disabled = false,
  onCover,
  onRemove,
}: {
  id: string;
  alt: string;
  cover?: boolean;
  disabled?: boolean;
  onCover?: () => void;
  onRemove: () => void;
}) {
  return (
    <div className={cover ? 'imgg__tile imgg__tile--cover' : 'imgg__tile'}>
      <StoredImg id={id} alt={alt} />
      {cover ? <span className="imgg__cover">Cover</span> : null}
      {disabled ? null : (
        <span className="imgg__acts">
          {onCover ? (
            <button type="button" className="imgg__act" title="Set as cover" aria-label="Set as cover image" onClick={onCover}>
              <Star aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" className="imgg__act" title="Remove" aria-label="Remove image" onClick={onRemove}>
            <Trash2 aria-hidden="true" />
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * One picture, for a row that has exactly one (an add-on). Uploads through
 * `storeImageFile` like the product media card; nothing lands in `value`
 * until the server committed the object.
 */
export function SingleImage({
  value,
  onChange,
  alt = '',
  disabled = false,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  alt?: string;
  disabled?: boolean;
}) {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function pick(file: File | undefined) {
    if (!file || disabled) return;
    setUploading(true);
    try {
      const stored = await storeImageFile(file);
      onChange(stored.id);
    } catch (err) {
      toast.show(err instanceof ImageError ? err.message : 'That image could not be added.', 'critical');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s2)', alignItems: 'flex-start' }}>
      {value ? (
        <div
          style={{
            width: '6rem',
            height: '6rem',
            overflow: 'hidden',
            borderRadius: 'var(--r-md)',
            background: 'var(--surface-sunken)',
          }}
        >
          <StoredImg id={value} alt={alt} />
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 'var(--s2)' }}>
        <Button onClick={() => fileInput.current?.click()} disabled={disabled || uploading} busy={uploading}>
          {value ? 'Replace picture' : 'Add picture'}
        </Button>
        {value ? (
          <Button tone="plain" onClick={() => onChange(null)} disabled={disabled}>
            Remove
          </Button>
        ) : null}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        className="sr"
        aria-label="Picture"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
    </div>
  );
}
