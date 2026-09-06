import { useCallback, useEffect, useMemo, useState } from 'react';
import { BadgePercent, Lock, MapPin, Plus } from 'lucide-react';
import {
  labelsOf,
  marketingApi,
  type MarketingSettings,
  type Program,
  type ServiceArea,
} from '../../data/api-marketing';
import { moneyRefusalMessage, parseMajor, plainMajor } from '../../data/api-shop';
import { getSession } from '../../data/session';
import { hasDomain } from '../../../shared/roles';
import { money } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, ButtonLink, EmptyState } from '../ui/primitives';
import { Card } from '../ui/Card';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { Defs } from '../ui/Defs';
import { AffixField, SelectField } from '../ui/Field';
import { PopEdit, PopEditFoot } from '../ui/PopEdit';
import { SearchSelect } from '../ui/SearchSelect';
import { useToast } from '../ui/Toast';
import { ProgramModal } from './ProgramModal';

/**
 * POINTS AND COSTS — `/spools/rates`. Three numbers about the programme that
 * pays for items sent back, gathered on one screen because the analytics page
 * divides one of them by the others:
 *
 *   1. What customers EARN for each item, and the fewest items a pickup may
 *      hold — the per-item programme (`kind: 'unit_return'`). Until
 *      2026-09-06 it was a row on Marketing beside the manual-points ones.
 *   2. Which programme a STOREFRONT REQUEST joins — `defaultReturnProgramId`,
 *      a settings field that used to sit in Marketing's redemption modal, a
 *      screen that no longer lists the programmes it chooses between.
 *   3. What a PICKUP NORMALLY COSTS in each district — the four standard lines
 *      (0920) that used to be a cell on Delivery areas, where a "costs us"
 *      column beside a "we charge" column read as a claim about parcels.
 *
 * EVERY WORD DRAWN FROM A PROGRAMME COMES FROM THE ROW (`labelsOf`): the name
 * of a point, the name of an item. This screen never writes the preset's noun
 * down, so a second programme collecting something else reads correctly.
 *
 * ONLY SWITCHED-ON DISTRICTS ARE LISTED for a pickup standard. A standard for
 * a place nobody collects from is a number with nothing to stand in for; the
 * switch itself lives on Where we collect, and the empty state says so.
 *
 * THE GATE IS `marketing`, matching the API's: programmes, settings and
 * districts are all in that domain, so the orders roles would meet a 403 on
 * the first fetch of a screen that rendered for them.
 */

const CURRENCY = 'NGN';

function pluralise(n: number, one: string, other: string): string {
  return `${n} ${n === 1 ? one : other}`;
}

interface Group {
  region: string;
  areas: ServiceArea[];
}

