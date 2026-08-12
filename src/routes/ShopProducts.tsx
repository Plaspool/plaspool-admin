import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { EditorContent, useEditor } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import { ArrowLeft, ImagePlus, Package, Plus, Search, X } from 'lucide-react';
import {
  shopApi,
  formatMinor,
  moneyRefusalMessage,
  parseMajor,
  type ProductStatus,
  type ShopCategory,
  type ShopProduct,
  type ShopProductDetail,
  type ShopProductPatch,
  type ShopVariant,
} from '../data/api-shop';
import { api } from '../data/api';
import { ApiError, NotFoundError, OfflineError, StaleWriteError } from '../data/errors';
import { createEditorExtensions } from '../editor/extensions';
import { ImageError, storeImageFile } from '../data/images';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Feedback';
import { useDelayed } from '../components/ui/useDelayed';
import { ConfirmDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import './shop.css';

/**
 * The catalogue, and one product's form.
 *
 * ONE URL FOR BOTH, exactly as `ShopOrders` does: `?id=` is the only difference
 * between the list somebody filtered and that list with a product open on top of
 * it, so closing the form returns to the filters they had rather than to an
 * unfiltered catalogue. `?id=new` is the create form — a route rather than a
 * boolean, so a half-written product survives a reload and can be linked to.
 *
 * MONEY IS ENTERED IN MAJOR UNITS AND SENT IN MINOR ONES, and the conversion is
 * `parseMajor`/`formatMinor` in `src/data/api-shop.ts` — the only place in `src/`
 * that knows the exponent. Nothing in this file divides or multiplies an amount.
 *
 * PRODUCT IMAGES DEPEND ON HANDOFF §2 A5 HAVING LANDED. Until the orphan
 * collector's reference walk unions `shop_products.cover_image_id` and
 * `unnest(image_ids)`, an image referenced only by a product is "unreferenced"
 * and is deleted 24 hours after upload (§1.10). The upload path here is the same
 * three-step slot → PUT → commit that the post editor uses, so nothing extra is
 * needed on this side once the walk is fixed — but the panel says so, because a
 * cover that vanishes overnight is the kind of bug an operator blames themselves
 * for.
 */

const STATUS_FILTERS: { value: ProductStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All products' },
  { value: 'draft', label: 'Drafts' },
  { value: 'active', label: 'Published' },
  { value: 'archived', label: 'Archived' },
  { value: 'trash', label: 'Trash' },
];

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  active: 'Published',
  archived: 'Archived',
  trash: 'In trash',
};

const PAGE_LIMIT = 100;
const MAX_TAGS = 12;
const TAG_MAX_LEN = 32;
const MAX_GALLERY = 8;

/** Radix throws outright on a Select item with `value=""`, so both "no filter"
 *  and "no category" need sentinels of their own. */
const ALL_CATEGORIES = '__all__';
const NO_CATEGORY = '__none__';
const NEW_CATEGORY = '__new__';

const WHEN = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function readStatus(params: URLSearchParams): ProductStatus | 'all' {
  const raw = params.get('status');
  return STATUS_FILTERS.some((s) => s.value === raw) ? (raw as ProductStatus | 'all') : 'all';
}

function withParams(
  base: URLSearchParams,
  patch: Record<string, string | null>,
): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '' || (key === 'status' && value === 'all')) {
      next.delete(key);
    } else next.set(key, value);
  }
  return next;
}

const asSearch = (params: URLSearchParams): string => {
  const qs = params.toString();
  return qs === '' ? '' : `?${qs}`;
};

export default function ShopProducts() {
  const [params] = useSearchParams();
  const openId = params.get('id');

  return (
    <div className="shopscr">
      {/*
        HIDDEN ENTIRELY ON A DETAIL PAGE. A page-level "Products" title above a
        form editing ONE product describes the section you left, not the thing in
        front of you, and it pushes the actual subject below the fold.
      */}
      {!openId && (
        <header className="shopscr__head">
          <div className="shopscr__headrow">
            <div>
              <h1 className="shopscr__title">Products</h1>
              <p className="shopscr__lede">
                Every product, its variants and the prices they carry. Prices are
                typed in whole naira and sent as kobo, so &#8358;18,500 leaves this
                screen as 1850000 — the store never rounds money through a float.
              </p>
            </div>
            <Link
              className="btn btn--primary"
              to={{ pathname: '/shop/products', search: asSearch(withParams(params, { id: 'new' })) }}
            >
              <Plus className="ui-ic" aria-hidden="true" />
              New product
            </Link>
          </div>
        </header>
      )}

      {/*
        THE SECTION NAV DISAPPEARS ON A DETAIL PAGE, and so does the lede above.
        Editing one product is a different flow from browsing the catalogue: the
        only navigation that makes sense is back to where you came from, and
        Overview / Orders / Customers sitting above an edit form are four ways to
        silently abandon unsaved work. `ProductForm` leads with its own back bar,
        which is the one exit this page should offer.
      */}
      {!openId && <ShopNav />}

      <div className="shopscr__body">
        {openId ? <ProductForm key={openId} id={openId} /> : <ProductList />}
      </div>
    </div>
  );
}

// ============================================================================
// LIST
// ============================================================================

