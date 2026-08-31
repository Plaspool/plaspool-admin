import { useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import { shopApi, type ShopCategory } from '../../data/api-shop';
import { useAsync } from '../lib/useAsync';
import { AnalyticsBar, AnalyticsMenuItem, PageHeader, useAnalyticsBar, type Metric } from '../ui/Page';
import { Badge, Banner, Button, EmptyState } from '../ui/primitives';
import { ShelfArt } from '../ui/illustrations';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { useToast } from '../ui/Toast';

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

  const { data, error, loading } = useAsync((signal) => shopApi.listCategories(signal), []);
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
          <Button
            tone="primary"
            size="lg"
            onClick={() => toast.show('Adding categories is coming with the new product editor')}
          >
            Add category
          </Button>
        }
        menu={(close) => <AnalyticsMenuItem shown={shown} onToggle={toggle} close={close} />}
      />

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