export default function SpoolsRates() {
  const toast = useToast();
  const session = getSession();
  const viewer = 'user' in session ? session.user : null;
  const allowed = viewer !== null && hasDomain(viewer.role, 'marketing');

  const [programs, setPrograms] = useState<Program[] | null>(null);
  const [settings, setSettings] = useState<MarketingSettings | null>(null);
  const [areas, setAreas] = useState<ServiceArea[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<'closed' | 'new' | Program>('closed');
  const [savingDefault, setSavingDefault] = useState(false);
  const [region, setRegion] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [programList, settingsRes, areasView] = await Promise.all([
        marketingApi.listPrograms(signal),
        marketingApi.getSettings(signal),
        marketingApi.listAreas(false, signal),
      ]);
      setPrograms(programList);
      setSettings(settingsRes);
      setAreas(areasView.areas);
      setLoadError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setLoadError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, allowed]);

  /* The programmes this screen owns. Manual-points ones stay on Marketing. */
  const perItem = useMemo(
    () => (programs ?? []).filter((p) => p.kind === 'unit_return'),
    [programs],
  );

  /** States with at least one district switched on, each with those districts. */
  const groups = useMemo<Group[]>(() => {
    const on = (areas ?? []).filter((a) => a.active);
    const names = [...new Set(on.map((a) => a.region))];
    return names.map((name) => ({ region: name, areas: on.filter((a) => a.region === name) }));
  }, [areas]);

  useEffect(() => {
    if (groups.length === 0) return;
    setRegion((chosen) =>
      chosen !== null && groups.some((g) => g.region === chosen) ? chosen : groups[0]!.region,
    );
  }, [groups]);

  const shown = groups.find((g) => g.region === region) ?? null;

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (shown?.areas ?? []).filter((a) => !q || a.name.toLowerCase().includes(q));
  }, [shown, search]);

  async function setStatus(program: Program, status: 'active' | 'paused') {
    try {
      await marketingApi.patchProgram(program.id, {
        expectedRevision: program.revision,
        status,
      });
      toast.show(
        status === 'paused'
          ? `${program.name} paused — nobody can ask for a pickup until you resume it`
          : `${program.name} is active again`,
      );
      void load();
    } catch (cause) {
      toast.show(
        cause instanceof Error && cause.message ? cause.message : 'Something went wrong.',
        'critical',
      );
      void load();
    }
  }

  /** Which programme a storefront request joins. Saved on change, the way a
   *  switch is — one deliberate pick, one write, the toast as the receipt. */
  async function saveDefault(programId: string) {
    if (!settings) return;
    setSavingDefault(true);
    try {
      const next = await marketingApi.patchSettings({
        expectedRevision: settings.revision,
        defaultReturnProgramId: programId || null,
      });
      setSettings(next);
      toast.show(
        programId
          ? 'Saved — new requests join that programme'
          : 'Saved — customers can’t ask for a pickup until you choose one',
      );
    } catch (cause) {
      toast.show(
        cause instanceof Error && cause.message ? cause.message : 'Something went wrong.',
        'critical',
      );
      void load();
    } finally {
      setSavingDefault(false);
    }
  }

  /**
   * The district's STANDARD PICKUP COST (0920). It is never copied onto a
   * pickup: the cost form on a pickup shows it as grey placeholder text and the
   * analytics resolves it at read time, so a correction here improves every
   * estimate that leaned on it — including last year's.
   */
  async function writeStandard(
    area: ServiceArea,
    patch: Record<string, number | null>,
  ): Promise<boolean> {
    try {
      const next = await marketingApi.patchArea(area.id, {
        expectedRevision: area.revision,
        ...patch,
      });
      setAreas((list) => (list ?? []).map((a) => (a.id === next.id ? { ...a, ...next } : a)));
      return true;
    } catch (cause) {
      toast.show(
        cause instanceof Error && cause.message ? cause.message : 'Something went wrong.',
        'critical',
      );
      /* A CAS miss means another tab moved it — re-read rather than guess. */
      void load();
      return false;
    }
  }

  if (!allowed) {
    return (
      <div className="page">
        <PageHeader icon={<Lock />} title="Points and costs" />
        <div className="card">
          <EmptyState
            icon={<Lock />}
            title="You don’t have access to this"
            body="Points and costs are for the owner, developers and the marketing team."
          />
        </div>
      </div>
    );
  }

  const columns: Column<ServiceArea>[] = [
    {
      key: 'district',
      header: 'District',
      primary: true,
      render: (a) => <IdCell thumb={<MapPin aria-hidden="true" />} title={a.name} meta={a.region} />,
    },
    {
      key: 'pickup',
      mobile: 'keep',
      header: 'Pickup costs us',
      label: 'Pickup costs us',
      numeric: true,
      render: (a) => <PickupCostCell area={a} onWrite={writeStandard} />,
    },
  ];

  const loading = programs === null && !loadError;

  return (
    <div className="page">
      <PageHeader
        icon={<BadgePercent />}
        title="Points and costs"
        subtitle="What customers earn for each item they send back, what that costs us, and what a pickup normally costs in each district."
        actions={
          <Button tone="primary" size="lg" onClick={() => setEditing('new')}>
            <Plus aria-hidden="true" />
            New programme
          </Button>
        }
      />

      {loadError ? (
        <Banner
          tone="critical"
          title="Couldn’t load points and costs"
          action={<Button onClick={() => void load()}>Retry</Button>}
        >
          {loadError}
        </Banner>
      ) : null}

      <div className="form2">
        <div className="form2__main">
          {loading ? (
            <section className="card" aria-hidden="true">
              <div className="card__body stack stack--tight">
                <span className="skel" style={{ width: '12rem' }} />
                <span className="skel" style={{ width: '18rem', opacity: 0.7 }} />
                <span className="skel" style={{ width: '9rem', opacity: 0.5 }} />
              </div>
            </section>
          ) : perItem.length === 0 ? (
            <div className="card">
              <EmptyState
                icon={<BadgePercent />}
                title="No programme pays for items yet"
                body="Add one to start paying customers points for the items they send back."
                actions={
                  <Button tone="primary" onClick={() => setEditing('new')}>
                    New programme
                  </Button>
                }
              />
            </div>
          ) : (
            perItem.map((p) => <ProgramCard key={p.id} program={p} onEdit={setEditing} onStatus={setStatus} />)
          )}

          {/* ── what a pickup normally costs, by district ────────────────── */}
          <section className="card">
            <div
              className="card__body row"
              style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--s3)' }}
            >
              <div>
                <h2 style={{ fontSize: 'var(--t-lg)', fontWeight: 'var(--w-semi)' }}>
                  What a pickup normally costs
                  {shown ? (
                    <span
                      className="muted"
                      style={{ fontWeight: 'var(--w-normal)', marginLeft: 'var(--s2)' }}
                    >
                      {shown.region}
                    </span>
                  ) : null}
                </h2>
                <p className="muted" style={{ fontSize: 'var(--t-sm)', marginTop: 2 }}>
                  Staff can type the real figures on each pickup. These stand in for the ones nobody
                  wrote down, so the analytics can still say what an item cost us. Only districts
                  you collect from are listed.
                </p>
              </div>
              {groups.length > 0 && region ? (
                <SearchSelect
                  label="State"
                  value={region}
                  onChange={setRegion}
                  align="right"
                  placeholder="Search states…"
                  emptyText="No state matches that."
                  options={groups.map((g) => ({
                    value: g.region,
                    label: g.region,
                    meta: `${g.areas.length} ${g.areas.length === 1 ? 'district' : 'districts'}`,
                  }))}
                />
              ) : null}
            </div>
          </section>

          <DataTable
            caption="What a pickup normally costs, by district"
            columns={columns}
            rows={rows}
            rowKey={(a) => a.id}
            loading={areas === null && !loadError}
            search={{
              value: search,
              placeholder: shown ? `Filter districts in ${shown.region}` : 'Filter districts',
              onChange: setSearch,
            }}
            empty={
              search ? (
                <EmptyState
                  icon={<MapPin />}
                  title="No districts match"
                  actions={<Button onClick={() => setSearch('')}>Clear filter</Button>}
                />
              ) : (
                <EmptyState
                  icon={<MapPin />}
                  title="No districts are switched on yet"
                  body="Switch some on under Where we collect, then come back to set what a pickup from each one normally costs."
                  actions={<ButtonLink to="/spools/areas">Open Where we collect</ButtonLink>}
                />
              )
            }
            footer={null}
          />
        </div>

        <aside className="form2__side">
          <Card title="Where customer requests go">
            {!settings ? (
              <div className="stack stack--tight" aria-hidden="true">
                <span className="skel" style={{ width: '9rem' }} />
                <span className="skel" style={{ width: '11rem', opacity: 0.7 }} />
              </div>
            ) : (
              <SelectField
                label="Programme for new requests"
                value={settings.defaultReturnProgramId ?? ''}
                disabled={savingDefault}
                hint="A request from the website joins this programme. Staff can still pick another when they log one by hand."
                onChange={(e) => void saveDefault(e.target.value)}
              >
                <option value="">None — customers can’t ask for a pickup</option>
                {perItem.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </SelectField>
            )}
          </Card>

          <Card title="How these fit together">
            <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.5 }}>
              A customer asks for a pickup. A driver collects from a district that’s switched on
              under Where we collect. You check the items and pay out points at the programme’s
              rate. Analytics adds what you paid to what the pickup cost, and divides by the items
              you kept — that’s what an item really costs us.
            </p>
            <div>
              <ButtonLink to="/spools/analytics">See what items cost us</ButtonLink>
            </div>
          </Card>
        </aside>
      </div>

      {editing !== 'closed' ? (
        <ProgramModal
          kind="unit_return"
          program={editing === 'new' ? null : editing}
          onClose={() => setEditing('closed')}
          onDone={() => {
            setEditing('closed');
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

/** One per-item programme, every word from its own row. */
function ProgramCard({
  program: p,
  onEdit,
  onStatus,
}: {
  program: Program;
  onEdit: (program: Program) => void;
  onStatus: (program: Program, status: 'active' | 'paused') => Promise<void>;
}) {
  const labels = labelsOf(p);
  const item = labels.unit?.one ?? 'item';
  const items = labels.unit?.other ?? 'items';
  const notSet = <span className="muted">Not set</span>;
  return (
    <Card
      title={p.name}
      action={
        <div className="row" style={{ gap: 'var(--s2)' }}>
          <Button
            aria-label={`${p.status === 'active' ? 'Pause' : 'Resume'} ${p.name}`}
            onClick={() => void onStatus(p, p.status === 'active' ? 'paused' : 'active')}
          >
            {p.status === 'active' ? 'Pause' : 'Resume'}
          </Button>
          <Button aria-label={`Edit ${p.name}`} onClick={() => onEdit(p)}>
            Edit
          </Button>
        </div>
      }
    >
      <Defs
        rows={[
          {
            label: 'Customers earn',
            value:
              p.pointsPerUnit === null
                ? notSet
                : `${pluralise(p.pointsPerUnit, labels.points.one, labels.points.other)} per ${item}`,
          },
          {
            label: `Fewest ${items} per pickup`,
            value: String(p.minUnitsPerReturn ?? 1),
          },
          {
            label: `Each ${item} costs us`,
            value: p.unitCostMinor == null ? notSet : money(p.unitCostMinor, CURRENCY),
          },
          {
            label: 'A new one costs to buy',
            value: p.unitMarketCostMinor == null ? notSet : money(p.unitMarketCostMinor, CURRENCY),
          },
          {
            label: 'Status',
            value:
              p.status === 'active' ? <Badge tone="ok">Active</Badge> : <Badge tone="warn">Paused</Badge>,
          },
          { label: 'Open pickups', value: String(p.openReturns) },
          { label: 'Points given out', value: p.awardedTotal.toLocaleString() },
        ]}
      />
      <span className="field__hint">
        {p.seeded
          ? 'Came with the admin. You can rename it and change every number; the ID code stays.'
          : `ID code ${p.key}. Changing the rate only affects pickups asked for from now on.`}
      </span>
    </Card>
  );
}

/**
 * WHAT A PICKUP FROM THIS DISTRICT NORMALLY COSTS US — four lines, one popover.
 * Lifted from Delivery areas on 2026-09-06; the rules are unchanged.
 */
const STANDARD_LINES = [
  { key: 'stdTransportMinor', label: 'Transport in' },
  { key: 'stdLocalMinor', label: 'Local delivery' },
  { key: 'stdDriverMinor', label: 'Driver' },
  { key: 'stdFeesMinor', label: 'Loading and fees' },
] as const;

type StandardKey = (typeof STANDARD_LINES)[number]['key'];

function PickupCostCell({
  area,
  onWrite,
}: {
  area: ServiceArea;
  onWrite: (area: ServiceArea, patch: Record<string, number | null>) => Promise<boolean>;
}) {
  /**
   * `== null`, NEVER `=== null`, ON EVERY ONE OF THESE — and the difference is
   * a crash, not a nicety.
   *
   * These four columns are younger than the API contract, so any payload
   * written before 0920 — a cached response, an older deployment answering a
   * newer bundle, a fixture — carries `undefined` rather than `null`, and
   * `plainMajor(undefined)` throws `MoneyShapeError` from inside a `useState`
   * initialiser, which takes the whole screen down rather than one cell.
   */
  const box = (minor: number | null | undefined): string =>
    minor == null ? '' : plainMajor(minor, CURRENCY);

  const [draft, setDraft] = useState<Record<StandardKey, string>>(() => ({
    stdTransportMinor: box(area.stdTransportMinor),
    stdLocalMinor: box(area.stdLocalMinor),
    stdDriverMinor: box(area.stdDriverMinor),
    stdFeesMinor: box(area.stdFeesMinor),
  }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = STANDARD_LINES.filter((l) => area[l.key] != null);
  const total = set.reduce((n, l) => n + (area[l.key] ?? 0), 0);

  async function commit(close: () => void) {
    const patch: Record<string, number | null> = {};
    for (const line of STANDARD_LINES) {
      const text = draft[line.key].trim();
      if (text === '') {
        /* An empty box CLEARS the standard — back to "we have no standard
           here", which is a different claim from "it is free" and the only
           way a figure typed into the wrong box is undone. */
        patch[line.key] = null;
        continue;
      }
      const parsed = parseMajor(text, CURRENCY);
      if (!parsed.ok) {
        setError(`${line.label}: ${moneyRefusalMessage(parsed.reason, CURRENCY)}`);
        return;
      }
      patch[line.key] = parsed.minor;
    }
    setBusy(true);
    const ok = await onWrite(area, patch);
    setBusy(false);
    if (ok) close();
  }

  return (
    <PopEdit
      ariaLabel={`What a pickup from ${area.name} costs us`}
      value={
        set.length > 0 ? (
          <span className="num">{money(total, CURRENCY)}</span>
        ) : (
          <span className="muted">Not set</span>
        )
      }
    >
      {(close) => (
        <>
          <p className="muted" style={{ fontSize: 'var(--t-sm)', margin: '0 0 var(--s2)' }}>
            What a pickup from {area.name} normally costs us. Leave a box empty for “we don’t
            know” — that is different from zero.
          </p>
          {STANDARD_LINES.map((line) => (
            <AffixField
              key={line.key}
              label={line.label}
              prefix={CURRENCY}
              inputMode="decimal"
              value={draft[line.key]}
              onChange={(e) => {
                setDraft((d) => ({ ...d, [line.key]: e.target.value }));
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit(close);
              }}
            />
          ))}
          {error ? (
            <span className="field__error" role="alert">
              {error}
            </span>
          ) : null}
          <PopEditFoot>
            <span className="spacer" />
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
