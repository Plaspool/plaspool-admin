import { useMemo, useState } from 'react';
import { Archive, Package, Plus, Tags, Trash2 } from 'lucide-react';
import { shopApi, type ProductStatus, type ShopProduct } from '../../data/api-shop';
import { useAsync } from '../lib/useAsync';
import { humanise, productTone, shortDate } from '../lib/format';
import { AnalyticsBar, AnalyticsMenuItem, PageHeader, useAnalyticsBar, type Metric } from '../ui/Page';
import { Badge, Banner, Button, EmptyState, SplitEmpty } from '../ui/primitives';
import { SpoolTiles } from '../ui/illustrations';
import { DataTable, IdCell, TablePager, type Column } from '../ui/DataTable';
import { MenuItem } from '../ui/Menu';
import { useToast } from '../ui/Toast';

/**
 * PRODUCTS.
 *
 * The endpoint filters by status and sorts, but does NOT search — so the search
 * box here filters the page you are looking at and says so in its placeholder,
 * rather than implying a store-wide search it cannot do. A control that quietly
 * searches less than it appears to is worse than one that states its scope.
 *
 * NO IMAGES YET, and the placeholder is deliberate. `acquireImageURL` hands
 * back an object URL that has to be released, which is a lifecycle this table
 * does not have; a broken thumbnail on every row would be worse than a neutral
 * mark. It lands with the in-depth product work.
 */

const TABS: { value: ProductStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'draft', label: 'Draft' },
  { value: 'archived', label: 'Archived' },
];

