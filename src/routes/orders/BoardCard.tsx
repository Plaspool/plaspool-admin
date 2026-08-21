import { useId } from 'react';
import { safeFormatMinor, type ShopOrder, type ShopOrderLine, type ShopOrderRow } from '../../data/api-shop';
import { ageLabel } from '../../data/when';
import {
  COLUMN_LABEL,
  ageBand,
  moneyStateOf,
  movesFor,
  type AgeBand,
  type ColumnKey,
  type Move,
  type Role,
} from './pipeline';
import { destinationLane, waitingSince } from './Board';
import { normaliseRegion } from './geography';

/**
 * ONE ORDER, AS A CARD, AND THE ARGUMENT FOR ITS HIERARCHY.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS BIG AND WHY, IN THE ORDER THE OPERATOR ACTUALLY ASKS.
 *
 * This shop is one person, packing boxes, ringing a courier per order
 * (CLAUDE.md records dispatch as "more like logging" while it is arranged by
 * hand). So the question a card is scanned for is never "which order is this",
 * it is "what is the job". The ramp follows that, and every step of it is a
 * deliberate demotion of something a generic admin would have put first:
 *
 *  1. **The recipient and the destination.** Largest, and the only thing at
 *     `--step-0`. It is what a box gets addressed to and what decides which
 *     courier call this belongs to. Two cards for Abuja are one trip.
 *  2. **What is in it.** `2 × PLA Filament`. Decides the box, the weight and
 *     whether the shelf actually has it. Directly under the name.
 *  3. **The money and the order number**, together, quiet, tabular, in the
 *     footer. The number is a HANDLE — you type it into the search box, you
 *     quote it in an email — and it is a run of digits nobody tells apart at a
 *     glance, so making it the headline (Shopify's choice) spends the loudest
 *     line on the least scannable string on the card.
 *  4. **Age, and only when it has earned it.** `ageBand` is `fresh` for
 *     everything that is not waiting on the operator, and a fresh card carries
 *     no band, no colour and no badge at all. An always-present age badge is
 *     decoration; this one is a claim, so it has to be able to be absent.
 *
 * A card that is a wall of equal-weight text has failed, and so has one that
 * shouts on every row: if everything is marked urgent, nothing is.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FACE IS THE DRAG HANDLE AND THE MOVE LIST'S TRIGGER, AND IT IS ONE
 * ELEMENT.
 *
 * The drag layer's ref and props arrive as `drag` and are spread ON THE FACE
 * BUTTON. This file imports no drag library and never inspects them.
 *
 * ONE FOCUSABLE ELEMENT PER CARD, which is the part worth defending. The
 * obvious alternative — the marketing board's `.mktcard__grip`, a wrapper
 * `<div>` carrying the library's `role="button"` and `tabIndex={0}` around a
 * card that is itself a control — gives every card two tab stops and nests a
 * button inside a button. On a board of thirty cards that is thirty extra stops
 * between an operator and the lane they were heading for. Here Space picks the
 * card up (the sensor's own activator) and Enter opens its moves (the button's
 * own click), from one stop, with no bespoke key handling anywhere.
 *
 * THE MOVE LIST IS THE COMPLETE PATH AND THE DRAG IS THE SHORTCUT, not the
 * other way round — because several of this board's moves change no lane at
 * all. "Pack what is left" leaves the card in Packing and "Mark delivered"
 * cannot move it anywhere, since `delivered` is not derivable from the list
 * payload and so is not a lane. A gesture-first board would have made those
 * unreachable and called itself accessible.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS COMPONENT DERIVES NO LANE AND NO TRANSITION. `columnOf`, `movesFor`,
 * `ageBand` and `COLUMN_LABEL` come from `pipeline.ts`, which owns all of it;
 * where a move lands comes from `Board.tsx`; the region comes from
 * `geography.ts`. What is left here is arrangement.
 */

const BAND_NOTE: Record<AgeBand, string> = {
  fresh: '',
  ageing: 'waiting',
  overdue: 'overdue',
};

