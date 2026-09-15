import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArchiveRestore,
  Boxes,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  moneyRefusalMessage,
  parseMajor,
  plainMajor,
  shopApi,
  type AuditEntry,
  type ProductLifecycleOp,
  type ProductStatus,
  type ShopCategory,
  type ShopProduct,
  type ShopProductDetail,
  type ShopProductPatch,
  type ShopTag,
  type ShopVariant,
} from '../../data/api-shop';
import type { BulkTier } from '../../data/api-shop';
import { ApiError } from '../../data/errors';
import { brand } from '../../brand';
import { dateTime, humanise, money, productTone, shortDate } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, ButtonLink, EmptyState } from '../ui/primitives';
import { Card } from '../ui/Card';
import { Defs } from '../ui/Defs';
import { AffixField, Checkbox, MoneyField, SelectField, TextArea, TextField } from '../ui/Field';
import { StoredImg, MediaManager, PhotoPicker, type MediaValue } from '../ui/Img';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { TableScroll } from '../ui/TableScroll';
import { Modal } from '../ui/Modal';
import { PopEdit, PopEditFoot } from '../ui/PopEdit';
import { RichText } from '../ui/RichText';
import { SaveBar } from '../ui/SaveBar';
import { StatusPicker, type StatusOption } from '../ui/StatusPicker';
import { TagInput } from '../ui/TagInput';
import { Timeline, type TimelineEvent } from '../ui/Timeline';
import { useToast } from '../ui/Toast';
import { StockCell } from './StockCell';

/**
 * PRODUCT DETAIL — `/products/:id`, and `/products/new` for creation.
 *
 * The shape is the reference admin's: title and description in the first
 * card, media, then variants as THE page's one table; status, organisation
 * and the record's facts on the sticky rail. Save is the contextual bar over
 * the topbar, carrying the CAS revision the form was loaded from.
 *
 * TWO DATA RULES FROM THE CLIENT CONTRACT, OBEYED THROUGHOUT:
 *  - `slug` and `status` are SERVER-AUTHORITATIVE. The slug is displayed and
 *    never edited; status moves only through the lifecycle ops, each of which
 *    answers with the new product so the form adopts the bumped revision.
 *  - Variant writes answer `ShopVariantBase` — price, stock and everOrdered
 *    are missing on purpose — so after every variant write this page
 *    RE-READS the product rather than adopting the response.
 */

/** The store currency, for a variant that has never been priced yet. Every
 *  priced variant carries its own. */
const STORE_CURRENCY = 'NGN';

/**
 * The storefront's public origin, for the search-listing facsimile. Display
 * only — nothing is fetched from it. There is no client-side constant to
 * import for this: PR #85 pointed every customer-facing link at plaspool.com
 * (`brand.url` is the ADMIN's own origin, which is exactly the wrong host to
 * show a shopper), so this states that decision locally.
 */
