import { useCallback, useEffect, useState } from 'react';
import { BadgePercent, Coins, Megaphone, MoreHorizontal, Plus } from 'lucide-react';
import {
  labelsOf,
  marketingApi,
  settingsLabels,
  type AdjustmentResult,
  type CustomerSummary,
  type LedgerEntry,
  type MarketingSettings,
  type Program,
  type ProgramDraft,
} from '../../data/api-marketing';
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
import { Badge, Banner, Button, EmptyState } from '../ui/primitives';
import { Card } from '../ui/Card';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { Defs } from '../ui/Defs';
import { AffixField, Checkbox, Segmented, SelectField, TextField } from '../ui/Field';
import { Menu, MenuItem } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

/**
 * MARKETING — `/marketing`. The points machine: programmes, the redemption
 * settings, and the owner's credit pen.
 *
 * A PROGRAMME'S `key` IS IMMUTABLE AND NEVER PATCHED — the ledger's rows
 * point at it, so renaming moves the words and never the identity. Ledger
 * `reason` strings are snapshots: rendered verbatim, never re-labelled.
 *
 * TODO(tests): none — skipped this session, recorded in CLAUDE.md. Worth
 * pinning: the redemption rate round-trip (points ↔ minor units), and the
 * insufficient-balance 409 surfacing beside the delta field.
 *
 * TODO(v2): the per-customer ledger view (filter by kind, keyset back
 * through history) is not built — crediting shows the live balance and the
 * latest activity list covers the rest for now.
 */

function pluralise(n: number, one: string, other: string): string {
  return `${n} ${n === 1 ? one : other}`;
}

