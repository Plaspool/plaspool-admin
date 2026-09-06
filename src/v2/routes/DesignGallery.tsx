import { useState } from 'react';
import {
  Archive,
  ArrowRight,
  Check,
  CheckCheck,
  CircleAlert,
  CornerDownRight,
  Download,
  House,
  ImagePlus,
  Inbox,
  Package,
  Plus,
  Receipt,
  Search,
  ShoppingBag,
  Star,
  Tags,
  TicketPercent,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { Badge, Banner, Button, ButtonLink, EmptyState, SplitEmpty, Stars } from '../ui/primitives';
import { AnalyticsBar, PageHeader } from '../ui/Page';
import { DataTable, IdCell, TablePager, type Column } from '../ui/DataTable';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { AffixField, Checkbox, Radio, Segmented, SelectField, TextArea, TextField } from '../ui/Field';
import { CouponArt, ReceiptArt, SpoolTiles } from '../ui/illustrations';
import { Defs } from '../ui/Defs';
import { PopEdit, PopEditFoot } from '../ui/PopEdit';
import { RichText } from '../ui/RichText';
import { SearchSelect } from '../ui/SearchSelect';
import { StatusPicker } from '../ui/StatusPicker';
import { TagInput } from '../ui/TagInput';
import { Timeline } from '../ui/Timeline';

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
  { key: 'qty', header: 'In stock', label: 'In stock', numeric: true, render: (r) => r.qty },
  { key: 'total', header: 'Price', label: 'Price', numeric: true, render: (r) => <strong className="num">{r.total}</strong> },
];

/** A drawn stand-in for a product photo — the gallery fetches nothing. */
const SPOOL_IMG = (ink: string, bg: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="${bg}"/><circle cx="40" cy="40" r="24" fill="none" stroke="${ink}" stroke-width="7"/><circle cx="40" cy="40" r="8" fill="${ink}"/></svg>`,
  )}`;

const SAMPLE_DOC = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Our ' },
        { type: 'text', marks: [{ type: 'bold' }], text: 'PLA Spool — Forest 1kg' },
        {
          type: 'text',
          text: ' prints clean at 195–215°C and holds its colour from first layer to last.',
        },
      ],
    },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Why this spool' }] },
    {
      type: 'bulletList',
      content: ['Tangle-free winding, measured', '1.75mm ±0.02 tolerance', 'Recyclable core'].map(
        (text) => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        }),
      ),
    },
  ],
};

function StatusSpecimen() {
  const [status, setStatus] = useState('active');
  return (
    <StatusPicker
      label="Product status"
      value={status}
      onChange={setStatus}
      options={[
        {
          value: 'active',
          label: 'Active',
          description: 'For sale on the storefront and in search.',
        },
        {
          value: 'draft',
          label: 'Draft',
          description: 'Not visible to customers until published.',
        },
        {
          value: 'archived',
          label: 'Archived',
          description: 'Off the storefront, kept for the record.',
        },
      ]}
    />
  );
}

function StateSpecimen() {
  const [state, setState] = useState('Abuja (FCT)');
  const STATES: { name: string; on: number; total: number }[] = [
    { name: 'Abia', on: 0, total: 17 },
    { name: 'Abuja (FCT)', on: 6, total: 6 },
    { name: 'Adamawa', on: 0, total: 21 },
    { name: 'Akwa Ibom', on: 2, total: 31 },
    { name: 'Anambra', on: 0, total: 21 },
    { name: 'Lagos', on: 20, total: 20 },
    { name: 'Rivers', on: 1, total: 23 },
  ];
  return (
    <SearchSelect
      label="State"
      value={state}
      onChange={setState}
      placeholder="Search states…"
      emptyText="No state matches that."
      options={STATES.map((s) => ({
        value: s.name,
        label: s.name,
        meta: `${s.on} of ${s.total}`,
      }))}
    />
  );
}

function TagSpecimen() {
  const [tags, setTags] = useState<string[]>(['PLA', 'Matte']);
  return (
    <TagInput
      label="Tags"
      value={tags}
      onChange={setTags}
      suggestions={[
        { name: 'PLA', count: 12 },
        { name: 'PETG', count: 5 },
        { name: 'Matte', count: 4 },
        { name: 'Silk', count: 3 },
        { name: 'Recycled', count: 2 },
      ]}
      hint="Existing spellings are offered while you type, so a tag is reused rather than re-invented."
    />
  );
}

