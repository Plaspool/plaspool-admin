import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Truck } from 'lucide-react';
import { shopApi, safeFormatMinor, type ShopDeliveryArea, type ShopShippingZone } from '../data/api-shop';
import { marketingApi, type ServiceArea } from '../data/api-marketing';
import { ApiError } from '../data/errors';
import { getSession } from '../data/session';
import { useToast } from '../components/Toast';
import { Switch } from '../components/ui/Switch';
import { Skeleton } from '../components/ui/Feedback';
import { useDelayed } from '../components/ui/useDelayed';
import { Picker } from '../components/ui/Picker';
import {
  deliveryZoneOf,
  deliveryZoneTableFrom,
  normaliseRegion,
  DELIVERY_RATE_CURRENCY,
} from './orders/geography';
import './marketing.css';
import './shop.css';

/**
 * Delivery areas — where the shop goes, and what it charges to get there.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS THE SHIPPING SCREEN REBUILT AS THE AREAS SCREEN, AND THE MERGE IS
 * THE POINT.
 *
 * What stood here was `ShopShippingZones`: three zones, raw `<button>`s with no
 * classes, "300000 minor units" printed at the operator, and comma-separated
 * ISO codes typed into a text box. It asked an owner to think in the database's
 * vocabulary — zones, regions arrays, fallback flags — to answer a question
 * they actually hold in the vocabulary of PLACES: do we deliver to Wuse, and
 * for how much.
 *
 * `MarketingAreas` had already solved that shape for collection: a searchable
 * state picker, one state's districts on screen, a Switch per row. The two
 * screens were asking the same question about the same country and answering it
 * two different ways — one of them badly. So this screen is that one, with the
 * price brought into the row beside the switch.
 *
 * ONE SCREEN, BOTH ACTS. Switching a district on and setting what it costs are
 * the same decision made at the same moment ("we'll start delivering to Gwarinpa
 * at ₦3,500"), and splitting them across two screens made the owner hold half
 * the decision in their head while they navigated.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DISTRICTS ARE MARKETING'S; THE PRICES ARE THE SHOP'S. TWO REQUESTS, ONE
 * ROW, JOINED ON `key`.
 *
 * `marketing_service_areas` is the only district list this business has, and
 * duplicating it into the shop would mean two lists drifting apart the first
 * time somebody fixed a spelling. So this screen reads BOTH APIs and joins them
 * on the area's stable `key` — the handle a rename does not move. The shop's
 * table (`shop_delivery_areas`, migration 0300) stores nothing but the opinion:
 * delivers, and an optional rate override.
 *
 * A DISTRICT WITH NO SHOP ROW IS NOT BROKEN AND NOT UNCONFIGURED. It delivers,
 * at whatever its state's zone already quotes — which is precisely the live
 * behaviour, because the fallback zone catches every address. Rows are written
 * the first time an owner says something. That is why the rate cell shows the
 * inherited zone rate in a quieter voice rather than an empty box: an empty box
 * would read as ₦0.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ⚠️  AND THE ONE THING THIS SCREEN MUST NOT LIE ABOUT — SAID ON THE SCREEN,
 *     NOT ONLY HERE. Checkout does not read district rates yet. `zoneFor`
 *     (`server/shop/cart/checkout/shipping.ts`) matches on the address's
 *     `region`, which is the STATE, and every address in the live capture has
 *     `city: "Abuja"` — the state again. There is no district text at checkout
 *     to match against until the storefront's address form captures one. An
 *     owner who sets ₦3,500 for Gwarinpa today and is not told this would
 *     believe customers are being charged it. The notice below is therefore not
 *     decoration and must not be removed before the storefront change lands.
 */

/** Minor units per naira. 100, confirmed against a live price (CLAUDE.md §6). */
const MINOR_PER_MAJOR = 100;

