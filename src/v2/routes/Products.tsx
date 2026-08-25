import { useMemo, useState } from 'react';
import { Archive, Package, Plus, Trash2 } from 'lucide-react';
import { shopApi, type ProductStatus, type ShopProduct } from '../../data/api-shop';
import { useAsync } from '../lib/useAsync';
import { humanise, productTone, shortDate } from '../lib/format';
import { AnalyticsBar, AnalyticsMenuItem, PageHeader, useAnalyticsBar, type Metric } from '../ui/Page';
import { Badge, Banner, Button, ButtonLink, EmptyState, SplitEmpty } from '../ui/primitives';
import { SpoolTiles } from '../ui/illustrations';
import { DataTable, IdCell, TablePager, type Column } from '../ui/DataTable';
import { StoredImg } from '../ui/Img';
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

  const { data, error, loading, reload } = useAsync(
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

  /**
   * Bulk lifecycle, run one product at a time — the API has no bulk route,
   * and pretending it does by hiding partial failure would be worse than the
   * sequential requests. The toast reports what actually happened.
   */
  async function bulkTransition(
    keys: string[],
    run: (id: string) => Promise<unknown>,
    verb: string,
  ) {
    let ok = 0;
    let failed = 0;
    for (const id of keys) {
      try {
        await run(id);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    toast.show(
      failed === 0
        ? `${ok} ${ok === 1 ? 'product' : 'products'} ${verb}`
        : `${ok} ${verb}, ${failed} refused — a transition only applies from certain states`,
      failed === 0 ? 'default' : 'critical',
    );
    reload();
  }

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
          thumb={
            p.coverImageId ? <StoredImg id={p.coverImageId} alt="" /> : <Package aria-hidden="true" />
          }
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
          <ButtonLink tone="primary" size="lg" to="/products/new">
            <Plus aria-hidden="true" />
            Add product
          </ButtonLink>
        }
        menu={(close) => (
          <>
            <AnalyticsMenuItem shown={shown} onToggle={toggle} close={close} />
            <MenuItem
              onSelect={() => {
                close();
                toast.show('Export is not built yet');
              }}
            >
              Export
            </MenuItem>
            <MenuItem
              onSelect={() => {
                close();
                toast.show('Import is not built yet');
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
              onAction: (keys) =>
                void bulkTransition(keys, (id) => shopApi.transitionProduct(id, 'unpublish'), 'set as draft'),
            },
          ],
          /* TODO(v2): bulk add/remove tags needs a tag-picking modal plus a
             CAS save per product — deferred, not forgotten. */
          menuGroups: [
            {
              items: [
                {
                  label: 'Publish products',
                  onAction: (keys) =>
                    void bulkTransition(keys, (id) => shopApi.transitionProduct(id, 'publish'), 'published'),
                },
                {
                  label: 'Archive products',
                  icon: <Archive aria-hidden="true" />,
                  onAction: (keys) =>
                    void bulkTransition(keys, (id) => shopApi.transitionProduct(id, 'archive'), 'archived'),
                },
                {
                  label: 'Move to trash',
                  icon: <Trash2 aria-hidden="true" />,
                  critical: true,
                  onAction: (keys) =>
                    void bulkTransition(keys, (id) => shopApi.trashProduct(id), 'moved to the trash'),
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
                  <ButtonLink tone="primary" to="/products/new">
                    <Plus aria-hidden="true" />
                    Add product
                  </ButtonLink>
                  <Button onClick={() => toast.show('Import is not built yet')}>Import</Button>
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