function PopEditSpecimen() {
  const [price, setPrice] = useState('185.00');
  const [draft, setDraft] = useState(price);
  return (
    <PopEdit value={<span className="num">₦{price}</span>} ariaLabel="Edit price" align="left">
      {(close) => (
        <>
          <AffixField
            label="Price"
            prefix="₦"
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <TextArea label="Reason" rows={2} hint="Recorded in the audit trail." onChange={() => {}} />
          <PopEditFoot>
            <Button tone="plain" onClick={close}>
              Cancel
            </Button>
            <Button
              tone="primary"
              onClick={() => {
                setPrice(draft);
                close();
              }}
            >
              Save
            </Button>
          </PopEditFoot>
        </>
      )}
    </PopEdit>
  );
}

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
  const [fillDemo, setFillDemo] = useState('');
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

        <Section title="Mobile — resize this page to see the rules apply">
          <div className="stack stack--tight" style={{ fontSize: 'var(--t-md)', color: 'var(--ink-sub)', lineHeight: 1.6 }}>
            <p>
              One breakpoint, <strong style={{ color: 'var(--ink)' }}>48rem</strong>, and five
              transforms — every specimen on this page demonstrates its own below it:
            </p>
            <p>
              <strong style={{ color: 'var(--ink)' }}>Tables become collapsed cards.</strong> The
              identity leads; only the one or two GOVERNING facts a screen marks (status, a
              total, an inline editor) stay on the card, each a full-width label-left /
              value-right row. Everything else lives behind the card's expand key in a per-row
              details sheet — live renders, so inline editors work there too — with Open at the
              bottom. Unnamed action columns float to the card's corner.
            </p>
            <p>
              <strong style={{ color: 'var(--ink)' }}>Modals become bottom sheets</strong> — pinned,
              top-rounded, body scrolls between a fixed head and a footer whose two keys split
              into thumb-sized halves.
            </p>
            <p>
              <strong style={{ color: 'var(--ink)' }}>The rail becomes a drawer</strong> that slides
              under the topbar, dims the page, and closes itself on any navigation, on the scrim,
              and on Escape.
            </p>
            <p>
              <strong style={{ color: 'var(--ink)' }}>The crumb takes two taps on touch</strong> —
              the first peeks the parent page's name in a bubble (itself a link), the second goes.
              Pointers keep the one-click chip with its hover title.
            </p>
            <p>
              <strong style={{ color: 'var(--ink)' }}>The save bar takes the whole topbar</strong>,
              the bento stacks to one column, and keyboard chords (Ctrl K, the palette legend)
              stand down where there is no keyboard.
            </p>
          </div>
        </Section>

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
            { label: 'Sales after refunds', value: '₦156,450.00', series: [20, 24, 18, 30, 28, 41, 46] },
            { label: 'Items ordered', value: '61', series: [8, 9, 12, 10, 16, 15, 21] },
            { label: 'Sales reversals', value: '₦0.00' },
            { label: 'Sent out', value: '27', series: [3, 5, 5, 8, 7, 11, 13] },
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
            <AffixField label="Amount off" prefix="₦" placeholder="0.00" inputMode="decimal" />
            <AffixField label="Percentage off" suffix="%" defaultValue="10" inputMode="decimal" />
            <AffixField
              label="With a quick-fill"
              prefix="₦"
              inputMode="decimal"
              value={fillDemo}
              hint="Tab — or tap the keycap — types the suggestion out, ready to edit. Empty until then."
              suggestion="27600.00"
              onSuggest={setFillDemo}
              onChange={(e) => setFillDemo(e.target.value)}
            />
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

        {/* ══════════════════ DETAIL/EDIT COMPONENTS (second wave) ═════════ */}

        <Section title="Save bar — takes the topbar slot while a form is dirty">
          <div
            style={{
              background: 'var(--topbar-bg)',
              borderRadius: 'var(--r-lg)',
              padding: 'var(--s3)',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <div
              className="savebar"
              style={{ position: 'static', transform: 'none', animation: 'none', width: 'min(34rem, 100%)' }}
            >
              <CircleAlert aria-hidden="true" />
              <span className="savebar__label">Unsaved changes</span>
              <button type="button" className="savebar__btn savebar__btn--ghost">
                Discard
              </button>
              <button type="button" className="savebar__btn savebar__btn--save">
                Save
              </button>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 'var(--t-sm)' }}>
            The live component portals over the topbar's centre — the reference's own move — and
            wires <span className="mono">beforeunload</span> to the same dirty flag.
          </p>
        </Section>

        <Section title="Breadcrumb — the parent page is an icon chip, not a Back line">
          <PageHeader
            icon={<Package />}
            title="PLA Spool — Forest 1kg"
            titleBadge={<Badge tone="ok">Active</Badge>}
            subtitle="Storefront path: /products/pla-spool-forest"
            backTo="/design"
            backLabel="Products"
            actions={<Button size="lg">Secondary</Button>}
          />
          <p className="muted" style={{ fontSize: 'var(--t-sm)' }}>
            The chip carries the section icon, presses like every key, and takes you up a level.
            The chevron and title finish the crumb — no row spent on “← Back”.
          </p>
        </Section>

        <Section title="Status picker — a state is a sentence, not a word">
          <div style={{ maxWidth: '16rem' }}>
            <StatusSpecimen />
          </div>
        </Section>

        <Section title="Search select — a list too long to scan">
          <div style={{ maxWidth: '16rem' }}>
            <StateSpecimen />
          </div>
          <p className="muted" style={{ fontSize: 'var(--t-sm)' }}>
            Thirty-seven states don’t fit in a tab strip. Type to narrow, arrow to the row, Enter
            to pick — each row carries the figure that is usually WHY you’re looking.
          </p>
        </Section>

        <Section title="Definition list — the payment card's grammar">
          <div style={{ maxWidth: '20rem' }}>
            <Defs
              rows={[
                { label: 'Subtotal · 3 items', value: <span className="num">₦55,500.00</span> },
                { label: 'Delivery — Abuja', value: <span className="num">₦3,000.00</span> },
                { label: 'Tax', value: <span className="num">₦0.00</span> },
                { label: 'Total', value: <span className="num">₦58,500.00</span>, total: true },
                { label: 'Refunded', value: <span className="num">₦0.00</span> },
              ]}
            />
          </div>
        </Section>

        <Section title="Tag input — chips, and the store's own vocabulary">
          <div style={{ maxWidth: '26rem' }}>
            <TagSpecimen />
          </div>
        </Section>

        <Section title="Media — cover big, gallery small, add tile last">
          <div className="imgg" style={{ maxWidth: '26rem' }}>
            <div className="imgg__tile imgg__tile--cover">
              <img src={SPOOL_IMG('#2e2a6b', '#eeedf5')} alt="" />
              <span className="imgg__cover">Cover</span>
              <span className="imgg__acts" style={{ opacity: 1 }}>
                <button type="button" className="imgg__act" aria-label="Remove image">
                  <Trash2 aria-hidden="true" />
                </button>
              </span>
            </div>
            <div className="imgg__tile">
              <img src={SPOOL_IMG('#0c5132', '#eaf7ef')} alt="" />
              <span className="imgg__acts" style={{ opacity: 1 }}>
                <button type="button" className="imgg__act" aria-label="Set as cover image">
                  <Star aria-hidden="true" />
                </button>
                <button type="button" className="imgg__act" aria-label="Remove image">
                  <Trash2 aria-hidden="true" />
                </button>
              </span>
            </div>
            <div className="imgg__tile">
              <img src={SPOOL_IMG('#8e1f0b', '#fdf0ee')} alt="" />
            </div>
            <button type="button" className="imgg__add" aria-label="Add images">
              <ImagePlus aria-hidden="true" />
            </button>
          </div>
          <p className="muted" style={{ fontSize: 'var(--t-sm)' }}>
            Tile actions surface on hover (shown forced here). The live component uploads through
            the EXIF-stripping pipeline and releases every object URL it acquires.
          </p>
        </Section>

        <Section title="Rich text — the description editor, live">
          <RichText value={SAMPLE_DOC} onChange={() => {}} />
        </Section>

        <Section title="Inline cell editor — a price change carries its reason">
          <div className="row" style={{ gap: 'var(--s6)' }}>
            <PopEditSpecimen />
            <span className="muted" style={{ fontSize: 'var(--t-sm)', maxWidth: '20rem' }}>
              The dashed underline is the affordance. The panel is where the reason lives — the
              audit trail refuses a stock change without one.
            </span>
          </div>
        </Section>

        <Section title="Timeline — dots on a rail that ends at the last event">
          <div style={{ maxWidth: '28rem' }}>
            <Timeline
              events={[
                {
                  id: '1',
                  tone: 'ok',
                  message: 'Parcel marked delivered',
                  meta: '21 Aug, 14:02 · admin',
                },
                {
                  id: '2',
                  tone: 'info',
                  message: (
                    <>
                      Payment captured — <strong className="num">₦58,500.00</strong>
                    </>
                  ),
                  meta: '20 Aug, 09:15',
                },
                { id: '3', message: 'Order placed by dami@example.com', meta: '20 Aug, 09:14' },
              ]}
            />
          </div>
        </Section>

        <Section title="Rating stars">
          <div className="row" style={{ gap: 'var(--s4)' }}>
            <Stars value={5} />
            <Stars value={4} />
            <Stars value={2} />
            <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>
              Ink, not gold — the rating is data, and badges stay the only saturated surfaces.
            </span>
          </div>
        </Section>

        <Section title="Alerts popover — unread on the sub surface, check on hover" flush>
          <div className="card__body" style={{ background: 'var(--topbar-bg)', borderRadius: '0 0 var(--r-lg) var(--r-lg)' }}>
            <div className="alerts" style={{ position: 'static', animation: 'none', margin: '0 auto' }}>
              <div className="alerts__head">
                <span className="alerts__title">Alerts</span>
                <span className="alerts__tools">
                  <button type="button" className="alerts__tool" aria-label="Mark all as read">
                    <CheckCheck aria-hidden="true" />
                  </button>
                </span>
              </div>
              <div className="alerts__list">
                <div className="alerts__item is-unread">
                  <span className="alerts__dot" aria-hidden="true" />
                  <span className="alerts__content">
                    <span className="alerts__meta">Emails • Sunday at 4:05 PM</span>
                    <span className="alerts__itemtitle">2 emails will never send</span>
                    <span className="alerts__body">
                      Out of retry attempts — nothing resends these without you.
                    </span>
                  </span>
                  <button type="button" className="alerts__check" style={{ opacity: 1 }} aria-label="Mark as read">
                    <Check aria-hidden="true" />
                  </button>
                </div>
                <div className="alerts__item">
                  <span className="alerts__dot" aria-hidden="true" />
                  <span className="alerts__content">
                    <span className="alerts__meta">Reviews • Sunday at 1:22 PM</span>
                    <span className="alerts__itemtitle">3 reviews awaiting moderation</span>
                    <span className="alerts__body">Nothing shows on the storefront until it is approved.</span>
                  </span>
                </div>
              </div>
              <div className="alerts__foot">No more alerts</div>
            </div>
          </div>
        </Section>

        <Section title="Search palette (Ctrl+K) — pages and the latest records" flush>
          <div className="card__body" style={{ background: 'var(--bg)', borderRadius: '0 0 var(--r-lg) var(--r-lg)' }}>
            <div className="palette" style={{ animation: 'none', margin: '0 auto' }}>
              <div className="palette__head">
                <Search aria-hidden="true" />
                <input className="palette__input" placeholder="Search PlaSpool Admin" defaultValue="spool" aria-label="Search (specimen)" />
                <span className="palette__esc" aria-hidden="true">esc</span>
              </div>
              <div className="palette__chips">
                <button type="button" className="palette__chip" aria-pressed="true">Everything</button>
                <button type="button" className="palette__chip" aria-pressed="false">Pages</button>
                <button type="button" className="palette__chip" aria-pressed="false">Products</button>
                <button type="button" className="palette__chip" aria-pressed="false">Orders</button>
                <button type="button" className="palette__chip" aria-pressed="false">Discounts</button>
              </div>
              <div className="palette__body">
                <div className="palette__label">Products</div>
                <button type="button" className="palette__row is-hot">
                  <Package aria-hidden="true" />
                  <span className="palette__rowtitle">PLA Spool — Forest 1kg</span>
                  <span className="palette__rowmeta">Active</span>
                </button>
                <button type="button" className="palette__row">
                  <Package aria-hidden="true" />
                  <span className="palette__rowtitle">PETG Spool — Clear 750g</span>
                  <span className="palette__rowmeta">Draft</span>
                </button>
                <div className="palette__label">Orders</div>
                <button type="button" className="palette__row">
                  <Receipt aria-hidden="true" />
                  <span className="palette__rowtitle mono">PS-1042-7</span>
                  <span className="palette__rowmeta">dami@example.com · ₦58,500.00</span>
                </button>
                <div className="palette__label">Discounts</div>
                <button type="button" className="palette__row">
                  <TicketPercent aria-hidden="true" />
                  <span className="palette__rowtitle mono">SPOOL10</span>
                  <span className="palette__rowmeta">10% off</span>
                </button>
              </div>
              <div className="palette__foot">
                <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
                <span><kbd>↵</kbd> open</span>
                <span><kbd>esc</kbd> close</span>
                <span className="spacer" />
                <span>Pages, latest products, orders &amp; discounts</span>
              </div>
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
