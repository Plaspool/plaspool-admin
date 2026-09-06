import { useCallback, useEffect, useMemo, useState } from 'react';
import { Lock, MapPin, Plus } from 'lucide-react';
import { marketingApi, type AreasView, type ServiceArea } from '../../data/api-marketing';
import { ApiError } from '../../data/errors';
import { getSession } from '../../data/session';
import { hasDomain } from '../../../shared/roles';
import { PageHeader } from '../ui/Page';
import { Banner, Button, EmptyState } from '../ui/primitives';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { TextField, Toggle } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { PopEdit, PopEditFoot } from '../ui/PopEdit';
import { SearchSelect } from '../ui/SearchSelect';
import { useToast } from '../ui/Toast';

/**
 * WHERE WE COLLECT — `/spools/areas`. The districts a driver picks up from.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS THE SCREEN THAT MAKES THE MODEL NATIONAL.
 *
 * Every state in the country ships loaded, and every district outside the one
 * served today ships SWITCHED OFF. Opening a new city is somebody flipping a
 * switch here — not a migration, not a deploy, not a developer. That is the
 * whole argument for `marketing_service_areas` being a table rather than a
 * constant, and this screen is where the argument pays off. v1 had it at
 * `/marketing/areas`; v2 went to production without it, which meant nobody
 * could switch a state on from the admin that was actually deployed.
 *
 * ONE STATE AT A TIME, from a searchable picker — the method Delivery areas
 * already settled on after a strip of thirty-seven states proved unfindable.
 * The picker's rows carry each state's tally, so "where do we collect" is
 * answered in the picker itself.
 *
 * THE MASTER SWITCH IS N REQUESTS, NOT ONE. There is no bulk route; `PATCH
 * /areas/:id` is the only writer and it CASes on each row's own revision. They
 * go out together, because the rows are independent and thirty sequential
 * round trips is a control nobody would use twice.
 *
 * ⚠️  PARTIAL SUCCESS IS THE NORMAL CASE ON THE WAY OFF, and it is said out
 *     loud. Switching off a district that still holds open pickups is REFUSED
 *     by the server (`area_in_use`) so those pickups are never stranded off
 *     every board. "Switch the state off" therefore means "switch off the ones
 *     that can be", and the toast says how many could not — a silent 27-of-30
 *     would leave the owner believing they had closed a city they had not.
 *
 * THE GATE IS `marketing`, matching the API's own: `/api/marketing/areas` is
 * in that domain, so a screen that rendered for the orders roles would show
 * them a table that 403s on its first fetch.
 * ═══════════════════════════════════════════════════════════════════════════
 */

interface Group {
  region: string;
  areas: ServiceArea[];
  /** How many of this state's districts are switched on. */
  on: number;
}

