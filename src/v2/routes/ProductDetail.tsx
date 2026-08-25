import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArchiveRestore,
  Boxes,
  MoreHorizontal,
  Package,
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
import { ApiError } from '../../data/errors';
import { dateTime, humanise, money, productTone, shortDate } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, EmptyState } from '../ui/primitives';
import { Card } from '../ui/Card';
import { Defs } from '../ui/Defs';
import { AffixField, Checkbox, SelectField, TextField } from '../ui/Field';
import { StoredImg, MediaManager, type MediaValue } from '../ui/Img';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { PopEdit, PopEditFoot } from '../ui/PopEdit';
import { RichText } from '../ui/RichText';
import { SaveBar } from '../ui/SaveBar';
import { StatusPicker, type StatusOption } from '../ui/StatusPicker';
import { TagInput } from '../ui/TagInput';
import { Timeline, type TimelineEvent } from '../ui/Timeline';
import { useToast } from '../ui/Toast';

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

/*
 * TODO(tests): none exist for this screen — skipped by this session's no-test
 * rule, recorded in CLAUDE.md §"tests that do not exist yet". The paths that
 * most deserve them: the CAS save (409 → conflict banner, not silent
 * overwrite), the archived→active double transition, the delete-variant
 * control staying ABSENT for an everOrdered variant, and description
 * omission when the editor never mounted.
 *
 * TODO(fields, queued by the owner 2026-08-25): compare-at price, cost per
 * item, and SEO title/description do not exist in the schema yet. They are
 * backend work (migration 0340+, catalog routes, api-shop) before any UI —
 * this screen gains a Pricing card and an SEO card when they land.
 */

/** The store currency, for a variant that has never been priced yet. Every
 *  priced variant carries its own. */