function ProductList() {
  const [params, setParams] = useSearchParams();
  const status = readStatus(params);
  const category = params.get('category') ?? '';
  const search = params.get('q') ?? '';

  const [items, setItems] = useState<ShopProduct[] | null>(null);
  /**
   * There is another page and this screen has no way to reach it.
   *
   * The catalogue is one keyset page deep on purpose for v1 — a shop with more
   * than a hundred products wants the search HANDOFF §2 A4 did not add to
   * `/admin/products` rather than a Next button over a list nobody can search.
   * What is NOT acceptable is truncating silently, so the count is said out
   * loud and the filters are named as the way through.
   */
  const [more, setMore] = useState(false);
  const [categories, setCategories] = useState<ShopCategory[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const showSkeletons = useDelayed(loading);

  const [draft, setDraft] = useState(search);
  const pushed = useRef(search);

  useEffect(() => {
    if (search === pushed.current) return;
    pushed.current = search;
    setDraft(search);
  }, [search]);

  useEffect(() => {
    if (draft === pushed.current) return;
    const timer = window.setTimeout(() => {
      pushed.current = draft;
      setParams((prev) => withParams(prev, { q: draft }), { replace: true });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draft, setParams]);

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setProblem(null);
      return shopApi
        .listProducts(
          {
            status: status === 'all' ? undefined : status,
            category: category || undefined,
            limit: PAGE_LIMIT,
          },
          signal,
        )
        .then((page) => {
          if (signal?.aborted) return;
          setItems(page.items);
          setMore(page.nextCursor !== null);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (signal?.aborted) return;
          setProblem(explain(err, 'catalogue'));
          setLoading(false);
        });
    },
    [status, category],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  /*
   * The category options come from the admin route, which is distinct over ALL
   * products including drafts — unlike the public one, which would hide a
   * category whose only product is unpublished, i.e. exactly the product
   * somebody is looking for on this screen. A failure here is swallowed: the
   * filter disappears, the list does not.
   */
  useEffect(() => {
    const ac = new AbortController();
    void shopApi
      .listCategories(ac.signal)
      .then((next) => !ac.signal.aborted && setCategories(next))
      .catch(() => {});
    return () => ac.abort();
  }, []);

  /**
   * SEARCH IS CLIENT-SIDE AND THAT IS THE ROUTE'S SHAPE, NOT A SHORTCUT.
   *
   * `AdminListQueryParams` in `server/shop/catalog/routes.ts` is `.strict()` and
   * has no `search` member, so sending one is a 400 naming the field — a
   * mistyped filter that is silently ignored being worse than a refusal is that
   * schema's own stated reason. So the box narrows the page already fetched,
   * and the hint under it says exactly that rather than implying a catalogue-wide
   * search that is not happening.
   */
  const visible = useMemo(() => {
    const rows = items ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [items, search]);

  const categoryOptions = [
    { value: ALL_CATEGORIES, label: 'Every category' },
    ...categories.map((c) => ({
      value: c.name,
      label: c.count > 0 ? `${c.name} (${c.count})` : c.name,
    })),
    // Pinned so a filter set from a link never leaves the trigger blank — the
    // same guard the dashboard's category Select carries.
    ...(category && !categories.some((c) => c.name === category)
      ? [{ value: category, label: category }]
      : []),
  ];

  return (
    <>
      <div className="shopfilters">
        <Select<string>
          label="Filter by status"
          value={status}
          onChange={(v) => setParams((prev) => withParams(prev, { status: v }), { replace: true })}
          options={STATUS_FILTERS.map((s) => ({ value: s.value, label: s.label }))}
        />

        <Select<string>
          label="Filter by category"
          value={category || ALL_CATEGORIES}
          onChange={(v) =>
            setParams(
              (prev) => withParams(prev, { category: v === ALL_CATEGORIES ? null : v }),
              { replace: true },
            )
          }
          options={categoryOptions}
        />

        <div className="searchbox">
          <Search className="ui-ic" aria-hidden="true" />
          <input
            className="searchbox__input"
            type="search"
            value={draft}
            placeholder="Filter these by title, category or tag…"
            aria-label="Filter products"
            onChange={(e) => setDraft(e.target.value)}
          />
          {draft && (
            <button
              className="searchbox__clear"
              aria-label="Clear filter"
              onClick={() => {
                pushed.current = '';
                setDraft('');
                setParams((prev) => withParams(prev, { q: '' }), { replace: true });
              }}
            >
              <X className="ui-ic" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {problem && (
        <div className="notice notice--danger" role="alert">
          <div>
            <strong>The catalogue didn&rsquo;t load.</strong> {problem}
          </div>
          <div className="notice__actions">
            <button className="btn btn--outline btn--sm" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </div>
      )}

      {loading && !items ? (
        showSkeletons ? (
          <div className="panel" style={{ marginTop: 'var(--s5)' }} aria-hidden="true">
            <div className="panel__body">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} height={18} width={`${92 - i * 7}%`} />
              ))}
            </div>
          </div>
        ) : null
      ) : visible.length === 0 && !problem ? (
        <div className="empty">
          <div className="empty__mark" aria-hidden="true">
            <Package />
          </div>
          <h2 className="empty__title">
            {search ? 'Nothing on this page matches' : 'Nothing in the catalogue'}
          </h2>
          <p className="empty__body">
            {search
              ? 'The box filters the products already loaded, not the whole catalogue. Widen the status or category filter first.'
              : 'Products live here once you make one. A new product starts as a draft and sells nothing until it is published.'}
          </p>
          <Link
            className="btn btn--outline"
            to={{ pathname: '/shop/products', search: asSearch(withParams(params, { id: 'new' })) }}
          >
            New product
          </Link>
        </div>
      ) : (
        <section className="panel" style={{ marginTop: 'var(--s5)' }}>
          <div className="panel__body panel__body--flush">
            <div className="dtable__scroll">
              <table className="dtable">
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">Status</th>
                    <th scope="col">Category</th>
                    <th scope="col">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((product) => (
                    <tr key={product.id}>
                      <td>
                        <Link
                          className="dtable__link"
                          to={{
                            pathname: '/shop/products',
                            search: asSearch(withParams(params, { id: product.id })),
                          }}
                        >
                          {product.title || 'Untitled product'}
                        </Link>
                        {product.tags.length > 0 && (
                          <span className="dtable__sub">{product.tags.join(' · ')}</span>
                        )}
                      </td>
                      <td>
                        <span className={`chip chip--${product.status}`}>
                          {STATUS_LABEL[product.status] ?? product.status}
                        </span>
                      </td>
                      <td>{product.category || <span className="dtable__sub">None</span>}</td>
                      <td className="num">{WHEN.format(new Date(product.updatedAt))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {more && (
        <p className="pager">
          <span className="pager__note">
            Showing the first {PAGE_LIMIT}. There are more — narrow by status or
            category to reach them.
          </span>
        </p>
      )}
    </>
  );
}

// ============================================================================
// FORM
// ============================================================================

function ProductForm({ id }: { id: string }) {
  const isNew = id === 'new';
  const [params, setParams] = useSearchParams();
  const { notify } = useToast();

  const [product, setProduct] = useState<ShopProductDetail | null>(null);
  const [categories, setCategories] = useState<ShopCategory[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmTrash, setConfirmTrash] = useState(false);

  // The editable buffer. Separate from `product` so an unsaved edit is visibly
  // unsaved and a lifecycle transition that returns a fresh product cannot
  // silently discard what is in the boxes.
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [description, setDescription] = useState<unknown>(null);
  const [coverImageId, setCoverImageId] = useState<string | null>(null);
  const [imageIds, setImageIds] = useState<string[]>([]);

  const adopt = useCallback((next: ShopProductDetail) => {
    setProduct(next);
    setTitle(next.title);
    setCategory(next.category);
    setTags(next.tags);
    setDescription(next.description);
    setCoverImageId(next.coverImageId);
    setImageIds(next.imageIds);
  }, []);

  const load = useCallback(
    (signal?: AbortSignal) => {
      if (isNew) return Promise.resolve();
      setLoading(true);
      setProblem(null);
      return shopApi
        .getProduct(id, signal)
        .then((next) => {
          if (signal?.aborted) return;
          adopt(next);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (signal?.aborted) return;
          setProblem(explain(err, 'product'));
          setLoading(false);
        });
    },
    [id, isNew, adopt],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  useEffect(() => {
    const ac = new AbortController();
    void shopApi
      .listCategories(ac.signal)
      .then((next) => !ac.signal.aborted && setCategories(next))
      .catch(() => {});
    return () => ac.abort();
  }, []);

  /**
   * Re-read, and take ONLY the variants from the answer.
   *
   * The variants panel writes through three routes of its own, and after any of
   * them the prices and stock on screen are stale. Calling `load` would fix
   * that and re-seed the whole editable buffer on the way — so setting a price
   * would silently throw away a title somebody had typed and not yet saved.
   * That is the "your work disappeared and nothing said so" failure this
   * codebase spends most of its care avoiding, one screen along.
   */
  const refreshVariants = useCallback(async () => {
    if (isNew) return;
    try {
      const next = await shopApi.getProduct(id);
      setProduct((prev) => (prev ? { ...prev, variants: next.variants } : next));
    } catch {
      // Swallowed: the rows on screen are the ones that were just there, and a
      // failed refresh is not a reason to replace a working panel with an error.
    }
  }, [id, isNew]);

  const backTo = {
    pathname: '/shop/products',
    search: asSearch(withParams(params, { id: null })),
  };

  const patch = (): ShopProductPatch => ({
    title: title.trim(),
    category: category.trim(),
    tags,
    coverImageId,
    imageIds,
    // `null` is what an editor that has not mounted yet holds. Sending it would
    // ask the server to validate a document that is not one; omitting the key
    // leaves the stored description alone, which is what "I did not touch it"
    // should mean.
    ...(description === null ? {} : { description }),
  });

  async function save() {
    setSaving(true);
    setConflict(false);
    try {
      if (isNew) {
        const created = await shopApi.createProduct(patch());
        notify('Product created as a draft');
        /*
         * REPLACE, not push. `?id=new` is not somewhere Back should return to —
         * it would be a second empty create form on top of a product that now
         * exists, and a second save would make a duplicate.
         */
        setParams(withParams(params, { id: created.id }), { replace: true });
        return;
      }
      const saved = await shopApi.saveProduct(id, patch(), {
        baseRevision: product?.revision,
      });
      // Variants are not in the PATCH response, so they are carried across
      // rather than dropped — re-fetching the whole product to redraw a title
      // would throw away every unsaved variant edit on the screen.
      setProduct((prev) => (prev ? { ...prev, ...saved, variants: prev.variants } : prev));
      notify('Saved');
    } catch (err) {
      if (err instanceof StaleWriteError) {
        /*
         * The shop's 409 carries the SERVER'S CURRENT PRODUCT in the body
         * (`server/shop/app.ts` renders it under the key `product`, because the
         * shared `StaleWriteError` carries a `Post` and that is a different
         * shape). `api.ts`'s error mapper reads `post`, so `err.product` does
         * not exist and `err.post` is null — the row is read out of the raw body
         * instead, which is what the server put it there for: "load theirs"
         * needs no second request.
         */
        setConflict(true);
        const theirs = (err.body as { product?: ShopProductDetail } | undefined)?.product;
        if (theirs) setProduct((prev) => ({ ...theirs, variants: prev?.variants ?? [] }));
      } else {
        notify(explain(err, 'save'), { tone: 'danger' });
      }
    } finally {
      setSaving(false);
    }
  }

  async function transition(op: 'publish' | 'unpublish' | 'archive' | 'unarchive' | 'restore') {
    try {
      const next = await shopApi.transitionProduct(id, op);
      // The transitions return the NEW product so the form can adopt the bumped
      // revision without a second request. Without it the next save would carry
      // a base the server has already passed and 409 against itself.
      setProduct((prev) => (prev ? { ...prev, ...next } : prev));
      notify(
        op === 'publish'
          ? 'Published — it is now on the storefront'
          : op === 'unpublish'
            ? 'Back to draft'
            : op === 'archive'
              ? 'Archived'
              : op === 'unarchive'
                ? 'Back to draft'
                : 'Restored from the trash',
      );
    } catch (err) {
      notify(explain(err, 'change'), { tone: 'danger' });
    }
  }

  if (loading) {
    return (
      <div className="panel" aria-hidden="true">
        <div className="panel__body">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} height={20} width={`${92 - i * 8}%`} />
          ))}
        </div>
      </div>
    );
  }

  if (!isNew && !product) {
    return (
      <div className="empty">
        <div className="empty__mark" aria-hidden="true">
          <Package />
        </div>
        <h2 className="empty__title">That product isn&rsquo;t here</h2>
        <p className="empty__body">{problem ?? 'It may have been opened from a stale link.'}</p>
        <Link className="btn btn--outline" to={backTo}>
          Back to the catalogue
        </Link>
      </div>
    );
  }

  const status = product?.status ?? 'draft';

  return (
    <>
      <div className="shopfilters" style={{ marginTop: 0 }}>
        <Link className="btn btn--ghost btn--sm" to={backTo}>
          <ArrowLeft className="ui-ic" aria-hidden="true" />
          Catalogue
        </Link>
        {!isNew && (
          <span className={`chip chip--${status}`}>{STATUS_LABEL[status] ?? status}</span>
        )}
        <span className="pager__note">
          {isNew
            ? 'New products start as drafts and sell nothing until published.'
            : `Revision ${product?.revision ?? 0} · updated ${WHEN.format(new Date(product!.updatedAt))}`}
        </span>
      </div>

      {conflict && (
        <div className="notice notice--warn" role="alert">
          <div>
            <strong>Somebody else saved this product first.</strong> The fields below
            still hold your version; the panel now shows theirs. Save again to overwrite
            it, or leave the form to keep theirs.
          </div>
          <div className="notice__actions">
            <button
              className="btn btn--outline btn--sm"
              onClick={() => {
                if (product) adopt(product);
                setConflict(false);
              }}
            >
              Use theirs
            </button>
          </div>
        </div>
      )}

      <div className="shopgrid" style={{ marginTop: 'var(--s5)' }}>
        <div className="shopgrid__col">
          <section className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Details</h2>
            </div>
            <div className="panel__body shopform">
              <div className="shopform__field">
                <label className="label" htmlFor="prod-title">
                  Title
                </label>
                <input
                  id="prod-title"
                  className="input"
                  value={title}
                  maxLength={400}
                  placeholder="Enamel mug"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>

              <div className="shopform__field">
                <span className="label">Description</span>
                <DescriptionEditor value={description} onChange={setDescription} />
                <p className="shopform__hint">
                  The same editor the blog uses, in a box. Pictures belong in the
                  images panel, not in here — the description is text on a product
                  page, and an image dropped into it is not part of what the shop
                  knows the product owns.
                </p>
              </div>

              <div className="shopform__split">
                <CategoryField
                  value={category}
                  options={categories}
                  onChange={setCategory}
                />
                <TagsField value={tags} onChange={setTags} />
              </div>

              <div className="shopform__actions">
                <button className="btn btn--primary" disabled={saving} onClick={() => void save()}>
                  {saving ? 'Saving…' : isNew ? 'Create product' : 'Save changes'}
                </button>
                {!isNew && (
                  <span className="shopform__hint">
                    Saves carry the revision this form loaded, so a second tab is
                    refused rather than silently overwritten.
                  </span>
                )}
              </div>
            </div>
          </section>

          {!isNew && product && (
            <VariantsPanel product={product} onChanged={() => void refreshVariants()} />
          )}
        </div>

        <div className="shopgrid__col">
          <ImagesPanel
            coverImageId={coverImageId}
            imageIds={imageIds}
            onCover={setCoverImageId}
            onGallery={setImageIds}
          />

          {!isNew && (
            <section className="panel">
              <div className="panel__head">
                <h2 className="panel__title">Lifecycle</h2>
              </div>
              <div className="panel__body shopform">
                <div className="shopform__actions">
                  {status === 'draft' && (
                    <button className="btn btn--outline btn--sm" onClick={() => void transition('publish')}>
                      Publish
                    </button>
                  )}
                  {status === 'active' && (
                    <button className="btn btn--outline btn--sm" onClick={() => void transition('unpublish')}>
                      Unpublish
                    </button>
                  )}
                  {(status === 'draft' || status === 'active') && (
                    <button className="btn btn--outline btn--sm" onClick={() => void transition('archive')}>
                      Archive
                    </button>
                  )}
                  {status === 'archived' && (
                    <button className="btn btn--outline btn--sm" onClick={() => void transition('unarchive')}>
                      Unarchive
                    </button>
                  )}
                  {status === 'trash' && (
                    <button className="btn btn--outline btn--sm" onClick={() => void transition('restore')}>
                      Restore
                    </button>
                  )}
                  {status !== 'trash' && (
                    <button className="btn btn--danger btn--sm" onClick={() => setConfirmTrash(true)}>
                      Move to trash
                    </button>
                  )}
                </div>
                {/* There is deliberately no hard delete: a product referenced by
                    an order line that snapshots its price must not be able to
                    vanish, so the server offers no route that would. */}
                <p className="shopform__hint">
                  Trashing is reversible. Nothing here ever destroys a product —
                  order history has to keep pointing at something.
                </p>
              </div>
            </section>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmTrash}
        onClose={() => setConfirmTrash(false)}
        title="Move to trash?"
        description={
          <>
            &ldquo;{title || 'Untitled product'}&rdquo; comes off the storefront
            immediately. Existing orders are unaffected and it can be restored.
          </>
        }
        confirmLabel="Move to trash"
        danger
        onConfirm={async () => {
          try {
            const next = await shopApi.trashProduct(id);
            setProduct((prev) => (prev ? { ...prev, ...next } : prev));
            notify('Moved to trash', { tone: 'danger' });
          } catch (err) {
            notify(explain(err, 'change'), { tone: 'danger' });
          }
        }}
      />
    </>
  );
}

// ============================================================================
// DESCRIPTION
// ============================================================================

/**
 * The post editor, bounded, with two extensions taken out.
 *
 * `studioImagePaste` GOES, and that is the §1.10 trap rather than a taste
 * decision: the orphan collector's reference walk covers a product's
 * `cover_image_id` and `image_ids` (once §2 A5 lands) and NOT images embedded in
 * its description document. An image pasted into this box would upload, commit,
 * render, and be deleted 24 hours later with the product page left pointing at
 * nothing. Removing the paste handler is what makes that unreachable; the image
 * NODE stays in the schema so a description that already holds one still renders.
 *
 * `placeholder` goes so it can come back saying something true — "Tell your
 * story…" is a blog's prompt and this is a product description.
 */
const DESCRIPTION_EXTENSIONS = [
  ...createEditorExtensions().filter(
    (ext) => ext.name !== 'studioImagePaste' && ext.name !== 'placeholder',
  ),
  Placeholder.configure({
    placeholder: 'What it is, what it is made of, who it is for…',
    showOnlyWhenEditable: true,
  }),
];

function DescriptionEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (doc: unknown) => void;
}) {
  const hydrated = useRef(false);

  const editor = useEditor({
    extensions: DESCRIPTION_EXTENSIONS,
    content: undefined,
    autofocus: false,
    editorProps: {
      attributes: {
        class: 'prose proddesc__surface',
        'aria-label': 'Product description',
        spellcheck: 'true',
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getJSON()),
  });

  /*
   * HYDRATED EXACTLY ONCE, with `addToHistory: false`, for the reason
   * `Editor.tsx` spells out at length: TipTap's `setContent` is an ordinary
   * undoable step, so loading the document pushes "empty → the whole
   * description" onto the undo stack and one Ctrl+Z empties the field. Hydration
   * is not an edit.
   */
  useEffect(() => {
    if (!editor || hydrated.current || value == null) return;
    hydrated.current = true;
    editor
      .chain()
      .setContent(value as never, { emitUpdate: false })
      .setMeta('addToHistory', false)
      .run();
  }, [editor, value]);

  return (
    <div className="proddesc">
      <EditorContent editor={editor} />
    </div>
  );
}

// ============================================================================
// CATEGORY + TAGS
// ============================================================================

/**
 * A picker over what exists, plus a way to name something that does not.
 *
 * FREE TEXT ONLY BEHIND AN EXPLICIT CHOICE. `shop_products.category` is a plain
 * text column with no managed list behind it, so a typo silently creates a
 * category — the same defect HANDOFF §1.6 records on the blog side. A Select
 * cannot produce a typo; the "New category…" arm can, and it is a deliberate
 * two-step rather than the default.
 */
function CategoryField({
  value,
  options,
  onChange,
}: {
  value: string;
  options: ShopCategory[];
  onChange: (v: string) => void;
}) {
  const known = options.some((o) => o.name === value);
  const [naming, setNaming] = useState(value !== '' && !known);

  const selectValue = naming ? NEW_CATEGORY : value === '' ? NO_CATEGORY : value;

  return (
    <div className="shopform__field">
      <span className="label">Category</span>
      <Select<string>
        label="Product category"
        value={selectValue}
        onChange={(v) => {
          if (v === NEW_CATEGORY) {
            setNaming(true);
            onChange('');
            return;
          }
          setNaming(false);
          onChange(v === NO_CATEGORY ? '' : v);
        }}
        options={[
          { value: NO_CATEGORY, label: 'No category' },
          ...options.map((o) => ({
            value: o.name,
            label: o.count > 0 ? `${o.name} (${o.count})` : o.name,
          })),
          ...(naming || known || value === '' ? [] : [{ value, label: value }]),
          { value: NEW_CATEGORY, label: 'New category…' },
        ]}
      />
      {naming && (
        <input
          className="input"
          autoFocus
          value={value}
          maxLength={400}
          aria-label="New category name"
          placeholder="Kitchenware"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <p className="shopform__hint">
        {naming
          ? 'The category exists as soon as a product is saved with it — there is no separate list to add it to.'
          : 'Drafts count too, so a category with no published product still appears here.'}
      </p>
    </div>
  );
}

function TagsField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  function add(raw: string) {
    const tag = raw.trim().replace(/^#/, '').slice(0, TAG_MAX_LEN);
    if (!tag) return;
    if (!value.includes(tag) && value.length < MAX_TAGS) onChange([...value, tag]);
    setDraft('');
  }

  return (
    <div className="shopform__field">
      <span className="label">
        Tags ({value.length}/{MAX_TAGS})
      </span>
      <div className="shoptags">
        {value.map((tag) => (
          <span className="shoptags__tag" key={tag}>
            {tag}
            <button
              onClick={() => onChange(value.filter((t) => t !== tag))}
              aria-label={`Remove tag ${tag}`}
            >
              ×
            </button>
          </span>
        ))}
        {value.length < MAX_TAGS && (
          <input
            className="shoptags__input"
            value={draft}
            maxLength={TAG_MAX_LEN}
            aria-label="Add a tag"
            placeholder={value.length ? 'Add another' : 'Add a tag'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                add(draft);
              } else if (e.key === 'Backspace' && !draft) {
                onChange(value.slice(0, -1));
              }
            }}
            onBlur={() => add(draft)}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================================
// VARIANTS
// ============================================================================

/**
 * The variants, their prices and their stock, inline.
 *
 * THREE SEPARATE WRITES BEHIND ONE ROW, and they are separate because the server
 * makes them separate: `PATCH /admin/variants/:id` changes the SKU and options,
 * `PUT /admin/variants/:id/price` appends a price row ("what did this cost on
 * Tuesday" is a question the shop has to be able to answer), and
 * `POST /admin/inventory/:id/adjust` records a signed delta with a mandatory
 * reason. A single "save row" button would have to invent an order for them and
 * would leave the row half-written when the second call failed.
 */
function VariantsPanel({
  product,
  onChanged,
}: {
  product: ShopProductDetail;
  onChanged: () => void;
}) {
  const { notify } = useToast();
  const [sku, setSku] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Variants</h2>
        <span className="pager__note">
          {product.variants.length} · prices are appended, never overwritten
        </span>
      </div>

      <div className="panel__body panel__body--flush">
        {product.variants.length === 0 ? (
          <p className="panel__note" style={{ padding: 'var(--s4)' }}>
            A product sells nothing until it has a variant with a price. Even a
            product with one version needs one.
          </p>
        ) : (
          <div className="dtable__scroll">
            <table className="dtable">
              <thead>
                <tr>
                  <th scope="col">SKU</th>
                  <th scope="col">Price</th>
                  <th scope="col">Stock</th>
                </tr>
              </thead>
              <tbody>
                {product.variants.map((variant) => (
                  <VariantRow key={variant.id} variant={variant} onChanged={onChanged} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel__body shopform" style={{ borderTop: '1px solid var(--rule)' }}>
        <div className="shopform__field">
          <label className="label" htmlFor="new-variant-sku">
            Add a variant
          </label>
          <div className="shopform__row">
            <input
              id="new-variant-sku"
              className="input"
              style={{ maxWidth: '16rem' }}
              value={sku}
              maxLength={200}
              placeholder="MUG-ENAMEL-BLUE"
              onChange={(e) => setSku(e.target.value)}
            />
            <button
              className="btn btn--outline btn--sm"
              disabled={busy || sku.trim() === ''}
              onClick={async () => {
                setBusy(true);
                try {
                  await shopApi.createVariant(product.id, { sku: sku.trim() });
                  setSku('');
                  notify('Variant added — give it a price next');
                  onChanged();
                } catch (err) {
                  notify(explain(err, 'variant'), { tone: 'danger' });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Add
            </button>
          </div>
          <p className="shopform__hint">
            The SKU is what an order line records, so it outlives the product.
          </p>
        </div>
      </div>
    </section>
  );
}

function VariantRow({
  variant,
  onChanged,
}: {
  variant: ShopVariant;
  onChanged: () => void;
}) {
  const { notify } = useToast();
  /** The store's currency for a variant that has never been priced. */
  const currency = variant.price?.currency ?? 'GBP';

  /*
   * The box shows MAJOR units and the request carries MINOR ones, and the two
   * conversions are the only ones on this screen. A price seeded from
   * `formatMinor` would arrive with a currency symbol in it, so the seed is the
   * digits only — `19.90`, including the trailing zero the operator would
   * otherwise have to notice was missing.
   */
  const [priceDraft, setPriceDraft] = useState(
    variant.price ? majorDigits(variant.price.amount, variant.price.currency) : '',
  );
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const parsed = priceDraft.trim() === '' ? null : parseMajor(priceDraft, currency);
  const priceError = parsed && !parsed.ok ? moneyRefusalMessage(parsed.reason, currency) : null;
  const changed = parsed?.ok && parsed.minor !== (variant.price?.amount ?? -1);

  const deltaValue = Number(delta);
  const deltaOk = delta.trim() !== '' && Number.isSafeInteger(deltaValue) && deltaValue !== 0;

  return (
    <tr>
      <td>
        <span className="dtable__strong">{variant.sku}</span>
        <span className="dtable__sub">
          {Object.entries(variant.optionValues ?? {})
            .map(([k, v]) => `${k} ${v}`)
            .join(' · ') || 'No options'}
          {variant.status === 'discontinued' && ' · discontinued'}
        </span>
      </td>

      <td>
        <div className="shopform__row">
          <input
            className="input"
            style={{ maxWidth: '8rem' }}
            inputMode="decimal"
            value={priceDraft}
            aria-label={`Price for ${variant.sku} in ${currency}`}
            placeholder="0.00"
            onChange={(e) => setPriceDraft(e.target.value)}
          />
          <button
            className="btn btn--outline btn--sm"
            disabled={busy || !changed}
            onClick={async () => {
              if (!parsed?.ok) return;
              setBusy(true);
              try {
                await shopApi.setVariantPrice(variant.id, parsed.minor, currency);
                notify(`Priced at ${formatMinor(parsed.minor, currency)}`);
                onChanged();
              } catch (err) {
                notify(explain(err, 'price'), { tone: 'danger' });
              } finally {
                setBusy(false);
              }
            }}
          >
            Set
          </button>
        </div>
        {priceError ? (
          <span className="shopform__error">{priceError}</span>
        ) : (
          <span className="dtable__sub">
            {variant.price
              ? `Now ${formatMinor(variant.price.amount, variant.price.currency)}`
              : 'Never priced — it cannot be sold'}
          </span>
        )}
      </td>

      <td>
        <div className="shopform__row">
          <input
            className="input"
            style={{ maxWidth: '5rem' }}
            inputMode="numeric"
            value={delta}
            aria-label={`Stock change for ${variant.sku}`}
            placeholder="+10"
            onChange={(e) => setDelta(e.target.value)}
          />
          <input
            className="input"
            style={{ maxWidth: '10rem' }}
            value={reason}
            maxLength={400}
            aria-label={`Reason for the stock change to ${variant.sku}`}
            placeholder="Why"
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            className="btn btn--outline btn--sm"
            disabled={busy || !deltaOk || reason.trim() === ''}
            onClick={async () => {
              setBusy(true);
              try {
                await shopApi.adjustInventory(variant.id, deltaValue, reason.trim());
                setDelta('');
                setReason('');
                notify('Stock adjusted');
                onChanged();
              } catch (err) {
                notify(explain(err, 'stock change'), { tone: 'danger' });
              } finally {
                setBusy(false);
              }
            }}
          >
            Adjust
          </button>
        </div>
        {/* The reason is mandatory on the server too. An unexplained stock
            change is the one you will most wish you had logged. */}
        <span className="dtable__sub">
          {variant.available === null
            ? 'Not tracked'
            : `${variant.available} available${variant.backorderable ? ', backorderable' : ''}`}
          {' · a reason is required'}
        </span>
      </td>
    </tr>
  );
}

// ============================================================================
// IMAGES
// ============================================================================

/**
 * Cover and gallery, through the same slot → PUT → commit path as post covers.
 *
 * `storeImageFile` IS REUSED WHOLE rather than reimplemented: it validates the
 * type and size before anything is uploaded, re-encodes through a canvas so no
 * EXIF (and no GPS coordinate) survives, PUTs with the exact headers the slot
 * signature was built from, and commits — and every one of those is a separate
 * thing to get wrong. It returns the server's asset id, which is precisely what
 * `coverImageId` and `imageIds` hold.
 *
 * `api.imageUrl(id)` RATHER THAN `StoredImg`. `StoredImg` resolves through
 * `acquireImageURL`, which looks in the local IndexedDB store first because a
 * pre-cutover post's images live only there. A product image has no such
 * history — it was uploaded to the server or it does not exist — so the direct
 * URL is both correct and one fewer database to open on this screen.
 */
function ImagesPanel({
  coverImageId,
  imageIds,
  onCover,
  onGallery,
}: {
  coverImageId: string | null;
  imageIds: string[];
  onCover: (id: string | null) => void;
  onGallery: (ids: string[]) => void;
}) {
  const { notify } = useToast();
  const coverInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'cover' | 'gallery' | null>(null);

  async function upload(file: File | undefined, into: 'cover' | 'gallery') {
    if (!file) return;
    setBusy(into);
    try {
      const stored = await storeImageFile(file);
      // Only after a fully successful COMMIT does the id go into the form. A
      // half-uploaded image in `imageIds` is a 400 on the next save, naming a
      // field the operator never typed in.
      if (into === 'cover') onCover(stored.id);
      else onGallery([...imageIds, stored.id].slice(0, MAX_GALLERY));
      notify('Image uploaded — save the product to keep it');
    } catch (err) {
      notify(
        err instanceof ImageError ? err.message : 'That image could not be added.',
        { tone: 'danger' },
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Images</h2>
      </div>
      <div className="panel__body shopform">
        <input
          ref={coverInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            void upload(file, 'cover');
          }}
        />
        <input
          ref={galleryInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            void upload(file, 'gallery');
          }}
        />

        <div className="shopform__field">
          <span className="label">Cover</span>
          <div className="imgpick">
            {coverImageId ? (
              <div className="imgpick__tile">
                <img className="imgpick__img" src={api.imageUrl(coverImageId)} alt="" />
                <button className="imgpick__drop" onClick={() => onCover(null)}>
                  Remove
                </button>
              </div>
            ) : null}
            <button
              className="imgpick__add"
              disabled={busy !== null}
              onClick={() => coverInput.current?.click()}
            >
              <ImagePlus className="ui-ic" aria-hidden="true" />
              {busy === 'cover' ? 'Uploading…' : coverImageId ? 'Replace' : 'Add a cover'}
            </button>
          </div>
        </div>

        <div className="shopform__field">
          <span className="label">
            Gallery ({imageIds.length}/{MAX_GALLERY})
          </span>
          <div className="imgpick">
            {imageIds.map((imageId) => (
              <div className="imgpick__tile" key={imageId}>
                <img className="imgpick__img" src={api.imageUrl(imageId)} alt="" />
                <button
                  className="imgpick__drop"
                  onClick={() => onGallery(imageIds.filter((x) => x !== imageId))}
                >
                  Remove
                </button>
              </div>
            ))}
            {imageIds.length < MAX_GALLERY && (
              <button
                className="imgpick__add"
                disabled={busy !== null}
                onClick={() => galleryInput.current?.click()}
              >
                <ImagePlus className="ui-ic" aria-hidden="true" />
                {busy === 'gallery' ? 'Uploading…' : 'Add'}
              </button>
            )}
          </div>
        </div>

        {/*
          THE §1.10 WARNING, SAID WHERE IT MATTERS. Until the orphan collector's
          reference walk unions `cover_image_id` and `unnest(image_ids)`, an
          image referenced only by a product is unreferenced as far as the sweep
          is concerned and is collected 24 hours after upload. This sentence
          comes out the moment §2 A5 lands; leaving it in after that would be its
          own kind of lie.
        */}
        <p className="shopform__hint">
          Images are stored on the blog and only counted as in use once the
          product references them, so save the product after uploading.
        </p>
      </div>
    </section>
  );
}

// ============================================================================
// SMALL THINGS
// ============================================================================

/**
 * Minor units → the digits a person would type. `1990, 'GBP'` → `19.90`.
 *
 * `formatMinor` and then the symbol stripped, rather than a second split of the
 * integer: one implementation of "where does the decimal point go" is the whole
 * point of putting it in `api-shop.ts`, and a second one here would be the
 * second implementation that drifts.
 */
function majorDigits(amount: number, currency: string): string {
  return formatMinor(amount, currency).replace(/[^\d.]/g, '');
}

/**
 * NOTHING HERE SAYS "the blog", and that is the point.
 *
 * This is the shop. Every message on this screen used to be phrased as the blog
 * refusing something — "The blog refused the sku." for a SKU that was merely
 * already in use — which named the wrong system AND the wrong problem in one
 * sentence, and sent somebody hunting for bad characters in a perfectly good
 * SKU. Field names are not error messages: `detail` is a field NAME by the
 * server's own convention, so rendering it raw shows the caller our schema
 * rather than their mistake.
 */
const FIELD_TROUBLE: Record<string, string> = {
  sku: 'That SKU isn’t usable — it can’t be blank.',
  title: 'The title is too long or empty.',
  category: 'That category name isn’t usable.',
  tags: 'One of those tags isn’t usable.',
  delta: 'That stock change would take the count below zero.',
  reason: 'A reason is required.',
  amount: 'That price isn’t a whole number of minor units.',
  currency: 'That currency code isn’t a three-letter ISO code.',
  coverImageId: 'That cover image isn’t one this shop can use yet.',
  imageIds: 'One of those images isn’t one this shop can use yet.',
  imageId: 'That image isn’t one this shop can use yet.',
  patch: 'Nothing was changed.',
};

function explain(err: unknown, what: string): string {
  if (err instanceof OfflineError) return 'The request didn’t reach the server.';
  if (err instanceof NotFoundError) return `That ${what} no longer exists.`;
  if (err instanceof ApiError) {
    // The SKU conflict, named as the conflict it is. `sku` rides along on the
    // body so this quotes what the server actually rejected.
    if (err.status === 409 && err.code === 'duplicate_sku') {
      const rec = (err.body ?? {}) as Record<string, unknown>;
      const sku = typeof rec.sku === 'string' ? rec.sku : '';
      return sku
        ? `SKU “${sku}” is already used by another variant. SKUs are unique across the whole catalogue.`
        : 'That SKU is already used by another variant.';
    }
    if (err.status === 403) return 'Your account isn’t allowed to do that.';
    if (err.status === 409) return 'Something else changed this first. Reload and look again.';
    if (err.status === 422) return 'That description was refused as unsafe.';
    if (err.status === 429) return 'Too many changes too quickly — wait a moment and retry.';
    if (err.status === 400 && err.detail) {
      return FIELD_TROUBLE[err.detail] ?? `The ${err.detail} wasn’t accepted.`;
    }
  }
  return `The ${what} didn’t go through.`;
}

/** See `Shop.tsx` for why this row is copied into each screen. */
function ShopNav() {
  return (
    <nav className="shopscr__nav" aria-label="Shop sections">
      <Link className="shopscr__tab" to="/shop">
        Overview
      </Link>
      <Link className="shopscr__tab" to="/shop/products" aria-current="page">
        Products
      </Link>
      <Link className="shopscr__tab" to="/shop/orders">
        Orders
      </Link>
      <Link className="shopscr__tab" to="/shop/customers">
        Customers
      </Link>
    </nav>
  );
}
