import { useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import { shopApi, type ShopCategory } from '../../data/api-shop';
import { useAsync } from '../lib/useAsync';
import { AnalyticsBar, AnalyticsMenuItem, PageHeader, useAnalyticsBar, type Metric } from '../ui/Page';
import { Badge, Banner, Button, EmptyState } from '../ui/primitives';
import { ShelfArt } from '../ui/illustrations';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { TextArea, TextField } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

/** No tint chosen. Empty rather than a colour, because "none" is a real
 *  answer here and a default colour would put a tile tint on every category
 *  whether or not anyone picked one. */
const NO_TINT = '';

/**
 * ADD A CATEGORY.
 *
 * The button used to raise a toast saying this was "coming with the new
 * product editor". It was not coming: `POST /admin/categories` and
 * `shopApi.createCategory` have both existed the whole time, so the only
 * missing piece was this form.
 *
 * 201 EVEN WHEN THE NAME IS ALREADY IN USE as free text on products, and that
 * is the interesting case rather than an error: "adopt the category I have
 * been typing onto products" and "create a new one" are the same request, and
 * the response comes back with those products already counted. The toast says
 * so when it happens, because a category that arrives owning six products
 * looks like a bug if nobody explains it.
 *
 * NO SLUG FIELD. The server allocates it, and a published URL is a promise —
 * moving it is a separate, deliberate act on the row afterwards.
 */
function NewCategoryModal({
  initialName,
  onClose,
  onCreated,
}: {
  initialName: string;
  onClose: () => void;
  onCreated: (category: ShopCategory) => void;
}) {
  const [name, setName] = useState(initialName);
  const [blurb, setBlurb] = useState('');
  const [accent, setAccent] = useState(NO_TINT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give the category a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const category = await shopApi.createCategory({
        name: trimmed,
        blurb: blurb.trim(),
        accentHex: accent === NO_TINT ? null : accent,
      });
      onCreated(category);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add a category"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void save()}>
            Add category
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--s4)' }}>
        <TextField
          label="Name"
          value={name}
          autoFocus
          placeholder="Filament"
          hint="What shoppers see at the top of the category's page."
          onChange={(e) => setName(e.target.value)}
        />
        <TextArea
          label="Short description"
          value={blurb}
          rows={3}
          placeholder="One line under the heading on its page."
          hint="Optional. You can write it later."
          onChange={(e) => setBlurb(e.target.value)}
        />
        <div className="field">
          <span className="field__label">Tile colour</span>
          <div className="row" style={{ gap: 'var(--s2)', alignItems: 'center' }}>
            <input
              type="color"
              aria-label="Tile colour"
              value={accent === NO_TINT ? '#1b4fa8' : accent}
              onChange={(e) => setAccent(e.target.value)}
              style={{
                width: '2.5rem',
                height: '2.25rem',
                padding: 0,
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-md)',
                background: 'none',
              }}
            />
            {accent === NO_TINT ? (
              <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>
                No colour — the tile uses the shop's default.
              </span>
            ) : (
              <Button tone="plain" onClick={() => setAccent(NO_TINT)}>
                Clear colour
              </Button>
            )}
          </div>
          <span className="field__hint">Optional. Tints the category's tile in your shop.</span>
        </div>
      </div>
      {error ? (
        <p className="field__error" style={{ marginTop: 'var(--s3)' }}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

/**
 * CATEGORIES — the shop's collections surface.
 *
 * THE `managed` COLUMN IS THE WHOLE SCREEN. This list is the union of the
 * managed `shop_categories` rows and the values still sitting in
 * `shop_products.category` as free text. An unmanaged row has no id, no slug
 * and therefore no URL the storefront can route to — it exists only because
 * some product is carrying the string. Showing both in one list without saying
 * which is which is how somebody spends an afternoon wondering why a category
 * does not appear on the shop.
 */
export default function Categories() {
  const [shown, toggle] = useAnalyticsBar('categories');
  const toast = useToast();
  const [search, setSearch] = useState('');

  const { data, error, loading, reload } = useAsync(
    (signal) => shopApi.listCategories(signal),
    [],
  );
  const [adding, setAdding] = useState<string | null>(null);
  const all = data ?? [];

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((c) => c.name.toLowerCase().includes(q));
  }, [all, search]);

  const metrics: Metric[] = useMemo(() => {
    const managed = all.filter((c) => c.managed);
    return [
      { label: 'Categories', value: String(all.length) },
      { label: 'Managed', value: String(managed.length) },
      { label: 'Unmanaged', value: String(all.length - managed.length) },
      { label: 'Products classified', value: String(all.reduce((n, c) => n + c.count, 0)) },
    ];
  }, [all]);

  const columns: Column<ShopCategory>[] = [
    {
      key: 'name',
      header: 'Category',
      primary: true,
      render: (c) => (
        <IdCell
          thumb={
            /* The tile tint, shown as the swatch rather than described in a hex
               column nobody can picture. A category with no tint gets the
               neutral well, which is exactly what the storefront renders. */
            <span
              style={{
                width: '100%',
                height: '100%',
                background: c.accentHex ? `#${c.accentHex.replace(/^#/, '')}` : 'var(--surface-sunken)',
              }}
            />
          }
          title={c.name}
          meta={c.slug ? <span className="mono">/{c.slug}</span> : 'Not shown in your shop'}
        />
      ),
    },
    {
      key: 'managed',
      header: 'Type',
      tight: true,
      render: (c) =>
        c.managed ? <Badge tone="ok">Managed</Badge> : <Badge tone="warn">In use only</Badge>,
    },
    {
      key: 'blurb',
      header: 'Blurb',
      render: (c) =>
        c.blurb ? (
          <span className="truncate" style={{ maxWidth: '22rem', display: 'inline-block' }}>
            {c.blurb}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { key: 'position', header: 'Position', numeric: true, render: (c) => c.position },
    { key: 'count', mobile: 'keep', header: 'Products', numeric: true, render: (c) => c.count },
  ];

  const unmanaged = all.filter((c) => !c.managed).length;

  return (
    <div className="page">
      <PageHeader
        icon={<Layers />}
        title="Categories"
        subtitle="How products are grouped in your shop."
        actions={
          <Button tone="primary" size="lg" onClick={() => setAdding('')}>
            Add category
          </Button>
        }
        menu={(close) => <AnalyticsMenuItem shown={shown} onToggle={toggle} close={close} />}
      />

      {adding !== null ? (
        <NewCategoryModal
          initialName={adding}
          onClose={() => setAdding(null)}
          onCreated={(category) => {
            setAdding(null);
            toast.show(
              category.count > 0
                ? `${category.name} set up properly — its ${category.count} product${category.count === 1 ? '' : 's'} came with it`
                : `${category.name} added`,
            );
            reload();
          }}
        />
      ) : null}

      {shown ? <AnalyticsBar range="All time" metrics={metrics} /> : null}

      {error ? (
        <Banner tone="critical" title="Couldn’t load categories">
          {error}
        </Banner>
      ) : null}

      {unmanaged > 0 ? (
        <Banner tone="warn" title={`${unmanaged} category name${unmanaged === 1 ? '' : 's'} in use, but not set up properly`}>
          These are typed straight onto products. They have no page of their own in your shop,
          so add one properly to give it a page, a short description and a colour.
        </Banner>
      ) : null}

      <DataTable
        caption="Categories"
        columns={columns}
        rows={rows}
        rowKey={(c) => c.id ?? `unmanaged:${c.name}`}
        loading={loading}
        search={{ value: search, placeholder: 'Filter categories', onChange: setSearch }}
        empty={
          (
            <EmptyState
              icon={search ? <Layers /> : undefined}
              art={search ? undefined : <ShelfArt />}
              title={search ? 'No categories match' : 'No categories yet'}
              body={
                search
                  ? 'Try a shorter search term.'
                  : 'Categories group products in your shop. Add one to give it a page.'
              }
              actions={search ? <Button onClick={() => setSearch('')}>Clear filter</Button> : null}
            />
          )
        }
      />
    </div>
  );
}
