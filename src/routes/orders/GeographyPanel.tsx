import { useMemo } from 'react';
import { safeFormatMinor, type ShopOrderRow } from '../../data/api-shop';
import {
  DELIVERY_RATE_CURRENCY,
  NO_REGION_LABEL,
  breakdown,
  type BreakdownGroup,
  type DeliveryZoneTable,
  type RawVariant,
  type UnrecognisedReason,
} from './geography';
import './board.css';

/**
 * WHERE THE PARCELS ARE GOING — and, just as loudly, what this panel had to do
 * to the operator's data to say it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE THINGS THIS PANEL MUST NEVER DO QUIETLY.
 *
 *  1. **COLLAPSE.** In the live capture, `Abuja` ×4 and
 *     `Federal Capital Territory` ×1 are one place, and this shows one row for
 *     them — as it must, because the shop's own zone table prices both
 *     identically and two rows would have the operator planning two runs for
 *     one city. But collapsing is a rewrite of what a customer typed, and a
 *     rewrite nobody can see is how the checkout form goes on accepting two
 *     spellings for ever. So every folded row carries a `<details>` naming each
 *     spelling and counting it, and the panel's header says how many rows were
 *     folded before anyone opens one.
 *
 *  2. **DROP.** An address this module cannot place is a ROW, never a silence.
 *     `breakdown` sorts those below the real destinations so a large one cannot
 *     read as the biggest destination, and the reasons are broken out
 *     underneath — "no region given" and "region not recognised" want different
 *     fixes and one bucket asks for neither.
 *
 *  3. **QUOTE A RATE IT CANNOT STAND BEHIND.** `BreakdownOptions.zones` HAS NO
 *     DEFAULT, and that is the module refusing to let this panel print the
 *     seeded migration values as if they were the shop's tariff — they are
 *     owner-editable without a deploy. So the zone column has two whole modes:
 *     with a table, a zone and a rate; without one, `{ known: false }` and a
 *     column that says there is no table rather than a number that was true in
 *     a migration. Inside the first mode the claims are still separated: a zone
 *     this module names, what the CHECKOUT would have quoted for the same raw
 *     text, and whether those two agree.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NO CHART LIBRARY AND NO SVG. The share is a bar drawn in the table row
 * itself: at 380px a pie is four unreadable slivers and a legend, and a bar in
 * the row is already beside the label it belongs to. LENGTH is the encoding,
 * not colour — every bar is the same accent, so a reader who cannot separate
 * hues loses nothing, the unplaced rows are hatched as well as labelled, and
 * the count and percentage are printed beside the bar for the reader a bar does
 * not serve at all.
 */

/** `breakdown`'s reasons, in this app's voice. */
const REASON_LABEL: Record<UnrecognisedReason, string> = {
  'no-address': 'the order carried no shipping address',
  'no-region': 'the address had no region field',
  'region-not-a-string': 'the region field was not text',
  'region-blank': 'the region field was blank',
  'region-unknown': 'the region is a place this table does not know',
  'non-nigerian': 'the address is outside Nigeria',
};

export interface GeographyPanelProps {
  /** The same page of orders the board is drawn from. No second request. */
  rows: readonly ShopOrderRow[];
  /** Epoch ms. Passed in, never read from a clock — see `BreakdownOptions.now`. */
  now: number;
  /**
   * The LIVE rate table:
   *
   *     const rows = await shopApi.listShippingZones();
   *     <GeographyPanel … zones={deliveryZoneTableFrom(rows)} />
   *
   * Leave it out, or pass `null` while the request is in flight or after it
   * failed, and every other column still renders from facts about the orders —
   * the destination, the collapse, the queue, and the money the customer was
   * actually charged. Only the zone column goes quiet, and it says why.
   *
   * DO NOT PASS `SEEDED_DELIVERY_ZONES` to fill the gap. `geography.ts` marks
   * that constant as the empty-database fallback and nothing else.
   */
  zones?: DeliveryZoneTable | null;
}