export default function SpoolsAreas() {
  const toast = useToast();
  const session = getSession();
  const viewer = 'user' in session ? session.user : null;
  const allowed = viewer !== null && hasDomain(viewer.role, 'marketing');

  const [view, setView] = useState<AreasView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      /* EVERYTHING, not `?active=true`: this is where a state is switched ON,
         so the rows that are off are the whole point of it. */
      setView(await marketingApi.listAreas(false, signal));
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

  const areas = view?.areas ?? null;

  /** States in the API's order, each with its switched-on tally — the picker's
   *  rows and the strip's numbers come from the same derivation. */
  const groups = useMemo<Group[]>(() => {
    const names = [...new Set((areas ?? []).map((a) => a.region))];
    return names.map((name) => {
      const inRegion = (areas ?? []).filter((a) => a.region === name);
      return { region: name, areas: inRegion, on: inRegion.filter((a) => a.active).length };
    });
  }, [areas]);

  /* The opening state: the first one collecting anything, else the first —
     chosen once per load, and kept while it still exists. Falling back to
     alphabetical would open every visit on a state nobody serves. */
  useEffect(() => {
    if (groups.length === 0) return;
    setRegion((chosen) => {
      if (chosen !== null && groups.some((g) => g.region === chosen)) return chosen;
      return (groups.find((g) => g.on > 0) ?? groups[0]!).region;
    });
  }, [groups]);

  const shown = groups.find((g) => g.region === region) ?? null;
  const onTotal = groups.reduce((n, g) => n + g.on, 0);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (shown?.areas ?? []).filter((a) => !q || a.name.toLowerCase().includes(q));
  }, [shown, search]);

  /* The PATCH answers with the row as the server now has it. Merged over the
     old one, because the counts (open pickups) ride only on the list. */
  const adopt = (next: ServiceArea) =>
    setView((v) =>
      v === null
        ? v
        : { ...v, areas: v.areas.map((a) => (a.id === next.id ? { ...a, ...next } : a)) },
    );

  /** The three refusals a district edit can meet, in words. */
  function explain(cause: unknown, area: ServiceArea): string {
    if (cause instanceof ApiError) {
      if (cause.code === 'area_in_use') {
        /* The count comes back with the error so the message is an
           instruction rather than a wall. `body` is `unknown` by design. */
        const payload = cause.body as { open?: unknown } | null;
        const open = typeof payload?.open === 'number' ? payload.open : area.open;
        return `${open} open ${open === 1 ? 'pickup is' : 'pickups are'} still on ${area.name}. Finish or move them before switching it off.`;
      }
      if (cause.code === 'duplicate_area') {
        return `${area.region} already has a district with that name.`;
      }
      if (cause.code === 'stale_write') {
        return `Somebody else changed ${area.name}. Showing the latest.`;
      }
    }
    return cause instanceof Error && cause.message ? cause.message : 'Something went wrong.';
  }

  async function write(
    area: ServiceArea,
    patch: { active?: boolean; name?: string },
  ): Promise<boolean> {
    try {
      const next = await marketingApi.patchArea(area.id, {
        expectedRevision: area.revision,
        ...patch,
      });
      adopt(next);
      if (patch.name !== undefined) toast.show(`Renamed to ${next.name}`);
      else if (patch.active === true) toast.show(`Collecting from ${next.name}`);
      else if (patch.active === false) toast.show(`${next.name} switched off`);
      return true;
    } catch (cause) {
      toast.show(explain(cause, area), 'critical');
      /* A refusal or a CAS miss means the row on screen is behind — re-read
         rather than guess, the recovery every v2 board takes. */
      void load();
      return false;
    }
  }

  /** The master switch: one press means "collect from all of this state" —
   *  or, on the way off, "switch off every district that legally can be". */
  async function switchAll(next: boolean) {
    if (!shown) return;
    const targets = shown.areas.filter((a) => a.active !== next);
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        targets.map((a) =>
          marketingApi.patchArea(a.id, { expectedRevision: a.revision, active: next }),
        ),
      );
      const done = results.filter((r) => r.status === 'fulfilled').length;
      /* The one refusal with a meaning worth naming. Anything else is counted
         but not diagnosed here — the per-row switch gives the full message. */
      const held = results.filter(
        (r) =>
          r.status === 'rejected' &&
          r.reason instanceof ApiError &&
          r.reason.code === 'area_in_use',
      ).length;
      const failed = results.length - done;
      if (failed === 0) {
        toast.show(
          next
            ? `Collecting everywhere in ${shown.region}`
            : `Collections switched off across ${shown.region}`,
        );
      } else if (held === failed) {
        toast.show(
          `${done} switched off. ${held} still ${held === 1 ? 'has' : 'have'} open pickups and ${held === 1 ? 'was' : 'were'} left on.`,
          'critical',
        );
      } else {
        toast.show(`${done} switched ${next ? 'on' : 'off'}, ${failed} could not be.`, 'critical');
      }
    } finally {
      /* Some rows moved and some may not have: read the truth back. */
      await load();
      setBulkBusy(false);
    }
  }

  if (!allowed) {
    return (
      <div className="page">
        <PageHeader icon={<Lock />} title="Where we collect" />
        <div className="card">
          <EmptyState
            icon={<Lock />}
            title="You don’t have access to this"
            body="Switching districts on and off is for the owner, developers and the marketing team."
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
      render: (a) => (
        <IdCell
          thumb={<MapPin aria-hidden="true" />}
          title={a.name}
          /* DERIVED FROM `seeded` AND NOTHING ELSE — never by matching a key or
             a name. A rename keeps it true. */
          meta={a.seeded ? 'Preset' : 'Added by hand'}
        />
      ),
    },
    {
      key: 'collecting',
      mobile: 'keep',
      header: 'Collecting',
      label: 'Collecting',
      tight: true,
      render: (a) => <CollectCell area={a} onWrite={write} />,
    },
    {
      key: 'open',
      header: 'Open pickups',
      label: 'Open pickups',
      numeric: true,
      render: (a) => {
        const open = a.open ?? 0;
        const act = a.needsAction ?? 0;
        if (open === 0) return <span className="muted">—</span>;
        return (
          <span className="num">
            {open}
            {act > 0 ? <span className="muted"> · {act} to act on</span> : null}
          </span>
        );
      },
    },
    {
      key: 'rename',
      pin: true,
      header: <span className="sr">Rename</span>,
      label: 'Rename',
      tight: true,
      render: (a) => <RenameCell area={a} onWrite={write} />,
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<MapPin />}
        title="Where we collect"
        subtitle="The districts a driver can pick up from. A pickup only earns points if its address is in a district that’s switched on."
        actions={
          <>
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
                  meta:
                    g.on === 0
                      ? `${g.areas.length} ${g.areas.length === 1 ? 'district' : 'districts'}`
                      : `${g.on} of ${g.areas.length} on`,
                }))}
              />
            ) : null}
            <Button tone="primary" size="lg" disabled={!shown} onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" />
              Add a district
            </Button>
          </>
        }
      />

      <Banner tone="info" title="How this list works">
        Every state is already loaded, with everything outside where you collect today switched
        off. To start collecting somewhere new, pick the state and switch its districts on — no
        developer needed.
        {onTotal > 0
          ? ` Right now ${onTotal} ${onTotal === 1 ? 'district is' : 'districts are'} switched on across the country.`
          : ''}
      </Banner>

      {view && view.outOfArea.open > 0 ? (
        <Banner tone="warn" title="Pickups with no district">
          {view.outOfArea.open} open {view.outOfArea.open === 1 ? 'pickup belongs' : 'pickups belong'}{' '}
          to no district at all. They can be closed with a reason, but they can never earn points.
        </Banner>
      ) : null}

      {loadError ? (
        <Banner
          tone="critical"
          title="Couldn’t load the districts"
          action={<Button onClick={() => void load()}>Retry</Button>}
        >
          {loadError}
        </Banner>
      ) : null}

      {shown ? (
        <section className="card">
          <div
            className="card__body row"
            style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--s3)' }}
          >
            <div>
              <h2 style={{ fontSize: 'var(--t-lg)', fontWeight: 'var(--w-semi)' }}>
                {shown.region}
                <span
                  className="muted"
                  style={{ fontWeight: 'var(--w-normal)', marginLeft: 'var(--s2)' }}
                >
                  {shown.on} of {shown.areas.length} switched on
                </span>
              </h2>
              <p className="muted" style={{ fontSize: 'var(--t-sm)', marginTop: 2 }}>
                One switch for the whole state. Districts with open pickups stay on until those
                pickups are finished.
              </p>
            </div>
            <span style={bulkBusy ? { opacity: 0.6, pointerEvents: 'none' } : undefined}>
              {/* Checked only when EVERY district is on, so a part-served state
                  reads as off and one press means "collect from all of it". */}
              <Toggle
                label={`All of ${shown.region}`}
                checked={shown.areas.length > 0 && shown.on === shown.areas.length}
                onChange={(next) => void switchAll(next)}
              />
            </span>
          </div>
        </section>
      ) : null}

      <DataTable
        caption="Where we collect"
        columns={columns}
        rows={rows}
        rowKey={(a) => a.id}
        loading={view === null && !loadError}
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
              title={shown ? `No districts in ${shown.region} yet` : 'No districts yet'}
              body="Add one with the button above. It starts switched off."
            />
          )
        }
        footer={null}
      />

      <p className="page__learn">
        Switching a district off never deletes it, and a district with open pickups can’t be
        switched off until they’re finished — so nobody’s pickup is left with nowhere to go.
      </p>

      {adding && shown ? (
        <AddDistrictModal
          region={shown.region}
          onClose={() => setAdding(false)}
          onDone={(created) => {
            setAdding(false);
            /* Adopt the new row straight in, no re-read: the answer IS the row,
               and it is created off, like every other district. */
            setView((v) => (v === null ? v : { ...v, areas: [...v.areas, created] }));
            toast.show('Added — switch it on when a driver covers it.');
          }}
        />
      ) : null}
    </div>
  );
}