const STOREFRONT_ORIGIN = 'https://plaspool.com';
/** The origin as a URL-handle prefix draws it — scheme dropped. */
const STOREFRONT_HOST = STOREFRONT_ORIGIN.replace(/^https:\/\//, '');

function optionLabel(values: Record<string, string>): string | null {
  const parts = Object.values(values).filter(Boolean);
  return parts.length ? parts.join(' / ') : null;
}

/** Which lifecycle ops carry `from` to `to`. Archived→active is genuinely two
 *  transitions (unarchive lands on draft), run in order. */
function opsFor(from: ProductStatus, to: ProductStatus): ProductLifecycleOp[] | null {
  if (from === to) return [];
  if (from === 'draft' && to === 'active') return ['publish'];
  if (from === 'active' && to === 'draft') return ['unpublish'];
  if ((from === 'draft' || from === 'active') && to === 'archived') return ['archive'];
  if (from === 'archived' && to === 'draft') return ['unarchive'];
  if (from === 'archived' && to === 'active') return ['unarchive', 'publish'];
  return null;
}

const STATUS_OPTIONS: StatusOption<ProductStatus>[] = [
  { value: 'active', label: 'Active', description: 'On sale in your shop and findable in search.' },
  { value: 'draft', label: 'Draft', description: 'Not visible to customers until published.' },
  { value: 'archived', label: 'Archived', description: 'Taken out of your shop, but kept on record.' },
];

interface Bundle {
  product: ShopProductDetail | null;
  categories: ShopCategory[];
  tags: ShopTag[];
}

export default function ProductDetail({ create = false }: { create?: boolean }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /* ── drafts ───────────────────────────────────────────────────────────── */
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [namingCategory, setNamingCategory] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [media, setMedia] = useState<MediaValue>({ coverImageId: null, imageIds: [] });
  const [seoTitle, setSeoTitle] = useState('');
  const [seoDescription, setSeoDescription] = useState('');
  const [overview, setOverview] = useState('');
  const [bulkEnabled, setBulkEnabled] = useState(true);
  /* The shop-wide default, read once — the ladder shown while this product
     inherits, and what "Use the shop default" reverts to. */
  const [bulkTiers, setBulkTiers] = useState<BulkTier[]>([]);
  /**
   * This product's OWN rungs, or `null` while it inherits.
   *
   * `null` and `[]` ARE DIFFERENT STATES and the whole editor turns on it:
   * `null` is "follows the shop default", `[]` is "has its own ladder, which is
   * empty — never discount this product by quantity". Collapsing them would make
   * "Remove" on the last rung silently mean "start inheriting again", which is
   * the opposite of what somebody clicking it intends.
   */
  const [tierOwn, setTierOwn] = useState<BulkTier[] | null>(null);
  /** The last saved copy, so the Save button can tell dirty from pristine. */
  const [tierSaved, setTierSaved] = useState<BulkTier[] | null>(null);
  const [tierBusy, setTierBusy] = useState(false);
  const [tierError, setTierError] = useState<string | null>(null);
  const [description, setDescription] = useState<unknown>(null);
  const [descDirty, setDescDirty] = useState(false);
  /* Remounting the editor is how a discard rehydrates it. */
  const [editorKey, setEditorKey] = useState(0);

  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [variantModal, setVariantModal] = useState<'closed' | 'new' | ShopVariant>('closed');
  const [confirmDeleteVariant, setConfirmDeleteVariant] = useState<ShopVariant | null>(null);
  /** The search-listing card: the facsimile alone by default, the editors
   *  after the pencil. Purely presentational — the SEO drafts above stay in
   *  state either way, so collapsing loses nothing. */
  const [seoOpen, setSeoOpen] = useState(false);

  const product = bundle?.product ?? null;

  /*
   * The cheapest live variant price, so the table can show what each rung
   * actually costs rather than an abstract percentage. `null` for a product with
   * no priced variant yet, which renders as an em dash rather than as ₦0.00 —
   * "we have not priced this" and "this is free" are different claims.
   */
  const cheapest =
    product?.variants?.reduce<{ amount: number; currency: string } | null>((low, v) => {
      /* Narrowed on the whole object, not on `amount`: an unpriced variant is a
         real state (a draft nobody has costed), and `v.price` is null there. */
      const price = v.price;
      if (!price || typeof price.amount !== 'number') return low;
      return low === null || price.amount < low.amount
        ? { amount: price.amount, currency: price.currency }
        : low;
    }, null) ?? null;

  const adoptDrafts = useCallback((next: ShopProductDetail | null) => {
    setTitle(next?.title ?? '');
    setCategory(next?.category ?? '');
    setNamingCategory(false);
    setTags(next?.tags ?? []);
    setMedia({ coverImageId: next?.coverImageId ?? null, imageIds: next?.imageIds ?? [] });
    setSeoTitle(next?.seoTitle ?? '');
    setSeoDescription(next?.seoDescription ?? '');
    /* `?? ''` — a NULL overview is an EMPTY box, never the derived text. Putting
       the fallback in the value would make every save promote a derived summary
       into a hand-written one, and the product would silently stop tracking its
       own description. It goes in the placeholder instead. */
    setOverview(next?.overview ?? '');
    setBulkEnabled(next?.bulkDiscountEnabled ?? true);
    setDescription(next?.description ?? null);
    setDescDirty(false);
    setEditorKey((k) => k + 1);
  }, []);

  /**
   * `adopt` decides whether the form fields reset. The initial load adopts;
   * a refresh after a VARIANT write does not — stock and price live in other
   * tables, and clobbering a half-typed title because a price moved would be
   * this screen's worst habit.
   */
  const load = useCallback(
    async (adopt: boolean, signal?: AbortSignal) => {
      try {
        const [prod, categories, tagList] = await Promise.all([
          create ? Promise.resolve(null) : shopApi.getProduct(id!, signal),
          shopApi.listCategories(signal).catch(() => [] as ShopCategory[]),
          shopApi.listTags(signal).catch(() => [] as ShopTag[]),
        ]);
        setBundle({ product: prod, categories, tags: tagList });
        setLoadError(null);
        if (adopt) adoptDrafts(prod);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setLoadError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      }
    },
    [create, id, adoptDrafts],
  );

  useEffect(() => {
    setBundle(null);
    setLoadError(null);
    const controller = new AbortController();
    void load(true, controller.signal);
    return () => controller.abort();
  }, [load]);

  /*
   * The shop-wide ladder, for the preview table. Fetched ONCE per mount and not
   * per product: it is the same rows for every screen, and re-reading it on
   * every save would put a request on the path of an edit that cannot change it.
   *
   * A failure is swallowed to an empty ladder rather than surfaced. The table is
   * an explanation of a switch, not the switch itself — a product page that
   * refused to load because a preview table could not be drawn would be a worse
   * screen than one showing the checkbox alone.
   */
  useEffect(() => {
    const controller = new AbortController();
    shopApi
      .defaultBulkTiers()
      .then((tiers) => {
        if (!controller.signal.aborted) setBulkTiers(tiers);
      })
      .catch(() => {
        if (!controller.signal.aborted) setBulkTiers([]);
      });
    return () => controller.abort();
  }, []);

  /* ── the bulk ladder ─────────────────────────────────────────────────── */

  /** Overriding when the product owns rows; inheriting otherwise. */
  const overriding = tierOwn !== null;
  /** What the table draws: this product's rungs, else the inherited default. */
  const tierRows = tierOwn ?? bulkTiers;
  const tiersDirty = JSON.stringify(tierOwn) !== JSON.stringify(tierSaved);

  /* Seeded from the shop default rather than from nothing: "set a different
     ladder" almost always means "the usual one, adjusted", and an empty table
     with an Add button makes the common case the most work. */
  const beginOverride = () => {
    setTierError(null);
    setTierOwn(bulkTiers.map((t) => ({ ...t })));
  };

  const editRung = (i: number, patch: Partial<BulkTier>) => {
    setTierError(null);
    setTierOwn((rows) => (rows ?? []).map((r, n) => (n === i ? { ...r, ...patch } : r)));
  };

  const removeRung = (i: number) => {
    setTierError(null);
    setTierOwn((rows) => (rows ?? []).filter((_, n) => n !== i));
  };

  /* The next rung starts above the highest one so a fresh row is valid on
     arrival — `minQty` must be ≥ 2 and unique, and a duplicate would come back
     from the server as a refusal the user did not cause. */
  const addRung = () => {
    setTierError(null);
    setTierOwn((rows) => {
      const cur = rows ?? [];
      const top = cur.reduce((n, r) => Math.max(n, r.minQty), 1);
      return [...cur, { minQty: Math.max(2, top + 1), percentBps: 500 }];
    });
  };

  async function saveTiers() {
    if (!product?.id || tierBusy || tierOwn === null) return;
    /* Validated HERE as well as by the route's Zod, because a 400 naming
       `tiers.1.minQty` is not a sentence anybody can act on. */
    const seen = new Set<number>();
    for (const r of tierOwn) {
      if (!Number.isInteger(r.minQty) || r.minQty < 2) {
        setTierError('Every row needs a quantity of 2 or more.');
        return;
      }
      if (seen.has(r.minQty)) {
        setTierError(`Two rows both start at ${r.minQty}. Each quantity can only appear once.`);
        return;
      }
      seen.add(r.minQty);
      if (!Number.isInteger(r.percentBps) || r.percentBps < 1 || r.percentBps > 5000) {
        setTierError('Every discount must be between 0.01% and 50%.');
        return;
      }
    }
    setTierBusy(true);
    setTierError(null);
    try {
      const next = await shopApi.saveProductBulkTiers(product.id, tierOwn);
      /* Trust the SERVER's copy, not the draft: it sorts and de-duplicates, so
         echoing the draft back would leave the table in an order the next reload
         would silently change. */
      const rows = next.inherited ? null : next.tiers;
      setTierOwn(rows);
      setTierSaved(rows);
      toast.show(next.inherited ? 'Back to the shop default' : 'Bulk discounts saved');
    } catch (err) {
      setTierError(err instanceof ApiError ? err.message : 'Could not save the discounts.');
    } finally {
      setTierBusy(false);
    }
  }

  /* Reset is an empty PUT, which the server reads as "delete this product's own
     rows" — the one spelling that returns it to inheriting. It is not a DELETE
     route because "no ladder of my own" and "no ladder at all" are different
     states and only the first is expressible. */
  async function resetTiers() {
    if (!product?.id || tierBusy) return;
    setTierBusy(true);
    setTierError(null);
    try {
      await shopApi.saveProductBulkTiers(product.id, []);
      setTierOwn(null);
      setTierSaved(null);
      toast.show('Back to the shop default');
    } catch (err) {
      setTierError(err instanceof ApiError ? err.message : 'Could not reset the discounts.');
    } finally {
      setTierBusy(false);
    }
  }

  /* This product's stored rungs. Separate from the shop-default read above
     because the two answer different questions, and `inherited` is the only
     thing that distinguishes "no rows" from "rows equal to the default". */
  useEffect(() => {
    if (!product?.id) return;
    const controller = new AbortController();
    shopApi
      .productBulkTiers(product.id)
      .then((set) => {
        if (controller.signal.aborted) return;
        const rows = set.inherited ? null : set.tiers;
        setTierOwn(rows);
        setTierSaved(rows);
      })
      .catch(() => {
        /* Swallowed to "inheriting" rather than surfaced: the ladder is an
           adjunct to this screen, and a product page that refused to load
           because of it would be worse than one showing the default. */
        if (!controller.signal.aborted) {
          setTierOwn(null);
          setTierSaved(null);
        }
      });
    return () => controller.abort();
  }, [product?.id]);

  /* ── audit trail ─────────────────────────────────────────────────────── */
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [auditNonce, setAuditNonce] = useState(0);
  useEffect(() => {
    if (!product?.id) return;
    const controller = new AbortController();
    shopApi
      .listAudit({ productId: product.id, limit: 8 }, controller.signal)
      .then((res) => setAudit(res.items))
      .catch(() => setAudit(null));
    return () => controller.abort();
  }, [product?.id, auditNonce]);

  const afterVariantWrite = useCallback(() => {
    void load(false);
    setAuditNonce((n) => n + 1);
  }, [load]);

  /* ── dirtiness, the v1 way: field-by-field against the loaded product ── */
  const dirty = create
    ? title.trim() !== '' ||
      category !== '' ||
      tags.length > 0 ||
      media.coverImageId !== null ||
      media.imageIds.length > 0 ||
      seoTitle.trim() !== '' ||
      seoDescription.trim() !== '' ||
      overview.trim() !== '' ||
      !bulkEnabled ||
      descDirty
    : product
      ? title !== product.title ||
        category !== product.category ||
        tags.join('\0') !== product.tags.join('\0') ||
        media.coverImageId !== product.coverImageId ||
        media.imageIds.join('\0') !== product.imageIds.join('\0') ||
        seoTitle !== (product.seoTitle ?? '') ||
        seoDescription !== (product.seoDescription ?? '') ||
        overview !== (product.overview ?? '') ||
        bulkEnabled !== product.bulkDiscountEnabled ||
        descDirty
      : false;

  const patch = (): ShopProductPatch => ({
    title: title.trim(),
    category: category.trim(),
    tags,
    coverImageId: media.coverImageId,
    imageIds: media.imageIds,
    /* Sent as typed; the server trims and stores `''` as NULL, so a cleared
       box and a never-filled one converge on "use the defaults". */
    seoTitle,
    seoDescription,
    /* Sent as typed, like the SEO pair: an emptied box is `''`, which the server
       stores as NULL, which means "go back to deriving it". */
    overview,
    bulkDiscountEnabled: bulkEnabled,
    /* `null` is an editor that never mounted or hydrated — omitting the key
       leaves the stored description alone, v1's own rule. */
    ...(description === null ? {} : { description }),
  });

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      if (create) {
        const created = await shopApi.createProduct(patch());
        toast.show(`${created.title || 'Product'} created as a draft`);
        navigate(`/products/${created.id}`, { replace: true });
        return;
      }
      const saved = await shopApi.saveProduct(product!.id, patch(), {
        baseRevision: product!.revision,
      });
      setBundle((b) =>
        b && b.product ? { ...b, product: { ...b.product, ...saved, variants: b.product.variants } } : b,
      );
      setDescDirty(false);
      setConflict(false);
      toast.show('Saved');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(true);
      } else {
        toast.show(messageFor(cause), 'critical');
      }
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    if (create) {
      navigate('/products');
      return;
    }
    adoptDrafts(product);
  }

  async function setStatus(to: ProductStatus) {
    if (!product) return;
    const ops = opsFor(product.status, to);
    if (ops === null || ops.length === 0) return;
    setStatusBusy(true);
    try {
      let latest: ShopProduct = product;
      for (const op of ops) latest = await shopApi.transitionProduct(product.id, op);
      setBundle((b) =>
        b && b.product ? { ...b, product: { ...b.product, ...latest, variants: b.product.variants } } : b,
      );
      toast.show(`Now ${humanise(latest.status).toLowerCase()}`);
    } catch (cause) {
      toast.show(messageFor(cause), 'critical');
    } finally {
      setStatusBusy(false);
    }
  }

  async function moveToTrash() {
    if (!product) return;
    try {
      const trashed = await shopApi.trashProduct(product.id);
      setBundle((b) =>
        b && b.product ? { ...b, product: { ...b.product, ...trashed, variants: b.product.variants } } : b,
      );
      setConfirmTrash(false);
      toast.show('Moved to the trash');
    } catch (cause) {
      toast.show(messageFor(cause), 'critical');
    }
  }

  async function restore() {
    if (!product) return;
    setStatusBusy(true);
    try {
      const restored = await shopApi.transitionProduct(product.id, 'restore');
      setBundle((b) =>
        b && b.product ? { ...b, product: { ...b.product, ...restored, variants: b.product.variants } } : b,
      );
      toast.show('Restored from the trash');
    } catch (cause) {
      toast.show(messageFor(cause), 'critical');
    } finally {
      setStatusBusy(false);
    }
  }

  /* ── render ──────────────────────────────────────────────────────────── */

  if (loadError) {
    return (
      <div className="page">
        <PageHeader icon={<Package />} title="Product" backTo="/products" backLabel="Products" />
        <Banner tone="critical" title="Couldn’t load this product" action={<Button onClick={() => void load(true)}>Retry</Button>}>
          {loadError}
        </Banner>
      </div>
    );
  }

  if (!bundle || (!create && !product)) {
    return <ProductSkeleton />;
  }

  const inTrash = product?.status === 'trash';
  const categoryNames = bundle.categories.map((c) => c.name);
  const categoryKnown = category === '' || categoryNames.includes(category);
  /** The facsimile's blue line: the hand-written SEO title, else the product
   *  title — the same fallback the storefront's <title> applies. */
  const serpTitle = seoTitle.trim() || title.trim();

  return (
    <div className="page">
      <SaveBar
        when={dirty || saving}
        label={create ? 'Unsaved product' : 'Unsaved changes'}
        saving={saving}
        disabled={title.trim() === ''}
        onDiscard={discard}
        onSave={() => void save()}
      />

      <PageHeader
        icon={<Package />}
        title={create ? 'Add product' : product!.title || 'Untitled product'}
        titleBadge={
          create ? null : <Badge tone={productTone(product!.status)}>{humanise(product!.status)}</Badge>
        }
        backTo="/products"
        backLabel="Products"
        menu={
          create
            ? undefined
            : (close) =>
                inTrash ? (
                  <MenuItem
                    icon={<ArchiveRestore aria-hidden="true" />}
                    onSelect={() => {
                      close();
                      void restore();
                    }}
                  >
                    Restore from trash
                  </MenuItem>
                ) : (
                  <MenuItem
                    critical
                    icon={<Trash2 aria-hidden="true" />}
                    onSelect={() => {
                      close();
                      setConfirmTrash(true);
                    }}
                  >
                    Move to trash
                  </MenuItem>
                )
        }
      />

      {conflict ? (
        <Banner
          tone="warn"
          title="This product changed somewhere else"
          action={
            <Button
              onClick={() => {
                setConflict(false);
                void load(true);
              }}
            >
              Reload
            </Button>
          }
        >
          Probably another tab. Reloading gets those changes and throws away your edits here.
        </Banner>
      ) : null}

      {inTrash ? (
        <Banner
          tone="warn"
          title="In the trash"
          action={<Button busy={statusBusy} onClick={() => void restore()}>Restore</Button>}
        >
          This product is hidden from your shop and every list. Restore it to edit or sell it
          again.
        </Banner>
      ) : null}

      <div className="form2">
        <div className="form2__main">
          <Card>
            <TextField
              label="Title"
              value={title}
              placeholder="Short sleeve t-shirt"
              onChange={(e) => setTitle(e.target.value)}
              error={dirty && title.trim() === '' ? 'A product needs a title.' : null}
              hint={
                create ? undefined : product!.slug ? (
                  <>
                    Storefront path: <span className="mono">/products/{product!.slug}</span> — the
                    slug follows the title and is set by the server on publish.
                  </>
                ) : (
                  'No link name yet — one is created when you first publish the product.'
                )
              }
            />
            <div className="field">
              <span className="field__label">Description</span>
              <RichText
                key={editorKey}
                value={create ? null : product!.description}
                onChange={(doc) => {
                  setDescription(doc);
                  setDescDirty(true);
                }}
              />
            </div>
            <TextArea
              label="Overview"
              value={overview}
              rows={3}
              /*
               * THE DERIVED TEXT IS THE PLACEHOLDER, NEVER THE VALUE.
               *
               * Putting it in `value` would make every save promote a derived
               * summary into a hand-written one, and the product would silently
               * stop tracking its own description forever after. As a
               * placeholder it shows exactly what the storefront will render
               * while the box is empty, which is the whole question the editor
               * is trying to answer.
               */
              placeholder={
                product?.overviewFallback?.trim() ||
                'Uses the first paragraph of the description'
              }
              hint={
                overview.trim() === ''
                  ? 'Left empty, so your shop shows the first paragraph of the description.'
                  : charactersUsed(overview, 160)
              }
              onChange={(e) => setOverview(e.target.value)}
            />
          </Card>

          <Card title="Media">
            <MediaManager value={media} onChange={setMedia} alt={title || 'Product image'} />
          </Card>

          {create ? (
            <Card title="Variants">
              <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
                Save the product first. Variants, prices and stock can only be added afterwards.
              </p>
            </Card>
          ) : (
            <VariantsCard
              product={product!}
              onAdd={() => setVariantModal('new')}
              onEdit={(v) => setVariantModal(v)}
              onDelete={(v) => setConfirmDeleteVariant(v)}
              onWrite={afterVariantWrite}
            />
          )}

          <Card title="Bulk discount">
            <Checkbox
              label="Offer a quantity discount on this product"
              hint="Customers who buy several get a lower price each. The count adds up across every variant of this product, so three black plus two white counts as five."
              checked={bulkEnabled}
              onChange={setBulkEnabled}
            />
            {bulkEnabled ? (
              <div className="pd__tiers">
                {/*
                 * THE LADDER SHOWN IS ALWAYS THE ONE THAT APPLIES, and the
                 * heading says which of the two it is.
                 *
                 * That distinction is not cosmetic. A product whose rows HAPPEN
                 * to equal the shop default still stops following it the moment
                 * the default changes — so "inherited" and "identical" have to
                 * be told apart, and the table alone cannot do it.
                 */}
                <div className="pd__tiers-head">
                  <span className="field__label">
                    {overriding ? 'This product only' : 'Shop default'}
                  </span>
                  {create ? null : overriding ? (
                    <Button tone="plain" onClick={() => void resetTiers()} disabled={tierBusy}>
                      Use the shop default
                    </Button>
                  ) : (
                    <Button tone="plain" onClick={beginOverride} disabled={tierBusy}>
                      Set different discounts for this product
                    </Button>
                  )}
                </div>

                {tierRows.length === 0 ? (
                  <p className="field__hint">
                    {overriding
                      ? 'No discounts — this product sells at full price whatever the quantity.'
                      : 'No shop-wide discounts are set up yet.'}
                  </p>
                ) : (
                  <table className="table pd__tiers-table">
                    <thead>
                      <tr>
                        <th>Buy at least</th>
                        <th>Discount</th>
                        <th>Price each</th>
                        {overriding ? <th aria-label="Remove row" /> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {tierRows.map((t, i) => (
                        <tr key={overriding ? i : t.minQty}>
                          <td>
                            {overriding ? (
                              <input
                                className="input input--tiny"
                                type="number"
                                min={2}
                                aria-label={'Smallest quantity for row ' + (i + 1)}
                                value={t.minQty}
                                onChange={(e) => editRung(i, { minQty: Number(e.target.value) })}
                              />
                            ) : (
                              t.minQty + ' or more'
                            )}
                          </td>
                          <td>
                            {overriding ? (
                              <span className="pd__pct">
                                <input
                                  className="input input--tiny"
                                  type="number"
                                  min={1}
                                  max={50}
                                  step={0.5}
                                  aria-label={'Discount for row ' + (i + 1)}
                                  /* bps ↔ percent converted at the BOUNDARY only.
                                     The wire and the engine are basis points; a
                                     percent held in state would round-trip 12.5%
                                     into 12 the first time it re-rendered. */
                                  value={t.percentBps / 100}
                                  onChange={(e) =>
                                    editRung(i, {
                                      percentBps: Math.round(Number(e.target.value) * 100),
                                    })
                                  }
                                />
                                <span>%</span>
                              </span>
                            ) : (
                              t.percentBps / 100 + '% off'
                            )}
                          </td>
                          <td>
                            {cheapest === null
                              ? '—'
                              : money(
                                  /* Round the UNIT, matching the totals engine
                                     exactly — a preview that rounded differently
                                     from what is charged is worse than none. */
                                  Math.round((cheapest.amount * (10_000 - t.percentBps)) / 10_000),
                                  cheapest.currency,
                                )}
                          </td>
                          {overriding ? (
                            <td>
                              <Button
                                tone="plain"
                                aria-label={'Remove row ' + (i + 1)}
                                onClick={() => removeRung(i)}
                                disabled={tierBusy}
                              >
                                Remove
                              </Button>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {overriding ? (
                  <>
                    {tierError ? <Banner tone="critical">{tierError}</Banner> : null}
                    <div className="pd__tiers-foot">
                      <Button tone="plain" onClick={addRung} disabled={tierBusy}>
                        Add a row
                      </Button>
                      {/* `busy` and NOT a swapped label: primitives.tsx says
                          why — replacing the text with "Saving…" resizes the
                          button under the cursor mid-press. */}
                      <Button
                        tone="primary"
                        busy={tierBusy}
                        onClick={() => void saveTiers()}
                        disabled={!tiersDirty}
                      >
                        Save discounts
                      </Button>
                    </div>
                    <p className="field__hint">
                      These save on their own, separately from the rest of the
                      product — so use this button, not the one at the top of the
                      page.
                    </p>
                  </>
                ) : (
                  <p className="field__hint">
                    This product follows the shop-wide discounts, so it changes when they do.
                    The switch above only decides whether any discount applies here at all.
                  </p>
                )}
              </div>
            ) : null}
          </Card>

          <Card
            title="Search engine listing"
            action={
              <Button
                tone="plain"
                iconOnly
                aria-label="Edit search engine listing"
                aria-expanded={seoOpen}
                onClick={() => setSeoOpen((open) => !open)}
              >
                <Pencil aria-hidden="true" />
              </Button>
            }
          >
            {serpTitle === '' ? (
              /* Nothing to draw a result FROM yet — the reference admin's
                 exact sentence for a fresh create. */
              <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
                Add a title and description to see how this product might look in a search
                engine listing.
              </p>
            ) : (
              /* A Google-result facsimile: site line, breadcrumb URL, blue
                 title, description, price — the product page as a search
                 result would draw it, updating live as the editors type. */
              <div className="stack stack--tight">
                <span style={{ fontSize: 'var(--t-sm)', fontWeight: 600 }}>{brand.name}</span>
                <span className="muted" style={{ fontSize: 'var(--t-xs)' }}>
                  {`${STOREFRONT_ORIGIN} › products${product?.slug ? ` › ${product.slug}` : ''}`}
                </span>
                <span
                  style={{
                    /* Google's own result-link blue, deliberately a literal
                       and not a design token: this block mimics Google's
                       page, not this admin's palette. */
                    color: '#1a0dab',
                    fontSize: 'var(--t-lg)',
                    lineHeight: 1.3,
                  }}
                >
                  {serpTitle}
                </span>
                <span
                  className="muted"
                  style={{
                    fontSize: 'var(--t-sm)',
                    lineHeight: 1.5,
                    /* Two lines, which is where Google clips it. */
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {seoDescription.trim() || 'While this is empty, the description is used instead.'}
                </span>
                {cheapest ? (
                  <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>
                    {serpPrice(cheapest.amount, cheapest.currency)}
                  </span>
                ) : null}
              </div>
            )}

            {seoOpen ? (
              <>
                <TextField
                  label="Page title"
                  value={seoTitle}
                  placeholder={title.trim() || 'Uses the product title'}
                  hint={charactersUsed(seoTitle, 70)}
                  onChange={(e) => setSeoTitle(e.target.value)}
                />
                <TextArea
                  label="Search description"
                  value={seoDescription}
                  rows={3}
                  placeholder="Uses the first lines of the description"
                  hint={charactersUsed(seoDescription, 160)}
                  onChange={(e) => setSeoDescription(e.target.value)}
                />
                {product?.slug ? (
                  <AffixField
                    label="Link name"
                    prefix={`${STOREFRONT_HOST}/products/`}
                    value={product.slug}
                    readOnly
                    hint="Made from the title when you first publish. It never changes after that, so links people saved keep working."
                  />
                ) : (
                  <div className="field">
                    <span className="field__label">Link name</span>
                    <span className="field__hint">
                      No link name yet — one is made from the title when the product is
                      first published. It never changes after that, so saved links keep working.
                    </span>
                  </div>
                )}
              </>
            ) : null}
          </Card>

          {create ? null : (
            <Card
              title="History"
              action={audit && audit.length > 0 ? <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>Latest {audit.length}</span> : undefined}
            >
              {audit === null ? (
                <div className="stack stack--tight" aria-hidden="true">
                  <span className="skel" style={{ width: '14rem' }} />
                  <span className="skel" style={{ width: '10rem', opacity: 0.7 }} />
                  <span className="skel" style={{ width: '12rem', opacity: 0.5 }} />
                </div>
              ) : audit.length === 0 ? (
                <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                  No stock or price changes recorded yet. Every change appears here, with its
                  reason if one was given.
                </p>
              ) : (
                <Timeline events={audit.map(auditEvent)} />
              )}
            </Card>
          )}
        </div>

        <aside className="form2__side">
          {create ? (
            <Card title="Status">
              <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
                New products are created as <strong>drafts</strong> — publish from this rail once
                it is saved.
              </p>
            </Card>
          ) : inTrash ? null : (
            <Card title="Status">
              <StatusPicker
                label="Product status"
                value={product!.status}
                options={STATUS_OPTIONS}
                onChange={(to) => void setStatus(to)}
                busy={statusBusy}
              />
              <span className="field__hint">
                {product!.publishedAt
                  ? `First published ${shortDate(product!.publishedAt)}.`
                  : 'Never published yet.'}
              </span>
            </Card>
          )}

          {/* Migration 1240. The mystery box is set up in Settings, not here; this
              card only says so, so nobody hunts for the controls on the product. */}
          {!create && product && product.boxMode !== null ? (
            <Card title="Mystery box">
              <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
                This product is the shop’s mystery box. What goes inside, how many items each size
                holds and how boxes get filled are set in Settings.
              </p>
              <div>
                <ButtonLink to="/settings/mystery-box">Open Mystery box settings</ButtonLink>
              </div>
            </Card>
          ) : null}

          <Card title="Organisation">
            {namingCategory ? (
              <TextField
                label="New category"
                value={category}
                autoFocus
                placeholder="Filament"
                hint={
                  <>
                    Free text creates the category on save.{' '}
                    <a
                      href="#/products/categories"
                      onClick={(e) => {
                        e.preventDefault();
                        setNamingCategory(false);
                        setCategory(product?.category ?? '');
                      }}
                    >
                      Pick an existing one instead
                    </a>
                  </>
                }
                onChange={(e) => setCategory(e.target.value)}
              />
            ) : (
              <SelectField
                label="Category"
                value={categoryKnown ? category : ' keep'}
                hint="Sets where it appears in your shop."
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === ' new') {
                    setNamingCategory(true);
                    setCategory('');
                  } else if (v !== ' keep') {
                    setCategory(v);
                  }
                }}
              >
                <option value="">No category</option>
                {categoryNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {categoryKnown ? null : <option value=" keep">{category} (unmanaged)</option>}
                <option value=" new">New category…</option>
              </SelectField>
            )}
            <TagInput
              label="Tags"
              value={tags}
              onChange={setTags}
              suggestions={bundle.tags}
              hint="Shoppers use these to filter. Tags you already use are suggested first."
            />
          </Card>

          {create ? null : (
            <Card title="Details">
              <Defs
                rows={[
                  { label: 'Created', value: shortDate(product!.createdAt) },
                  { label: 'Updated', value: shortDate(product!.updatedAt) },
                  {
                    label: 'Published',
                    value: product!.publishedAt ? shortDate(product!.publishedAt) : '—',
                  },
                  { label: 'Variants', value: product!.variants.length },
                ]}
              />
            </Card>
          )}
        </aside>
      </div>

      {confirmTrash && product ? (
        <Modal
          title="Move to trash?"
          onClose={() => setConfirmTrash(false)}
          footer={
            <>
              <Button onClick={() => setConfirmTrash(false)}>Cancel</Button>
              <Button tone="critical" onClick={() => void moveToTrash()}>
                Move to trash
              </Button>
            </>
          }
        >
          <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
            <strong>{product.title || 'This product'}</strong> leaves the storefront immediately.
            Nothing is deleted. You can restore it later.
          </p>
        </Modal>
      ) : null}

      {variantModal !== 'closed' && product ? (
        <VariantModal
          product={product}
          variant={variantModal === 'new' ? null : variantModal}
          onClose={() => setVariantModal('closed')}
          onDone={() => {
            setVariantModal('closed');
            afterVariantWrite();
          }}
        />
      ) : null}

      {confirmDeleteVariant && product ? (
        <DeleteVariantModal
          variant={confirmDeleteVariant}
          onClose={() => setConfirmDeleteVariant(null)}
          onDone={() => {
            setConfirmDeleteVariant(null);
            afterVariantWrite();
          }}
        />
      ) : null}
    </div>
  );
}

function messageFor(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 422) {
    return 'That description was rejected as unsafe.';
  }
  return cause instanceof Error && cause.message ? cause.message : 'Something went wrong.';
}

/**
 * The reference admin's counter copy, verbatim: "12 of 70 characters used".
 * Raw length, and it keeps counting past the ceiling on purpose — "78 of 70"
 * is the actionable fact, and clamping there would hide exactly the state the
 * counter exists to flag. 70/160 are what a search result typically renders;
 * guidance, never a cap.
 */
function charactersUsed(value: string, ideal: number): string {
  return `${value.length} of ${ideal} characters used`;
}

/**
 * The facsimile's price line the way the reference admin draws it —
 * "₦23,500.00 NGN", amount then code. `money` already spells the code out in
 * locales whose NGN symbol IS the code ("NGN 23,500.00"), and
 * "NGN 23,500.00 NGN" reads as a stutter, so the code is appended only when
 * the locale used a bare symbol instead.
 */
function serpPrice(amount: number, currency: string): string {
  const rendered = money(amount, currency);
  return rendered.includes(currency) ? rendered : `${rendered} ${currency}`;
}

/* ═══════════════════════════════════════════════════════════ VARIANTS ════ */

function VariantsCard({
  product,
  onAdd,
  onEdit,
  onDelete,
  onWrite,
}: {
  product: ShopProductDetail;
  onAdd: () => void;
  onEdit: (v: ShopVariant) => void;
  onDelete: (v: ShopVariant) => void;
  onWrite: () => void;
}) {
  const toast = useToast();
  const variants = product.variants;

  async function setVariantStatus(v: ShopVariant, status: 'active' | 'discontinued') {
    try {
      await shopApi.updateVariant(v.id, { status });
      toast.show(status === 'active' ? `${v.sku} reactivated` : `${v.sku} discontinued`);
      onWrite();
    } catch (cause) {
      toast.show(messageFor(cause), 'critical');
    }
  }

  return (
    <section className="card">
      <div className="card__head">
        <h2 className="card__title">Variants</h2>
        <Button onClick={onAdd}>
          <Plus aria-hidden="true" />
          Add variant
        </Button>
      </div>
      {variants.length === 0 ? (
        <EmptyState
          icon={<Boxes />}
          title="No variants yet"
          body="A product sells through its variants — each one has its own product code, price and stock."
          actions={
            <Button tone="primary" onClick={onAdd}>
              <Plus aria-hidden="true" />
              Add variant
            </Button>
          }
        />
      ) : (
        <TableScroll className="tscroll">
          <table className="table">
            <caption className="sr">Variants of {product.title}</caption>
            <thead>
              <tr>
                <th scope="col">Variant</th>
                <th scope="col" className="th--num">Price</th>
                <th scope="col" className="th--num">Available</th>
                <th scope="col" className="th--tight">Status</th>
                <th scope="col" className="th--tight th--pin">
                  <span className="sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {variants.map((v) => (
                <tr key={v.id}>
                  <td className="cell--primary">
                    <span className="idcell">
                      <span className="idcell__thumb" aria-hidden="true">
                        {v.imageId ? (
                          <StoredImg id={v.imageId} />
                        ) : v.colorHex ? (
                          <span style={{ width: '100%', height: '100%', background: v.colorHex, display: 'block' }} />
                        ) : (
                          <Boxes />
                        )}
                      </span>
                      <span className="idcell__text">
                        <span className="idcell__title">{optionLabel(v.optionValues) ?? 'Default'}</span>
                        <span className="idcell__meta mono">{v.sku}</span>
                      </span>
                    </span>
                  </td>
                  {/* The card attributes by hand — this table predates the
                      shared DataTable and rolls its own rows, so the phone
                      layout's contract (data-label names the fact, keep stays
                      on the card, '' floats to the corner) is stated here
                      explicitly. Price and Available are the working surface
                      and Status the scan, so all three stay on the card. */}
                  <td className="cell--num" data-label="Price" data-mobile="keep">
                    {/* Keyed by the live value so a refresh restates the
                        editor's draft from what the server now holds. */}
                    <PriceCell key={`p${v.price?.amount ?? 'none'}`} variant={v} onWrite={onWrite} />
                  </td>
                  <td className="cell--num" data-label="Available" data-mobile="keep">
                    <StockCell
                      key={`s${v.available ?? 'none'}`}
                      variantId={v.id}
                      sku={v.sku}
                      available={v.available}
                      backorderable={v.backorderable}
                      onWrite={onWrite}
                    />
                  </td>
                  <td className="cell--tight" data-label="Status" data-mobile="keep">
                    <Badge tone={v.status === 'active' ? 'ok' : 'neutral'}>
                      {humanise(v.status)}
                    </Badge>
                  </td>
                  <td className="cell--tight cell--pin" data-label="">
                    <Menu
                      chrome="bare"
                      buttonLabel={`Actions for ${v.sku}`}
                      label={
                        <span
                          className="btn btn--plain btn--icon"
                          style={{ display: 'inline-grid', placeItems: 'center' }}
                        >
                          <MoreHorizontal aria-hidden="true" />
                        </span>
                      }
                    >
                      {(close) => (
                        <>
                          <MenuItem
                            onSelect={() => {
                              close();
                              onEdit(v);
                            }}
                          >
                            Edit variant…
                          </MenuItem>
                          <MenuItem
                            onSelect={() => {
                              close();
                              void setVariantStatus(v, v.status === 'active' ? 'discontinued' : 'active');
                            }}
                          >
                            {v.status === 'active' ? 'Discontinue' : 'Reactivate'}
                          </MenuItem>
                          {/* A variant that has sold can only be discontinued —
                              the control is absent rather than a 409 (issue #18). */}
                          {v.everOrdered ? null : (
                            <>
                              <MenuSeparator />
                              <MenuItem
                                critical
                                onSelect={() => {
                                  close();
                                  onDelete(v);
                                }}
                              >
                                Delete variant…
                              </MenuItem>
                            </>
                          )}
                        </>
                      )}
                    </Menu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </section>
  );
}

function PriceCell({ variant, onWrite }: { variant: ShopVariant; onWrite: () => void }) {
  const toast = useToast();
  const currency = variant.price?.currency ?? STORE_CURRENCY;
  const [draft, setDraft] = useState(() =>
    variant.price ? plainMajor(variant.price.amount, currency) : '',
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function commit(close: () => void) {
    const parsed = parseMajor(draft, currency);
    if (!parsed.ok) {
      setError(moneyRefusalMessage(parsed.reason, currency));
      return;
    }
    setBusy(true);
    try {
      await shopApi.setVariantPrice(variant.id, parsed.minor, currency, reason.trim() || undefined);
      toast.show(`${variant.sku} — ${money(parsed.minor, currency)}`);
      close();
      setReason('');
      onWrite();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  /* The sale state at a glance: the struck-through compare-at sits beside the
     price exactly as the storefront will draw it — and only while it is
     genuinely higher, the same render-time rule the storefront applies. */
  const onSale =
    variant.price !== null &&
    variant.compareAtMinor !== null &&
    variant.compareAtMinor > variant.price.amount;

  return (
    <PopEdit
      ariaLabel={`Edit price of ${variant.sku}`}
      value={
        variant.price ? (
          <span className="num">
            {money(variant.price.amount, currency)}
            {onSale ? (
              <s className="muted" style={{ fontSize: 'var(--t-sm)', marginLeft: 'var(--s2)' }}>
                {money(variant.compareAtMinor!, currency)}
              </s>
            ) : null}
          </span>
        ) : (
          <span className="muted">Not priced</span>
        )
      }
    >
      {(close) => (
        <>
          <MoneyField
            label="Price"
            currency={currency}
            value={draft}
            error={error}
            autoFocus
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit(close);
            }}
          />
          <TextField
            label="Reason"
            value={reason}
            placeholder="Optional"
            hint="Saved in the price history."
            onChange={(e) => setReason(e.target.value)}
          />
          <PopEditFoot>
            <Button tone="plain" onClick={close}>
              Cancel
            </Button>
            <Button tone="primary" busy={busy} onClick={() => void commit(close)}>
              Save
            </Button>
          </PopEditFoot>
        </>
      )}
    </PopEdit>
  );
}

/* ════════════════════════════════════════════════════ VARIANT MODAL ════ */

function VariantModal({
  product,
  variant,
  onClose,
  onDone,
}: {
  product: ShopProductDetail;
  /** `null` creates. */
  variant: ShopVariant | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const creating = variant === null;

  const [sku, setSku] = useState(variant?.sku ?? '');
  const [pairs, setPairs] = useState<{ k: string; v: string }[]>(() => {
    const entries = Object.entries(variant?.optionValues ?? {});
    return entries.length ? entries.map(([k, v]) => ({ k, v })) : [{ k: 'Colour', v: '' }];
  });
  const [weight, setWeight] = useState(
    variant?.weightGrams != null ? String(variant.weightGrams) : '',
  );
  /* EMPTY WHEN THERE IS NO OVERRIDE, not the displayed weight copied in — see
     the field's own comment for why a prefill would be a trap. */
  const [shipWeight, setShipWeight] = useState(
    variant?.shippingWeightGrams != null ? String(variant.shippingWeightGrams) : '',
  );
  const [colorHex, setColorHex] = useState(variant?.colorHex ?? '');
  const [imageId, setImageId] = useState<string | null>(variant?.imageId ?? null);
  /* The variant's own currency where it has a price; the store's for a new one.
     Compare-at and cost render beside that price, so they share its currency. */
  const currency = variant?.price?.currency ?? STORE_CURRENCY;
  const [compareAt, setCompareAt] = useState(() =>
    variant?.compareAtMinor != null ? plainMajor(variant.compareAtMinor, currency) : '',
  );
  const [cost, setCost] = useState(() =>
    variant?.costMinor != null ? plainMajor(variant.costMinor, currency) : '',
  );
  /* No longer create-only (owner's queue, 2026-08-25): editing initialises
     from the row and the PATCH carries the flag when it changes. */
  const [backorderable, setBackorderable] = useState(variant?.backorderable ?? false);
  const [onHand, setOnHand] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const productImages = [
    ...(product.coverImageId ? [product.coverImageId] : []),
    ...product.imageIds,
  ];

  /* Live economics beside the cost box. Price is set from the variants table
     (that path carries the reason into the audit trail), so here it is only
     read — margin against it is the whole point of recording cost at all. */
  const price = variant?.price ?? null;
  const costParsed = cost.trim() === '' ? null : parseMajor(cost, currency);
  const marginHint = (() => {
    if (!price) return 'Profit shows once you set a price in the variants table.';
    if (costParsed === null || !costParsed.ok || price.amount === 0) {
      return `Against the current price of ${money(price.amount, currency)}.`;
    }
    const profit = price.amount - costParsed.minor;
    const pct = Math.round(((profit / price.amount) * 1000)) / 10;
    return `${pct}% profit · ${money(profit, currency)} per sale`;
  })();
  const compareParsed = compareAt.trim() === '' ? null : parseMajor(compareAt, currency);
  const compareHint =
    price && compareParsed?.ok && compareParsed.minor <= price.amount
      ? 'At or below the current price, so your shop won’t show this as a sale.'
      : 'Shown crossed out in your shop while it is above the price.';

  /* The owner's quick-fill rules (2026-08-25): compare-at offers price +20%,
     cost offers price −15%, both rounded to the whole naira — the same 85%
     figure migration 0500 backfilled. Offers, never values: the keycap or Tab
     types the digits out for editing, and an untouched field stays empty. */
  const roundNaira = (minor: number) => Math.round(minor / 100) * 100;
  const compareSuggest = price ? plainMajor(roundNaira(price.amount * 1.2), currency) : undefined;
  const costSuggest = price ? plainMajor(roundNaira(price.amount * 0.85), currency) : undefined;

  function buildOptionValues(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const { k, v } of pairs) {
      if (k.trim() && v.trim()) out[k.trim()] = v.trim();
    }
    return out;
  }

  async function commit() {
    setError(null);
    const weightGrams = weight.trim() === '' ? null : Number(weight);
    if (weightGrams !== null && (!Number.isFinite(weightGrams) || weightGrams < 0)) {
      setError('Weight is grams — a non-negative number, or empty.');
      return;
    }
    const shippingWeightGrams = shipWeight.trim() === '' ? null : Number(shipWeight);
    if (
      shippingWeightGrams !== null &&
      (!Number.isFinite(shippingWeightGrams) || shippingWeightGrams < 0)
    ) {
      setError('Shipping weight is grams — a non-negative number, or empty.');
      return;
    }
    const color = colorHex.trim() === '' ? null : colorHex.trim().toLowerCase();
    if (color !== null && !/^#[0-9a-f]{6}$/.test(color)) {
      setError('Colour is a six-digit hex code like #8b5a2b, or empty.');
      return;
    }
    /* Empty clears — "not on sale" / "cost unknown" are real states, so the
       fields parse only when there is something to parse. */
    const compareAtMinor = compareAt.trim() === '' ? null : parseMajor(compareAt, currency);
    if (compareAtMinor !== null && !compareAtMinor.ok) {
      setError(`Original price: ${moneyRefusalMessage(compareAtMinor.reason, currency)}`);
      return;
    }
    const costMinor = cost.trim() === '' ? null : parseMajor(cost, currency);
    if (costMinor !== null && !costMinor.ok) {
      setError(`Cost per item: ${moneyRefusalMessage(costMinor.reason, currency)}`);
      return;
    }
    const stock = Number(onHand);
    if (creating && (!Number.isInteger(stock) || stock < 0)) {
      setError('Initial stock is a whole number of zero or more.');
      return;
    }
    setBusy(true);
    try {
      if (creating) {
        const created = await shopApi.createVariant(product.id, {
          ...(sku.trim() ? { sku: sku.trim() } : {}),
          optionValues: buildOptionValues(),
          weightGrams,
          shippingWeightGrams,
          colorHex: color,
          imageId,
          backorderable,
          onHand: stock,
          compareAtMinor: compareAtMinor === null ? null : compareAtMinor.minor,
          costMinor: costMinor === null ? null : costMinor.minor,
        });
        toast.show(`${created.sku} added`);
      } else {
        await shopApi.updateVariant(variant.id, {
          ...(sku.trim() && sku.trim() !== variant.sku ? { sku: sku.trim() } : {}),
          optionValues: buildOptionValues(),
          weightGrams,
          shippingWeightGrams,
          colorHex: color,
          imageId,
          compareAtMinor: compareAtMinor === null ? null : compareAtMinor.minor,
          costMinor: costMinor === null ? null : costMinor.minor,
          /* Only when it moved: the flag lands on the inventory row, and a
             no-op write would still bump that row's clock. */
          ...(backorderable !== variant.backorderable ? { backorderable } : {}),
        });
        toast.show(`${sku.trim() || variant.sku} updated`);
      }
      onDone();
    } catch (cause) {
      setError(messageFor(cause));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={creating ? 'Add variant' : `Edit ${variant.sku}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void commit()}>
            {creating ? 'Add variant' : 'Save variant'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField
          label="Product code"
          value={sku}
          placeholder={creating ? 'Left empty, the server derives one' : undefined}
          className="input mono"
          spellCheck={false}
          onChange={(e) => setSku(e.target.value)}
        />

        <div className="stack stack--tight">
          <span className="field__label">Options</span>
          {pairs.map((pair, i) => (
            <div key={i} className="row" style={{ alignItems: 'center', gap: 'var(--s2)' }}>
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder="Option — Colour, Size…"
                aria-label={`Option ${i + 1} name`}
                value={pair.k}
                onChange={(e) =>
                  setPairs((p) => p.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))
                }
              />
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder="Value — Forest, 1kg…"
                aria-label={`Option ${i + 1} value`}
                value={pair.v}
                onChange={(e) =>
                  setPairs((p) => p.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))
                }
              />
              <Button
                tone="plain"
                iconOnly
                aria-label={`Remove option ${i + 1}`}
                onClick={() => setPairs((p) => p.filter((_, j) => j !== i))}
              >
                ✕
              </Button>
            </div>
          ))}
          <div>
            <Button tone="plain" onClick={() => setPairs((p) => [...p, { k: '', v: '' }])}>
              <Plus aria-hidden="true" />
              Add option
            </Button>
          </div>
        </div>

        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 1 }}>
            <AffixField
              label="Weight"
              suffix="g"
              inputMode="numeric"
              value={weight}
              hint="Shown in your shop. Optional."
              onChange={(e) => setWeight(e.target.value)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <AffixField
              label="Shipping weight"
              suffix="g"
              inputMode="numeric"
              value={shipWeight}
              hint="Used to price delivery. Blank means the weight beside it."
              /* A SUGGESTION, NEVER A PREFILL. Blank is the ordinary state and
                 it means "use the weight shown" — writing that number in would
                 pin every variant to whatever it displayed the day somebody
                 opened this modal to change something else. Tab types it out
                 for the one case where the two really do differ by a little. */
              suggestion={weight.trim() === '' ? undefined : weight.trim()}
              onSuggest={setShipWeight}
              onChange={(e) => setShipWeight(e.target.value)}
            />
          </div>
        </div>

        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 1 }}>
            <TextField
              label="Colour code"
              value={colorHex}
              placeholder="#8b5a2b"
              className="input mono"
              spellCheck={false}
              hint="The colour shown while this variant has no photo."
              onChange={(e) => setColorHex(e.target.value)}
            />
          </div>
          {/* Keeps the hex field at the half width it has always had. `.row`
              does not wrap, so this costs nothing on a phone either. */}
          <div style={{ flex: 1 }} aria-hidden="true" />
        </div>

        <div className="stack stack--tight">
          <span className="field__label">Pricing</span>
          <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
            <div style={{ flex: 1 }}>
              <MoneyField
                label="Original price"
                currency={currency}
                value={compareAt}
                hint={compareHint}
                suggestion={compareSuggest}
                onSuggest={(v) => {
                  setCompareAt(v);
                  setError(null);
                }}
                onChange={(e) => {
                  setCompareAt(e.target.value);
                  setError(null);
                }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <MoneyField
                label="Cost per item"
                currency={currency}
                value={cost}
                hint={marginHint}
                suggestion={costSuggest}
                onSuggest={(v) => {
                  setCost(v);
                  setError(null);
                }}
                onChange={(e) => {
                  setCost(e.target.value);
                  setError(null);
                }}
              />
            </div>
          </div>
        </div>

        <div className="stack stack--tight">
          <span className="field__label">Variant photo</span>
          <PhotoPicker value={imageId} onChange={setImageId} choices={productImages} alt="Variant photo" />
          <span className="field__hint">Pick one of the product’s pictures, or upload a photo of this variant.</span>
        </div>

        {creating ? (
          <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
            <div style={{ flex: 1 }}>
              <TextField
                label="Initial stock"
                type="number"
                min={0}
                step={1}
                value={onHand}
                onChange={(e) => setOnHand(e.target.value)}
              />
            </div>
            <div style={{ flex: 1, paddingTop: '1.375rem' }}>
              <Checkbox
                label="Backorderable"
                hint="Keeps selling below zero on purpose."
                checked={backorderable}
                onChange={setBackorderable}
              />
            </div>
          </div>
        ) : (
          <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
            <div style={{ flex: 1 }}>
              <Checkbox
                label="Backorderable"
                hint="Keeps selling below zero on purpose."
                checked={backorderable}
                onChange={setBackorderable}
              />
            </div>
            <div style={{ flex: 1 }}>
              <span className="field__hint">
                Stock moves through the Available column’s adjuster, never here — so every
                change is kept on record.
              </span>
            </div>
          </div>
        )}

        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}

function DeleteVariantModal({
  variant,
  onClose,
  onDone,
}: {
  variant: ShopVariant;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function commit() {
    setBusy(true);
    try {
      await shopApi.deleteVariant(variant.id);
      toast.show(`${variant.sku} deleted`);
      onDone();
    } catch (cause) {
      toast.show(messageFor(cause), 'critical');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Delete ${variant.sku}?`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="critical" busy={busy} onClick={() => void commit()}>
            Delete variant
          </Button>
        </>
      }
    >
      <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
        This really removes the row — it has never been ordered, so there is no history to keep.
        The price and stock records go with it.
      </p>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════ HELPERS ════ */

function auditEvent(entry: AuditEntry): TimelineEvent {
  const sku = entry.sku ?? 'variant';
  if (entry.kind === 'stock') {
    const delta = entry.delta ?? 0;
    return {
      id: entry.id,
      tone: 'neutral',
      message: (
        <>
          Stock {delta > 0 ? `+${delta}` : delta} on <span className="mono">{sku}</span>
          {entry.onHand !== null ? <> — {entry.onHand} on hand</> : null}
          {entry.reason ? <> · {entry.reason}</> : null}
        </>
      ),
      meta: `${dateTime(entry.occurredAt)}${entry.actor ? ` · ${entry.actor}` : ''}`,
    };
  }
  const currency = entry.currency ?? STORE_CURRENCY;
  return {
    id: entry.id,
    tone: 'info',
    message: (
      <>
        Price {entry.previousAmount !== null ? <>{money(entry.previousAmount, currency)} → </> : null}
        <strong className="num">{money(entry.amount ?? 0, currency)}</strong> on{' '}
        <span className="mono">{sku}</span>
        {entry.reason ? <> · {entry.reason}</> : null}
      </>
    ),
    /* Price rows have no actor column server-side — inventing one would be a
       fact the audit view made up. */
    meta: dateTime(entry.occurredAt),
  };
}

function ProductSkeleton() {
  return (
    <div className="page" aria-busy="true">
      <div>
        <span className="skel" style={{ width: '5rem' }} />
        <div className="page__head" style={{ marginTop: 'var(--s2)' }}>
          <span className="skel" style={{ width: '16rem', height: '1rem' }} />
        </div>
      </div>
      <div className="form2">
        <div className="form2__main">
          <div className="card" style={{ padding: 'var(--s4)' }}>
            <div className="stack stack--tight">
              <span className="skel" style={{ width: '10rem' }} />
              <span className="skel" style={{ width: '100%', height: '2rem' }} />
              <span className="skel" style={{ width: '10rem', marginTop: 'var(--s3)' }} />
              <span className="skel" style={{ width: '100%', height: '8rem' }} />
            </div>
          </div>
          <div className="card" style={{ padding: 'var(--s4)' }}>
            <div className="row" style={{ gap: 'var(--s3)' }}>
              <span className="skel skel--thumb" style={{ width: '7rem', height: '7rem' }} />
              <span className="skel skel--thumb" />
              <span className="skel skel--thumb" />
            </div>
          </div>
        </div>
        <aside className="form2__side">
          <div className="card" style={{ padding: 'var(--s4)' }}>
            <div className="stack stack--tight">
              <span className="skel" style={{ width: '6rem' }} />
              <span className="skel" style={{ width: '100%', height: '2rem' }} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