export function GeographyPanel({ rows, now, zones = null }: GeographyPanelProps) {
  const data = useMemo(() => breakdown(rows, { now, zones }), [rows, now, zones]);

  const folded = data.collapses.length;
  const rated = data.delivery.known;
  /* Rows this module could put on the map. NOT `groups.length`: the unplaced
   * ones are rows too, deliberately (see 2. above), and counting them as
   * destinations would make a page of unreadable addresses look well travelled. */
  const placed = data.groups.filter((group) => group.recognised).length;

  return (
    <section className="panel shopgeo" aria-labelledby="shopgeo-title">
      <header className="panel__head">
        <div className="panel__heading">
          <h2 className="panel__title" id="shopgeo-title">
            Where these are going
          </h2>
          <p className="panel__sub">
            {data.totalOrders} order{data.totalOrders === 1 ? '' : 's'} on this page.
            {folded > 0 && (
              <>
                {' '}
                {folded} destination{folded === 1 ? '' : 's'} {folded === 1 ? 'was' : 'were'} written more
                than one way — open a row to see which spellings.
              </>
            )}
          </p>
        </div>
      </header>

      {/*
        THE SHOP'S OWN STAT TILES, and every number on them is one the table or
        a footnote below already carries. That is the whole rule for this row: it
        restates, it never asserts. A tile that computed something new here would
        be a fourth claim on a panel whose header is about not making claims
        quietly, and `.stat--alert` is spent on the one number that means somebody
        has to do something — an address nothing could place is an order nobody
        can plan a run for.
      */}
      <div className="panel__body shopgeo__head">
        <div className="stattiles shopgeo__stats">
          <div className="stat">
            <span className="stat__label">Destinations</span>
            <span className="stat__value">{placed}</span>
            <span className="stat__note">
              places on this page this table could put on the map
            </span>
          </div>
          <div className="stat">
            <span className="stat__label">Spellings folded</span>
            <span className="stat__value">{folded}</span>
            <span className="stat__note">
              {folded === 0
                ? 'every destination was written one way'
                : 'open a row below to see which spellings became one'}
            </span>
          </div>
          <div className={`stat${data.unrecognised.orders > 0 ? ' stat--alert' : ''}`}>
            <span className="stat__label">Not placed</span>
            <span className="stat__value">{data.unrecognised.orders}</span>
            <span className="stat__note">
              {data.unrecognised.orders === 0
                ? 'every address resolved to a region'
                : 'listed below with the region text exactly as it arrived'}
            </span>
          </div>
        </div>
      </div>

      <div className="panel__body panel__body--flush">
        <div className="dtable__scroll">
          <table className="dtable shopgeo__table">
            <thead>
              <tr>
                <th scope="col">Destination</th>
                <th scope="col">Share of orders</th>
                <th scope="col" className="dtable__num">
                  Value
                </th>
                <th scope="col">
                  Delivery zone
                  {!rated && (
                    /*
                     * Said in the heading, not a footnote: a caveat away from
                     * the column it qualifies is a caveat nobody reads beside
                     * the number — and here there is no number to read at all.
                     *
                     * THE SEPARATOR IS REAL TEXT, AND IT IS NOT DECORATION. The
                     * caveat is `display: block`, so on screen it is already its
                     * own line — but a line break drawn by CSS is not a
                     * character, and the string this cell computes to was
                     * "Delivery zoneno zone table was supplied". That is what
                     * `textContent` gave (measured) and what the accessible name
                     * is built from, so it is what the column header announced
                     * before every cell in the column. An em dash in the flow
                     * fixes the string; `visually-hidden` keeps it out of the
                     * picture, where the block already does the separating and a
                     * dash starting the second line would only be noise.
                     */
                    <>
                      <span className="visually-hidden"> — </span>
                      <span className="shopgeo__caveat">no zone table was supplied</span>
                    </>
                  )}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.groups.map((group) => (
                <Row key={keyOf(group)} group={group} />
              ))}

              {data.groups.length === 0 && (
                <tr>
                  <td className="dtable__empty" colSpan={4}>
                    No orders on this page, so nowhere to send anything.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel__body shopgeo__foot">
        {/*
          THE SHARES DO NOT HAVE TO ADD UP TO 100 AND ARE NOT FORCED TO —
          `SHARE_DECIMALS` argues it at length: each row is rounded on its own so
          that a row an operator checks against the order count is right, and
          three equal thirds are allowed to print 99.9. Saying "of N orders"
          here is what stops that reading as an error.
        */}
        <p className="panel__note">
          Each share is of all {data.totalOrders} order{data.totalOrders === 1 ? '' : 's'} on this page,
          rounded on its own — the column is not meant to total exactly 100.
        </p>

        {!rated && (
          <p className="panel__note">
            <strong>No delivery rates are shown.</strong> This panel was not given the shop’s zone table,
            and it will not fall back to the seeded migration values — those are editable in the shipping
            zones screen without a deploy, so printing them here would be quoting a price that may not have
            been charged since. Everything else on this page is a fact about the orders themselves.
          </p>
        )}

        {data.unrecognised.orders > 0 && (
          <p className="panel__note">
            <strong>
              {data.unrecognised.orders} order{data.unrecognised.orders === 1 ? '' : 's'} could not be placed
              on the map
            </strong>{' '}
            {data.unrecognised.reasons.map((entry, index) => (
              <span key={entry.reason}>
                {index === 0 ? '— ' : '; '}
                {entry.orders} because {REASON_LABEL[entry.reason]}
              </span>
            ))}
            . They are listed above with the region text exactly as it arrived, and are counted in every
            total on this page.
          </p>
        )}

        {data.inferredOrders > 0 && (
          <p className="panel__note">
            {data.inferredOrders} order{data.inferredOrders === 1 ? '' : 's'} named a town rather than a
            state, so the state beside {data.inferredOrders === 1 ? 'it' : 'them'} is this screen’s
            inference and is marked <em>inferred</em>. It is not what the checkout priced on.
          </p>
        )}

        {data.delivery.known && data.delivery.disagreements > 0 && (
          <p className="panel__note">
            <strong>
              {data.delivery.disagreements} order
              {data.delivery.disagreements === 1 ? '' : 's'} would be priced by the checkout differently
              from the zone shown here.
            </strong>{' '}
            Either the zone table is missing that spelling — fixable in the shipping zones screen with no
            deploy — or the address is outside Nigeria and the fallback zone claims it anyway. What the
            customer actually paid is in the value column and was frozen at checkout; it is never re-quoted
            here.
          </p>
        )}

        {data.unusableMoneyFields > 0 && (
          <p className="panel__note">
            <strong>
              {data.unusableMoneyFields} money field{data.unusableMoneyFields === 1 ? '' : 's'} on this page
              could not be read
            </strong>{' '}
            and {data.unusableMoneyFields === 1 ? 'was' : 'were'} counted as zero, so at least one total
            above is short by an unknowable amount. That is a bug to report, not a rounding note.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * A group key that survives two unrecognised rows sharing a label. `breakdown`
 * already keys them apart internally by country plus folded text; this rebuilds
 * enough of that to keep React's reconciliation honest.
 */
function keyOf(group: BreakdownGroup): string {
  return group.code ?? `?|${group.countryCode ?? ''}|${group.label}`;
}

function Row({ group }: { group: BreakdownGroup }) {
  const spellings = group.collapsed.length;

  return (
    <tr className={group.recognised ? undefined : 'shopgeo__row--unplaced'}>
      <td>
        <span className="shopgeo__place">
          {/*
            `<bdi>`, BECAUSE THIS IS A STRING A CUSTOMER TYPED. React escapes
            markup and does nothing at all about U+202A–U+202E; one address
            carrying a right-to-left override, left bare, reverses the run it
            sits in and can flip the order count and the money beside it. `<bdi>`
            is `unicode-bidi: isolate`, so anything opened inside it is closed at
            its own boundary. The unrecognised rows are exactly the ones most
            likely to carry it, and they are the ones printed verbatim.
          */}
          <bdi className="dtable__strong">{group.label}</bdi>
          {!group.recognised && (
            /* Words, never colour alone. The row says what it is. */
            <span className="shopgeo__flag">not recognised</span>
          )}
          {group.countryCodeMixed ? (
            <span className="shopgeo__flag">mixed countries</span>
          ) : (
            group.countryCode !== null &&
            group.countryCode !== 'NG' && <span className="shopgeo__flag">{group.countryCode}</span>
          )}
          {group.inferred > 0 && (
            <span className="shopgeo__flag" title="Worked out from a town name, not stated as a region">
              {group.inferred} inferred
            </span>
          )}
        </span>

        {group.awaitingAction > 0 && (
          <span className="dtable__sub">{group.awaitingAction} still waiting on you</span>
        )}

        {spellings > 1 && (
          /*
            THE COLLAPSE, OPENABLE. Native `<details>` rather than a custom
            disclosure: keyboard-operable, screen-reader-announced and printable
            without a line of JavaScript, and this is exactly the "reveal the
            evidence" case it was added to HTML for.
          */
          <details className="shopgeo__collapse">
            <summary>{spellings} spellings folded into this row</summary>
            <ul className="shopgeo__variants">
              {group.collapsed.map((variant) => (
                <li key={variant.raw ?? ' none'}>
                  <bdi className="shopgeo__variant">{labelOf(variant)}</bdi>
                  <span className="num"> × {variant.orders}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </td>

      {/* `data-label` on every cell after the first: below 640px `shop.css`
          turns `.dtable` into a stack and moves the header words into the cells
          themselves, and a cell without one gets no label at all. */}
      <td data-label="Share">
        <span className="shopgeo__share">
          <span className="shopgeo__bar" aria-hidden="true">
            <span className="shopgeo__fill" style={{ inlineSize: `${Math.min(100, group.sharePct)}%` }} />
          </span>
          <span className="shopgeo__pct num">
            {group.orders} · {group.sharePct}%
          </span>
        </span>
      </td>

      <td className="dtable__num" data-label="Value">
        {group.value.length === 0 ? (
          <span className="shopgeo__none">—</span>
        ) : (
          group.value.map((total) => (
            /* One line per currency, never a sum — `CurrencyTotal` refuses it
               for the same reason `stats.ts` does. */
            <span className="shopgeo__money num" key={total.currency}>
              {safeFormatMinor(total.grandTotal, total.currency)}
              {total.refundedTotal > 0 && (
                <span className="dtable__sub">
                  {safeFormatMinor(total.refundedTotal, total.currency)} refunded
                </span>
              )}
            </span>
          ))
        )}
      </td>

      <td data-label="Zone">
        <Zone group={group} />
      </td>
    </tr>
  );
}

/**
 * The zone column, which is FOUR different claims and never blurs them.
 *
 *   no table          — nothing was supplied, so there is nothing to say.
 *   no zone           — outside Nigeria; this module refuses to name a
 *                       Nigerian zone for it even though the fallback would.
 *   a zone and a rate — the ordinary case.
 *   a zone, no rate   — the zone quotes nothing, or quotes two prices the
 *                       customer picks between. `amountMinor` is `null` and the
 *                       options are listed rather than one of them being
 *                       chosen here.
 *
 * `viaFallback` IS NOT RENDERED AS A GUESS BADGE, and `ZoneKnown` says why in
 * bold: with the seeded table it is `true` for 35 of Nigeria's 37 regions, all
 * of them confidently recognised, because "Rest of Nigeria" is genuinely the
 * zone Oyo is in and genuinely what the customer paid. It says which zone
 * caught the address and nothing about how well the address was read.
 */
function Zone({ group }: { group: BreakdownGroup }) {
  const reading = group.delivery;

  if (!reading.known) {
    return <span className="shopgeo__none">—</span>;
  }

  if (reading.zone === null) {
    return (
      <span className="shopgeo__zone">
        <span className="shopgeo__none">no zone</span>
        <span className="shopgeo__note">
          Outside Nigeria — this screen will not name a Nigerian zone for it, whatever the fallback would
          charge.
        </span>
      </span>
    );
  }

  return (
    <span className="shopgeo__zone">
      <span>{reading.zone.label}</span>

      {reading.zone.amountMinor === null ? (
        <span className="shopgeo__note">
          {reading.zone.options.length === 0
            ? 'this zone quotes no rate'
            : `${reading.zone.options.length} rates — the customer picks`}
        </span>
      ) : (
        <span className="num">{safeFormatMinor(reading.zone.amountMinor, DELIVERY_RATE_CURRENCY)}</span>
      )}

      {reading.viaFallback && <span className="shopgeo__note">caught by the fallback zone</span>}

      {reading.serverZoneMixed ? (
        <span className="shopgeo__flag shopgeo__flag--warn">
          the spellings here are priced differently from each other
        </span>
      ) : (
        reading.disagreements > 0 && (
          <span className="shopgeo__flag shopgeo__flag--warn">checkout prices this differently</span>
        )
      )}
    </span>
  );
}

/** A variant with no region text at all still needs a name on screen. */
function labelOf(variant: RawVariant): string {
  return variant.raw === null || variant.raw === '' ? NO_REGION_LABEL : variant.raw;
}
