import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { EditorContent, useEditor } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import { ArrowLeft, ImagePlus, Package, Plus, Search, Trash2, X } from 'lucide-react';
import {
  shopApi,
  type ProductStatus,
  type ShopCategory,
  type ShopProduct,
  type ShopProductDetail,
  type ShopProductPatch,
  type ShopTag,
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
import { VariantsPanel } from './ShopVariants';
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

/**
 * The open product's section, in the URL like everything else on this screen —
 * a reload lands on the tab somebody was reading, and a link can point at "the
 * variants of this product". `details` is the default and is DELETED from the
 * query rather than written, so the plain `?id=` URL stays canonical.
 */
const FORM_TABS = ['details', 'images', 'variants'] as const;
type FormTab = (typeof FORM_TABS)[number];

function readTab(params: URLSearchParams): FormTab {
  const raw = params.get('tab') ?? '';
  return (FORM_TABS as readonly string[]).includes(raw) ? (raw as FormTab) : 'details';
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
    /*
      `--form` PULLS THE WHOLE PAGE UP. The list view keeps the masthead's
      breathing room; the form view starts where the eye starts, because on a
      detail page every centimetre above the back bar is a centimetre the
      actual subject is pushed down by.
    */
    <div className={`shopscr${openId ? ' shopscr--form' : ''}`}>
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
              to={{
                pathname: '/shop/products',
                // `tab: null` — a leaked ?tab=images would open the create
                // form on its Images tab, title unasked-for.
                search: asSearch(withParams(params, { id: 'new', tab: null })),
              }}
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
            to={{
              pathname: '/shop/products',
              search: asSearch(withParams(params, { id: 'new', tab: null })),
            }}
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
  /*
   * The document is a deep tree and diffing it per keystroke buys nothing — a
   * flag set by the editor's own onUpdate (hydration never fires it) is the
   * honest "the words changed" bit, cleared when a save lands or `adopt`
   * re-seeds the buffer from the server.
   */
  const [descDirty, setDescDirty] = useState(false);

  const adopt = useCallback((next: ShopProductDetail) => {
    setProduct(next);
    setTitle(next.title);
    setCategory(next.category);
    setTags(next.tags);
    setDescription(next.description);
    setCoverImageId(next.coverImageId);
    setImageIds(next.imageIds);
    setDescDirty(false);
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

  /*
   * The tag vocabulary, for the tag box's suggestions. Swallowed on failure
   * exactly as the categories are: the box still works, it just offers
   * nothing — and offering nothing is how the PLA/pla/Pla mess was typed in
   * the first place, so the request is worth making.
   */
  const [tagVocab, setTagVocab] = useState<ShopTag[]>([]);
  useEffect(() => {
    const ac = new AbortController();
    void shopApi
      .listTags(ac.signal)
      .then((next) => !ac.signal.aborted && setTagVocab(next))
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
    // `tab` goes too: it is THIS product's open section, and carried back to
    // the list it silently decides which tab the NEXT product opens on.
    search: asSearch(withParams(params, { id: null, tab: null })),
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
      // The server may have re-spelled category and tags onto the catalogue's
      // canon (fold.ts) — the buffer adopts what was actually stored, so the
      // boxes show the truth rather than the keystrokes.
      setTitle(saved.title);
      setCategory(saved.category);
      setTags(saved.tags);
      setDescDirty(false);
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

  const tab = readTab(params);
  // Variants attach to a product id; on `?id=new` the tab cannot exist yet.
  const activeTab: FormTab = isNew && tab === 'variants' ? 'details' : tab;
  const tabTo = (t: FormTab) => ({
    pathname: '/shop/products',
    search: asSearch(withParams(params, { tab: t === 'details' ? null : t })),
  });

  /*
   * "Unsaved changes" is computed against the row the form loaded, field by
   * field — not tracked as a boolean set by every onChange, which reads as
   * dirty after somebody types a letter and deletes it again. The description
   * is the one exception (`descDirty` above): a document diff per keystroke
   * buys nothing.
   */
  const dirty =
    descDirty ||
    (isNew
      ? title.trim() !== '' ||
        category !== '' ||
        tags.length > 0 ||
        coverImageId !== null ||
        imageIds.length > 0
      : product
        ? title !== product.title ||
          category !== product.category ||
          tags.join(' ') !== product.tags.join(' ') ||
          coverImageId !== product.coverImageId ||
          imageIds.join(' ') !== product.imageIds.join(' ')
        : false);

  const imageCount = (coverImageId ? 1 : 0) + imageIds.length;
  const variantCount = product?.variants.length ?? 0;

  return (
    <>
      {/*
        ONE BAR OWNS THE PRODUCT-WIDE ACTS: where you came from, what state the
        product is in, the lifecycle moves, and Save. Save lives here and not
        inside a tab because title, description, category, tags, cover and
        gallery are ONE PATCH — a Save button that vanished when you clicked
        over to Images would imply the images save separately, and they do not.
      */}
      <div className="prodbar">
        <Link className="btn btn--ghost btn--sm" to={backTo}>
          <ArrowLeft className="ui-ic" aria-hidden="true" />
          Catalogue
        </Link>
        {!isNew && (
          <span className={`chip chip--${status}`}>{STATUS_LABEL[status] ?? status}</span>
        )}
        <span className="prodbar__note">
          {isNew
            ? 'New products start as drafts and sell nothing until published.'
            : `Revision ${product?.revision ?? 0} · updated ${WHEN.format(new Date(product!.updatedAt))}`}
        </span>
        <span className="prodbar__grow" aria-hidden="true" />
        {dirty && <span className="prodbar__dirty">Unsaved changes</span>}
        {!isNew && (
          <div className="prodbar__ops">
            {status === 'draft' && (
              <button
                className="btn btn--outline btn--sm"
                onClick={() => void transition('publish')}
              >
                Publish
              </button>
            )}
            {status === 'active' && (
              <button
                className="btn btn--outline btn--sm"
                onClick={() => void transition('unpublish')}
              >
                Unpublish
              </button>
            )}
            {(status === 'draft' || status === 'active') && (
              <button
                className="btn btn--outline btn--sm"
                onClick={() => void transition('archive')}
              >
                Archive
              </button>
            )}
            {status === 'archived' && (
              <button
                className="btn btn--outline btn--sm"
                onClick={() => void transition('unarchive')}
              >
                Unarchive
              </button>
            )}
            {status === 'trash' && (
              <button
                className="btn btn--outline btn--sm"
                onClick={() => void transition('restore')}
              >
                Restore
              </button>
            )}
            {/* There is deliberately no hard delete: a product referenced by an
                order line that snapshots its price must not be able to vanish,
                so the server offers no route that would. */}
            {status !== 'trash' && (
              <button
                className="btn btn--ghost btn--sm"
                aria-label="Move to trash"
                title="Move to trash — reversible"
                onClick={() => setConfirmTrash(true)}
              >
                <Trash2 className="ui-ic" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        <button
          className="btn btn--primary btn--sm"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : isNew ? 'Create product' : 'Save changes'}
        </button>
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

      {/*
        THE SECTIONS ARE TABS, AND THE TAB IS IN THE URL. Details, Images and
        Variants used to sit in one two-column sprawl — the variants (the part
        with the prices in it) started below the fold on any product with a
        real description. One section at a time puts every field on screen at
        the size it deserves, and `?tab=` means a reload or a shared link lands
        on the same section. Counts are honest: both lists are fully loaded,
        not paged guesses.
      */}
      <nav className="shoptabs prodtabs" aria-label="Product sections">
        <Link
          className={`shoptabs__tab${activeTab === 'details' ? ' is-active' : ''}`}
          aria-current={activeTab === 'details' ? 'page' : undefined}
          replace
          to={tabTo('details')}
        >
          Details
        </Link>
        <Link
          className={`shoptabs__tab${activeTab === 'images' ? ' is-active' : ''}`}
          aria-current={activeTab === 'images' ? 'page' : undefined}
          replace
          to={tabTo('images')}
        >
          Images{imageCount > 0 ? ` (${imageCount})` : ''}
        </Link>
        {isNew ? (
          <span
            className="shoptabs__tab is-disabled"
            title="Create the product first — variants attach to it"
          >
            Variants
          </span>
        ) : (
          <Link
            className={`shoptabs__tab${activeTab === 'variants' ? ' is-active' : ''}`}
            aria-current={activeTab === 'variants' ? 'page' : undefined}
            replace
            to={tabTo('variants')}
          >
            Variants{variantCount > 0 ? ` (${variantCount})` : ''}
          </Link>
        )}
      </nav>

      <div className="prodbody">
        {activeTab === 'details' && (
          <section className="panel">
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
                <DescriptionEditor
                  value={description}
                  onChange={(doc) => {
                    setDescription(doc);
                    setDescDirty(true);
                  }}
                />
                <p className="shopform__hint">
                  The same editor the blog uses, in a box. Pictures belong in the
                  Images tab, not in here — the description is text on a product
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
                <TagsField value={tags} vocabulary={tagVocab} onChange={setTags} />
              </div>

              {!isNew && (
                <p className="shopform__hint">
                  Saves carry the revision this form loaded, so a second tab is
                  refused rather than silently overwritten.
                </p>
              )}
            </div>
          </section>
        )}

        {activeTab === 'images' && (
          <ImagesPanel
            coverImageId={coverImageId}
            imageIds={imageIds}
            onCover={setCoverImageId}
            onGallery={setImageIds}
          />
        )}

        {activeTab === 'variants' && !isNew && product && (
          <VariantsPanel product={product} onChanged={() => void refreshVariants()} />
        )}
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

  /*
   * A typed name that case-matches an existing category IS that category —
   * the server adopts the stored spelling on save (`catalog/fold.ts`), so the
   * hint says so while the person is still typing rather than surprising them
   * after the round trip. The list is folded server-side, so one option per
   * group is all there is to match against.
   */
  const twin = naming
    ? options.find((o) => o.name.toLowerCase() === value.trim().toLowerCase())
    : undefined;
  const adopts = twin !== undefined && twin.name !== value.trim();

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
          onBlur={() => {
            // Adopt the stored spelling in the box itself the moment focus
            // leaves — the save would do it anyway; doing it here means what
            // is on screen is what will be stored.
            if (twin) {
              onChange(twin.name);
              setNaming(false);
            }
          }}
        />
      )}
      <p className="shopform__hint">
        {adopts
          ? `Matches the existing “${twin.name}” — that spelling will be used.`
          : naming
            ? 'The category exists as soon as a product is saved with it — there is no separate list to add it to.'
            : 'Drafts count too, so a category with no published product still appears here.'}
      </p>
    </div>
  );
}

/**
 * Tags, with the catalogue's own vocabulary offered while typing.
 *
 * The tag box was the door the `PLA / pla / Pla / pLA` mess came in through:
 * with nothing offered, every writer re-invents the spelling. Three defences,
 * in order of firing: matching existing tags appear as one-click suggestions;
 * a typed tag that case-matches the vocabulary (or a tag already in the list)
 * ADOPTS that spelling instead of minting a twin; and the server folds again
 * on save for whatever slips past a stale vocabulary.
 */
function TagsField({
  value,
  vocabulary,
  onChange,
}: {
  value: string[];
  vocabulary: ShopTag[];
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const fold = (s: string) => s.toLowerCase();
  const has = (tag: string) => value.some((t) => fold(t) === fold(tag));

  function add(raw: string) {
    const typed = raw.trim().replace(/^#/, '').slice(0, TAG_MAX_LEN);
    setDraft('');
    if (!typed) return;
    const known = vocabulary.find((t) => fold(t.name) === fold(typed));
    const tag = known ? known.name : typed;
    if (has(tag)) {
      // The entry went somewhere — say where, or a swallowed keystroke reads
      // as a broken box. Silent only when it is the literal same chip.
      const twin = value.find((t) => fold(t) === fold(tag));
      setNotice(twin !== typed ? `“${typed}” is already here as “${twin}”.` : null);
      return;
    }
    if (value.length < MAX_TAGS) {
      onChange([...value, tag]);
      setNotice(tag !== typed ? `Added as “${tag}” — the shop’s spelling.` : null);
    }
  }

  /*
   * Up to five, matched anywhere in the name, minus what is already chosen.
   * Suggestions only exist while something is typed — an always-open cloud of
   * every tag in the shop would dwarf the field it serves.
   */
  const suggestions =
    draft.trim() === ''
      ? []
      : vocabulary
          .filter((t) => fold(t.name).includes(fold(draft.trim())) && !has(t.name))
          .slice(0, 5);

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
            onChange={(e) => {
              setDraft(e.target.value);
              setNotice(null);
            }}
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
      {notice && <p className="shopform__hint">{notice}</p>}
      {suggestions.length > 0 && (
        <div className="shoptags__suggest" aria-label="Existing tags that match">
          {suggestions.map((t) => (
            <button
              key={t.name}
              type="button"
              className="shoptags__offer"
              /*
               * onMouseDown, because the input's onBlur fires first on click
               * and would add the TYPED text — then this click would find the
               * fold-twin already present and do nothing, which reads as a
               * broken button.
               */
              onMouseDown={(e) => {
                e.preventDefault();
                add(t.name);
              }}
            >
              {t.name}
              <span className="shoptags__count">{t.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// VARIANTS
// ============================================================================

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