export default function Products() {
  const [shown, toggle] = useAnalyticsBar('products');
  const toast = useToast();
  const [tab, setTab] = useState<ProductStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'newest' | 'price_asc' | 'price_desc' | 'alphabetical'>('newest');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;

  const { data, error, loading } = useAsync(
    (signal) =>
      shopApi.listProducts(
        {
          ...(tab === 'all' ? {} : { status: tab }),
          sort,
          ...(cursor ? { cursor } : {}),
          limit: 25,
        },
        signal,
      ),
    [tab, sort, cursor],
  );

  const all = data?.items ?? [];
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (p) => p.title.toLowerCase().includes(q) || (p.category ?? '').toLowerCase().includes(q),
    );
  }, [all, search]);

  const metrics: Metric[] = useMemo(
    () => [
      { label: 'Products on this page', value: String(all.length) },
      { label: 'Active', value: String(all.filter((p) => p.status === 'active').length) },
      { label: 'Draft', value: String(all.filter((p) => p.status === 'draft').length) },
      { label: 'Archived', value: String(all.filter((p) => p.status === 'archived').length) },
      {
        label: 'Categories in use',
        value: String(new Set(all.map((p) => p.category).filter(Boolean)).size),
      },
    ],
    [all],
  );

  const columns: Column<ShopProduct>[] = [
    {
      key: 'product',
      header: 'Product',
      primary: true,
      render: (p) => (
        <IdCell
          thumb={<Package aria-hidden="true" />}
          title={p.title || 'Untitled product'}
          meta={p.slug ? <span className="mono">/{p.slug}</span> : 'No slug'}
          href={`/products/${p.id}`}
        />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      label: 'Status',
      tight: true,
      render: (p) => <Badge tone={productTone(p.status)}>{humanise(p.status)}</Badge>,
    },
    {
      key: 'category',
      header: 'Category',
      label: 'Category',
      render: (p) => p.category || <span className="muted">Uncategorised</span>,
    },
    {
      key: 'tags',
      header: 'Tags',
      label: 'Tags',
      render: (p) =>
        p.tags.length ? (
          <span className="muted">{p.tags.slice(0, 3).join(', ')}{p.tags.length > 3 ? ` +${p.tags.length - 3}` : ''}</span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { key: 'updated', header: 'Updated', label: 'Updated', render: (p) => shortDate(p.updatedAt) },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<Package />}
        title="Products"
        actions={
          <Button
            tone="primary"
            size="lg"
            onClick={() => toast.show('Creating products lands with the v2 product editor')}
          >
            <Plus aria-hidden="true" />
            Add product
          </Button>
        }
        menu={(close) => (
          <>
            <AnalyticsMenuItem shown={shown} onToggle={toggle} close={close} />
            <MenuItem
              onSelect={() => {
                close();
                toast.show('Export lands with the v2 product editor');
              }}
            >
              Export
            </MenuItem>
            <MenuItem
              onSelect={() => {
                close();
                toast.show('Import lands with the v2 product editor');
              }}
            >
              Import
            </MenuItem>
          </>
        )}
      />

      {shown ? <AnalyticsBar range="This page" metrics={metrics} /> : null}

      {error ? (
        <Banner tone="critical" title="Couldn’t load products">
          {error}
        </Banner>
      ) : null}

      <DataTable
        caption="Products"
        columns={columns}
        rows={rows}
        rowKey={(p) => p.id}
        hrefFor={(p) => `/products/${p.id}`}
        loading={loading}
        bulk={{
          pills: [
            {
              label: 'Set as draft',
              onAction: (keys) => toast.show(`Bulk edits land with the v2 product editor (${keys.length} selected)`),
            },
          ],
          menuGroups: [
            {
              items: [
                {
                  label: 'Archive products',
                  icon: <Archive aria-hidden="true" />,
                  onAction: (keys) => toast.show(`Archiving lands with the v2 product editor (${keys.length} selected)`),
                },
                {
                  label: 'Delete products',
                  icon: <Trash2 aria-hidden="true" />,
                  critical: true,
                  onAction: (keys) => toast.show(`Deleting lands with the v2 product editor (${keys.length} selected)`),
                },
              ],
            },
            {
              items: [
                {
                  label: 'Add tags',
                  icon: <Tags aria-hidden="true" />,
                  onAction: (keys) => toast.show(`Tagging lands with the v2 product editor (${keys.length} selected)`),
                },
                {
                  label: 'Remove tags',
                  icon: <Tags aria-hidden="true" />,
                  onAction: (keys) => toast.show(`Tagging lands with the v2 product editor (${keys.length} selected)`),
                },
              ],
            },
          ],
        }}
        tabs={{
          value: tab,
          tabs: TABS,
          onChange: (next) => {
            setCursors([null]);
            setTab(next);
          },
        }}
        search={{
          value: search,
          placeholder: 'Filter the products on this page',
          onChange: setSearch,
        }}
        sort={{
          value: sort,
          options: [
            { value: 'newest', label: 'Newest' },
            { value: 'alphabetical', label: 'Alphabetical' },
            { value: 'price_asc', label: 'Price, low to high' },
            { value: 'price_desc', label: 'Price, high to low' },
          ],
          onChange: (next) => {
            setCursors([null]);
            setSort(next as typeof sort);
          },
        }}
        empty={
          search ? (
            <EmptyState
              icon={<Package />}
              title="No products match that filter"
              body="The filter only searches the products on this page."
              actions={<Button onClick={() => setSearch('')}>Clear filter</Button>}
            />
          ) : (
            /* The reference's product first-run: copy left, a shelf of
               product pictures right. */
            <SplitEmpty
              title="Add your products"
              body="Start by stocking the store with spools your customers will love. Products you add show up here with their status, category and tags."
              actions={
                <>
                  <Button tone="primary" onClick={() => toast.show('Creating products lands with the v2 product editor')}>
                    <Plus aria-hidden="true" />
                    Add product
                  </Button>
                  <Button onClick={() => toast.show('Import lands with the v2 product editor')}>
                    Import
                  </Button>
                </>
              }
              shelf={<SpoolTiles />}
            />
          )
        }
        footer={
          <TablePager
            note={`${rows.length} shown`}
            canPrev={cursors.length > 1}
            canNext={Boolean(data?.nextCursor)}
            onPrev={() => setCursors((c) => c.slice(0, -1))}
            onNext={() => setCursors((c) => [...c, data?.nextCursor ?? null])}
          />
        }
      />
    </div>
  );
}
