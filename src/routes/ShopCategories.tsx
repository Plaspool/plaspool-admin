import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { Palette, Tags } from 'lucide-react';
import { shopApi, type ShopCategory, type ShopCategoryPatch } from '../data/api-shop';
import { ApiError } from '../data/errors';
import './shop.css';

/**
 * Shop categories — the managed list behind the storefront's tiles (migration
 * 0200).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO KINDS OF ROW, AND THE DIFFERENCE IS THE WHOLE SCREEN.
 *
 * `shop_products.category` is free text with no foreign key, so a category can
 * be IN USE WITHOUT BEING MANAGED — somebody typed it into a product and
 * nothing else exists. Those rows arrive with a null `id`, and the only thing
 * that can be done to one is ADOPT it: create the managed row that gives it a
 * slug, a blurb and a colour.
 *
 * Until it is adopted the storefront cannot show it at all, because
 * `/store/<slug>` has nothing to route to. That is the single most important
 * thing this screen has to communicate, so an unmanaged row does not look like
 * a managed one with empty fields — it says what it is and offers the one
 * action that changes it.
 *
 * A RENAME IS NOT A URL CHANGE, and the form says so where somebody can see it.
 * Renaming rewrites every product carrying the old value — the count is
 * reported back, because "this moved 12 products" is the sentence that stops
 * somebody renaming the wrong row — but it deliberately leaves the slug alone.
 * A published URL is a promise. Moving it is a separate box.
 *
 * NO ROLE GATE ANYWHERE IN THIS FILE. Every route behind it is `requireAuth`,
 * not `requireOwner`, matching the rest of the catalogue. If that ever changes
 * it is a server change first — a control drawn ahead of one is a form in front
 * of a 403, which is the failure `MarketingBanners.tsx` records.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** A blank tint reads as "none chosen", which is a real state and not an error. */
const NO_TINT = '';

interface DraftFields {
  name: string;
  slug: string;
  blurb: string;
  accentHex: string;
  position: string;
}

const fieldsOf = (category: ShopCategory): DraftFields => ({
  name: category.name,
  slug: category.slug ?? '',
  blurb: category.blurb,
  accentHex: category.accentHex ?? NO_TINT,
  position: String(category.position),
});

const EMPTY: DraftFields = { name: '', slug: '', blurb: '', accentHex: NO_TINT, position: '0' };

/**
 * The copy for a `bad_request`, keyed by the field the server named.
 *
 * The catalogue's treatment for a 400 is inline and keyed by `detail`, which
 * needs a sentence per field: `accentHex` is the server's name for a box
 * labelled "Tile colour", and a message quoting the path names nothing on
 * screen.
 */
const FIELD_MESSAGE: Record<string, string> = {
  name: 'A category needs a name, and it cannot be only spaces.',
  slug: 'That address could not be used. Letters, numbers and hyphens.',
  blurb: 'That description is too long.',
  accentHex: 'A tile colour is a six-digit hex value, like #1b4fa8.',
  reassign: 'That destination category could not be used.',
};

/**
 * A labelled control with its hint attached by `aria-describedby`.
 *
 * THE HINT IS NOT INSIDE THE `<label>`, AND THAT IS THE POINT. A label wrapping
 * both the caption and the hint makes the whole run of text the control's
 * ACCESSIBLE NAME, so a screen reader announces "Name Renaming moves every
 * product carrying the old name. It does not change the web address, edit text"
 * where it should say "Name". Described-by keeps the sentence available and out
 * of the name. Caught by `ShopCategories.test.tsx` failing to find the field by
 * its own label.
 */