const STORE_CURRENCY = 'NGN';

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
  { value: 'active', label: 'Active', description: 'For sale on the storefront and in search.' },
  { value: 'draft', label: 'Draft', description: 'Not visible to customers until published.' },
  { value: 'archived', label: 'Archived', description: 'Off the storefront, kept for the record.' },
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

  const product = bundle?.product ?? null;

  const adoptDrafts = useCallback((next: ShopProductDetail | null) => {
    setTitle(next?.title ?? '');
    setCategory(next?.category ?? '');
    setNamingCategory(false);
    setTags(next?.tags ?? []);
    setMedia({ coverImageId: next?.coverImageId ?? null, imageIds: next?.imageIds ?? [] });
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
      descDirty
    : product
      ? title !== product.title ||
        category !== product.category ||
        tags.join('\0') !== product.tags.join('\0') ||
        media.coverImageId !== product.coverImageId ||
        media.imageIds.join('\0') !== product.imageIds.join('\0') ||
        descDirty
      : false;

  const patch = (): ShopProductPatch => ({
    title: title.trim(),
    category: category.trim(),
    tags,
    coverImageId: media.coverImageId,
    imageIds: media.imageIds,
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
          Probably another tab. Reloading picks up those changes and discards the edits here.
        </Banner>
      ) : null}

      {inTrash ? (
        <Banner
          tone="warn"
          title="In the trash"
          action={<Button busy={statusBusy} onClick={() => void restore()}>Restore</Button>}
        >
          This product is off the storefront and out of every list. Restore it to edit or sell it
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
                  'No slug yet — one is assigned when the product is first published.'
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
          </Card>

          <Card title="Media">
            <MediaManager value={media} onChange={setMedia} alt={title || 'Product image'} />
          </Card>

          {create ? (
            <Card title="Variants">
              <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
                Save the product first — variants, prices and stock attach to a saved product.
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
                  No stock or price changes recorded yet. Every adjustment lands here with its
                  reason.
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
                hint="Determines where it appears on the storefront."
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
              hint="Shoppers filter by these. Existing spellings are offered first."
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
            Nothing is deleted — you can restore it from here later.
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
    return 'That description was refused as unsafe.';
  }
  return cause instanceof Error && cause.message ? cause.message : 'Something went wrong.';
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
          body="A product sells through its variants — each one carries the SKU, the price and the stock."
          actions={
            <Button tone="primary" onClick={onAdd}>
              <Plus aria-hidden="true" />
              Add variant
            </Button>
          }
        />
      ) : (
        <div className="tscroll">
          <table className="table">
            <caption className="sr">Variants of {product.title}</caption>
            <thead>
              <tr>
                <th scope="col">Variant</th>
                <th scope="col" className="th--num">Price</th>
                <th scope="col" className="th--num">Available</th>
                <th scope="col" className="th--tight">Status</th>
                <th scope="col" className="th--tight">
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
                  <td className="cell--num">
                    {/* Keyed by the live value so a refresh restates the
                        editor's draft from what the server now holds. */}
                    <PriceCell key={`p${v.price?.amount ?? 'none'}`} variant={v} onWrite={onWrite} />
                  </td>
                  <td className="cell--num">
                    <StockCell key={`s${v.available ?? 'none'}`} variant={v} onWrite={onWrite} />
                  </td>
                  <td className="cell--tight">
                    <Badge tone={v.status === 'active' ? 'ok' : 'neutral'}>
                      {humanise(v.status)}
                    </Badge>
                  </td>
                  <td className="cell--tight">
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
        </div>
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

  return (
    <PopEdit
      ariaLabel={`Edit price of ${variant.sku}`}
      value={
        variant.price ? (
          <span className="num">{money(variant.price.amount, currency)}</span>
        ) : (
          <span className="muted">Not priced</span>
        )
      }
    >
      {(close) => (
        <>
          <AffixField
            label="Price"
            prefix={currency}
            inputMode="decimal"
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
            hint="Recorded in the price history."
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

function StockCell({ variant, onWrite }: { variant: ShopVariant; onWrite: () => void }) {
  const toast = useToast();
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsedDelta = Number(delta);
  const deltaOk = delta.trim() !== '' && Number.isInteger(parsedDelta) && parsedDelta !== 0;

  async function commit(close: () => void) {
    if (!deltaOk) {
      setError('A whole number, positive or negative — and not zero.');
      return;
    }
    if (!reason.trim()) {
      setError('The audit trail refuses a stock change without a reason.');
      return;
    }
    setBusy(true);
    try {
      const res = await shopApi.adjustInventory(variant.id, parsedDelta, reason.trim());
      toast.show(`${variant.sku} — ${res.available} available`);
      close();
      setDelta('');
      setReason('');
      onWrite();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  const available = variant.available;

  return (
    <PopEdit
      ariaLabel={`Adjust stock of ${variant.sku}`}
      value={
        available === null ? (
          <span className="muted">No stock row</span>
        ) : (
          <span className="num" style={available < 0 ? { color: 'var(--critical)' } : undefined}>
            {available}
          </span>
        )
      }
    >
      {(close) => (
        <>
          <TextField
            label="Adjust by"
            type="number"
            step={1}
            placeholder="+5 or -2"
            value={delta}
            autoFocus
            hint={
              available !== null && deltaOk
                ? `Available ${available} → ${available + parsedDelta}`
                : variant.backorderable
                  ? 'Backorderable — available may go negative on purpose.'
                  : undefined
            }
            onChange={(e) => {
              setDelta(e.target.value);
              setError(null);
            }}
          />
          <TextField
            label="Reason"
            value={reason}
            placeholder="Stocktake, damage, correction…"
            error={error}
            onChange={(e) => {
              setReason(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit(close);
            }}
          />
          <PopEditFoot>
            <Button tone="plain" onClick={close}>
              Cancel
            </Button>
            <Button tone="primary" busy={busy} onClick={() => void commit(close)}>
              Adjust
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
  const [colorHex, setColorHex] = useState(variant?.colorHex ?? '');
  const [imageId, setImageId] = useState<string | null>(variant?.imageId ?? null);
  const [backorderable, setBackorderable] = useState(false);
  const [onHand, setOnHand] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const productImages = [
    ...(product.coverImageId ? [product.coverImageId] : []),
    ...product.imageIds,
  ];

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
    const color = colorHex.trim() === '' ? null : colorHex.trim().toLowerCase();
    if (color !== null && !/^#[0-9a-f]{6}$/.test(color)) {
      setError('Colour is a six-digit hex code like #8b5a2b, or empty.');
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
          colorHex: color,
          imageId,
          backorderable,
          onHand: stock,
        });
        toast.show(`${created.sku} added`);
      } else {
        await shopApi.updateVariant(variant.id, {
          ...(sku.trim() && sku.trim() !== variant.sku ? { sku: sku.trim() } : {}),
          optionValues: buildOptionValues(),
          weightGrams,
          colorHex: color,
          imageId,
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
          label="SKU"
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
              hint="Optional."
              onChange={(e) => setWeight(e.target.value)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <TextField
              label="Colour code"
              value={colorHex}
              placeholder="#8b5a2b"
              className="input mono"
              spellCheck={false}
              hint="The swatch shown while the variant has no photo."
              onChange={(e) => setColorHex(e.target.value)}
            />
          </div>
        </div>

        {productImages.length > 0 ? (
          <div className="stack stack--tight">
            <span className="field__label">Variant photo</span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s2)' }}>
              <button
                type="button"
                className="imgg__tile"
                style={{
                  width: '3.5rem',
                  aspectRatio: '1',
                  cursor: 'pointer',
                  boxShadow:
                    imageId === null
                      ? '0 0 0 2px var(--accent) inset'
                      : '0 0 0 1px rgb(26 26 26 / 0.08) inset',
                }}
                aria-pressed={imageId === null}
                aria-label="No photo"
                onClick={() => setImageId(null)}
              >
                <span className="muted" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 'var(--t-xs)' }}>
                  None
                </span>
              </button>
              {productImages.map((pid) => (
                <button
                  key={pid}
                  type="button"
                  className="imgg__tile"
                  style={{
                    width: '3.5rem',
                    aspectRatio: '1',
                    cursor: 'pointer',
                    boxShadow:
                      imageId === pid
                        ? '0 0 0 2px var(--accent) inset'
                        : '0 0 0 1px rgb(26 26 26 / 0.08) inset',
                  }}
                  aria-pressed={imageId === pid}
                  aria-label="Use this product image"
                  onClick={() => setImageId(pid)}
                >
                  <StoredImg id={pid} />
                </button>
              ))}
            </div>
            <span className="field__hint">Picked from the product’s own media.</span>
          </div>
        ) : null}

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
          /* TODO(v2): `updateVariant` has no `backorderable` in its body — the
             flag is create-time only through this client. Flipping it later
             needs the PATCH route to accept it; queued as backend work. */
          <span className="field__hint">
            Stock moves through the Available column’s adjuster, never here — every change carries
            its reason into the audit trail.
          </span>
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