export default function Marketing() {
  const toast = useToast();
  const session = getSession();
  const isOwner = 'user' in session && session.user?.role === 'owner';

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
  const [activityShown, toggleActivity] = useRevealPanel('marketing-activity', 'Latest activity');

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
              {p.seeded ? ' · seeded preset' : ''}
            </>
          }
        />
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      label: 'Kind',
      tight: true,
      render: (p) => <Badge>{p.kind === 'unit_return' ? 'Unit return' : 'Ad hoc'}</Badge>,
    },
    {
      key: 'rate',
      header: 'Rate',
      label: 'Rate',
      render: (p) => {
        const labels = labelsOf(p);
        if (p.kind !== 'unit_return' || p.pointsPerUnit === null) {
          return <span className="muted">Manual credits only</span>;
        }
        return (
          <span>
            {pluralise(p.pointsPerUnit, labels.points.one, labels.points.other)} per{' '}
            {labels.unit?.one ?? 'unit'}
            {p.minUnitsPerReturn && p.minUnitsPerReturn > 1 ? (
              <span className="muted"> · min {p.minUnitsPerReturn}</span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'open',
      header: 'Open returns',
      label: 'Open returns',
      numeric: true,
      render: (p) => <span className="num">{p.openReturns}</span>,
    },
    {
      key: 'awarded',
      header: 'Awarded',
      label: 'Awarded',
      numeric: true,
      render: (p) => <span className="num">{p.awardedTotal}</span>,
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
    { label: 'Programmes', value: String((programs ?? []).length) },
    {
      label: 'Active',
      value: String((programs ?? []).filter((p) => p.status === 'active').length),
    },
    {
      label: 'Open returns',
      value: String((programs ?? []).reduce((n, p) => n + p.openReturns, 0)),
    },
    {
      label: 'Points awarded',
      value: (programs ?? []).reduce((n, p) => n + p.awardedTotal, 0).toLocaleString(),
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
        subtitle="The points programmes, what they pay, and what points are worth at checkout."
        menu={(close) => (
          <>
            <AnalyticsMenuItem shown={barShown} onToggle={toggleBar} close={close} />
            <RevealMenuItem
              shown={activityShown}
              onToggle={toggleActivity}
              close={close}
              noun="latest activity"
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

      <div className="form2">
        <div className="form2__main">
          <DataTable
            caption="Programmes"
            columns={columns}
            rows={programs ?? []}
            rowKey={(p) => p.id}
            onRowClick={isOwner ? setEditing : undefined}
            loading={programs === null && !loadError}
            empty={
              <EmptyState
                icon={<BadgePercent />}
                title="No programmes"
                body="A programme names what customers earn and what a returned unit pays."
              />
            }
            footer={null}
          />

          {activityShown ? (
          <Card title="Latest activity">
            {latest === null ? (
              <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                The activity feed didn’t load — the ledger itself is unaffected.
              </p>
            ) : latest.length === 0 ? (
              <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                Nothing in the ledger yet — awards land here as returns are inspected.
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
            title="Redemption"
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
                      label: 'Cart cap',
                      value: `${(settings.maxRedeemBps / 100).toFixed(settings.maxRedeemBps % 100 === 0 ? 0 : 2)}% of the order`,
                    },
                    {
                      label: 'Default programme',
                      value:
                        (programs ?? []).find((p) => p.id === settings.defaultReturnProgramId)?.name ?? (
                          <span className="muted">None</span>
                        ),
                    },
                  ]}
                />
                <span className="field__hint">
                  The rate every checkout redemption prices from. Points already held keep their
                  count — a rate change moves what they buy.
                </span>
              </>
            )}
          </Card>

          <Card title="Credit points">
            <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.5 }}>
              A manual ledger entry — a goodwill credit, or a debit with its reason. An unknown
              email is a zero balance, not an error, so a walk-in is creditable.
            </p>
            {isOwner ? (
              <div>
                <Button onClick={() => setCrediting(true)}>
                  <Coins aria-hidden="true" />
                  Credit a customer…
                </Button>
              </div>
            ) : (
              <span className="field__hint">Owner-only.</span>
            )}
          </Card>
        </aside>
      </div>

      {editing !== 'closed' && isOwner ? (
        <ProgramModal
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
          programs={programs ?? []}
          onClose={() => setSettingsOpen(false)}
          onDone={(next) => {
            setSettingsOpen(false);
            setSettings(next);
            toast.show('Redemption settings saved');
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
            toast.show(`Done — balance is now ${result.balance}`);
          }}
        />
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════ PROGRAM MODAL ══ */

function ProgramModal({
  program,
  onClose,
  onDone,
}: {
  program: Program | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const creating = program === null;
  const [kind, setKind] = useState<'unit_return' | 'adhoc'>(program?.kind ?? 'unit_return');
  const [key, setKey] = useState(program?.key ?? '');
  const [name, setName] = useState(program?.name ?? '');
  const [pointsOne, setPointsOne] = useState(program?.pointsLabelSingular ?? 'point');
  const [pointsMany, setPointsMany] = useState(program?.pointsLabelPlural ?? 'points');
  const [unitOne, setUnitOne] = useState(program?.unitLabelSingular ?? '');
  const [unitMany, setUnitMany] = useState(program?.unitLabelPlural ?? '');
  const [perUnit, setPerUnit] = useState(
    program?.pointsPerUnit != null ? String(program.pointsPerUnit) : '',
  );
  const [minUnits, setMinUnits] = useState(
    program?.minUnitsPerReturn != null ? String(program.minUnitsPerReturn) : '1',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function commit() {
    if (!name.trim() || !pointsOne.trim() || !pointsMany.trim()) {
      setError('Name and both points labels are required.');
      return;
    }
    const unit = kind === 'unit_return';
    const nPerUnit = Number(perUnit);
    const nMin = Number(minUnits);
    if (unit) {
      if (!unitOne.trim() || !unitMany.trim()) {
        setError('A unit-return programme needs its unit words — “spool”, “spools”.');
        return;
      }
      if (!Number.isInteger(nPerUnit) || nPerUnit < 1) {
        setError('Points per unit is a whole number of at least 1.');
        return;
      }
      if (!Number.isInteger(nMin) || nMin < 1) {
        setError('Minimum units is a whole number of at least 1.');
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        const machineKey = key.trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(machineKey)) {
          setError('The key is the immutable machine handle: 3–32 of a-z, 0-9, - or _.');
          setBusy(false);
          return;
        }
        const draft: ProgramDraft = {
          key: machineKey,
          kind,
          name: name.trim(),
          pointsLabelSingular: pointsOne.trim(),
          pointsLabelPlural: pointsMany.trim(),
          ...(unit
            ? {
                unitLabelSingular: unitOne.trim(),
                unitLabelPlural: unitMany.trim(),
                pointsPerUnit: nPerUnit,
                minUnitsPerReturn: nMin,
              }
            : {}),
        };
        const created = await marketingApi.createProgram(draft);
        toast.show(`${created.name} created`);
      } else {
        await marketingApi.patchProgram(program.id, {
          expectedRevision: program.revision,
          name: name.trim(),
          pointsLabelSingular: pointsOne.trim(),
          pointsLabelPlural: pointsMany.trim(),
          ...(unit
            ? {
                unitLabelSingular: unitOne.trim(),
                unitLabelPlural: unitMany.trim(),
                pointsPerUnit: nPerUnit,
                minUnitsPerReturn: nMin,
              }
            : {}),
        });
        toast.show(`${name.trim()} saved`);
      }
      onDone();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={creating ? 'New programme' : `Edit ${program.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void commit()}>
            {creating ? 'Create programme' : 'Save programme'}
          </Button>
        </>
      }
    >
      <div className="stack">
        {creating ? (
          <Segmented
            label="Kind"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'unit_return', label: 'Unit return' },
              { value: 'adhoc', label: 'Ad hoc' },
            ]}
            hint="Unit return pays per accepted unit; ad hoc is a bucket for manual credits."
          />
        ) : (
          <span className="field__hint">
            Kind and key never change — the ledger’s rows point at them.{' '}
            <span className="mono">{program.key}</span>
          </span>
        )}
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          {creating ? (
            <div style={{ flex: 0.8 }}>
              <TextField
                label="Key"
                value={key}
                className="input mono"
                placeholder="spool-return"
                spellCheck={false}
                hint="Immutable machine handle."
                onChange={(e) => setKey(e.target.value)}
              />
            </div>
          ) : null}
          <div style={{ flex: 1.2 }}>
            <TextField label="Name" value={name} placeholder="Spool returns" onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 1 }}>
            <TextField label="Point, singular" value={pointsOne} onChange={(e) => setPointsOne(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <TextField label="Points, plural" value={pointsMany} onChange={(e) => setPointsMany(e.target.value)} />
          </div>
        </div>
        {kind === 'unit_return' ? (
          <>
            <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
              <div style={{ flex: 1 }}>
                <TextField label="Unit, singular" value={unitOne} placeholder="spool" onChange={(e) => setUnitOne(e.target.value)} />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label="Units, plural" value={unitMany} placeholder="spools" onChange={(e) => setUnitMany(e.target.value)} />
              </div>
            </div>
            <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
              <div style={{ flex: 1 }}>
                <TextField
                  label="Points per unit"
                  type="number"
                  min={1}
                  step={1}
                  value={perUnit}
                  hint="Snapshotted onto every request — a change never restates old cards."
                  onChange={(e) => setPerUnit(e.target.value)}
                />
              </div>
              <div style={{ flex: 1 }}>
                <TextField
                  label="Minimum units per return"
                  type="number"
                  min={1}
                  step={1}
                  value={minUnits}
                  onChange={(e) => setMinUnits(e.target.value)}
                />
              </div>
            </div>
          </>
        ) : null}
        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════ SETTINGS + CREDIT ══ */

function SettingsModal({
  settings,
  programs,
  onClose,
  onDone,
}: {
  settings: MarketingSettings;
  programs: Program[];
  onClose: () => void;
  onDone: (next: MarketingSettings) => void;
}) {
  const [enabled, setEnabled] = useState(settings.redemptionEnabled);
  const [ratePoints, setRatePoints] = useState(String(settings.redemptionRatePoints));
  const [rateMajor, setRateMajor] = useState(
    (settings.redemptionRateMinor / 100).toFixed(2),
  );
  const [minPoints, setMinPoints] = useState(String(settings.minRedeemPoints));
  const [capPercent, setCapPercent] = useState(String(settings.maxRedeemBps / 100));
  const [labelOne, setLabelOne] = useState(settings.pointsLabelSingular);
  const [labelMany, setLabelMany] = useState(settings.pointsLabelPlural);
  const [defaultProgram, setDefaultProgram] = useState(settings.defaultReturnProgramId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function commit() {
    const nRatePoints = Number(ratePoints);
    const nRateMinor = Math.round(Number(rateMajor) * 100);
    const nMin = Number(minPoints);
    const pct = Number(capPercent);
    if (!Number.isInteger(nRatePoints) || nRatePoints < 1) {
      setError('The points side of the rate is a whole number of at least 1.');
      return;
    }
    if (!Number.isFinite(nRateMinor) || nRateMinor < 1) {
      setError('The money side of the rate has to be a positive amount.');
      return;
    }
    if (!Number.isInteger(nMin) || nMin < 0) {
      setError('Minimum spend is a whole number of points.');
      return;
    }
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      setError('The cart cap is a percentage between 0 and 100.');
      return;
    }
    if (!labelOne.trim() || !labelMany.trim()) {
      setError('Both points words are required — balances render with them.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await marketingApi.patchSettings({
        expectedRevision: settings.revision,
        redemptionEnabled: enabled,
        redemptionRatePoints: nRatePoints,
        redemptionRateMinor: nRateMinor,
        minRedeemPoints: nMin,
        maxRedeemBps: Math.round(pct * 100),
        pointsLabelSingular: labelOne.trim(),
        pointsLabelPlural: labelMany.trim(),
        defaultReturnProgramId: defaultProgram || null,
      });
      onDone(next);
    } catch (cause) {
      if (cause instanceof ApiError && cause.detail === 'defaultReturnProgramId') {
        setError('That programme is gone — pick another default.');
      } else {
        setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      }
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Redemption settings"
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
          hint="Off keeps earning on while spending waits."
          checked={enabled}
          onChange={setEnabled}
        />
        <div className="row" style={{ alignItems: 'flex-end', gap: 'var(--s3)' }}>
          <div style={{ flex: 1 }}>
            <TextField
              label="Rate — points"
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
            <AffixField
              label="Rate — money"
              prefix={settings.redemptionCurrency}
              inputMode="decimal"
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
              label="Cart cap"
              suffix="%"
              inputMode="decimal"
              value={capPercent}
              hint="The share of an order points may pay."
              onChange={(e) => setCapPercent(e.target.value)}
            />
          </div>
        </div>
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 1 }}>
            <TextField label="Point, singular" value={labelOne} onChange={(e) => setLabelOne(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <TextField label="Points, plural" value={labelMany} onChange={(e) => setLabelMany(e.target.value)} />
          </div>
        </div>
        <SelectField
          label="Default returns programme"
          value={defaultProgram}
          hint="What a new return lands on when nothing names one."
          onChange={(e) => setDefaultProgram(e.target.value)}
        >
          <option value="">None</option>
          {programs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </SelectField>
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
      setError('The customer’s email is the ledger’s identity.');
      return;
    }
    if (!Number.isInteger(n) || n === 0) {
      setError('A whole number of points — negative debits, and zero is nothing.');
      return;
    }
    if (!reason.trim()) {
      setError('The reason is stored verbatim, forever — it is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await marketingApi.adjust({
        email: addr,
        delta: n,
        reason: reason.trim(),
        ...(programId ? { programId } : {}),
      });
      onDone(result);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'insufficient_balance') {
        setError('That debit would take the balance below zero — the ledger refuses it.');
      } else {
        setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      }
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Credit points"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void commit()}>
            <Coins aria-hidden="true" />
            Write the entry
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
              ? `Balance: ${lookup.balance} · lifetime ${lookup.lifetimeEarned}${lookup.displayName ? ` · ${lookup.displayName}` : ''}`
              : 'An unknown email is a zero balance, not an error.'
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
          label="Reason"
          value={reason}
          placeholder="Goodwill for the late pickup"
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