function Field({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: ReactNode;
  wide?: boolean;
  children: (props: { id: string; 'aria-describedby'?: string }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={`shopcat__field${wide ? ' shopcat__field--wide' : ''}`}>
      <label className="shopcat__label" htmlFor={id}>
        {label}
      </label>
      {children(hint ? { id, 'aria-describedby': hintId } : { id })}
      {hint && (
        <span className="shopcat__hint" id={hintId}>
          {hint}
        </span>
      )}
    </div>
  );
}

function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 400 && err.detail && FIELD_MESSAGE[err.detail]) {
      return FIELD_MESSAGE[err.detail];
    }
    if (err.status === 409) {
      /*
       * The two 409s this screen can raise need different words, and the server
       * distinguishes them with `operation` precisely so they can have them.
       * Collapsed into one, "that did not work" is the only honest sentence.
       */
      const body = err.body as { operation?: string; category?: ShopCategory } | undefined;
      const count = body?.category?.count ?? 0;
      if (body?.operation === 'delete') {
        return `${count} product${count === 1 ? '' : 's'} still use this category. Choose where they should go, or move them first.`;
      }
      return `A category called “${body?.category?.name ?? ''}” already exists. Names are matched without case, so “PLA” and “pla” are the same one.`;
    }
  }
  return fallback;
}

