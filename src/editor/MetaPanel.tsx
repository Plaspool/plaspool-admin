import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { cachedList } from '../data/cache';
import { activeUser } from '../data/posts';
import { Dialog } from '../components/Dialog';
import { slugify } from '../data/doc';
import { Select } from '../components/ui/Select';
import { useCategories } from '../data/useCategories';
import { useSettings, TEMPLATES, type ReadingTemplate } from '../data/settings';
import type { Post } from '../data/types';
import type { PostPatch } from '../data/posts';

const MAX_TAGS = 8;
const TAG_MAX_LEN = 32;
/** Radix rejects an Item with value="", so "no override" needs a sentinel. */
const USE_DEFAULT = '__default__';

/**
 * How long a name the "New category…" field will take.
 *
 * The column holds 400 bytes, so this is a house rule rather than a limit:
 * a category is a shelf label, and a shelf label that does not fit in a
 * dropdown is not doing its job. It is applied WHERE THE NAME IS TYPED and
 * nowhere else — see `commit()`.
 */
const CATEGORY_MAX_LEN = 40;

/**
 * Uncategorised, and the way back to it.
 *
 * `posts.category = ''` is what uncategorised means on the server and Radix
 * refuses an Item with `value=""`, so it needs a sentinel exactly as the
 * dashboard's "All categories" does. Without one, a post that has been filed
 * can never be un-filed from this panel.
 */
const NO_CATEGORY = '__none__';
/** Not a value: choosing it opens the field below rather than setting anything. */
const NEW_CATEGORY = '__new__';