function CollectCell({
  area,
  onWrite,
}: {
  area: ServiceArea;
  onWrite: (area: ServiceArea, patch: { active?: boolean }) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <span
      onClick={(e) => e.stopPropagation()}
      /* Guarded by a busy dim rather than a `disabled` the shared Toggle does
         not have: a second click while the first PATCH is in flight would race
         its own CAS and answer `stale_write` for no reason. */
      style={busy ? { opacity: 0.6, pointerEvents: 'none' } : undefined}
    >
      <Toggle
        label={<span className="sr">Collect from {area.name}</span>}
        checked={area.active}
        onChange={(next) => {
          setBusy(true);
          void onWrite(area, { active: next }).finally(() => setBusy(false));
        }}
      />
    </span>
  );
}

/**
 * The shipped dataset misspells real places and files at least one under the
 * wrong state, and nothing outside the served region is on — so no customer
 * meets a bad name until somebody switches it on. The correction has to be
 * available at the same moment the switch is, or the only option is to switch
 * on a lie.
 */
function RenameCell({
  area,
  onWrite,
}: {
  area: ServiceArea;
  onWrite: (area: ServiceArea, patch: { name?: string }) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(area.name);
  const [busy, setBusy] = useState(false);

  async function commit(close: () => void) {
    const name = draft.trim();
    if (name === '' || name === area.name) {
      close();
      return;
    }
    setBusy(true);
    const ok = await onWrite(area, { name });
    setBusy(false);
    if (ok) close();
  }

  return (
    <PopEdit ariaLabel={`Rename ${area.name}`} value="Rename">
      {(close) => (
        <>
          <TextField
            label={`New name for ${area.name}`}
            value={draft}
            autoFocus
            hint="Fixes a spelling without moving anything — pickups already logged here stay here."
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit(close);
            }}
          />
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

/** A district typed by hand, into the state on screen. Created OFF — switching
 *  it on is the separate, deliberate act, and the toast says so. */
function AddDistrictModal({
  region,
  onClose,
  onDone,
}: {
  region: string;
  onClose: () => void;
  onDone: (created: ServiceArea) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function commit() {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('Type the name of the district.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDone(await marketingApi.createArea({ region, name: trimmed }));
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'duplicate_area') {
        setError(`${region} already has a district with that name.`);
      } else {
        setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      }
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add a district"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void commit()}>
            Add
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField
          label="Name of the district"
          value={name}
          autoFocus
          placeholder="The place as a customer would write it"
          hint={`Added to ${region}. It starts switched off — turn it on when a driver covers it.`}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit();
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