export default function ShopCategories() {
  const [categories, setCategories] = useState<ShopCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [fields, setFields] = useState<DraftFields>(EMPTY);
  const [creating, setCreating] = useState(false);
  const [newFields, setNewFields] = useState<DraftFields>(EMPTY);
  const [moved, setMoved] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      setCategories(await shopApi.listCategories(signal));
      setError(null);
    } catch {
      setError('Could not load categories.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const managed = categories.filter((c) => c.managed);
  const unmanaged = categories.filter((c) => !c.managed);

  async function create(fromName?: string): Promise<void> {
    const source = fromName ? { ...EMPTY, name: fromName } : newFields;
    setBusy(fromName ?? 'new');
    setError(null);
    try {
      await shopApi.createCategory({
        name: source.name.trim(),
        blurb: source.blurb.trim(),
        accentHex: source.accentHex === NO_TINT ? null : source.accentHex,
        position: Number(source.position) || 0,
      });
      setCreating(false);
      setNewFields(EMPTY);
      await load();
    } catch (err) {
      setError(messageFor(err, 'Could not create that category.'));
    } finally {
      setBusy(null);
    }
  }

  async function save(category: ShopCategory): Promise<void> {
    if (!category.id) return;
    setBusy(category.id);
    setError(null);
    setMoved(null);
    /*
     * ONLY WHAT CHANGED. A patch that resends every field would rename on every
     * save — and a rename rewrites every product carrying the value, so the
     * no-op case has to be genuinely absent from the body rather than equal.
     */
    const patch: ShopCategoryPatch = {};
    if (fields.name.trim() !== category.name) patch.name = fields.name.trim();
    if (fields.slug.trim() !== (category.slug ?? '')) patch.slug = fields.slug.trim();
    if (fields.blurb.trim() !== category.blurb) patch.blurb = fields.blurb.trim();
    const nextTint = fields.accentHex === NO_TINT ? null : fields.accentHex;
    if (nextTint !== category.accentHex) patch.accentHex = nextTint;
    if (Number(fields.position) !== category.position) patch.position = Number(fields.position) || 0;

    if (Object.keys(patch).length === 0) {
      setEditingId(null);
      setBusy(null);
      return;
    }

    try {
      const result = await shopApi.saveCategory(category.id, patch);
      if (result.movedProducts > 0) {
        setMoved(
          `Renamed. ${result.movedProducts} product${result.movedProducts === 1 ? '' : 's'} moved to “${result.category.name}”.`,
        );
      }
      setEditingId(null);
      await load();
    } catch (err) {
      setError(messageFor(err, 'Could not save that category.'));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Delete, asking where the products should go ONLY when there are some.
   *
   * The refusal is the server's and it is the right one — silently orphaning a
   * dozen products' category into unmanaged free text is the state the managed
   * table exists to end — so this asks the question the refusal would ask,
   * before making the request that would be refused.
   */
  async function remove(category: ShopCategory): Promise<void> {
    if (!category.id) return;
    let reassign: string | undefined;
    if (category.count > 0) {
      const answer = window.prompt(
        `${category.count} product${category.count === 1 ? '' : 's'} still use “${category.name}”.\n\n` +
          'Type the category they should move to, or leave this empty to make them uncategorised. ' +
          'Cancel to keep the category.',
        '',
      );
      if (answer === null) return;
      reassign = answer.trim();
    } else if (!window.confirm(`Delete “${category.name}”? Nothing uses it.`)) {
      return;
    }

    setBusy(category.id);
    setError(null);
    try {
      await shopApi.deleteCategory(category.id, reassign);
      await load();
    } catch (err) {
      setError(messageFor(err, 'Could not delete that category.'));
    } finally {
      setBusy(null);
    }
  }

  function editorFor(category: ShopCategory) {
    return (
      <div className="shopcat__editor">
        <div className="shopcat__grid">
          <Field
            label="Name"
            hint="Renaming moves every product carrying the old name. It does not change the web address."
          >
            {(p) => (
              <input
                {...p}
                className="input"
                value={fields.name}
                onChange={(e) => setFields({ ...fields, name: e.target.value })}
              />
            )}
          </Field>

          <Field
            label="Web address"
            hint={`/store/${fields.slug || '…'} — changing this breaks links people have already shared.`}
          >
            {(p) => (
              <input
                {...p}
                className="input"
                value={fields.slug}
                onChange={(e) => setFields({ ...fields, slug: e.target.value })}
              />
            )}
          </Field>

          <Field
            label="Description"
            wide
            hint="The line under the heading on the category page, and its search description."
          >
            {(p) => (
              <textarea
                {...p}
                className="input shopcat__textarea"
                rows={2}
                value={fields.blurb}
                onChange={(e) => setFields({ ...fields, blurb: e.target.value })}
              />
            )}
          </Field>

          <Field label="Tile colour">
            {(p) => (
              <span className="shopcat__tint">
                <input
                  type="color"
                  className="shopcat__swatch"
                  aria-label="Tile colour picker"
                  value={fields.accentHex || '#1b4fa8'}
                  onChange={(e) => setFields({ ...fields, accentHex: e.target.value })}
                />
                <input
                  {...p}
                  className="input"
                  value={fields.accentHex}
                  placeholder="none"
                  onChange={(e) => setFields({ ...fields, accentHex: e.target.value })}
                />
                {fields.accentHex !== NO_TINT && (
                  <button
                    type="button"
                    className="btn btn--sm btn--outline"
                    onClick={() => setFields({ ...fields, accentHex: NO_TINT })}
                  >
                    Clear
                  </button>
                )}
              </span>
            )}
          </Field>

          <Field label="Order" hint="Lowest first. Ties fall back to the name.">
            {(p) => (
              <input
                {...p}
                className="input"
                type="number"
                min={0}
                value={fields.position}
                onChange={(e) => setFields({ ...fields, position: e.target.value })}
              />
            )}
          </Field>
        </div>

        <div className="shopcat__actions">
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy === category.id}
            onClick={() => void save(category)}
          >
            Save
          </button>
          <button
            type="button"
            className="btn btn--sm btn--outline"
            onClick={() => setEditingId(null)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--sm btn--danger shopcat__delete"
            disabled={busy === category.id}
            onClick={() => void remove(category)}
          >
            Delete
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="shopscr">
      <header className="shopscr__head">
        <h1 className="shopscr__title">Categories</h1>
        <p className="shopscr__lede">
          What the storefront groups products under. A category needs to be on this list before
          it can have a page — its address, description and tile colour all live here.
        </p>
      </header>

      <div className="shopscr__body">
        {error && (
          <div className="notice notice--danger" role="alert">
            <span>{error}</span>
            <div className="notice__actions">
              <button
                type="button"
                className="btn btn--sm btn--outline"
                onClick={() => void load()}
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {moved && (
          <div className="notice" role="status">
            <span>{moved}</span>
          </div>
        )}

        {loading && <p className="shopscr__muted">Loading…</p>}

        {!loading && (
          <>
            <section className="shopcat__section">
              <div className="shopcat__sectionhead">
                <h2 className="shopcat__heading">
                  <Tags size={16} aria-hidden /> On the storefront
                </h2>
                {!creating && (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      setCreating(true);
                      setNewFields(EMPTY);
                    }}
                  >
                    New category
                  </button>
                )}
              </div>

              {creating && (
                <div className="shopcat__row shopcat__row--new">
                  <div className="shopcat__grid">
                    <Field
                      label="Name"
                      hint="The web address is made from this, and does not change if you rename it later."
                    >
                      {(p) => (
                        <input
                          {...p}
                          className="input"
                          autoFocus
                          value={newFields.name}
                          onChange={(e) => setNewFields({ ...newFields, name: e.target.value })}
                        />
                      )}
                    </Field>
                    <Field label="Description" wide>
                      {(p) => (
                        <textarea
                          {...p}
                          className="input shopcat__textarea"
                          rows={2}
                          value={newFields.blurb}
                          onChange={(e) => setNewFields({ ...newFields, blurb: e.target.value })}
                        />
                      )}
                    </Field>
                  </div>
                  <div className="shopcat__actions">
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={busy === 'new' || newFields.name.trim() === ''}
                      onClick={() => void create()}
                    >
                      Create
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--outline"
                      onClick={() => setCreating(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {managed.length === 0 && !creating && (
                <p className="shopscr__muted">
                  No categories yet. Until one exists the storefront has no category pages.
                </p>
              )}

              {managed.map((category) => (
                <div key={category.id} className="shopcat__row">
                  <div className="shopcat__summary">
                    <span
                      className="shopcat__dot"
                      style={{ background: category.accentHex ?? 'transparent' }}
                      aria-hidden
                    />
                    <span className="shopcat__name">{category.name}</span>
                    <span className="shopcat__slug">/store/{category.slug}</span>
                    <span className="shopcat__count">
                      {category.count} product{category.count === 1 ? '' : 's'}
                    </span>
                    {!category.accentHex && (
                      <span className="shopcat__flag" title="No tile colour chosen">
                        <Palette size={13} aria-hidden /> no colour
                      </span>
                    )}
                    <button
                      type="button"
                      className="btn btn--sm btn--outline shopcat__edit"
                      onClick={() => {
                        setEditingId(category.id);
                        setFields(fieldsOf(category));
                        setMoved(null);
                      }}
                    >
                      {editingId === category.id ? 'Editing' : 'Edit'}
                    </button>
                  </div>
                  {category.blurb && <p className="shopcat__blurb">{category.blurb}</p>}
                  {editingId === category.id && editorFor(category)}
                </div>
              ))}
            </section>

            {unmanaged.length > 0 && (
              <section className="shopcat__section">
                <h2 className="shopcat__heading">Typed on a product, not on the storefront</h2>
                <p className="shopscr__muted">
                  These were typed straight into a product. They work as a filter here, but they
                  have no page on the storefront and customers cannot browse them. Adding one
                  gives it an address, a description and a colour — no products move.
                </p>
                {unmanaged.map((category) => (
                  <div key={category.name} className="shopcat__row shopcat__row--orphan">
                    <div className="shopcat__summary">
                      <span className="shopcat__name">{category.name}</span>
                      <span className="shopcat__count">
                        {category.count} product{category.count === 1 ? '' : 's'}
                      </span>
                      <button
                        type="button"
                        className="btn btn--sm shopcat__edit"
                        disabled={busy === category.name}
                        onClick={() => void create(category.name)}
                      >
                        Add to storefront
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
