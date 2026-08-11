import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { Dialog } from '../components/Dialog';
import { deriveExcerpt, slugify } from '../data/doc';
import type { Post } from '../data/types';
import type { PostPatch } from '../data/posts';

const MAX_TAGS = 8;
const TAG_MAX_LEN = 32;

export function MetaPanel({
  open,
  onClose,
  post,
  onPatch,
}: {
  open: boolean;
  onClose: () => void;
  post: Post;
  onPatch: (p: PostPatch) => void;
}) {
  const [category, setCategory] = useState(post.category);
  const [tags, setTags] = useState<string[]>(post.tags);
  const [tagDraft, setTagDraft] = useState('');
  const [excerpt, setExcerpt] = useState(post.excerpt);
  const [slug, setSlug] = useState(post.slug);

  // Re-seed from the store each time the panel opens, not on every keystroke.
  useEffect(() => {
    if (!open) return;
    setCategory(post.category);
    setTags(post.tags);
    setExcerpt(post.excerptSource === 'author' ? post.excerpt : '');
    setSlug(post.slug);
    setTagDraft('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const all = useLiveQuery(() => db.posts.toArray(), []) ?? [];
  const knownCategories = useMemo(
    () => [...new Set(all.map((p) => p.category).filter(Boolean))].sort(),
    [all],
  );
  const knownTags = useMemo(
    () =>
      [...new Set(all.flatMap((p) => p.tags))]
        .filter((t) => !tags.includes(t))
        .sort()
        .slice(0, 12),
    [all, tags],
  );

  function addTag(raw: string) {
    const t = raw.trim().replace(/^#/, '').slice(0, TAG_MAX_LEN);
    if (!t) return;
    setTags((prev) =>
      prev.includes(t) || prev.length >= MAX_TAGS ? prev : [...prev, t],
    );
    setTagDraft('');
  }

  function commit() {
    const patch: PostPatch = {
      category: category.trim().slice(0, 40),
      tags,
      slug: slug.trim() ? slugify(slug) : '',
    };
    // Only send the excerpt if the author actually changed it. Sending the
    // untouched value blanked derived excerpts just for opening this panel.
    if (excerpt.trim() !== post.excerpt.trim()) {
      patch.excerpt = excerpt.trim().slice(0, 320);
    }
    onPatch(patch);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Post details"
      description="Everything a reader sees before they click through."
      width="36rem"
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={commit}>
            Save details
          </button>
        </>
      }
    >
      <div>
        <label className="label" htmlFor="meta-cat">
          Category
        </label>
        <input
          id="meta-cat"
          className="input"
          list="known-categories"
          value={category}
          maxLength={40}
          placeholder="Technology"
          onChange={(e) => setCategory(e.target.value)}
        />
        <datalist id="known-categories">
          {knownCategories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>

      <div>
        <span className="label">Tags ({tags.length}/{MAX_TAGS})</span>
        <div className="tagfield">
          {tags.map((t) => (
            <span className="tagfield__tag" key={t}>
              {t}
              <button
                onClick={() => setTags((p) => p.filter((x) => x !== t))}
                aria-label={`Remove tag ${t}`}
              >
                ×
              </button>
            </span>
          ))}
          {tags.length < MAX_TAGS && (
            <input
              className="tagfield__input"
              value={tagDraft}
              placeholder={tags.length ? 'Add another' : 'Add a tag'}
              maxLength={TAG_MAX_LEN}
              aria-label="Add a tag"
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  addTag(tagDraft);
                } else if (e.key === 'Backspace' && !tagDraft) {
                  setTags((p) => p.slice(0, -1));
                }
              }}
              onBlur={() => addTag(tagDraft)}
            />
          )}
        </div>
        {knownTags.length > 0 && tags.length < MAX_TAGS && (
          <div className="tagfield__suggest">
            {knownTags.map((t) => (
              <button key={t} className="chip" onClick={() => addTag(t)}>
                + {t}
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <label className="label" htmlFor="meta-excerpt">
          Excerpt
        </label>
        <textarea
          id="meta-excerpt"
          className="input"
          rows={3}
          maxLength={320}
          value={excerpt}
          placeholder={deriveExcerpt(post.content) || 'A short description…'}
          onChange={(e) => setExcerpt(e.target.value)}
          style={{ resize: 'vertical', fontFamily: 'var(--font-display)' }}
        />
        <p className="hint">
          Leave blank to track the opening of the post. {320 - excerpt.length} left.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="meta-slug">
          Slug
        </label>
        <input
          id="meta-slug"
          className="input"
          value={slug}
          maxLength={80}
          placeholder={slugify(post.title || 'untitled')}
          onChange={(e) => setSlug(e.target.value)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--step--1)' }}
        />
      </div>
    </Dialog>
  );
}
