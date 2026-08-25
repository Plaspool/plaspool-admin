import { useState } from 'react';
import {
  Archive,
  ArrowRight,
  CornerDownRight,
  Download,
  House,
  Inbox,
  Package,
  Plus,
  ShoppingBag,
  Tags,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { Badge, Banner, Button, ButtonLink, EmptyState, SplitEmpty } from '../ui/primitives';
import { AnalyticsBar, PageHeader } from '../ui/Page';
import { DataTable, IdCell, TablePager, type Column } from '../ui/DataTable';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { AffixField, Checkbox, Radio, Segmented, SelectField, TextField } from '../ui/Field';
import { CouponArt, ReceiptArt, SpoolTiles } from '../ui/illustrations';

/**
 * THE DESIGN SYSTEM, ON ONE PAGE — `#/design`.
 *
 * Outside the auth gate on purpose: it fetches nothing and renders only
 * sample data, so reviewing components never needs production credentials.
 * The SPECIMENS at the top exist because the shell itself only renders
 * signed-in — the sidebar's pill rule and connector, the pressed states, and
 * the modal are reproduced here statically so a screenshot of this page is a
 * complete visual test of the system.
 */

interface SampleRow {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'neutral';
  statusLabel: string;
  qty: number;
  total: string;
}

const ROWS: SampleRow[] = [
  { id: '1', name: 'PLA Spool — Forest 1kg', status: 'ok', statusLabel: 'Active', qty: 32, total: '₦18,500.00' },
  { id: '2', name: 'PLA Spool — Signal Orange 1kg', status: 'ok', statusLabel: 'Active', qty: 12, total: '₦18,500.00' },
  { id: '3', name: 'PETG Spool — Clear 750g', status: 'warn', statusLabel: 'Draft', qty: 0, total: '₦21,000.00' },
  { id: '4', name: 'Sample pack — 6 colours', status: 'neutral', statusLabel: 'Archived', qty: 4, total: '₦9,900.00' },
];

const COLUMNS: Column<SampleRow>[] = [
  {
    key: 'name',
    header: 'Product',
    primary: true,
    render: (r) => (
      <IdCell thumb={<Package aria-hidden="true" />} title={r.name} meta={<span className="mono">/spools</span>} />
    ),
  },
  { key: 'status', header: 'Status', label: 'Status', tight: true, render: (r) => <Badge tone={r.status}>{r.statusLabel}</Badge> },
  { key: 'qty', header: 'On hand', label: 'On hand', numeric: true, render: (r) => r.qty },
  { key: 'total', header: 'Price', label: 'Price', numeric: true, render: (r) => <strong className="num">{r.total}</strong> },
];

function Section({ title, children, flush = false }: { title: string; children: React.ReactNode; flush?: boolean }) {
  return (
    <section className="card">
      <div className="card__head">
        <h2 className="card__title">{title}</h2>
      </div>
      <div className={flush ? '' : 'card__body stack'}>{children}</div>
    </section>
  );
}

/** The rail, reproduced statically with a CHILD active — the state that
 *  carries the whole rule: one pill, parent plain, connector exactly as long
 *  as it needs to be, ↳ as its terminal elbow. */
function SidebarSpecimen() {
  return (
    <div style={{ width: '15rem', background: 'var(--bg)', borderRadius: 'var(--r-lg)', padding: 'var(--s3)' }}>
      <nav className="side" style={{ border: 0, padding: 0, overflow: 'visible' }} aria-label="Sidebar specimen">
        <div>
          <a className="side__link" href="#/design">
            <House aria-hidden="true" />
            <span className="side__label">Home</span>
          </a>
        </div>
        <div>
          <a className="side__link" href="#/design">
            <ShoppingBag aria-hidden="true" />
            <span className="side__label">Orders</span>
          </a>
        </div>
        <div>
          {/* the section you are INSIDE: named, not pilled */}
          <a className="side__link is-section" href="#/design">
            <Package aria-hidden="true" />
            <span className="side__label">Products</span>
          </a>
          <div className="side__sub">
            <a className="side__sublink" href="#/design">
              <CornerDownRight className="side__arrow" aria-hidden="true" />
              <span className="side__label">Categories</span>
            </a>
            <a className="side__sublink is-active" href="#/design">
              <CornerDownRight className="side__arrow" aria-hidden="true" />
              <span className="side__label">Inventory</span>
            </a>
            <a className="side__sublink" href="#/design">
              <CornerDownRight className="side__arrow" aria-hidden="true" />
              <span className="side__label">Reviews</span>
            </a>
          </div>
        </div>
        <div>
          <a className="side__link" href="#/design">
            <Users aria-hidden="true" />
            <span className="side__label">Customers</span>
          </a>
        </div>
      </nav>
    </div>
  );
}

export default function DesignGallery() {
  const [seg, setSeg] = useState<'code' | 'auto'>('code');
  const [check, setCheck] = useState(true);
  const [tab, setTab] = useState<'all' | 'active'>('all');
  const [q, setQ] = useState('');
  const [expScope, setExpScope] = useState<'page' | 'all' | 'selected'>('page');
  const [expAs, setExpAs] = useState<'excel' | 'plain'>('excel');

  return (
    <div style={{ background: 'var(--bg)', minHeight: '100%', overflowY: 'auto' }}>
      <div className="page">
        <PageHeader
          title="Design system"
          subtitle="Every v2 component with sample data. Nothing on this page touches the API."
          actions={
            <>
              <Button size="lg">Secondary</Button>
              <Button tone="primary" size="lg">
                <Plus aria-hidden="true" />
                Primary
              </Button>
            </>
          }
          menu={(close) => (
            <>
              <MenuItem icon={<Download aria-hidden="true" />} onSelect={close}>
                Export
              </MenuItem>
              <MenuItem icon={<Upload aria-hidden="true" />} onSelect={close}>
                Import
              </MenuItem>
              <MenuSeparator />
              <MenuItem critical icon={<Trash2 aria-hidden="true" />} onSelect={close}>
                A destructive action
              </MenuItem>
            </>
          )}
        />

        <Section title="Buttons — rest, held-open, disabled">
          <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s3)' }}>
            <Button tone="primary">Primary</Button>
            <Button>Default</Button>
            <Button tone="plain">Plain</Button>
            <Button tone="critical">Critical</Button>
            <button type="button" className="btn btn--default is-open">
              Held open
            </button>
            <button type="button" className="btn btn--primary is-open">
              Held open
            </button>
            <Button disabled>Disabled</Button>
            <Menu label="More actions">
              {(close) => (
                <>
                  <MenuItem onSelect={close}>First action</MenuItem>
                  <MenuItem onSelect={close}>Second action</MenuItem>
                </>
              )}
            </Menu>
          </div>
          <p className="muted" style={{ fontSize: 'var(--t-sm)' }}>
            Hold one down: the press is instant and travels a full pixel; only the release is
            animated. A trigger with its menu open keeps the pressed face until the menu closes.
          </p>
        </Section>

        <Section title="Sidebar — one pill, connector as long as it needs to be" flush>
          <div className="card__body" style={{ display: 'flex', gap: 'var(--s6)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <SidebarSpecimen />
            <p className="muted" style={{ maxWidth: '22rem', fontSize: 'var(--t-md)', lineHeight: 1.6 }}>
              Inventory is the current screen, so Inventory alone carries the pill. Products — the
              section it lives in — is named in ink but not pilled, and the connector runs from
              under the Products icon down exactly as far as the active child, where the ↳ is its
              terminal elbow. Rows below the active one get no line.
            </p>
          </div>
        </Section>

        <div className="stack">
          <Banner
            tone="critical"
            title="2 emails will never send"
            action={<ButtonLink to="/design">View emails</ButtonLink>}
          >
            These are out of retry attempts. Nothing will resend them without you.
          </Banner>
          <Banner tone="warn" title="Codes do not apply at checkout yet">
            The admin side is live; the storefront half is not built.
          </Banner>
        </div>

        <AnalyticsBar
          range="Today"
          metrics={[
            { label: 'Orders', value: '32', delta: '+8%', series: [4, 6, 5, 9, 7, 12, 14] },
            { label: 'Net revenue', value: '₦156,450.00', series: [20, 24, 18, 30, 28, 41, 46] },
            { label: 'Items ordered', value: '61', series: [8, 9, 12, 10, 16, 15, 21] },
            { label: 'Sales reversals', value: '₦0.00' },
            { label: 'Fulfilled', value: '27', series: [3, 5, 5, 8, 7, 11, 13] },
          ]}
        />

        <DataTable
          caption="Sample table"
          columns={COLUMNS}
          rows={ROWS.filter(
            (r) =>
              (tab === 'all' || r.status === 'ok') &&
              (!q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase())),
          )}
          rowKey={(r) => r.id}
          bulk={{
            pills: [{ label: 'Set as draft', onAction: () => {} }],
            menuGroups: [
              {
                items: [
                  { label: 'Archive products', icon: <Archive aria-hidden="true" />, onAction: () => {} },
                  { label: 'Delete products', icon: <Trash2 aria-hidden="true" />, critical: true, onAction: () => {} },
                ],
              },
              {
                section: 'Organise',
                items: [{ label: 'Add tags', icon: <Tags aria-hidden="true" />, onAction: () => {} }],
              },
            ],
          }}
          initialSelected={['1', '2']}
          tabs={{
            value: tab,
            tabs: [
              { value: 'all', label: 'All' },
              { value: 'active', label: 'Active' },
            ],
            onChange: setTab,
          }}
          search={{ value: q, placeholder: 'Filter this sample', onChange: setQ }}
          sort={{
            value: 'newest',
            options: [
              { value: 'newest', label: 'Newest' },
              { value: 'alphabetical', label: 'Alphabetical' },
            ],
            onChange: () => {},
          }}
          empty={
            <EmptyState
              icon={<Inbox />}
              title="No rows match"
              body="The filter-miss grade: an icon ring, no illustration."
              actions={<Button onClick={() => setQ('')}>Clear filter</Button>}
            />
          }
          footer={<TablePager note="4 sample rows" canPrev={false} canNext={false} onPrev={() => {}} onNext={() => {}} />}
        />

        <Section title="Table skeleton — the wait shows the shape" flush>
          <DataTable
            caption="Skeleton sample"
            columns={COLUMNS}
            rows={[]}
            rowKey={() => ''}
            loading
            skeletonRows={4}
            search={{ value: '', placeholder: 'Search and filter', onChange: () => {} }}
            empty={null}
          />
        </Section>

        <Section title="Bento (Home) — 2 / 3 / 1, art cropped by the card" flush>
          <div className="card__body">
            <div className="bento">
              <a className="bento__card bento__card--a" href="#/design">
                <span className="bento__art">
                  <ReceiptArt />
                </span>
                <span className="bento__stat num">6</span>
                <span className="bento__kicker">Orders</span>
                <span className="bento__title">Work through orders</span>
                <span className="bento__body">Fulfil what is paid for, chase what is not.</span>
                <span className="bento__go" aria-hidden="true">
                  <ArrowRight />
                </span>
              </a>
              <a className="bento__card bento__card--b" href="#/design">
                <span className="bento__art">
                  <CouponArt />
                </span>
                <span className="bento__kicker">Discounts</span>
                <span className="bento__title">Set up a discount</span>
                <span className="bento__body">A code a customer types at checkout.</span>
                <span className="bento__go" aria-hidden="true">
                  <ArrowRight />
                </span>
              </a>
            </div>
            <p className="muted" style={{ fontSize: 'var(--t-sm)', marginTop: 'var(--s3)' }}>
              Hover a card: it lifts on a spring while the illustration counter-rotates and the
              arrow chip fills ink. On mount the cards rise in, staggered.
            </p>
          </div>
        </Section>

        <Section title="Split empty (Products first-run)" flush>
          <SplitEmpty
            title="Add your products"
            body="Start by stocking the store with spools your customers will love."
            actions={
              <>
                <Button tone="primary">
                  <Plus aria-hidden="true" />
                  Add product
                </Button>
                <Button>Import</Button>
              </>
            }
            shelf={<SpoolTiles />}
          />
        </Section>

        <Section title="Modal specimen" flush>
          <div className="card__body" style={{ background: 'var(--bg)', borderRadius: '0 0 var(--r-lg) var(--r-lg)' }}>
            <div className="modal" style={{ margin: '0 auto', animation: 'none' }}>
              <div className="modal__head">
                <h2 className="modal__title">Export products</h2>
                <Button tone="plain" iconOnly aria-label="Close (specimen)">
                  <X aria-hidden="true" />
                </Button>
              </div>
              <div className="modal__body stack">
                <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
                  This CSV file can update all product information. To update just inventory
                  quantities use the <a href="#/design">CSV file for inventory</a>.
                </p>
                <div className="stack stack--tight">
                  <span className="field__label">Export</span>
                  <Radio
                    name="exp-scope"
                    label="Current page"
                    checked={expScope === 'page'}
                    onChange={() => setExpScope('page')}
                  />
                  <Radio
                    name="exp-scope"
                    label="All products"
                    checked={expScope === 'all'}
                    onChange={() => setExpScope('all')}
                  />
                  <Radio
                    name="exp-scope"
                    label="Selected: 2 products"
                    checked={expScope === 'selected'}
                    onChange={() => setExpScope('selected')}
                  />
                  <Radio
                    name="exp-scope"
                    label="2 products matching your search"
                    checked={false}
                    disabled
                    onChange={() => {}}
                  />
                </div>
                <div className="stack stack--tight">
                  <span className="field__label">Export as</span>
                  <Radio
                    name="exp-as"
                    label="CSV for Excel, Numbers, or other spreadsheet programs"
                    checked={expAs === 'excel'}
                    onChange={() => setExpAs('excel')}
                  />
                  <Radio
                    name="exp-as"
                    label="Plain CSV file"
                    checked={expAs === 'plain'}
                    onChange={() => setExpAs('plain')}
                  />
                </div>
              </div>
              <div className="modal__foot">
                <Button>Cancel</Button>
                <Button tone="primary">
                  <Upload aria-hidden="true" />
                  Export products
                </Button>
              </div>
            </div>
          </div>
        </Section>

        <Section title="Form controls">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))', gap: 'var(--s4)' }}>
            <TextField label="Discount code" placeholder="SUMMER20" hint="Customers type this at checkout." />
            <TextField label="With an error" defaultValue="not-an-email" error="That does not look like an email address." />
            <AffixField label="Amount off" prefix="NGN" placeholder="0.00" inputMode="decimal" />
            <AffixField label="Percentage off" suffix="%" defaultValue="10" inputMode="decimal" />
            <SelectField label="Type" defaultValue="percent">
              <option value="percent">Percentage</option>
              <option value="fixed">Fixed amount</option>
            </SelectField>
            <div className="stack stack--tight">
              <Segmented
                label="Method"
                value={seg}
                onChange={setSeg}
                options={[
                  { value: 'code', label: 'Discount code' },
                  { value: 'auto', label: 'Automatic', disabled: true, title: 'Not built yet' },
                ]}
              />
              <Checkbox label="Limit total uses" hint="Null means unlimited." checked={check} onChange={setCheck} />
            </div>
          </div>
        </Section>

        <p className="page__learn">
          `#/design` renders outside the auth gate and fetches nothing — the design system as a
          deliverable, separate from every screen that uses it.
        </p>
      </div>
    </div>
  );
}
