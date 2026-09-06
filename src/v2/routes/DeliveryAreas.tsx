import { useCallback, useEffect, useMemo, useState } from 'react';
import { MapPin, Truck } from 'lucide-react';
import {
  moneyRefusalMessage,
  parseMajor,
  plainMajor,
  shopApi,
  type ShopDeliveryArea,
  type ShopShippingZone,
} from '../../data/api-shop';
import { marketingApi, type ServiceArea } from '../../data/api-marketing';
import { money } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Banner, Button, EmptyState } from '../ui/primitives';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { AffixField, Toggle } from '../ui/Field';
import { PopEdit, PopEditFoot } from '../ui/PopEdit';
import { SearchSelect } from '../ui/SearchSelect';
import { useToast } from '../ui/Toast';

/**
 * DELIVERY AREAS — `/orders/delivery`. The districts a van goes to and what
 * each one costs.
 *
 * ONE STATE AT A TIME, PICKED FROM A SEARCHABLE SELECT — v1's method, kept
 * on purpose after a tab strip of thirty-seven states proved unfindable. The
 * picker carries each state's delivering tally, the strip above the table
 * carries the tally and the master "All of {state}" switch, and the table is
 * only ever one state's districts.
 *
 * TWO SOURCES, JOINED ON `areaKey`: the districts belong to
 * `marketingApi.listAreas` (name, region, active), and the shop holds only
 * its OPINION about each — delivers or not, and an optional rate override. A
 * district with NO shop row delivers at its state's zone rate, the pre-0300
 * behaviour and the default this screen renders.
 *
 * DELIVERIES ONLY, since 2026-09-06. This screen used to carry two facts about
 * collections as well — whether a district was on the returns board, and what
 * a pickup from it normally costs us — because they were both facts about a
 * district. They read as claims about parcels here, and they now live where
 * the people deciding them work: Spools → Where we collect, and Spools →
 * Points and costs.
 *
 * CHECKOUT PRICES FROM THESE ROWS since migration 0460: an address naming a
 * district takes its rate override on every delivery option and its frozen
 * total, and a switched-off district is refused outright. An address naming
 * none — every address, until the storefront's district picker ships —
 * prices at the state's zone. The on-screen note states the same.
 */

const STORE_CURRENCY = 'NGN';

interface Row {
  area: ServiceArea;
  /** The shop's opinion, or null — "delivers at the zone rate". */
  opinion: ShopDeliveryArea | null;
}

/** The zone whose region list names this region, else the fallback zone. */
function zoneFor(zones: ShopShippingZone[], region: string): ShopShippingZone | null {
  const named = zones.find((z) => z.regions.some((r) => r.toLowerCase() === region.toLowerCase()));
  if (named) return named;
  return zones.find((z) => z.isFallback) ?? null;
}

function zoneRateLabel(zone: ShopShippingZone | null): string {
  const first = zone?.options.slice().sort((a, b) => a.position - b.position)[0];
  if (!first) return 'Zone rate';
  return `${money(first.amountMinor, STORE_CURRENCY)} · ${zone!.label}`;
}