const toSelectValue = (c: string): string => (c === '' ? NO_CATEGORY : c);
const fromSelectValue = (v: string): string => (v === NO_CATEGORY ? '' : v);

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
  const [template, setTemplate] = useState<string>(post.template ?? USE_DEFAULT);
  const [settings] = useSettings();
  const defaultName =
    TEMPLATES.find((t) => t.id === settings.template)?.name ?? settings.template;

  /** The "New category…" field is open, and what has been typed into it. */
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState('');

  // Re-seed from the store each time the panel opens, not on every keystroke.
  useEffect(() => {
    if (!open) return;
    setCategory(post.category);
    setTags(post.tags);
    setExcerpt(post.excerptSource === 'author' ? post.excerpt : '');
    setTemplate(post.template ?? USE_DEFAULT);
    setTagDraft('');
    setNaming(false);
    setNewName('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * `postList`, NOT `posts` (plan §2.1, §4).
   *
   * This list is the whole point of the tag suggestions below: they offer what
   * the writer has used elsewhere. `db.posts` is a cache of the posts whose
   * bodies have been fetched — after the cutover that is the handful this
   * session has opened — so reading it here would suggest tags from three posts
   * out of two hundred and quietly look like the feature had stopped working.
   *
   * Scoped by the active user for the same reason every other cache read is
   * (I2): a row left by another account on a shared machine must not put their
   * tag names into this writer's suggestions.
   *
   * CATEGORIES USED TO BE DERIVED HERE TOO, right next to this, and separately
   * from the dashboard's own copy of the same derivation. They come from
   * `useCategories` now — the managed list, with this same cache as its
   * fallback — so the two screens can no longer disagree about which categories
   * a blog has.
   */
  const all = useLiveQuery(() => cachedList(activeUser()), []) ?? [];
  const { names: knownCategories, create: createCategory } = useCategories(activeUser());
  const knownTags = useMemo(
    () =>
      [...new Set(all.flatMap((p) => p.tags))]
        .filter((t) => !tags.includes(t))
        .sort()
        .slice(0, 12),
    [all, tags],
  );

  /**
   * The picker's items: uncategorised, the managed list, and the way out.
   *
   * THE POST'S OWN VALUE IS PINNED IN even when the list has never heard of it,
   * and that arm is the entire reason `GET /api/categories` answers with
   * in-use-but-unmanaged rows at all (`api-categories.ts`). Every post written
   * before the categories table existed carries free text; if this control
   * could not show it, opening the Details panel on such a post would render a
   * blank trigger — and saving from there would silently re-file the post under
   * whatever the writer picked instead, which is a data change nobody asked
   * for. The same pin is what the dashboard filter does for the same reason.
   */
  const categoryOptions = useMemo(() => {
    const listed =
      category && !knownCategories.includes(category)
        ? [...knownCategories, category].sort((a, b) => a.localeCompare(b))
        : knownCategories;
    return [
      { value: NO_CATEGORY, label: 'Uncategorised' },
      ...listed.map((c) => ({ value: c, label: c })),
      { value: NEW_CATEGORY, label: 'New category…' },
    ];
  }, [knownCategories, category]);

  /**
   * The only way a name that is not already on the list can reach a post.
   *
   * This replaced an `<input list="known-categories">`, where the datalist was
   * a suggestion and anything typed past it was a new category — so "Technolgy"
   * became a category, silently, and nothing on any screen said the blog now
   * had two spellings of one shelf. Making the free-text path an explicit
   * choice is the whole of the fix.
   */
  async function addCategory() {
    const name = newName.trim().slice(0, CATEGORY_MAX_LEN);
    if (!name) return;
    /*
     * Selected before the request rather than after it. `create` never rejects
     * — a category that could not be registered is still a legal value for
     * `posts.category`, which is plain text on the wire — so making the writer
     * watch a spinner to see their own typing appear would be theatre.
     */
    setCategory(name);
    setNaming(false);
    setNewName('');
    const created = await createCategory(name);
    // The server can hand back its own spelling of a name it already held.
    // Applied only if the writer has not picked something else meanwhile.
    setCategory((prev) => (prev === name ? created.name : prev));
  }

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
      /*
       * SENT AS IT STANDS, where it used to be `.trim().slice(0, 40)`d on the
       * way out. Every path that can set it now yields a value that is already
       * legal: the sentinel maps to `''`, a pick comes from the list itself,
       * and the "New category…" field is capped as it is typed. Truncating here
       * would take a 45-character name off the managed list and file the post
       * under a NEW category one character different from the one the writer
       * chose — the silent typo-category this control was rebuilt to prevent,
       * reintroduced by the code meant to tidy up after it.
       */
      category,
      tags,
      template: template === USE_DEFAULT ? null : (template as ReadingTemplate),
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
        {/* A `<span>` rather than a `<label htmlFor>`: the control below is a
            Radix trigger, not an input, so the name has to reach it through
            the `label` prop — the same shape "Reading layout" uses. */}
        <span className="label">Category</span>
        <Select<string>
          label="Category for this post"
          value={toSelectValue(category)}
          onChange={(v) => {
            if (v === NEW_CATEGORY) {
              setNewName('');
              setNaming(true);
              return;
            }
            setNaming(false);
            setCategory(fromSelectValue(v));
          }}
          options={categoryOptions}
        />

        {naming && (
          <div
            /* Two layout rules, inline. The class this wants is a sibling of
               `.tagfield` in `editor.css`, which another workstream owns this
               run — and a rule added there now is a rule that gets lost in the
               merge rather than one that gets reviewed. */
            style={{ display: 'flex', gap: 'var(--s2)', marginTop: 'var(--s2)' }}
          >
            <input
              className="input"
              value={newName}
              autoFocus
              maxLength={CATEGORY_MAX_LEN}
              placeholder="Technology"
              aria-label="New category name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  // Enter inside a <dialog> submits nothing here, but stopping
                  // it is what keeps a stray form default from ever closing the
                  // panel with a half-typed name.
                  e.preventDefault();
                  void addCategory();
                } else if (e.key === 'Escape') {
                  /*
                   * `preventDefault` because this Escape is about the field,
                   * not the dialog. Without it the browser fires `cancel` on
                   * the native <dialog> and the whole Details panel closes —
                   * discarding the tags and excerpt alongside the name the
                   * writer was backing out of.
                   */
                  e.preventDefault();
                  setNaming(false);
                  setNewName('');
                }
              }}
            />
            <button
              className="btn btn--outline btn--sm"
              disabled={newName.trim() === ''}
              onClick={() => void addCategory()}
            >
              Add
            </button>
            <button
              className="btn btn--ghost btn--sm"
              /* The panel's footer already has a Cancel, and "Cancel" twice in
                 one dialog is a coin toss for anyone listening to it rather
                 than looking at it. The word stays short on screen where the
                 field it sits in supplies the context. */
              aria-label="Cancel new category"
              onClick={() => {
                setNaming(false);
                setNewName('');
              }}
            >
              Cancel
            </button>
          </div>
        )}

        <p className="hint">
          {naming
            ? 'The name is added to the blog’s categories, so the next post can pick it from the list.'
            : 'Pick one, or add a new one. A name typed twice two ways used to be two categories.'}
        </p>
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
          /*
           * THE SERVER'S DERIVED EXCERPT, NOT A SECOND DERIVATION OF IT. The
           * blog derives one on every write (`server/repo/mapping.ts`), so
           * `post.excerpt` is already the sentence this placeholder is trying
           * to reconstruct — and reconstructing it walked the whole document on
           * every keystroke in this field to produce, at best, the same string.
           * At worst a different one, which is the failure the same decision
           * removed from `PostCard` (F13): two answers to a question that has
           * one, differing whenever the two implementations drift.
           */
          placeholder={post.excerpt || 'A short description…'}
          onChange={(e) => setExcerpt(e.target.value)}
          style={{ resize: 'vertical', fontFamily: 'var(--font-display)' }}
        />
        <p className="hint">
          Leave blank to track the opening of the post. {320 - excerpt.length} left.
        </p>
      </div>

      <div>
        <span className="label">Reading layout</span>
        <Select<string>
          label="Reading layout for this post"
          value={template}
          onChange={setTemplate}
          options={[
            { value: USE_DEFAULT, label: `Site default · ${defaultName}` },
            ...TEMPLATES.map((t) => ({ value: t.id, label: t.name })),
          ]}
        />
        <p className="hint">
          {template === USE_DEFAULT
            ? 'Follows the blog default, so changing that in Settings changes this post too.'
            : 'Pinned to this post. The blog default no longer applies to it.'}
        </p>
      </div>

      <div>
        <label className="label" htmlFor="meta-slug">
          Slug
        </label>
        {/* Read-only: slugs are server-authoritative (spec §4.5). Letting a
            client set one bypasses uniqueness and turns a collision into a
            500 rather than a `-2` suffix. */}
        <input
          id="meta-slug"
          className="input"
          value={post.slug ?? ''}
          readOnly
          placeholder={slugify(post.title || 'untitled')}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--step--1)' }}
        />
        <p className="hint">Assigned automatically from the title on first save.</p>
      </div>
    </Dialog>
  );
}