/**
 * `2 × PLA Filament`, and how many more lines there are behind it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A QUANTITY THIS CLIENT CANNOT READ PRINTS AS `—`, NEVER AS `1`.
 *
 * The old fallback invented the one number the card had just refused to
 * believe, and it did it in the ONE LANE THAT EXISTS TO SAY SO: `columnOf`
 * sends a row to `needs_attention` BECAUSE `coverage.unreadable > 0`
 * (`pipeline.ts`), so "1 × Mystery line" was not an edge case there, it was the
 * standard visible content of the lane whose whole job is admitting the board
 * cannot read this order. The same card's `aria-label` said "0 items", because
 * `units` below has always summed only numbers it could read — so the screen
 * and the accessible name disagreed about the same line, and the screen was the
 * one that was lying.
 *
 * `—` IS THE HOUSE ANSWER FOR THIS, not a new invention: `ageBand` will not
 * redden an unreadable date and the destination panel prints `—` rather than a
 * delivery rate it cannot stand behind. An unknown is refused out loud here for
 * the same reason it is there — an operator packs a box from this line, and a
 * fabricated `1` is a wrong box that looks exactly like a right one.
 *
 * `unreadable` IS COUNTED AND HANDED BACK so the spoken sentence can say the
 * same thing the grid does. "0 items" over a line nobody can count is the
 * accessible name making the opposite mistake — a confident number where there
 * is none — and the caller needs this to avoid it.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function contentsOf(lines: readonly ShopOrderLine[]): {
  first: string | null;
  more: number;
  units: number;
  unreadable: number;
} {
  const usable = Array.isArray(lines) ? lines.filter((line) => line !== null && typeof line === 'object') : [];
  /*
   * `pipeline.ts`'s own `readCount`, which is not exported and is not worth
   * widening that module's surface for. The RULE is copied deliberately and
   * stated here so a reader can check it against the original: a count is a
   * finite number that is not negative, and everything else — `null`, a string,
   * `NaN`, `-1` — is not a count at all.
   */
  const count = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;

  let units = 0;
  let unreadable = 0;
  for (const line of usable) {
    const n = count(line.qty);
    if (n === null) unreadable += 1;
    else units += n;
  }

  const head = usable[0];
  const title = typeof head?.title === 'string' && head.title !== '' ? head.title : null;
  const qty = head === undefined ? null : count(head.qty);
  return {
    first: title === null ? null : `${qty === null ? '—' : qty} × ${title}`,
    more: Math.max(0, usable.length - 1),
    units,
    unreadable,
  };
}

/**
 * Who the parcel is for. The NAME on the shipping address first, because that is
 * what goes on the box and what the courier asks for; the email behind it,
 * because a guest checkout can arrive with no name at all and an anonymous card
 * is one the operator cannot match to anything.
 */
export function recipientOf(order: Partial<ShopOrder>): string {
  const address = order.shippingAddress;
  if (address !== null && typeof address === 'object' && !Array.isArray(address)) {
    const name = (address as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim() !== '') return name.trim();
  }
  return typeof order.email === 'string' && order.email !== '' ? order.email : 'No name given';
}

export interface BoardCardProps {
  row: ShopOrderRow;
  now: number;
  role: Role;
  /** The lane this card is drawn in. Passed rather than recomputed per card. */
  lane: ColumnKey;
  /** The move list is open — this card is showing what can be done to it. */
  expanded: boolean;
  /** This card is the one in hand; what is drawn here is the hole it left. */
  held?: boolean;
  /** This is the copy under the pointer, drawn in the drag overlay. */
  lifted?: boolean;
  /** A move is in flight. The card is frozen and says what is happening. */
  busy?: null | { label: string; needsDetail: boolean };
  /** The operator has marked this order seen. Browser-local — see `BoardScreen`. */
  seen?: boolean;
  /** `false` when this browser refused to remember the marker at all. */
  seenPersists?: boolean;
  onToggleExpanded?: () => void;
  onToggleSeen?: () => void;
  onMove?: (move: Move) => void;
  /**
   * The drag layer's node ref and DOM props for the face. Spread verbatim; this
   * component neither reads them nor knows what produced them.
   */
  drag?: {
    ref?: (node: HTMLElement | null) => void;
    props?: Record<string, unknown>;
  };
}

