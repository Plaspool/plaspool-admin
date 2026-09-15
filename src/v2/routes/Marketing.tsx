import { useCallback, useEffect, useState } from 'react';
import { BadgePercent, Coins, Megaphone, MoreHorizontal, Plus } from 'lucide-react';
import {
  marketingApi,
  settingsLabels,
  type AdjustmentResult,
  type CustomerSummary,
  type LedgerEntry,
  type MarketingSettings,
  type Program,
} from '../../data/api-marketing';
import { moneyRefusalMessage, parseMajor, plainMajor } from '../../data/api-shop';
import { ApiError } from '../../data/errors';
import { getSession } from '../../data/session';
import { dateTime, humanise, money } from '../lib/format';
import {
  AnalyticsBar,
  AnalyticsMenuItem,
  PageHeader,
  RevealMenuItem,
  useAnalyticsBar,
  useRevealPanel,
  type Metric,
} from '../ui/Page';
import { Badge, Banner, Button, ButtonLink, EmptyState } from '../ui/primitives';
import { Card } from '../ui/Card';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { Defs } from '../ui/Defs';
import { AffixField, Checkbox, MoneyField, SelectField, TextField } from '../ui/Field';
import { Menu, MenuItem } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { hasDomain } from '../../../shared/roles';
import { ProgramModal } from './ProgramModal';

/**
 * MARKETING — `/marketing`. The points machine's MARKETING half: manual
 * points programmes, what a point is worth at checkout, and the credit pen.
 *
 * THE PER-ITEM PROGRAMME IS NOT HERE ANY MORE (2026-09-06). What customers
 * earn for each item they send back, what that costs us, and which programme
 * a storefront request joins all live under Spools → Points and costs, beside
 * the pickups they govern. This screen still LOADS every programme — the
 * credit modal's programme select needs them — but its table lists only the
 * `adhoc` kind, and its create form makes only that kind. The banner below the
 * header points at the new home, because the owner learned this screen first.
 *
 * A PROGRAMME'S `key` IS IMMUTABLE AND NEVER PATCHED — the ledger's rows
 * point at it, so renaming moves the words and never the identity. Ledger
 * `reason` strings are snapshots: rendered verbatim, never re-labelled.
 *
 * TODO(v2): the per-customer ledger view (filter by kind, keyset back
 * through history) is not built — crediting shows the live balance and the
 * latest activity list covers the rest for now.
 */

