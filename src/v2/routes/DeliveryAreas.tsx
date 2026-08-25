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
import { humanise, money } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, EmptyState } from '../ui/primitives';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { AffixField, Toggle } from '../ui/Field';
import { MenuItem } from '../ui/Menu';
import { PopEdit, PopEditFoot } from '../ui/PopEdit';
import { useToast } from '../ui/Toast';

/**
 * DELIVERY AREAS — `/orders/delivery`. The districts a van goes to and what
 * each one costs.
 *
 * TWO SOURCES, JOINED ON `areaKey`: the districts themselves belong to
 * `marketingApi.listAreas` (name, region, active), and the shop holds only
 * its OPINION about each — delivers or not, and an optional rate override.
 * A district with NO shop row delivers at its state's zone rate, which is
 * the pre-0300 behaviour and the default this screen renders.
 *
 * THE HONEST CAVEAT, STATED ON SCREEN: the storefront checkout does not send
 * a district yet, so nothing prices from these rows today — the state's zone
 * still prices delivery. Rates authored here arm the moment the storefront
 * sends `district`.
 */

/* TODO(tests): none — skipped this session, recorded in CLAUDE.md. Worth
 * pinning: `rateMinor: null` clears the override while ABSENT leaves it, and
 * a CAS miss re-reads instead of retrying blind. */

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
  const [tab, setTab] = useState<string>('all');
  const [search, setSearch] = useState('');

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

  const regions = useMemo(
    () => [...new Set((areas ?? []).map((a) => a.region))].sort((a, b) => a.localeCompare(b)),
    [areas],
  );

  const rows = useMemo<Row[]>(() => {
    const q = search.trim().toLowerCase();
    return (areas ?? [])
      .filter((a) => tab === 'all' || a.region === tab)
      .filter((a) => !q || a.name.toLowerCase().includes(q))
      .map((area) => ({ area, opinion: opinions.get(area.key) ?? null }));
  }, [areas, opinions, tab, search]);

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

  async function bulkDelivers(region: string, delivers: boolean) {
    const keys = (areas ?? []).filter((a) => a.region === region).map((a) => a.key);
    if (!keys.length) return;
    try {
      const written = await shopApi.saveDeliveryAreas({ areaKeys: keys, delivers });
      setOpinions((m) => {
        const next = new Map(m);
        for (const d of written) next.set(d.areaKey, d);
        return next;
      });
      toast.show(
        delivers
          ? `Delivering everywhere in ${region}`
          : `Deliveries off across ${region}`,
      );
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
    }
  }

  const columns: Column<Row>[] = [
    {
      key: 'district',
      header: 'District',
      primary: true,
      render: ({ area }) => (
        <IdCell
          thumb={<MapPin aria-hidden="true" />}
          title={area.name}
          meta={area.region}
        />
      ),
    },
    {
      key: 'board',
      header: 'Board',
      label: 'Board',
      tight: true,
      render: ({ area }) =>
        area.active ? <Badge tone="ok">Active</Badge> : <Badge>Off the board</Badge>,
    },
    {
      key: 'delivers',
      header: 'Delivers',
      label: 'Delivers',
      tight: true,
      render: (row) => <DeliversCell row={row} onWrite={write} />,
    },
    {
      key: 'rate',
      header: 'Delivery rate',
      label: 'Delivery rate',
      numeric: true,
      render: (row) => (
        <RateCell row={row} zone={zoneFor(zones, row.area.region)} onWrite={write} />
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<Truck />}
        title="Delivery areas"
        subtitle="Per-district rates over the state zones — Abuja, Lagos, and everywhere else."
        menu={
          tab === 'all'
            ? undefined
            : (close) => (
                <>
                  <MenuItem
                    onSelect={() => {
                      close();
                      void bulkDelivers(tab, true);
                    }}
                  >
                    Deliver everywhere in {humanise(tab)}
                  </MenuItem>
                  <MenuItem
                    critical
                    onSelect={() => {
                      close();
                      void bulkDelivers(tab, false);
                    }}
                  >
                    Stop delivering in {humanise(tab)}
                  </MenuItem>
                </>
              )
        }
      />

      <Banner tone="info" title="The storefront doesn’t send a district yet">
        These rows arm the moment checkout sends one; until then the state’s zone prices delivery
        — Abuja ₦3,000, elsewhere ₦10,000. Authoring here is safe and takes effect automatically.
      </Banner>

      {loadError ? (
        <Banner tone="critical" title="Couldn’t load delivery areas" action={<Button onClick={() => void load()}>Retry</Button>}>
          {loadError}
        </Banner>
      ) : null}

      <DataTable
        caption="Delivery areas"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.area.key}
        loading={areas === null && !loadError}
        tabs={{
          value: tab,
          tabs: [{ value: 'all', label: 'All regions' }, ...regions.map((r) => ({ value: r, label: r }))],
          onChange: setTab,
        }}
        search={{
          value: search,
          placeholder: 'Filter districts',
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
              body="Districts are managed on the returns side — the delivery board shares them."
            />
          )
        }
        footer={null}
      />

      <p className="page__learn">
        No override means the district ships at its state zone’s rate. An override never means
        free — clearing it returns to the zone.
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
  const delivers = row.opinion?.delivers ?? true;
  return (
    <span
      onClick={(e) => e.stopPropagation()}
      style={busy ? { opacity: 0.6, pointerEvents: 'none' } : undefined}
    >
      <Toggle
        label={<span className="sr">Delivers to {row.area.name}</span>}
        checked={delivers}
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
                Clear override
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