export function BoardCard({
  row,
  now,
  role,
  lane,
  expanded,
  held = false,
  lifted = false,
  busy = null,
  seen = false,
  seenPersists = true,
  onToggleExpanded,
  onToggleSeen,
  onMove,
  drag,
}: BoardCardProps) {
  const panelId = useId();
  const order = row?.order ?? ({} as ShopOrder);

  const region = normaliseRegion(order.shippingAddress);
  const band = ageBand(row, now);
  const waited = ageLabel(waitingSince(order), now);
  const money = moneyStateOf(row);
  const contents = contentsOf(row?.lines ?? []);

  const moves = movesFor(row, role);
  /*
   * The moves an OWNER would have here, diffed against this role's, so the
   * absence can be explained without this file re-stating `CANCELLABLE`.
   * `movesFor` is asked twice; no rule is copied. Nothing below turns one of
   * these into a control — a greyed-out cancel on a writer's surface is a
   * permanent invitation to a 403 (`pipeline.ts`).
   */
  const withheld =
    role === 'owner'
      ? []
      : movesFor(row, 'owner').filter((m) => m.ownerOnly && !moves.some((x) => x.key === m.key));

  const number = typeof order.orderNumber === 'string' && order.orderNumber !== '' ? order.orderNumber : '—';
  const who = recipientOf(order);

  /*
   * THE "inferred" CHIP IS SAID, not left to a `title` on a `<span>` nobody can
   * focus. The face's `aria-label` REPLACES its contents, so every visible mark
   * inside it reaches assistive tech only if this sentence carries it — and the
   * chip is a claim about where the parcel is going, which is the loudest thing
   * on the card. The chip's own tooltip quotes the raw address text back; this
   * does not, on purpose. An accessible name is a flat string with no `<bdi>` to
   * isolate an embedding, and the raw field is exactly the untrusted customer
   * text the card puts in a `<bdi>` everywhere else.
   */
  const place =
    region.code !== null && !region.confident
      ? `${region.label}, worked out from the address rather than stated`
      : region.label;

  /*
   * AND THE COUNT REFUSES TO BE A NUMBER WHEN IT IS NOT ONE. `contentsOf` prints
   * `—` for a quantity nobody can read; saying "0 items" here would put the
   * confident version of the same lie into the accessible name, which is the
   * defect this pair was fixed for — the grid and the sentence now agree.
   */
  const counted =
    contents.unreadable === 0
      ? `${contents.units} item${contents.units === 1 ? '' : 's'}`
      : `${contents.unreadable} line${contents.unreadable === 1 ? '' : 's'} with no readable quantity` +
        (contents.units > 0
          ? `, and ${contents.units} item${contents.units === 1 ? '' : 's'} beside ${
              contents.unreadable === 1 ? 'it' : 'them'
            }`
          : '');

  /*
   * ONE SENTENCE THAT IS THE WHOLE CARD, for a reader who gets no layout. The
   * visible text is a grid of fragments; read in DOM order by a screen reader it
   * would be "2026-000006-S overdue Payment Test Abuja…", which is a list of
   * nouns. This is the same facts as a sentence, and it is what the lane
   * announcements echo when the card is picked up. The two clauses above are the
   * parts of it that had been quietly dropping a claim the grid was making.
   */
  const spoken =
    `Order ${number}, ${who}, ${place}. ` +
    `${counted}, ` +
    `${safeFormatMinor(order.grandTotal, order.currency)}. ` +
    `In ${COLUMN_LABEL[lane]}${band === 'fresh' ? '' : `, ${BAND_NOTE[band]} ${waited}`}.`;

  return (
    <li className="shopcard__slot">
      <article
        className={
          'shopcard' +
          (band === 'fresh' ? '' : ` shopcard--${band}`) +
          (held ? ' shopcard--ghost' : '') +
          (lifted ? ' shopcard--lifted' : '') +
          (seen ? ' shopcard--seen' : '') +
          (busy !== null ? ' shopcard--busy' : '')
        }
        aria-busy={busy !== null}
      >
        {/* The waiting band. Absent when nothing is wrong — see the header. */}
        {band !== 'fresh' && <span className="shopcard__band" aria-hidden="true" />}

        <button
          /*
           * The drag layer's props go on FIRST so nothing below can be silently
           * shadowed by them: `onClick`, `aria-label` and the rest are this
           * card's own and must win.
           */
          {...(drag?.props ?? {})}
          type="button"
          ref={drag?.ref}
          className="shopcard__face"
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={`${spoken} ${moves.length} move${moves.length === 1 ? '' : 's'}. Enter for the moves, space to pick it up.`}
          data-order={order.id ?? ''}
          onClick={onToggleExpanded}
        >
          <span className="shopcard__top">
            {/* The handle, not the headline. Mono so a mistyped digit is visible. */}
            <span className="shopcard__number">{number}</span>
            {band !== 'fresh' && (
              /* Never colour alone: the word is the signal, the colour agrees. */
              <span className={`shopcard__age shopcard__age--${band}`}>
                {BAND_NOTE[band]} {waited}
              </span>
            )}
          </span>

          {/*
            EVERY PIECE OF CUSTOMER TEXT ON THIS CARD IS IN A `<bdi>`, and that
            is the name, the region and the product title — not just the one
            that looked risky. React escapes MARKUP; it does not touch
            U+202A–U+202E, and one address carrying RLO left bare reverses the
            run it sits in, which on a card whose next line is a money total is
            a total read back to front. `<bdi>` is `unicode-bidi: isolate`, so
            any embedding opened inside it is terminated at its own boundary and
            the damage cannot reach the row.
          */}
          <span className="shopcard__who">
            <bdi>{who}</bdi>
          </span>

          <span className="shopcard__where">
            <bdi className="shopcard__place">{region.label}</bdi>
            {region.code !== null && !region.confident && (
              <span
                className="shopcard__guess"
                title={`Worked out from “${region.rawCity ?? region.raw ?? ''}”, not stated`}
              >
                inferred
              </span>
            )}
          </span>

          <span className="shopcard__what">
            <bdi>{contents.first ?? 'Lines did not arrive'}</bdi>
            {contents.more > 0 && <span className="shopcard__more"> +{contents.more} more</span>}
          </span>
        </button>

        <div className="shopcard__foot">
          <span className="shopcard__total">{safeFormatMinor(order.grandTotal, order.currency)}</span>
          {money !== 'none' && (
            <span className={`chip chip--${money === 'refunded' ? 'refunded' : 'partially_refunded'}`}>
              {money === 'refunded' ? 'Refunded' : 'Partly refunded'}
            </span>
          )}
          <button
            type="button"
            className="shopcard__seen"
            aria-pressed={seen}
            /*
             * THE LABEL SAYS WHERE IT LIVES, IN THE ACCESSIBLE NAME AND NOT ONLY
             * IN A TOOLTIP. There is no acknowledgement column in the database
             * and this work adds no migration, so "Seen" is a note in this
             * browser and nothing else. An operator who reads it as a shared
             * state will assume a colleague can see it, and will stop telling
             * them.
             */
            aria-label={
              seen
                ? `Seen — a note stored in this browser only. Clear it for order ${number}.`
                : `Mark order ${number} seen. A note stored in this browser only; the shop never learns about it.`
            }
            title={
              seenPersists
                ? 'Stored in this browser. Not sent to the shop, and not visible on another device.'
                : 'This browser will not keep it — storage is unavailable, so it lasts until you reload.'
            }
            onClick={onToggleSeen}
          >
            {seen ? 'Seen' : 'Mark seen'}
          </button>
        </div>

        {/*
          NOT `role="status"`. The board has exactly one live region of its own
          and the drag layer has another; a third competing with both would be
          the card shouting over the sentence that explains it. `aria-busy` on
          the article already tells assistive tech the card is mid-change.
        */}
        {busy !== null && (
          <p className="shopcard__busy">
            {busy.needsDetail ? `${busy.label} — opening the order to find the parcel…` : `${busy.label}…`}
          </p>
        )}

        <div
          className={`shopcard__moves${expanded ? '' : ' shopcard__moves--shut'}`}
          id={panelId}
          hidden={!expanded}
        >
          {moves.map((move) => {
            const to = destinationLane(row, move.key, now);
            return (
              <button
                key={move.key}
                type="button"
                className={`shopcard__move${move.destructive ? ' shopcard__move--danger' : ''}`}
                disabled={busy !== null}
                onClick={() => onMove?.(move)}
              >
                <span className="shopcard__movehead">
                  <span className="shopcard__movelabel">{move.label}</span>
                  <span className="shopcard__movedest">
                    {to === lane ? `stays in ${COLUMN_LABEL[lane]}` : `→ ${COLUMN_LABEL[to]}`}
                  </span>
                </span>
                {/*
                  The hint is `pipeline.ts`'s own sentence, not a shorter one
                  written here, and `needs_detail` is said BEFORE the click
                  rather than explained by a spinner afterwards.
                */}
                <span className="shopcard__movehint">
                  {move.hint}
                  {move.cost === 'needs_detail' && ' This one opens the order first, so it is not instant.'}
                </span>
              </button>
            );
          })}

          {moves.length === 0 && (
            <p className="shopcard__nomoves">
              {lane === 'needs_attention'
                ? 'Nothing here can be acted on from this board — the order arrived in a shape this screen cannot address.'
                : 'Nothing is waiting on you for this one.'}
            </p>
          )}

          {withheld.length > 0 && (
            <p className="shopcard__nomoves">
              Only the owner can cancel an order, so that is not offered here.
            </p>
          )}
        </div>
      </article>
    </li>
  );
}