export default function DeliveryAreas() {
  const toast = useToast();
  const [areas, setAreas] = useState<ServiceArea[] | null>(null);
  const [opinions, setOpinions] = useState<Map<string, ShopDeliveryArea>>(new Map());
  const [zones, setZones] = useState<ShopShippingZone[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [areasView, deliveryAreas, zoneList] = await Promise.all([
        marketingApi.listAreas(false, signal),
        shopApi.listDeliveryAreas(signal),
        shopApi.listShippingZones(signal).catch(() => [] as ShopShippingZone[]),
      ]);
      setAreas(areasView.areas);
      setOpinions(new Map(deliveryAreas.map((d) => [d.areaKey, d])));
      setZones(zoneList);
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

  const delivers = useCallback(
    (area: ServiceArea) => opinions.get(area.key)?.delivers ?? true,
    [opinions],
  );

  /** States in the API's order, each with its delivering tally — the picker's
   *  rows and the strip's numbers come from the same derivation. */
  const groups = useMemo(() => {
    const names = [...new Set((areas ?? []).map((a) => a.region))];
    return names.map((name) => {
      const inRegion = (areas ?? []).filter((a) => a.region === name);
      return { region: name, areas: inRegion, on: inRegion.filter(delivers).length };
    });
  }, [areas, delivers]);

  /* The opening state, v1's rule: the first state that delivers, else the
     first — chosen once per load, kept while it still exists. */
  useEffect(() => {
    if (groups.length === 0) return;
    setRegion((chosen) => {
      if (chosen !== null && groups.some((g) => g.region === chosen)) return chosen;
      return (groups.find((g) => g.on > 0) ?? groups[0]!).region;
    });
  }, [groups]);

  const shown = groups.find((g) => g.region === region) ?? null;
  const zone = shown ? zoneFor(zones, shown.region) : null;

  const rows = useMemo<Row[]>(() => {
    const q = search.trim().toLowerCase();
    return (shown?.areas ?? [])
      .filter((a) => !q || a.name.toLowerCase().includes(q))
      .map((area) => ({ area, opinion: opinions.get(area.key) ?? null }));
  }, [shown, opinions, search]);

  const adopt = (next: ShopDeliveryArea) =>
    setOpinions((m) => new Map(m).set(next.areaKey, next));

  async function write(
    area: ServiceArea,
    body: { delivers?: boolean; rateMinor?: number | null },
  ): Promise<boolean> {
    const opinion = opinions.get(area.key) ?? null;
    try {
      const next = await shopApi.saveDeliveryArea(area.key, {
        ...body,
        /* CAS: `null` asserts "no row for this district yet". */
        expectedRevision: opinion?.revision ?? null,
      });
      adopt(next);
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

  /** The master switch: one press means "deliver to all of this state". */
  async function switchAll(next: boolean) {
    if (!shown) return;
    setBulkBusy(true);
    try {
      const written = await shopApi.saveDeliveryAreas({
        areaKeys: shown.areas.map((a) => a.key),
        delivers: next,
      });
      setOpinions((m) => {
        const merged = new Map(m);
        for (const d of written) merged.set(d.areaKey, d);
        return merged;
      });
      toast.show(
        next ? `Delivering everywhere in ${shown.region}` : `Deliveries off across ${shown.region}`,
      );
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
    } finally {
      setBulkBusy(false);
    }
  }

  const columns: Column<Row>[] = [
    {
      key: 'district',
      header: 'District',
      primary: true,
      render: ({ area }) => (
        <IdCell thumb={<MapPin aria-hidden="true" />} title={area.name} meta={area.region} />
      ),
    },
    {
      key: 'delivers', mobile: 'keep',
      header: 'Delivers',
      label: 'Delivers',
      tight: true,
      render: (row) => <DeliversCell row={row} onWrite={write} />,
    },
    {
      key: 'rate', mobile: 'keep',
      header: 'Delivery rate',
      label: 'Delivery rate',
      numeric: true,
      render: (row) => <RateCell row={row} zone={zoneFor(zones, row.area.region)} onWrite={write} />,
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<Truck />}
        title="Delivery areas"
        subtitle="Charge a different delivery price for particular districts."
        actions={
          groups.length > 0 && region ? (
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
                meta: `${g.on} of ${g.areas.length}`,
              }))}
            />
          ) : undefined
        }
      />

      <Banner tone="info" title="How these prices work">
        Checkout uses the district the customer picks. A price set here replaces the state’s usual
        price, and a district you switch off can’t be ordered to at all. Customers who don’t pick a district pay
        the state’s usual price.
      </Banner>

      {loadError ? (
        <Banner tone="critical" title="Couldn’t load delivery areas" action={<Button onClick={() => void load()}>Retry</Button>}>
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
                <span className="muted" style={{ fontWeight: 'var(--w-normal)', marginLeft: 'var(--s2)' }}>
                  {shown.on} of {shown.areas.length} delivering
                </span>
              </h2>
              <p className="muted" style={{ fontSize: 'var(--t-sm)', marginTop: 2 }}>
                State zone rate: {zoneRateLabel(zone)} — a district charges this unless you give it
                a rate of its own.
              </p>
            </div>
            <span style={bulkBusy ? { opacity: 0.6, pointerEvents: 'none' } : undefined}>
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
        caption="Delivery areas"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.area.key}
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
              title="No districts yet"
              body="Districts are set up under Spools → Where we collect, and shared with delivery."
            />
          )
        }
        footer={null}
      />

      <p className="page__learn">
        A district with no price of its own uses the state’s usual price. Setting one never means
        free delivery — clearing it goes back to the state price.
      </p>
    </div>
  );
}

function DeliversCell({
  row,
  onWrite,
}: {
  row: Row;
  onWrite: (area: ServiceArea, body: { delivers?: boolean }) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const on = row.opinion?.delivers ?? true;
  return (
    <span
      onClick={(e) => e.stopPropagation()}
      style={busy ? { opacity: 0.6, pointerEvents: 'none' } : undefined}
    >
      <Toggle
        label={<span className="sr">Delivers to {row.area.name}</span>}
        checked={on}
        onChange={(next) => {
          setBusy(true);
          void onWrite(row.area, { delivers: next }).finally(() => setBusy(false));
        }}
      />
    </span>
  );
}

function RateCell({
  row,
  zone,
  onWrite,
}: {
  row: Row;
  zone: ShopShippingZone | null;
  onWrite: (area: ServiceArea, body: { rateMinor?: number | null }) => Promise<boolean>;
}) {
  const override = row.opinion?.rateMinor ?? null;
  const [draft, setDraft] = useState(() => (override !== null ? plainMajor(override, STORE_CURRENCY) : ''));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function commit(close: () => void) {
    const parsed = parseMajor(draft, STORE_CURRENCY);
    if (!parsed.ok) {
      setError(moneyRefusalMessage(parsed.reason, STORE_CURRENCY));
      return;
    }
    setBusy(true);
    const ok = await onWrite(row.area, { rateMinor: parsed.minor });
    setBusy(false);
    if (ok) close();
  }

  async function clear(close: () => void) {
    setBusy(true);
    /* Explicit `null` clears the override — absent would leave it. */
    const ok = await onWrite(row.area, { rateMinor: null });
    setBusy(false);
    if (ok) {
      setDraft('');
      close();
    }
  }

  return (
    <PopEdit
      ariaLabel={`Delivery rate for ${row.area.name}`}
      value={
        override !== null ? (
          <span className="num">{money(override, STORE_CURRENCY)}</span>
        ) : (
          <span className="muted">{zoneRateLabel(zone)}</span>
        )
      }
    >
      {(close) => (
        <>
          <AffixField
            label={`Rate for ${row.area.name}`}
            prefix={STORE_CURRENCY}
            inputMode="decimal"
            value={draft}
            error={error}
            autoFocus
            hint={
              override === null
                ? `No override — currently ships at ${zoneRateLabel(zone)}.`
                : `Overrides the zone (${zoneRateLabel(zone)}).`
            }
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit(close);
            }}
          />
          <PopEditFoot>
            {override !== null ? (
              <Button tone="plain" busy={busy} onClick={() => void clear(close)}>
                Use the state price
              </Button>
            ) : null}
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

