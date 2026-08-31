import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Archive, Package, Plus, Tags, Trash2 } from 'lucide-react';
import { shopApi, type ProductStatus, type ShopProduct, type ShopTag } from '../../data/api-shop';
import {
  shopCsvApi,
  type CsvImportPreview,
  type ProductExportResult,
} from '../../data/api-shop-csv';
import { getSession, subscribe } from '../../data/session';
import { useAsync } from '../lib/useAsync';
import { humanise, productTone, shortDate } from '../lib/format';
import { AnalyticsBar, AnalyticsMenuItem, PageHeader, useAnalyticsBar, type Metric } from '../ui/Page';
import { Badge, Banner, Button, ButtonLink, EmptyState, SplitEmpty } from '../ui/primitives';
import { SpoolTiles } from '../ui/illustrations';
import { DataTable, IdCell, TablePager, type Column } from '../ui/DataTable';
import { Checkbox } from '../ui/Field';
import { StoredImg } from '../ui/Img';
import { MenuItem } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { TagInput } from '../ui/TagInput';
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
  const [tagAction, setTagAction] = useState<{ mode: 'add' | 'remove'; keys: string[] } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

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
      key: 'status', mobile: 'keep',
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
                setExportOpen(true);
              }}
            >
              Export…
            </MenuItem>
            <MenuItem
              onSelect={() => {
                close();
                setImportOpen(true);
              }}
            >
              Import…
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
            {
              section: 'Organise',
              items: [
                {
                  label: 'Add tags…',
                  icon: <Tags aria-hidden="true" />,
                  onAction: (keys) => setTagAction({ mode: 'add', keys }),
                },
                {
                  label: 'Remove tags…',
                  icon: <Tags aria-hidden="true" />,
                  onAction: (keys) => setTagAction({ mode: 'remove', keys }),
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
                  <Button onClick={() => setImportOpen(true)}>Import</Button>
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

      {tagAction ? (
        <BulkTagsModal
          mode={tagAction.mode}
          products={tagAction.keys
            .map((key) => all.find((p) => p.id === key))
            .filter((p): p is ShopProduct => Boolean(p))}
          onClose={() => setTagAction(null)}
          onDone={(ok, failed) => {
            setTagAction(null);
            toast.show(
              failed === 0
                ? `Tags updated on ${ok} ${ok === 1 ? 'product' : 'products'}`
                : `${ok} updated, ${failed} refused — refresh and retry those`,
              failed === 0 ? 'default' : 'critical',
            );
            reload();
          }}
        />
      ) : null}

      {exportOpen ? <ExportModal onClose={() => setExportOpen(false)} /> : null}
      {importOpen ? (
        <ImportModal
          onClose={() => setImportOpen(false)}
          onDone={() => {
            setImportOpen(false);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Export: build the whole catalogue as CSV server-side, email the signed-in
 * admin the download link, and offer the same link right here — the email is
 * the convenience, never the only way out (a deployment with no mail still
 * answers with the URL and says so).
 */
function ExportModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const session = useSyncExternalStore(subscribe, getSession, getSession);
  const email = session.status === 'authed' ? session.user.email : null;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProductExportResult | null>(null);

  async function run() {
    setBusy(true);
    try {
      setResult(await shopCsvApi.exportProducts());
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Export failed', 'critical');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Export products"
      onClose={onClose}
      footer={
        result ? (
          <Button tone="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button tone="primary" busy={busy} onClick={() => void run()}>
              Email me the export
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="stack">
          <p style={{ fontSize: 'var(--t-md)' }}>
            {`${result.export.rowCount} ${result.export.rowCount === 1 ? 'row' : 'rows'} exported.`}
          </p>
          <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
            {result.emailed
              ? 'The download link is on its way to your inbox, and works for 7 days.'
              : 'Email is not configured on this deployment — use the link below; it works for 7 days.'}
          </p>
          <p style={{ fontSize: 'var(--t-md)' }}>
            {/* A plain anchor on purpose: the response is Content-Disposition
                attachment, so the browser downloads rather than navigates. */}
            <a href={result.export.url}>Download now</a>
          </p>
          <div>
            <Button
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(result.export.url)
                  .then(() => toast.show('Link copied'))
                  .catch(() => toast.show('Couldn’t copy — use the link above', 'critical'));
              }}
            >
              Copy link
            </Button>
          </div>
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
          Every product, one row per variant. The download link goes to{' '}
          <strong>{email ?? 'your email'}</strong> and works for 7 days.
        </p>
      )}
    </Modal>
  );
}

/**
 * Import, easy like the reference admin: choose a file, see what it would do,
 * then apply. The preview round trip runs the server's real parser, so the
 * counts and the per-row problems here are the ones apply will act on — not a
 * client-side guess that can disagree with it.
 */
function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [csv, setCsv] = useState<string | null>(null);
  const [replace, setReplace] = useState(true);
  const [preview, setPreview] = useState<CsvImportPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);

  async function pick(file: File | undefined) {
    if (!file) return;
    setPreview(null);
    setChecking(true);
    try {
      const text = await file.text();
      setCsv(text);
      setPreview(await shopCsvApi.previewImport(text, replace));
    } catch (err) {
      setCsv(null);
      toast.show(err instanceof Error ? err.message : 'Couldn’t read that file', 'critical');
    } finally {
      setChecking(false);
    }
  }

  async function apply() {
    if (csv === null) return;
    setBusy(true);
    try {
      const r = await shopCsvApi.applyImport(csv, replace);
      const parts = [`${r.created} created`, `${r.updated} updated`];
      if (r.skipped > 0) parts.push(`${r.skipped} skipped`);
      if (r.invalid.length > 0) {
        parts.push(`${r.invalid.length} ${r.invalid.length === 1 ? 'row' : 'rows'} refused`);
      }
      toast.show(parts.join(' · '), r.invalid.length > 0 ? 'critical' : 'default');
      onDone();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Import failed', 'critical');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Import products"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            tone="primary"
            busy={busy}
            disabled={csv === null || checking}
            onClick={() => void apply()}
          >
            Import products
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
          One row per variant, matching the export: Handle is the product’s URL slug and is how
          rows are matched to what you already have. Prices are in naira with two decimals; stock
          is the absolute count.
        </p>
        <label className="field">
          <span className="field__label">CSV file</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => void pick(event.target.files?.[0])}
          />
        </label>
        <Checkbox
          label="Replace products with the same handle"
          hint="Unticked, rows whose handle already exists are skipped rather than updated."
          checked={replace}
          onChange={setReplace}
        />
        {checking ? (
          <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
            Checking the file…
          </p>
        ) : null}
        {preview ? (
          <div className="stack stack--tight">
            <p style={{ fontSize: 'var(--t-md)' }}>
              <strong>
                {`${preview.creates} new · ${preview.updates} to update · ${preview.invalid.length} ${
                  preview.invalid.length === 1 ? 'row' : 'rows'
                } with problems`}
              </strong>
            </p>
            {preview.invalid.slice(0, 5).map((problem) => (
              <p key={problem.line} className="muted" style={{ fontSize: 'var(--t-sm)' }}>
                {`Row ${problem.line}: ${problem.problem}`}
              </p>
            ))}
            {preview.invalid.length > 5 ? (
              <p className="muted" style={{ fontSize: 'var(--t-sm)' }}>
                {`…and ${preview.invalid.length - 5} more`}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * Bulk tag edits: a CAS save per product, sequentially — the API has no bulk
 * route, and each row's `revision` is the one it was listed with, so a row
 * another tab moved refuses honestly instead of being overwritten.
 */
function BulkTagsModal({
  mode,
  products,
  onClose,
  onDone,
}: {
  mode: 'add' | 'remove';
  products: ShopProduct[];
  onClose: () => void;
  onDone: (ok: number, failed: number) => void;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [vocabulary, setVocabulary] = useState<ShopTag[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode !== 'add') return;
    let live = true;
    shopApi
      .listTags()
      .then((tags) => {
        if (live) setVocabulary(tags);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [mode]);

  const present = useMemo(() => {
    const set = new Map<string, number>();
    for (const p of products) for (const t of p.tags) set.set(t, (set.get(t) ?? 0) + 1);
    return [...set.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [products]);

  async function apply() {
    setBusy(true);
    let ok = 0;
    let failed = 0;
    for (const product of products) {
      const next =
        mode === 'add'
          ? [...product.tags, ...chosen.filter((t) => !product.tags.some((x) => x.toLowerCase() === t.toLowerCase()))]
          : product.tags.filter((t) => !ticked.has(t));
      if (next.join('\0') === product.tags.join('\0')) {
        ok += 1;
        continue;
      }
      try {
        await shopApi.saveProduct(product.id, { tags: next }, { baseRevision: product.revision });
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    onDone(ok, failed);
  }

  const nothingChosen = mode === 'add' ? chosen.length === 0 : ticked.size === 0;

  return (
    <Modal
      title={mode === 'add' ? `Add tags to ${products.length} ${products.length === 1 ? 'product' : 'products'}` : 'Remove tags'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} disabled={nothingChosen} onClick={() => void apply()}>
            {mode === 'add' ? 'Add tags' : 'Remove tags'}
          </Button>
        </>
      }
    >
      {mode === 'add' ? (
        <TagInput
          label="Tags to add"
          value={chosen}
          onChange={setChosen}
          suggestions={vocabulary}
          hint="Added to every selected product; existing spellings win over typed ones."
        />
      ) : present.length === 0 ? (
        <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
          The selected products carry no tags.
        </p>
      ) : (
        <div className="stack stack--tight">
          <span className="field__label">Tick what goes</span>
          {present.map(([tag, count]) => (
            <Checkbox
              key={tag}
              label={
                <>
                  {tag}{' '}
                  <span className="muted">
                    — on {count} of {products.length}
                  </span>
                </>
              }
              checked={ticked.has(tag)}
              onChange={(next) =>
                setTicked((was) => {
                  const set = new Set(was);
                  if (next) set.add(tag);
                  else set.delete(tag);
                  return set;
                })
              }
            />
          ))}
        </div>
      )}
    </Modal>
  );
}