/**
 * Naira typed by a person → minor units, or `null` when it is not a price.
 *
 * REJECTS RATHER THAN ROUNDS. `3000.456` is not a naira amount and guessing
 * which way the operator meant it to go is how a shop charges a kobo it never
 * agreed to. Blank is a legitimate answer meaning "clear the override" and is
 * handled by the caller, not here.
 */
export function parseNaira(raw: string): number | null {
  const text = raw.trim().replace(/[₦,\s]/g, '');
  if (text === '' || !/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const minor = Math.round(Number(text) * MINOR_PER_MAJOR);
  return Number.isSafeInteger(minor) && minor >= 0 ? minor : null;
}

/** Minor units → the bare number a naira input should be seeded with. */
export function nairaValue(minor: number): string {
  const whole = Math.floor(minor / MINOR_PER_MAJOR);
  const kobo = minor % MINOR_PER_MAJOR;
  return kobo === 0 ? String(whole) : `${whole}.${String(kobo).padStart(2, '0')}`;
}

/** Regions in the order the API sends them, each with its delivering tally. */
export function byRegion(
  areas: readonly ServiceArea[],
  delivers: (area: ServiceArea) => boolean,
): { region: string; areas: ServiceArea[]; on: number }[] {
  const regions = [...new Set(areas.map((area) => area.region))];
  return regions.map((region) => {
    const inRegion = areas.filter((area) => area.region === region);
    return { region, areas: inRegion, on: inRegion.filter(delivers).length };
  });
}

export default function ShopDeliveryAreas() {
  const { notify } = useToast();
  const session = getSession();
  const isOwner = session.status === 'authed' && session.user.role === 'owner';

  const [areas, setAreas] = useState<ServiceArea[] | null>(null);
  const [opinions, setOpinions] = useState<Map<string, ShopDeliveryArea>>(new Map());
  const [zones, setZones] = useState<ShopShippingZone[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const showSkeletons = useDelayed(loading);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [bulk, setBulk] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [stateRate, setStateRate] = useState<string | null>(null);
  const [stateBusy, setStateBusy] = useState(false);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    /*
     * THREE REQUESTS, AND A ZONE FAILURE IS NOT A SCREEN FAILURE. The districts
     * and the shop's opinions are what this screen IS; the zone table only
     * supplies the inherited rate shown behind an un-overridden district, so it
     * is allowed to be `null` and the cell goes quiet rather than the page
     * going red. Same contract `ShopOrders` gives the rates it shows.
     */
    return Promise.all([
      marketingApi.listAreas(false, signal),
      shopApi.listDeliveryAreas(signal),
      shopApi.listShippingZones(signal).catch(() => null),
    ])
      .then(([areasView, delivery, zoneRows]) => {
        if (signal?.aborted) return;
        setAreas(areasView.areas);
        setOpinions(new Map(delivery.map((row) => [row.areaKey, row])));
        setZones(zoneRows);
        setProblem(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (signal?.aborted) return;
        setProblem(
          err instanceof ApiError && err.status === 403
            ? 'You do not have access to the delivery rates.'
            : 'The delivery areas didn’t load.',
        );
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const zoneTable = useMemo(
    () => (zones === null ? null : deliveryZoneTableFrom(zones)),
    [zones],
  );

  /**
   * What a district costs TODAY if nobody overrides it — its state's zone rate.
   *
   * Reuses `deliveryZoneOf` rather than re-deriving the match, so the number
   * beside a district is the same reading the orders console shows for a parcel
   * going there. `null` whenever the table did not load or the zone quotes no
   * single price, and the cell then says nothing rather than inventing one.
   */
  const inheritedRate = useCallback(
    (area: ServiceArea): number | null => {
      if (zoneTable === null) return null;
      const reading = deliveryZoneOf(
        normaliseRegion({ region: area.region, countryCode: 'NG' }),
        zoneTable,
      );
      return reading.known && reading.zone !== null ? reading.zone.amountMinor : null;
    },
    [zoneTable],
  );

  const deliversNow = useCallback(
    /* ABSENCE MEANS DELIVERS — the table's own safety property (migration 0300).
     * A district nobody has had an opinion about is one the shop is already
     * selling to, so the default here must agree with the database's. */
    (area: ServiceArea) => opinions.get(area.key)?.delivers ?? true,
    [opinions],
  );

  const groups = useMemo(
    () => (areas === null ? [] : byRegion(areas, deliversNow)),
    [areas, deliversNow],
  );

  /* The opening state, chosen once per load: the first region that delivers
   * anywhere, which is the one this shop actually operates in. Alphabetical
   * would open every visit on Abia. Lifted verbatim from `MarketingAreas`. */
  useEffect(() => {
    if (groups.length === 0) return;
    setRegion((chosen) => {
      if (chosen !== null && groups.some((group) => group.region === chosen)) return chosen;
      return (groups.find((group) => group.on > 0) ?? groups[0]!).region;
    });
  }, [groups]);

  const shown = groups.find((group) => group.region === region) ?? null;

  /**
   * THE ZONE THAT ACTUALLY PRICES THIS STATE TODAY, and the single option on it.
   *
   * This is the number customers are being charged right now — district rates
   * are still inert (see the header) — so the screen would be useless without a
   * way to edit it, and "one screen where both can be done" would have meant a
   * second trip to the zones screen for the only rate that bites.
   *
   * `null` whenever the zone quotes anything other than exactly one option: two
   * delivery choices are a structure this row cannot represent without picking
   * one arbitrarily, and the advanced screen is the honest place for that.
   */
  const stateZone = useMemo(() => {
    if (shown === null || zones === null || zoneTable === null) return null;
    const reading = deliveryZoneOf(
      normaliseRegion({ region: shown.region, countryCode: 'NG' }),
      zoneTable,
    );
    if (!reading.known || reading.zone === null) return null;
    const raw = zones.find((zone) => zone.id === reading.zone!.id);
    if (raw === undefined || raw.options.length !== 1) return null;
    return { zone: raw, option: raw.options[0]! };
  }, [shown, zones, zoneTable]);

  async function saveStateRate(): Promise<void> {
    if (stateZone === null || stateRate === null) return;
    const minor = parseNaira(stateRate);
    if (minor === null) {
      notify('Type a delivery price, like 3000.', { tone: 'danger' });
      return;
    }
    setStateBusy(true);
    try {
      await shopApi.saveShippingOption(stateZone.option.id, { amountMinor: minor });
      /* Refetch rather than patch: this rate is inherited by every district
       * below that has no override, so a stale copy would print the old number
       * beside every one of them. */
      setZones(await shopApi.listShippingZones());
      setStateRate(null);
      notify(`${stateZone.zone.label} rate is now ${safeFormatMinor(minor, DELIVERY_RATE_CURRENCY)}`);
    } catch (err) {
      notify(explain(err, 'That rate didn’t save.'), { tone: 'danger' });
    } finally {
      setStateBusy(false);
    }
  }

  function explain(err: unknown, fallback: string): string {
    if (err instanceof ApiError) {
      if (err.status === 403) return 'Only the owner can change delivery.';
      if (err.code === 'stale_write' || err.status === 409) {
        return 'Somebody else changed that district. Reloading.';
      }
    }
    return fallback;
  }

  async function save(area: ServiceArea, patch: { delivers?: boolean; rateMinor?: number | null }) {
    setBusy(area.key);
    try {
      const saved = await shopApi.saveDeliveryArea(area.key, {
        ...patch,
        /* `null` says "I believe there is no row yet", which is the honest
         * assertion for a district nobody has priced — and it is what makes a
         * concurrent first write lose instead of silently winning. */
        expectedRevision: opinions.get(area.key)?.revision ?? null,
      });
      setOpinions((prev) => new Map(prev).set(saved.areaKey, saved));
      notify(
        patch.delivers === true
          ? `Now delivering to ${area.name}`
          : patch.delivers === false
            ? `Stopped delivering to ${area.name}`
            : patch.rateMinor === null
              ? `${area.name} back on the ${area.region} rate`
              : `${area.name} rate saved`,
      );
    } catch (err) {
      const message = explain(err, 'That change didn’t save.');
      notify(message, { tone: 'danger' });
      if (err instanceof ApiError && (err.code === 'stale_write' || err.status === 409)) {
        await load();
      }
    } finally {
      setBusy(null);
      setEditing(null);
    }
  }

  /**
   * SWITCH A WHOLE STATE'S DELIVERY ON OR OFF.
   *
   * ONE REQUEST, unlike the Areas screen's equivalent — the bulk route takes a
   * list of area keys, so "stop delivering to this state" is a single write and
   * cannot half-apply. That is the difference between having a bulk endpoint and
   * fanning out over a per-row one.
   *
   * DOES NOT TOUCH THE RATES, the mirror of `applyBulk` not touching the
   * switches. Switching a state back on later should find the prices the owner
   * set before, not a table wiped by the act of pausing.
   */
  async function switchAll(next: boolean): Promise<void> {
    if (shown === null) return;
    setBulkBusy(true);
    try {
      const saved = await shopApi.saveDeliveryAreas({
        areaKeys: shown.areas.map((area) => area.key),
        delivers: next,
      });
      setOpinions((prev) => {
        const map = new Map(prev);
        for (const row of saved) map.set(row.areaKey, row);
        return map;
      });
      notify(
        `${shown.region} — ${saved.length} ${saved.length === 1 ? 'district' : 'districts'} ${next ? 'now delivering' : 'switched off'}`,
      );
    } catch (err) {
      notify(explain(err, 'That change didn’t save.'), { tone: 'danger' });
    } finally {
      setBulkBusy(false);
    }
  }

  async function applyBulk(): Promise<void> {
    if (shown === null) return;
    const minor = parseNaira(bulk);
    if (minor === null) {
      notify('Type a delivery price, like 3000.', { tone: 'danger' });
      return;
    }
    setBulkBusy(true);
    try {
      const saved = await shopApi.saveDeliveryAreas({
        areaKeys: shown.areas.map((area) => area.key),
        rateMinor: minor,
      });
      setOpinions((prev) => {
        const next = new Map(prev);
        for (const row of saved) next.set(row.areaKey, row);
        return next;
      });
      setBulk('');
      notify(
        `${saved.length} ${saved.length === 1 ? 'district' : 'districts'} in ${shown.region} set to ${safeFormatMinor(minor, DELIVERY_RATE_CURRENCY)}`,
      );
    } catch (err) {
      notify(explain(err, 'Those rates didn’t save.'), { tone: 'danger' });
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="mktscr">
      <header className="mktscr__head">
        <div className="mktscr__headrow">
          <div>
            <h1 className="mktscr__title">
              <Truck className="mktdesk__flag" aria-hidden="true" /> Delivery areas
            </h1>
            <p className="mktscr__lede">
              Where we deliver, and what we charge to get there.
            </p>
          </div>

          {groups.length > 0 && (
            <div className="mktscr__headacts">
              <Picker
                label="State"
                value={region}
                onChange={setRegion}
                items={groups.map((group) => ({
                  value: group.region,
                  label: group.region,
                  badge: group.on,
                  note: group.on === 0 ? `${group.areas.length} districts` : undefined,
                }))}
                icon={<Truck className="ui-ic" aria-hidden="true" />}
                searchPlaceholder="Search states…"
                emptyText="No state matches that."
                align="end"
              />
            </div>
          )}
        </div>
      </header>

      {/*
        THE HONESTY NOTICE. See this file's header: district rates are authored
        here and not yet read at the till. Removing this before the storefront
        captures a district would leave an owner believing a price is being
        charged that is not.
      */}
      <p className="notice notice--warn">
        <strong>Not charged at checkout yet.</strong> Orders are still priced by
        state — the rates below are saved and will apply once the storefront’s
        address form asks which district a customer is in.
      </p>

      {problem !== null && <p className="mktform__error">{problem}</p>}
      {showSkeletons && areas === null && <Skeleton height="12rem" />}

      {shown !== null && (
        <section className="mktarea">
          <header className="mktarea__head">
            <h2 className="mktarea__region">{shown.region}</h2>
            <p className="mktarea__tally">
              {shown.on} of {shown.areas.length} delivering
            </p>

            {/*
              THE MASTER SWITCH, matching the Areas screen's. Checked only when
              EVERY district is on, so a part-served state reads as off and one
              press means "deliver to all of this state".
            */}
            {isOwner && shown.areas.length > 0 && (
              <span className="mktarea__all">
                <span className="mktarea__alllabel">All of {shown.region}</span>
                <Switch
                  checked={shown.on === shown.areas.length}
                  label={`Deliver to every district in ${shown.region}`}
                  disabled={bulkBusy || busy !== null}
                  onChange={(next) => {
                    if (!bulkBusy && busy === null) void switchAll(next);
                  }}
                />
              </span>
            )}

            {/*
              THE RATE THAT IS ACTUALLY CHARGED, edited in place. Everything
              below it is an override on top of this number, so it belongs at the
              top of the section rather than behind a link to another screen.
            */}
            {stateZone !== null && (
              <p className="mktarea__tally dlvstate">
                {stateRate !== null ? (
                  <form
                    className="dlvbulk"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveStateRate();
                    }}
                  >
                    <span className="dlvrate__field">
                      <span className="dlvrate__sign" aria-hidden="true">₦</span>
                      <input
                        className="mktform__input dlvrate__input"
                        value={stateRate}
                        autoFocus
                        inputMode="decimal"
                        aria-label={`Delivery price for the ${stateZone.zone.label} zone`}
                        onChange={(event) => setStateRate(event.target.value)}
                      />
                    </span>
                    <button type="submit" className="btn btn--sm" disabled={stateBusy}>
                      Save
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setStateRate(null)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    Charged today:{' '}
                    <strong>
                      {safeFormatMinor(stateZone.option.amountMinor, DELIVERY_RATE_CURRENCY)}
                    </strong>{' '}
                    <span className="dlvrate__from">({stateZone.zone.label} zone)</span>
                    {isOwner && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setStateRate(nairaValue(stateZone.option.amountMinor))}
                      >
                        Edit
                      </button>
                    )}
                  </>
                )}
              </p>
            )}
          </header>

          {/*
            ACROSS-THE-BOARD PRICING — the "and all" half of the ask. It sets a
            rate and never touches the switches: an owner repricing a state has
            not thereby decided to start delivering to districts they had
            switched off, and a control that did both would make that decision
            for them silently.
          */}
          {isOwner && (
            <form
              className="mktarea__add"
              onSubmit={(event) => {
                event.preventDefault();
                void applyBulk();
              }}
            >
              <label className="dlvbulk">
                <span className="dlvbulk__label">Set every district in {shown.region} to</span>
                <span className="dlvrate__field">
                  <span className="dlvrate__sign" aria-hidden="true">₦</span>
                  <input
                    className="mktform__input dlvrate__input"
                    value={bulk}
                    inputMode="decimal"
                    placeholder="3000"
                    aria-label={`Delivery price for every district in ${shown.region}`}
                    onChange={(event) => setBulk(event.target.value)}
                  />
                </span>
              </label>
              <button type="submit" className="btn btn--sm" disabled={bulkBusy || bulk.trim() === ''}>
                Apply to all {shown.areas.length}
              </button>
            </form>
          )}

          <ul className="mktarea__list">
            {shown.areas.map((area) => {
              const opinion = opinions.get(area.key);
              const override = opinion?.rateMinor ?? null;
              const inherited = inheritedRate(area);
              const delivers = opinion?.delivers ?? true;

              return (
                <li className="mktarea__row" key={area.id}>
                  <span className="mktarea__name">{area.name}</span>
                  {/*
                    NO "PRESET"/"SHIPPED" CHIP HERE, deliberately. The Areas
                    screen marks rows that came from the bundled dataset because
                    an owner correcting a misspelt district wants to know which
                    names they did not write. On THIS screen that provenance
                    answers no question anybody is asking — the questions are "do
                    we go there" and "what does it cost" — and the chip read
                    "Shipped" beside a delivery rate, which looked like a claim
                    about a parcel. Dropped rather than relabelled.
                  */}

                  {editing?.key === area.key ? (
                    <form
                      className="mktarea__rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const text = editing.value.trim();
                        /* BLANK CLEARS THE OVERRIDE — `null`, not zero. The two
                         * differ and the difference is free delivery. */
                        if (text === '') {
                          void save(area, { rateMinor: null });
                          return;
                        }
                        const minor = parseNaira(text);
                        if (minor === null) {
                          notify('Type a delivery price, like 3000.', { tone: 'danger' });
                          return;
                        }
                        void save(area, { rateMinor: minor });
                      }}
                    >
                      <span className="dlvrate__field">
                        <span className="dlvrate__sign" aria-hidden="true">₦</span>
                        <input
                          className="mktform__input dlvrate__input"
                          value={editing.value}
                          autoFocus
                          inputMode="decimal"
                          placeholder={inherited === null ? '3000' : nairaValue(inherited)}
                          aria-label={`Delivery price for ${area.name}`}
                          onChange={(event) =>
                            setEditing({ key: area.key, value: event.target.value })
                          }
                        />
                      </span>
                      <button type="submit" className="btn btn--sm" disabled={busy === area.key}>
                        Save
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <span className="dlvrate">
                      {override !== null ? (
                        <span className="dlvrate__value">
                          {safeFormatMinor(override, DELIVERY_RATE_CURRENCY)}
                        </span>
                      ) : inherited !== null ? (
                        /* QUIETER, AND LABELLED. This is the state's rate, not
                         * this district's — printing it in the same voice as an
                         * override would make "inherited" indistinguishable
                         * from "decided". */
                        <span className="dlvrate__value dlvrate__value--inherited">
                          {safeFormatMinor(inherited, DELIVERY_RATE_CURRENCY)}
                          <span className="dlvrate__from"> · {shown.region} rate</span>
                        </span>
                      ) : (
                        <span className="dlvrate__value dlvrate__value--inherited">
                          No rate set
                        </span>
                      )}
                      {isOwner && (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() =>
                            setEditing({
                              key: area.key,
                              value: override === null ? '' : nairaValue(override),
                            })
                          }
                        >
                          {override === null ? 'Set price' : 'Edit'}
                        </button>
                      )}
                    </span>
                  )}

                  {isOwner ? (
                    <Switch
                      checked={delivers}
                      label={`Deliver to ${area.name}`}
                      disabled={busy === area.key}
                      onChange={(next) => {
                        if (busy === null) void save(area, { delivers: next });
                      }}
                    />
                  ) : (
                    <span className="mktarea__state">
                      {delivers ? 'Delivering' : 'Not delivering'}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/*
        THE ESCAPE HATCH, AND WHY IT IS A LINK RATHER THAN A NAV ENTRY. This
        screen answers the questions an owner has weekly — do we go there, what
        does it cost. Creating a zone, editing its country list, its tax rate or
        which zone is the fallback are structural jobs done roughly never, and
        `ShopShippingZones` still does them. Two sidebar entries would put a
        rarely-correct screen beside the usually-correct one and let an operator
        land on the wrong one; one entry and a footer link does not.
      */}
      {isOwner && areas !== null && (
        <p className="mktarea__tally dlvadvanced">
          <Link to="/shop/shipping-zones">Zones, countries and tax</Link> — the structure
          behind these rates. Rarely needs changing.
        </p>
      )}
    </div>
  );
}