export default function Marketing() {
  const toast = useToast();
  const session = getSession();
  /* WHO MAY EDIT rewards programs and redemption settings: the marketing
     DOMAIN (owner, developer, marketing), which is exactly what the server's
     domain gate admits on /api/marketing/* since migration 0680. `isOwner` is
     kept as the name every control below reads; the meaning is "may write
     marketing config". */
  const isOwner =
    'user' in session && session.user != null && hasDomain(session.user.role, 'marketing');

  const [programs, setPrograms] = useState<Program[] | null>(null);
  const [settings, setSettings] = useState<MarketingSettings | null>(null);
  const [latest, setLatest] = useState<(LedgerEntry & { customerEmail: string })[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<'closed' | 'new' | Program>('closed');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [crediting, setCrediting] = useState(false);
  /* Both start HIDDEN (owner's ask): the screen opens on the programmes and
     the redemption card — the numbers and the feed are a More-actions reveal,
     remembered for the session like every analytics bar. */
  const [barShown, toggleBar] = useAnalyticsBar('marketing');
  const [activityShown, toggleActivity] = useRevealPanel('marketing-activity', 'Points history');

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [programList, settingsRes, summary] = await Promise.all([
        marketingApi.listPrograms(signal),
        marketingApi.getSettings(signal),
        marketingApi.getSummary(signal).catch(() => null),
      ]);
      setPrograms(programList);
      setSettings(settingsRes);
      setLatest(summary?.latestLedger ?? null);
      setLoadError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setLoadError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function setProgramStatus(program: Program, status: 'active' | 'paused') {
    try {
      await marketingApi.patchProgram(program.id, {
        expectedRevision: program.revision,
        status,
      });
      toast.show(status === 'paused' ? `${program.name} paused` : `${program.name} active again`);
      void load();
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
      void load();
    }
  }

  /* Only the programmes this screen owns. The per-item ones are listed and
     edited under Spools → Points and costs; every row here is the same type,
     so there is no Type column and no rate to show. */
  const manual = (programs ?? []).filter((p) => p.kind === 'adhoc');

  const columns: Column<Program>[] = [
    {
      key: 'program',
      header: 'Programme',
      primary: true,
      render: (p) => (
        <IdCell
          thumb={<BadgePercent aria-hidden="true" />}
          title={p.name}
          meta={
            <>
              <span className="mono">{p.key}</span>
              {p.seeded ? ' · built in' : ''}
            </>
          }
        />
      ),
    },
    {
      key: 'awarded',
      header: 'Points given out',
      label: 'Points given out',
      numeric: true,
      render: (p) => <span className="num">{p.awardedTotal.toLocaleString()}</span>,
    },
    {
      key: 'status', mobile: 'keep',
      header: 'Status',
      label: 'Status',
      tight: true,
      render: (p) =>
        p.status === 'active' ? <Badge tone="ok">Active</Badge> : <Badge tone="warn">Paused</Badge>,
    },
    ...(isOwner
      ? [
          {
            key: 'act', pin: true,
            header: <span className="sr">Actions</span>,
            label: 'Actions',
            tight: true,
            render: (p: Program) => (
              <Menu
                chrome="bare"
                buttonLabel={`Actions for ${p.name}`}
                label={
                  <span className="btn btn--plain btn--icon" style={{ display: 'inline-grid', placeItems: 'center' }}>
                    <MoreHorizontal aria-hidden="true" />
                  </span>
                }
              >
                {(close) => (
                  <>
                    <MenuItem
                      onSelect={() => {
                        close();
                        setEditing(p);
                      }}
                    >
                      Edit programme…
                    </MenuItem>
                    <MenuItem
                      onSelect={() => {
                        close();
                        void setProgramStatus(p, p.status === 'active' ? 'paused' : 'active');
                      }}
                    >
                      {p.status === 'active' ? 'Pause' : 'Resume'}
                    </MenuItem>
                  </>
                )}
              </Menu>
            ),
          } satisfies Column<Program>,
        ]
      : []),
  ];

  const words = settings ? settingsLabels(settings) : null;

  /* The bar's numbers come from what the screen already loaded — nothing is
     fetched for a panel that is hidden by default. No deltas and no series:
     these are standings, not a window, and a fabricated sparkline under a
     real number is the thing the bar must never do. */
  const metrics: Metric[] = [
    { label: 'Programmes', value: String(manual.length) },
    {
      label: 'Active',
      value: String(manual.filter((p) => p.status === 'active').length),
    },
    {
      label: 'Points given out',
      value: manual.reduce((n, p) => n + p.awardedTotal, 0).toLocaleString(),
    },
    ...(settings && settings.redemptionEnabled
      ? [
          {
            label: 'Point worth',
            value: `${settings.redemptionRatePoints} = ${money(settings.redemptionRateMinor, settings.redemptionCurrency)}`,
          },
        ]
      : []),
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<Megaphone />}
        title="Marketing"
        subtitle="Points you give out by hand, and what a point is worth at checkout."
        menu={(close) => (
          <>
            <AnalyticsMenuItem shown={barShown} onToggle={toggleBar} close={close} />
            <RevealMenuItem
              shown={activityShown}
              onToggle={toggleActivity}
              close={close}
              noun="points history"
            />
          </>
        )}
        actions={
          isOwner ? (
            <Button tone="primary" size="lg" onClick={() => setEditing('new')}>
              <Plus aria-hidden="true" />
              New programme
            </Button>
          ) : undefined
        }
      />

      {barShown ? <AnalyticsBar range="Store total" metrics={metrics} /> : null}

      {loadError ? (
        <Banner tone="critical" title="Couldn’t load marketing" action={<Button onClick={() => void load()}>Retry</Button>}>
          {loadError}
        </Banner>
      ) : null}

      <Banner
        tone="info"
        title="Looking for the programme that pays for items sent back?"
        action={<ButtonLink to="/spools/rates">Open Points and costs</ButtonLink>}
      >
        It moved to the Spools section, next to the pickups it pays for — along with what each
        item costs us and what a pickup costs in each district.
      </Banner>

      <div className="form2">
        <div className="form2__main">
          <DataTable
            caption="Manual points programmes"
            columns={columns}
            rows={manual}
            rowKey={(p) => p.id}
            onRowClick={isOwner ? setEditing : undefined}
            loading={programs === null && !loadError}
            empty={
              <EmptyState
                icon={<BadgePercent />}
                title="No manual points programmes"
                body="A manual points programme lets you add points to a customer by hand — goodwill, a prize, a thank-you."
              />
            }
            footer={null}
          />

          {activityShown ? (
          <Card title="Points history">
            {latest === null ? (
              <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                The history didn’t load. Nobody’s points are affected.
              </p>
            ) : latest.length === 0 ? (
              <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                No points given out yet. Points show up here once a pickup is checked and paid
                out, or you add some by hand.
              </p>
            ) : (
              <div className="stack stack--tight">
                {latest.map((entry) => (
                  <div key={entry.id} className="row" style={{ gap: 'var(--s3)', alignItems: 'baseline' }}>
                    <span
                      className="num"
                      style={{
                        fontWeight: 'var(--w-semi)',
                        color: entry.delta < 0 ? 'var(--critical)' : 'var(--ink-strong)',
                        minWidth: '3.5rem',
                        textAlign: 'right',
                      }}
                    >
                      {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 'var(--t-md)' }}>{entry.customerEmail}</span>
                      {/* The reason is a snapshot — verbatim, never re-labelled. */}
                      <span className="muted" style={{ fontSize: 'var(--t-sm)', display: 'block' }}>
                        {entry.reason} · {humanise(entry.kind)} · {dateTime(entry.createdAt)}
                      </span>
                    </span>
                    <span className="muted num" style={{ fontSize: 'var(--t-sm)' }}>
                      → {entry.balanceAfter}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
          ) : null}
        </div>

        <aside className="form2__side">
          <Card
            title="Spending points"
            action={
              isOwner && settings ? (
                <Button onClick={() => setSettingsOpen(true)}>Edit</Button>
              ) : undefined
            }
          >
            {!settings ? (
              <div className="stack stack--tight" aria-hidden="true">
                <span className="skel" style={{ width: '9rem' }} />
                <span className="skel" style={{ width: '11rem', opacity: 0.7 }} />
              </div>
            ) : (
              <>
                <Defs
                  rows={[
                    {
                      label: 'At checkout',
                      value: settings.redemptionEnabled ? (
                        <Badge tone="ok">On</Badge>
                      ) : (
                        <Badge tone="warn">Off</Badge>
                      ),
                    },
                    {
                      label: 'Worth',
                      value: (
                        <span className="num">
                          {settings.redemptionRatePoints} {words!.points.other} ={' '}
                          {money(settings.redemptionRateMinor, settings.redemptionCurrency)}
                        </span>
                      ),
                    },
                    { label: 'Minimum spend', value: `${settings.minRedeemPoints} ${words!.points.other}` },
                    {
                      label: 'Order limit',
                      value: `${(settings.maxRedeemBps / 100).toFixed(settings.maxRedeemBps % 100 === 0 ? 0 : 2)}% of the order`,
                    },
                  ]}
                />
                <span className="field__hint">
                  This is what points are worth at checkout. Changing it doesn’t change anyone’s
                  points — only what those points can buy.
                </span>
              </>
            )}
          </Card>

          <Card title="Add points by hand">
            <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.5 }}>
              Add or take away points yourself, with a reason. An email you don’t recognise
              simply starts at zero, so you can credit a walk-in customer too.
            </p>
            {isOwner ? (
              <div>
                <Button onClick={() => setCrediting(true)}>
                  <Coins aria-hidden="true" />
                  Credit a customer…
                </Button>
              </div>
            ) : (
              <span className="field__hint">Only the owner can do this.</span>
            )}
          </Card>
        </aside>
      </div>

      {editing !== 'closed' && isOwner ? (
        <ProgramModal
          kind="adhoc"
          program={editing === 'new' ? null : editing}
          onClose={() => setEditing('closed')}
          onDone={() => {
            setEditing('closed');
            void load();
          }}
        />
      ) : null}

      {settingsOpen && settings ? (
        <SettingsModal
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onDone={(next) => {
            setSettingsOpen(false);
            setSettings(next);
            toast.show('Spending settings saved');
          }}
        />
      ) : null}

      {crediting ? (
        <CreditModal
          programs={(programs ?? []).filter((p) => p.status === 'active')}
          onClose={() => setCrediting(false)}
          onDone={(result) => {
            setCrediting(false);
            void load();
            toast.show(`Done — their balance is now ${result.balance}`);
          }}
        />
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════ SETTINGS + CREDIT ══ */

/**
 * NOTE WHAT IS ABSENT: `defaultReturnProgramId`. Which programme a storefront
 * request joins is decided under Spools → Points and costs, beside the
 * programmes it chooses between; a PATCH from here leaves it alone by simply
 * not carrying the key.
 */
function SettingsModal({
  settings,
  onClose,
  onDone,
}: {
  settings: MarketingSettings;
  onClose: () => void;
  onDone: (next: MarketingSettings) => void;
}) {
  const [enabled, setEnabled] = useState(settings.redemptionEnabled);
  const [ratePoints, setRatePoints] = useState(String(settings.redemptionRatePoints));
  const [rateMajor, setRateMajor] = useState(() =>
    plainMajor(settings.redemptionRateMinor, settings.redemptionCurrency),
  );
  const [minPoints, setMinPoints] = useState(String(settings.minRedeemPoints));
  const [capPercent, setCapPercent] = useState(String(settings.maxRedeemBps / 100));
  const [labelOne, setLabelOne] = useState(settings.pointsLabelSingular);
  const [labelMany, setLabelMany] = useState(settings.pointsLabelPlural);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function commit() {
    const nRatePoints = Number(ratePoints);
    /* `parseMajor`, never `Number(...) * 100`: the box groups its thousands
       (`1,500.00`), which `Number` reads as NaN, and a float times 100 is
       not always the integer it looks like. */
    const rate = parseMajor(rateMajor, settings.redemptionCurrency);
    const nMin = Number(minPoints);
    const pct = Number(capPercent);
    if (!Number.isInteger(nRatePoints) || nRatePoints < 1) {
      setError('The number of points must be a whole number, 1 or more.');
      return;
    }
    if (!rate.ok) {
      setError(
        rate.reason === 'empty' || rate.reason === 'negative'
          ? 'The money amount must be more than zero.'
          : `How much money: ${moneyRefusalMessage(rate.reason, settings.redemptionCurrency)}`,
      );
      return;
    }
    if (rate.minor < 1) {
      setError('The money amount must be more than zero.');
      return;
    }
    if (!Number.isInteger(nMin) || nMin < 0) {
      setError('Minimum spend must be a whole number of points.');
      return;
    }
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      setError('The order limit must be a percentage between 0 and 100.');
      return;
    }
    if (!labelOne.trim() || !labelMany.trim()) {
      setError('Fill in both point words. Balances are shown using them.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await marketingApi.patchSettings({
        expectedRevision: settings.revision,
        redemptionEnabled: enabled,
        redemptionRatePoints: nRatePoints,
        redemptionRateMinor: rate.minor,
        minRedeemPoints: nMin,
        maxRedeemBps: Math.round(pct * 100),
        pointsLabelSingular: labelOne.trim(),
        pointsLabelPlural: labelMany.trim(),
      });
      onDone(next);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="How points are spent"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void commit()}>
            Save settings
          </Button>
        </>
      }
    >
      <div className="stack">
        <Checkbox
          label="Points can be spent at checkout"
          hint="Turning this off stops spending. Customers still earn."
          checked={enabled}
          onChange={setEnabled}
        />
        <div className="row" style={{ alignItems: 'flex-end', gap: 'var(--s3)' }}>
          <div style={{ flex: 1 }}>
            <TextField
              label="How many points"
              type="number"
              min={1}
              step={1}
              value={ratePoints}
              onChange={(e) => {
                setRatePoints(e.target.value);
                setError(null);
              }}
            />
          </div>
          <span className="muted" style={{ paddingBottom: '0.6rem' }}>
            are worth
          </span>
          <div style={{ flex: 1 }}>
            <MoneyField
              label="How much money"
              currency={settings.redemptionCurrency}
              value={rateMajor}
              onChange={(e) => {
                setRateMajor(e.target.value);
                setError(null);
              }}
            />
          </div>
        </div>
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 1 }}>
            <TextField
              label="Minimum points to spend"
              type="number"
              min={0}
              step={1}
              value={minPoints}
              onChange={(e) => setMinPoints(e.target.value)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <AffixField
              label="Order limit"
              suffix="%"
              inputMode="decimal"
              value={capPercent}
              hint="The most of an order that points can pay for."
              onChange={(e) => setCapPercent(e.target.value)}
            />
          </div>
        </div>
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 1 }}>
            <TextField label="Word for one point" value={labelOne} onChange={(e) => setLabelOne(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <TextField label="Word for many points" value={labelMany} onChange={(e) => setLabelMany(e.target.value)} />
          </div>
        </div>
        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}

function CreditModal({
  programs,
  onClose,
  onDone,
}: {
  programs: Program[];
  onClose: () => void;
  onDone: (result: AdjustmentResult) => void;
}) {
  const [email, setEmail] = useState('');
  const [lookup, setLookup] = useState<CustomerSummary | null>(null);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [programId, setProgramId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function checkBalance() {
    const addr = email.trim().toLowerCase();
    if (!addr.includes('@')) return;
    try {
      setLookup(await marketingApi.getCustomer(addr));
    } catch {
      setLookup(null);
    }
  }

  async function commit() {
    const addr = email.trim().toLowerCase();
    const n = Number(delta);
    if (!addr.includes('@')) {
      setError('Enter the customer’s email address.');
      return;
    }
    if (!Number.isInteger(n) || n === 0) {
      setError('Enter a whole number of points. Use a minus sign to take points away.');
      return;
    }
    /* NO REASON GUARD since 2026-09-03 (owner's instruction). This is the one
     * ledger row nothing else in the database explains, so the field is still
     * asked for and still prefilled from the presets — it just no longer stops
     * the entry being saved. */
    setBusy(true);
    setError(null);
    try {
      const result = await marketingApi.adjust({
        email: addr,
        delta: n,
        /* `filled()` drops a blank before the body is built, so this sends no
         * `reason` key rather than `''` — which the route still refuses. */
        reason: reason.trim(),
        ...(programId ? { programId } : {}),
      });
      onDone(result);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'insufficient_balance') {
        setError('That would take their balance below zero.');
      } else {
        setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      }
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add points by hand"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void commit()}>
            <Coins aria-hidden="true" />
            Save entry
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField
          label="Customer email"
          type="email"
          value={email}
          autoFocus
          hint={
            lookup
              ? `Balance: ${lookup.balance} · earned in total ${lookup.lifetimeEarned}${lookup.displayName ? ` · ${lookup.displayName}` : ''}`
              : 'An email you don’t recognise simply starts at zero.'
          }
          onChange={(e) => {
            setEmail(e.target.value);
            setLookup(null);
            setError(null);
          }}
          onBlur={() => void checkBalance()}
        />
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 0.7 }}>
            <TextField
              label="Points"
              type="number"
              step={1}
              value={delta}
              placeholder="+50 or -20"
              onChange={(e) => {
                setDelta(e.target.value);
                setError(null);
              }}
            />
          </div>
          <div style={{ flex: 1.3 }}>
            <SelectField label="Programme" value={programId} onChange={(e) => setProgramId(e.target.value)}>
              <option value="">None — general balance</option>
              {programs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectField>
          </div>
        </div>
        <TextField
          label="Reason (optional)"
          value={reason}
          placeholder="Goodwill for the late pickup"
          hint="Saved permanently. Nothing else records why these points moved."
          onChange={(e) => {
            setReason(e.target.value);
            setError(null);
          }}
        />
        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}
