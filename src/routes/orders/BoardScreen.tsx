import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import {
  safeFormatMinor,
  shopApi,
  type FulfillmentStatus,
  type ShopOrderRow,
} from '../../data/api-shop';
import { ApiError, NotFoundError, OfflineError } from '../../data/errors';
import { useSession } from '../../components/RequireAuth';
import { useToast } from '../../components/Toast';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import {
  COLUMN_LABEL,
  columnOf,
  planMove,
  type ColumnKey,
  type Move,
  type MovePlan,
  type Role,
} from './pipeline';
import {
  BOARD_LANES,
  OrdersBoard,
  legalTargets,
  projectMove,
  resolveDrop,
  type BoardLane,
  type LaneState,
  type OrdersBoardProps,
} from './Board';
import { BoardCard, recipientOf } from './BoardCard';
import './board.css';

/**
 * THE ORDERS SCREEN — the board, the drag layer that moves cards on it, and the
 * forms that are the only thing allowed to commit a move.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE OWNS AND WHAT IT REFUSES TO OWN.
 *
 * It owns INTERACTION: the `DndContext`, the three sensors, the optimistic patch
 * and its rollback, the dialogs, the local "seen" marker. It owns no rules.
 * Every lane comes from `columnOf`, every button from `movesFor`, every request
 * from `planMove`, every age from `ageBand`, every header total from
 * `summarise`, and what a release MEANS comes from `resolveDrop`. There is no
 * status→lane table here, no list of which role may cancel, and no route string.
 *
 * A DROP IS THE INTENT AND THE FORM IS THE ACT. `onDragEnd` never calls a
 * transition: it resolves the release to a move, checks it against the moves the
 * SERVER's guards allow, and opens that move's form or its confirmation. The
 * card renders in its old lane until the dialog succeeds. Abandon the dialog and
 * the card is already home. That is the whole reason this board cannot ship a
 * parcel nobody packed — `Board.tsx`'s header makes the argument in full.
 *
 * THE MENU IS THE DIFFERENT CASE, DELIBERATELY. A move opened from the card's
 * own list is a labelled button with a sentence under it, pressed on purpose, so
 * it obeys `Move.confirm` — `pipeline.ts`'s judgement about which moves deserve
 * a question — and `ship`/`deliver` go straight through. A DROP always asks,
 * because a release lands where the pointer was rather than where the eye was.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ────────────────────────────────────────────── the acknowledgement marker

/**
 * "SEEN" IS A NOTE IN THIS BROWSER, AND THE SCREEN SAYS SO EVERYWHERE IT SHOWS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * There is no acknowledgement column in `shop_orders` and this work adds no
 * migration, so there is nothing on the server to write it to. The choice is
 * therefore between a local marker that admits what it is and no marker at all —
 * and an operator with a queue of paid orders genuinely does need to record "I
 * know about this one". So: local, and labelled local in the button's own
 * accessible name, in its tooltip and in a line under the board. Not a tooltip
 * alone: an operator who reads it as shared state will assume a colleague can
 * see it and will stop telling them.
 *
 * WHY `localStorage` AND NOT `db.ts`. `src/data/db.ts` is Dexie, and its stores
 * are the writer's posts — cache scoped to a user plus a pre-backend library
 * that nothing may delete. An orders table there is a schema version bump in a
 * file this change does not own, for a set of ids that are worthless without
 * this device. `src/data/settings.ts` describes exactly this case in its own
 * header — "a handful of scalars… worthless without the device they were set
 * on" — so this follows that module's mechanism precisely: one JSON key, both
 * ends wrapped in `try`, a custom event for this tab and `storage` for the
 * others. It is NOT a field on `Settings`, because that object is a fixed set of
 * preferences and this is an unbounded set of order ids.
 *
 * IT DEGRADES TO NOTHING. A browser with storage disabled or full throws on
 * `setItem`; that is caught, the marks live in React state for the session, and
 * the card's tooltip stops promising they will survive a reload.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const TRIAGE_KEY = 'plaspool-admin:orders-seen';
const TRIAGE_EVENT = 'plaspool-admin:orders-seen-changed';
/** Oldest marks fall off first. An unbounded key is a quota error in a year. */
const TRIAGE_CAP = 500;

function readTriage(): string[] {
  try {
    const raw = localStorage.getItem(TRIAGE_KEY);
    if (raw === null || raw === '') return [];
    const parsed = JSON.parse(raw) as { ids?: unknown };
    if (!Array.isArray(parsed?.ids)) return [];
    return parsed.ids.filter((id): id is string => typeof id === 'string' && id !== '');
  } catch {
    // A hand-edited key, a quota error, a browser with storage switched off.
    // None of them is a reason for the board not to render.
    return [];
  }
}

/** `false` when this browser would not keep it. The caller says so on screen. */
function writeTriage(ids: readonly string[]): boolean {
  try {
    localStorage.setItem(
      TRIAGE_KEY,
      JSON.stringify({ ids: ids.slice(-TRIAGE_CAP), updatedAt: Date.now() }),
    );
  } catch {
    /*
     * THE EVENT IS NOT FIRED ON A FAILED WRITE, and that ordering is the whole
     * of the degradation. Every listener answers it by RE-READING the key, so
     * announcing a write that never landed makes each of them replace the mark
     * the operator just made with the empty storage underneath it — the button
     * flicks back to "Mark seen" and nothing says why. Failing quietly leaves
     * the mark in React state for the session, which is exactly what
     * `Triage.persists` then tells the operator they have.
     */
    return false;
  }
  try {
    window.dispatchEvent(new CustomEvent(TRIAGE_EVENT));
  } catch {
    // No event constructor is not a reason to lose a mark that did store.
  }
  return true;
}

export interface Triage {
  seen: ReadonlySet<string>;
  toggle: (orderId: string) => void;
  /** `false` once a write has been refused — the marks are session-only now. */
  persists: boolean;
}

export function useTriage(): Triage {
  const [ids, setIds] = useState<string[]>(() => readTriage());
  const [persists, setPersists] = useState(true);

  useEffect(() => {
    const sync = () => setIds(readTriage());
    window.addEventListener(TRIAGE_EVENT, sync);
    // `storage` fires for OTHER tabs, so a mark made in one is seen in the next.
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(TRIAGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const toggle = useCallback(
    (orderId: string) => {
      const next = ids.includes(orderId) ? ids.filter((id) => id !== orderId) : [...ids, orderId];
      setIds(next);
      if (!writeTriage(next)) setPersists(false);
    },
    [ids],
  );

  const seen = useMemo(() => new Set(ids), [ids]);
  return { seen, toggle, persists };
}

// ─────────────────────────────────────────────────────── running a move plan

/**
 * A refusal the operator can read as-is, raised by this file rather than by the
 * server. It exists for one case and it is a real one: `movesFor` offers "mark
 * shipped" from the LIST, which carries no fulfilment rows, so the parcel the
 * `read` step goes looking for may genuinely not be there. `pipeline.ts` calls
 * that "an ORDINARY ANSWER", and an ordinary answer deserves a sentence rather
 * than a PATCH against nothing.
 */
class MoveBlocked extends Error {}

/** `ShopOrders.tsx`'s own words for a parcel's state, so two screens agree. */
const PARCEL_LABEL: Record<FulfillmentStatus, string> = {
  pending: 'ready to ship',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

/** What the shipment form finally sends, over the plan's own default. */
export interface Shipment {
  lines: { orderLineId: string; qty: number }[];
  carrier: string | null;
  trackingNumber: string | null;
}

/**
 * The plan, executed. A switch over `call`, every branch a `shopApi` method — so
 * no route string appears in any component, exactly as `planMove`'s header asks.
 * `path` is carried on the plan for logs and tests and is never fetched.
 *
 * `shipment` OVERRIDES THE PLAN'S BODY FOR A SHIPMENT AND ONLY FOR ONE. The plan
 * describes the work ("everything outstanding"), which is the right default and
 * exactly what a drag can mean; the FORM describes what is actually in the box.
 * The lines it sends are a subset of the plan's, chosen from them — the operator
 * can ship fewer units, never units `packableOf` did not offer.
 */
async function runPlan(plan: MovePlan, shipment?: Shipment): Promise<void> {
  const bound: (string | null)[] = plan.steps.map(() => null);

  for (let i = 0; i < plan.steps.length; i += 1) {
    const step = plan.steps[i];

    if (step.kind === 'read') {
      const detail = await shopApi.getOrder(step.orderId);
      const parcels = Array.isArray(detail?.fulfillments) ? detail.fulfillments : [];
      const found = parcels.find(
        (parcel) =>
          parcel !== null && typeof parcel === 'object' && parcel.status === step.find.fulfillmentStatus,
      );
      if (found === undefined || typeof found.id !== 'string' || found.id === '') {
        throw new MoveBlocked(
          `This order has no parcel that is ${PARCEL_LABEL[step.find.fulfillmentStatus]}. ` +
            'The orders list carries no fulfilments, so the board offered the move without being able to check first.',
        );
      }
      bound[i] = found.id;
      continue;
    }

    if (step.call === 'createFulfillment') {
      await shopApi.createFulfillment(step.orderId, {
        lines: shipment?.lines ?? step.body.lines,
        carrier: shipment?.carrier ?? null,
        trackingNumber: shipment?.trackingNumber ?? null,
      });
      continue;
    }
    if (step.call === 'cancelOrder') {
      await shopApi.cancelOrder(step.orderId);
      continue;
    }

    const fulfillmentId = bound[step.fulfillmentId.index] ?? null;
    if (fulfillmentId === null) {
      throw new MoveBlocked('The board could not work out which parcel to change.');
    }
    await shopApi.setFulfillmentStatus(fulfillmentId, step.body.status);
  }
}

/**
 * Why it failed, in a sentence. Deliberately the same wordings as
 * `ShopOrders.tsx`'s own `explain`, which is not exported — see the report.
 */
function explainMove(err: unknown, move: Move): string {
  if (err instanceof MoveBlocked) return err.message;
  if (err instanceof OfflineError) return 'The request didn’t reach the server.';
  if (err instanceof NotFoundError) return 'This deployment has no order route yet.';
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Your account isn’t allowed to do that.';
    if (err.status === 409) {
      return 'Something else changed this order first — the card now shows what the server has.';
    }
    if (err.status === 429) return 'Too many changes too quickly — wait a moment and try again.';
    if (err.status === 400 && err.detail) return `The ${err.detail} wasn’t accepted.`;
  }
  return `“${move.label}” didn’t go through.`;
}

// ─────────────────────────────────────────────────────────────── the sensors

/**
 * ARROW KEYS MOVE BY A LANE, NOT BY 25 PIXELS.
 *
 * `KeyboardSensor`'s default coordinate getter translates the held card 25px per
 * press, which is correct for a sortable list of rows and useless across a rail
 * of 19rem lanes: reaching the next one is a dozen presses, and reaching the far
 * end of the rail is dozens. The sensor exposes `coordinateGetter` for exactly this, and
 * this is the whole of the customisation — there is no bespoke keyboard model
 * here, no key handler on a card, and no second idea of what "the next lane"
 * means. The rects come from the drag layer's own measurements, so the lane
 * under the card is the lane the collision detector will agree with.
 *
 * IT SNAPS TO THE NEAREST LANE RATHER THAN COUNTING FROM THE START, so a card
 * dragged with the pointer and then finished with the keyboard carries on from
 * where it visibly is.
 */
const laneCoordinateGetter: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  const step =
    event.code === 'ArrowRight' || event.code === 'ArrowDown'
      ? 1
      : event.code === 'ArrowLeft' || event.code === 'ArrowUp'
        ? -1
        : 0;
  if (step === 0) return undefined;
  event.preventDefault();

  const { collisionRect, droppableRects } = context;
  if (collisionRect === null || collisionRect === undefined) return undefined;

  const lanes = [...droppableRects.entries()]
    .filter(([id]) => (BOARD_LANES as readonly string[]).includes(String(id)))
    .map(([, rect]) => rect)
    .sort((a, b) => a.left - b.left);
  if (lanes.length === 0) return undefined;

  const centre = collisionRect.left + collisionRect.width / 2;
  let at = 0;
  let nearest = Number.POSITIVE_INFINITY;
  lanes.forEach((rect, index) => {
    const distance = Math.abs(rect.left + rect.width / 2 - centre);
    if (distance < nearest) {
      nearest = distance;
      at = index;
    }
  });

  const next = lanes[Math.min(lanes.length - 1, Math.max(0, at + step))];
  return { x: currentCoordinates.x + (next.left + next.width / 2 - centre), y: currentCoordinates.y };
};

// ──────────────────────────────────────────────────── the motion preference

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * DOES THIS OPERATOR WANT MOTION — ASKED NOW, AND ASKED AGAIN WHEN THEY CHANGE
 * THEIR MIND.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `tokens.css` flattens every CSS animation and transition in the app under
 * `prefers-reduced-motion: reduce`, with `!important`, and that covers
 * everything this board draws except one thing: `DragOverlay` settles a dropped
 * card with `Element.animate()`. A WAAPI animation carries its own timing in
 * JavaScript, so NO stylesheet can reach it — measured under the reduce
 * override with the CSS transition and the lane notice correctly gone and one
 * animation still running, `duration 250, easing "ease", fill "forwards"`,
 * `translate3d(294px,0,0) → translate3d(0,0,0)` on the overlay wrapper, on
 * every drop and every escape. The only lever is the library's own
 * `dropAnimation`, and reaching it means reading the preference in JavaScript.
 *
 * A LISTENER, NOT A ONE-SHOT READ. `matchMedia(…).matches` evaluated once at
 * module load is a build-time constant in everything but name, and the moment
 * it is wrong is the moment that matters: somebody turns this setting on
 * BECAUSE something on screen has started to hurt, mid-shift, and a board that
 * only believes them after a reload has refused the request exactly when it was
 * made. One subscription for the life of the board answers it in the same
 * frame, and answers it in both directions.
 *
 * GUARDED, for the reason `Sidebar.tsx` guards its own: jsdom ships no
 * `matchMedia`, and an unguarded call inside a passive effect throws and takes
 * the whole board to the router's error page. `false` is the right initial
 * answer for an environment that cannot express a preference — it is what a
 * browser with the setting untouched reports too.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(REDUCED_MOTION).matches;
  });

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(REDUCED_MOTION);
    const onChange = () => setReduce(mq.matches);
    // Read once on the way in as well: the setting can have changed between the
    // first render's initialiser and this effect, and on a slow first paint of
    // a board of fifty cards that gap is not theoretical.
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduce;
}

// ────────────────────────────────────────────────────────── the drop targets

/**
 * One `useDroppable` per lane, written out rather than mapped — `BOARD_LANES` is
 * a fixed list and a hook in a loop is a lint error waiting for the day it is
 * not.
 *
 * ⚠️  THE NODE IS THE POINT, AND IT IS WHAT `ReturnsScreen.tsx` IS MISSING.
 *     That screen registers each column with `useDroppable({ id })` inside a
 *     component that returns `null`, and never passes `columnRef` to
 *     `ReturnsBoard` — so no droppable there has a DOM node, every rect is
 *     `null`, the collision detector matches nothing, and `event.over` is always
 *     `null`. The returns board's drag cannot complete a drop. Reported rather
 *     than fixed here; this file wires the refs through.
 *
 * ⚠️  AND IT HAS TO BE CALLED FROM INSIDE THE `DndContext`, which is why the
 *     wrapper below exists rather than this being called at the top of the
 *     screen. `useDroppable` reads the drag layer's internal context to register
 *     itself; called from the component that RENDERS `<DndContext>`, it reads
 *     the default context instead, registers with nobody, and every lane is
 *     silently unmeasured — measured here as `droppableRects: []` with the drag
 *     otherwise working perfectly, which is the same shape of failure as the
 *     returns board's.
 */
function useLaneDroppables(): (lane: BoardLane) => (node: HTMLElement | null) => void {
  /*
   * THERE IS NO `awaiting_payment` DROPPABLE, because there is no lane for it to
   * be. `BoardLane` is what actually enforces that — a `Record<BoardLane, …>`
   * cannot carry the key and `columnRef` cannot be asked for it — and this list
   * simply has nothing left to say about it.
   *
   * Leaving the `useDroppable` call in would have been inert rather than
   * dangerous, and that is measured rather than assumed: a droppable whose ref
   * reaches no node is never given a rect, so it is absent from
   * `droppableRects`, invisible to `closestCenter` and unreachable by the arrow
   * keys — the same dead registration the warning below describes on the returns
   * board. Inert is not a guarantee, which is why the guarantee is a type.
   */
  const toPack = useDroppable({ id: 'to_pack' });
  const packing = useDroppable({ id: 'packing' });
  const checkParcel = useDroppable({ id: 'check_parcel' });
  const shipped = useDroppable({ id: 'shipped' });
  const closed = useDroppable({ id: 'closed' });
  const needsAttention = useDroppable({ id: 'needs_attention' });

  const refs: Record<BoardLane, (node: HTMLElement | null) => void> = {
    to_pack: toPack.setNodeRef,
    packing: packing.setNodeRef,
    check_parcel: checkParcel.setNodeRef,
    shipped: shipped.setNodeRef,
    closed: closed.setNodeRef,
    needs_attention: needsAttention.setNodeRef,
  };
  return (lane) => refs[lane];
}

/** The arrangement, with every lane registered as a drop target. Rendered as a
 *  CHILD of `<DndContext>` — see the warning above. */
function DroppableLanes(props: Omit<OrdersBoardProps, 'columnRef'>) {
  const columnRef = useLaneDroppables();
  return <OrdersBoard {...props} columnRef={columnRef} />;
}

// ──────────────────────────────────────────────────────────── one held card

/**
 * One card, wired for drag. Split out so `OrdersBoard` stays a presentational
 * arrangement a test can render without a `DndContext`.
 *
 * The library's ref and props go to the card's FACE — one focusable element per
 * card, which `BoardCard.tsx`'s header argues at length.
 */
function DraggableCard({
  row,
  cardId,
  lane,
  now,
  role,
  expanded,
  busy,
  seen,
  seenPersists,
  onToggleExpanded,
  onToggleSeen,
  onMove,
}: {
  row: ShopOrderRow;
  cardId: string;
  lane: ColumnKey;
  now: number;
  role: Role;
  expanded: boolean;
  busy: null | { label: string; needsDetail: boolean };
  seen: boolean;
  seenPersists: boolean;
  onToggleExpanded: () => void;
  onToggleSeen: () => void;
  onMove: (move: Move) => void;
}) {
  const orderId = row?.order?.id;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: cardId,
    /* A row with no id can be drawn and cannot be addressed — there is no
     * shipment to create and no cancel to post — so it is not draggable either.
     * Same for one already mid-write: a second drag would race its own patch. */
    disabled: typeof orderId !== 'string' || orderId === '' || busy !== null,
  });

  return (
    <BoardCard
      row={row}
      now={now}
      role={role}
      lane={lane}
      expanded={expanded}
      held={isDragging}
      busy={busy}
      seen={seen}
      seenPersists={seenPersists}
      onToggleExpanded={onToggleExpanded}
      onToggleSeen={onToggleSeen}
      onMove={onMove}
      drag={{ ref: setNodeRef, props: { ...attributes, ...listeners } }}
    />
  );
}

// ───────────────────────────────────────────────────────── the shipment form

/**
 * WHAT GOES IN THE BOX — the form a drop cannot fill in, which is the entire
 * reason a drop is not allowed to finish the move.
 *
 * The lines and their ceilings come from `planMove`'s own `createFulfillment`
 * body, which is `packableOf`'s answer: lines a parcel can actually name, each
 * with the units nothing holds yet. So the maximum is `pipeline.ts`'s number and
 * not a second subtraction written here that would agree with it today.
 *
 * OVER THE CEILING IS REFUSED RATHER THAN CLAMPED. Quietly shipping 2 when the
 * operator typed 5 is the board deciding what is in a box it cannot see;
 * `shop_order_lines_fulfilled_ck` would refuse the 5 anyway, and being told
 * which line is wrong beats a 409 with no field named.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY REFUSAL IS ATTACHED, ANNOUNCED, AND SURVIVABLE FROM A KEYBOARD.
 *
 * Three separate things, and the form used to do none of them. It set
 * `aria-invalid` on the field and rendered the explanation as a bare `<p>` with
 * no id, so nothing tied the two together: a screen reader said "invalid entry"
 * and stopped, on a dialog that creates a shipment. So:
 *
 *  1. **Attached.** Each message has an id, each field points at the one that
 *     is about IT — the ceiling message or the whole-number message, never
 *     both — through `aria-describedby`. That is also why the two messages are
 *     now independent instead of one hiding the other: an `aria-describedby`
 *     pointing at a paragraph that a sibling error has suppressed resolves to
 *     nothing, and a line with an unreadable quantity was silent whenever
 *     another line was over its ceiling.
 *
 *  2. **Announced.** ONE polite live region, and it is the summary line that
 *     was already there rather than a fourth `role="alert"`. That is not
 *     tidiness: an alert is assertive and this text changes on every keystroke,
 *     so a reading of the field would be interrupted by the message ABOUT the
 *     field, over and over, while the operator was still typing. The summary
 *     line is a node that exists before the first error does, which is the
 *     other half of why a live region works at all.
 *
 *  3. **Survivable.** The submit is `aria-disabled` rather than `disabled`
 *     while the form is blocked. `disabled` removes it from the tab order, so
 *     the reason it will not fire — now its own `aria-describedby` — is bolted
 *     to a control a keyboard operator can never reach; the measured result was
 *     "invalid entry" and then a button that does nothing, with no route to
 *     either explanation. Kept reachable, it says why, and pressing it moves
 *     focus to the field that is actually wrong instead of silently declining.
 *     `busy` stays a real `disabled`, because a request already in flight is
 *     not something the operator can act on at all.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function ShipmentForm({
  row,
  plannedLines,
  busy,
  onSubmit,
  onCancel,
}: {
  row: ShopOrderRow;
  plannedLines: readonly { orderLineId: string; qty: number }[];
  busy: boolean;
  onSubmit: (shipment: Shipment) => void;
  onCancel: () => void;
}) {
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(plannedLines.map((line) => [line.orderLineId, String(line.qty)])),
  );
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');

  const ids = useId();
  const ceilingId = `${ids}-ceiling`;
  const wholeId = `${ids}-whole`;
  const statusId = `${ids}-status`;
  /** Stable per line, so a refusal can send focus at the field it is about. */
  const fieldId = (orderLineId: string) => `${ids}-qty-${orderLineId}`;

  const titles = new Map((row?.lines ?? []).map((line) => [line.id, line]));

  const typed = plannedLines.map((line) => {
    const raw = (qty[line.orderLineId] ?? '').trim();
    const n = raw === '' ? 0 : Number.parseInt(raw, 10);
    return { orderLineId: line.orderLineId, max: line.qty, n: Number.isFinite(n) ? n : Number.NaN };
  });
  const overCeiling = typed.filter((line) => Number.isFinite(line.n) && line.n > line.max);
  const unreadable = typed.filter((line) => !Number.isFinite(line.n) || line.n < 0);
  const picked = typed.filter((line) => Number.isFinite(line.n) && line.n > 0 && line.n <= line.max);
  const units = picked.reduce((n, line) => n + line.n, 0);
  const blocked = overCeiling.length > 0 || unreadable.length > 0 || picked.length === 0;

  /*
   * WHY THE SUBMIT WILL NOT FIRE — WHICH IS NOT THE SAME SENTENCE AS THE ONE
   * ABOUT THE FIELD, and must not be. The paragraphs below explain what is
   * wrong with a quantity; this line explains what that does to the BUTTON, and
   * it is the button's own `aria-describedby`. Written as a restatement it read
   * as two near-identical sentences side by side on screen — the fault said
   * twice and the consequence said never.
   *
   * The empty-selection case is not an error and never was: it is the state a
   * freshly opened form sits in, so it shares this line rather than turning the
   * panel red.
   */
  const refusal =
    overCeiling.length > 0
      ? 'Not ready to ship: a quantity is above what the order still owes.'
      : unreadable.length > 0
        ? 'Not ready to ship: a quantity is not a whole number.'
        : picked.length === 0
          ? 'Enter at least one quantity to ship.'
          : null;

  /** Where a refused submit sends the operator: the first field at fault. */
  const firstFault =
    overCeiling[0]?.orderLineId ?? unreadable[0]?.orderLineId ?? plannedLines[0]?.orderLineId ?? null;

  return (
    <div className="shopform">
      <div className="dtable__scroll">
        <table className="dtable shopform__lines">
          <thead>
            <tr>
              <th scope="col">Line</th>
              <th scope="col" className="dtable__num">
                Not yet packed
              </th>
              <th scope="col" className="dtable__num">
                In this parcel
              </th>
            </tr>
          </thead>
          <tbody>
            {plannedLines.map((line) => {
              const detail = titles.get(line.orderLineId);
              const state = typed.find((t) => t.orderLineId === line.orderLineId);
              const over = Number.isFinite(state?.n ?? Number.NaN) && (state?.n ?? 0) > line.qty;
              /* The same test `unreadable` runs, asked about this one row so the
               * field can point at the message that is about IT. */
              const notWhole = !Number.isFinite(state?.n ?? Number.NaN) || (state?.n ?? 0) < 0;
              return (
                <tr key={line.orderLineId}>
                  <td>
                    {/* A product title is text somebody typed into the catalogue;
                        it is isolated for the same reason the card's is. */}
                    <bdi className="dtable__strong">{detail?.title ?? 'This line'}</bdi>
                    {detail?.sku !== undefined && detail.sku !== '' && (
                      <span className="dtable__sub">{detail.sku}</span>
                    )}
                  </td>
                  <td className="dtable__num shopform__ceiling">{line.qty}</td>
                  <td className="dtable__num">
                    <input
                      id={fieldId(line.orderLineId)}
                      className="input shopform__qty"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={line.qty}
                      step={1}
                      value={qty[line.orderLineId] ?? ''}
                      aria-label={`Units of ${detail?.title ?? 'this line'} in this parcel, at most ${line.qty}`}
                      aria-invalid={over || notWhole}
                      aria-describedby={over ? ceilingId : notWhole ? wholeId : undefined}
                      onChange={(event) =>
                        setQty((prev) => ({ ...prev, [line.orderLineId]: event.target.value }))
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="shopform__split">
        <div className="shopform__field">
          <label className="label" htmlFor="shipment-carrier">
            Carrier
          </label>
          <input
            id="shipment-carrier"
            className="input"
            value={carrier}
            maxLength={300}
            placeholder="Optional"
            onChange={(event) => setCarrier(event.target.value)}
          />
        </div>
        <div className="shopform__field">
          <label className="label" htmlFor="shipment-tracking">
            Tracking number
          </label>
          <input
            id="shipment-tracking"
            className="input"
            value={tracking}
            maxLength={300}
            placeholder="Optional"
            onChange={(event) => setTracking(event.target.value)}
          />
        </div>
      </div>

      {/*
        BOTH MESSAGES CAN STAND AT ONCE. The first version showed the
        whole-number one only when no line was over its ceiling, which read as
        tidy and meant a line typed as `x` went unmentioned — and, once the
        fields point at these paragraphs by id, unmentioned becomes undescribed.
        Each error is now about its own fault and appears exactly when that
        fault does.
      */}
      {overCeiling.length > 0 && (
        <p className="shopform__error" id={ceilingId}>
          {overCeiling.length === 1 ? 'One line asks' : `${overCeiling.length} lines ask`} for more
          units than are still unpacked. A parcel cannot hold more than the order owes.
        </p>
      )}
      {unreadable.length > 0 && (
        <p className="shopform__error" id={wholeId}>
          Quantities have to be whole numbers, zero or more.
        </p>
      )}

      <div className="shopform__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          aria-disabled={blocked || undefined}
          aria-describedby={blocked ? statusId : undefined}
          onClick={() => {
            if (blocked) {
              /* Not a no-op. The button says why it is refusing, and pressing
               * it anyway takes the operator to the field that is wrong — which
               * is the question anybody who pressed it was asking. */
              if (firstFault !== null) document.getElementById(fieldId(firstFault))?.focus();
              return;
            }
            onSubmit({
              lines: picked.map((line) => ({ orderLineId: line.orderLineId, qty: line.n })),
              carrier: carrier.trim() === '' ? null : carrier.trim(),
              trackingNumber: tracking.trim() === '' ? null : tracking.trim(),
            });
          }}
        >
          Create shipment
        </button>
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        {/*
          THE ONE LIVE REGION IN THIS DIALOG, and it is this line because this
          line is always here. A region that arrives together with its first
          message is a region half the screen readers that matter never
          announce; this one exists from the moment the form opens and only its
          text changes. `polite`, never `alert`, because it changes on every
          keystroke — see the header.
        */}
        <span
          className="shopform__hint"
          id={statusId}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {refusal ??
            `${units} item${units === 1 ? '' : 's'} across ${picked.length} line${
              picked.length === 1 ? '' : 's'
            }.`}
        </span>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────── the screen

/** What a dialog is currently asking about. `seq` remounts the form so a second
 *  attempt starts clean rather than carrying the first one's typing. */
type Pending =
  | { kind: 'shipment'; row: ShopOrderRow; move: Move; lines: { orderLineId: string; qty: number }[]; seq: number }
  | { kind: 'confirm'; row: ShopOrderRow; move: Move; dropped: ColumnKey | null; seq: number };

const EMPTY_PATCH: ReadonlyMap<string, ShopOrderRow> = new Map();
const NO_INFLIGHT: ReadonlyMap<string, { label: string; needsDetail: boolean }> = new Map();

export interface BoardScreenProps {
  /**
   * The page of orders the route already fetched, exactly as
   * `GET /shop/admin/orders` sent it. The screen never mutates this array; a
   * move is held as a patch beside it until the server answers.
   */
  rows: readonly ShopOrderRow[];
  /** The instant the board is drawn at, epoch ms. Passed in, never read from a
   *  clock — see `OrdersBoardProps.now`. */
  now: number;
  /** Fired with an order's id once a move has settled against the server. */
  onMoved?: (orderId: string) => void;
  /** Which lanes to draw. The orders console passes `MOTION_LANES` so terminal
   *  orders fall through to the Closed tab; defaults to every lane. */
  lanes?: readonly BoardLane[];
  /**
   * Reload the whole page of orders. Offered in a toast in the one case the
   * board cannot resolve on its own — a write that succeeded and a re-read that
   * did not, which leaves one card showing a guess.
   */
  onReload?: () => void;
}

export function BoardScreen({ rows, now, onMoved, onReload, lanes }: BoardScreenProps) {
  const session = useSession();
  /*
   * LEAST PRIVILEGE, and `writer` is the answer to every question that is not a
   * confirmed owner — an unknown or offline session included. `movesFor` then
   * withholds `cancel` rather than disabling it, because `POST /orders/:id/
   * cancel` is `requireOwner()` while every fulfilment route is `requireAuth()`.
   */
  const role: Role = session.status === 'authed' && session.user.role === 'owner' ? 'owner' : 'writer';

  const { notify } = useToast();
  const triage = useTriage();
  const reduceMotion = usePrefersReducedMotion();

  /*
   * THE OPTIMISTIC PATCH, KEYED BY ORDER ID, BESIDE THE PROP RATHER THAN OVER IT.
   * `source` is how a fresh page from the parent throws the patch away: props
   * are the truth, and the moment the route hands over a newer array, anything
   * this board was guessing about is stale by definition.
   */
  const [patch, setPatch] = useState<{
    source: readonly ShopOrderRow[];
    map: ReadonlyMap<string, ShopOrderRow>;
  }>({ source: rows, map: EMPTY_PATCH });
  if (patch.source !== rows) setPatch({ source: rows, map: EMPTY_PATCH });

  const [inflight, setInflight] =
    useState<ReadonlyMap<string, { label: string; needsDetail: boolean }>>(NO_INFLIGHT);
  /*
   * The SAME guard as `inflight`, one tick earlier. `inflight` is state, so two
   * moves fired in one tick — a double Enter, a keyboard commit racing a drop —
   * both read it as empty and both post. On a surface that creates shipments and
   * cancels orders that is a duplicate write, so the ref is what actually
   * refuses and the state is what the card renders.
   */
  const running = useRef(new Set<string>());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [held, setHeld] = useState<{ row: ShopOrderRow; from: ColumnKey } | null>(null);
  const [over, setOver] = useState<ColumnKey | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [live, setLive] = useState('');
  const seq = useRef(0);

  const boardRef = useRef<HTMLDivElement | null>(null);
  const [refocus, setRefocus] = useState<{
    orderId: string;
    token: number;
    /** Focus was in the board when the move started. See the effect below. */
    wasInside: boolean;
  } | null>(null);
  const token = useRef(0);

  const effective = useMemo(
    () => rows.map((row) => patch.map.get(row.order?.id ?? '') ?? row),
    [rows, patch],
  );

  const rowOf = useCallback(
    (id: string) => effective.find((row) => row.order?.id === id) ?? null,
    [effective],
  );

  const announce = useCallback((message: string) => setLive(message), []);

  /**
   * Put focus back on the card after it has moved lane.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * A CARD CHANGING LANE IS A DIFFERENT `<li>` IN A DIFFERENT `<ul>`, so React
   * unmounts the node the operator was standing on and mounts a new one. The
   * browser answers that by moving focus to `<body>` — which means a keyboard
   * operator who moves one card is returned to the top of the document and has
   * to tab back through the whole board to move the next one.
   *
   * THE GUARD IS TAKEN BEFORE THE MOVE, NOT AFTER IT, and that is the part that
   * has to be right. "Is focus in the board now?" is asked in the same event
   * handler as the state change, while the old node is still mounted and still
   * focused. Asking afterwards cannot distinguish the two cases this exists to
   * separate: focus is on `<body>` both when our own unmount blurred it and when
   * the operator deliberately tabbed away to the search box — and yanking it
   * back in the second case is worse than losing it in the first.
   *
   * THE CARD IS FOUND BY `data-order` RATHER THAN BY A REF MAP, because the face
   * already carries one and the drag layer already owns that node's ref. Two
   * refs on one element is a merge nobody needs.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  useEffect(() => {
    if (refocus === null || !refocus.wasInside) return;
    const board = boardRef.current;
    const active = document.activeElement;
    // Still ours, or blurred to nothing by our own re-render. Anywhere else is
    // somewhere the operator chose to be.
    const mine = active === null || active === document.body || board?.contains(active) === true;
    if (!mine) return;
    /*
     * MATCHED IN JAVASCRIPT, NOT IN A SELECTOR. An order id interpolated into
     * `[data-order="…"]` is a selector-injection waiting for the first id with a
     * quote in it, and the usual guard — `CSS.escape` — is not present in every
     * environment this suite runs in (jsdom does not implement `CSS` at all, so
     * the effect threw and React tore the tree down). Comparing the attribute is
     * both safe and total.
     */
    const faces = board === null ? [] : [...board.querySelectorAll<HTMLElement>('.shopcard__face')];
    faces.find((node) => node.getAttribute('data-order') === refocus.orderId)?.focus();
  }, [refocus, effective]);

  const wantFocus = useCallback((orderId: string) => {
    const board = boardRef.current;
    const wasInside = board === null || board.contains(document.activeElement);
    token.current += 1;
    setRefocus({ orderId, token: token.current, wasInside });
  }, []);

  // ────────────────────────────────────────────────────────── performing a move

  const settle = useCallback(async (orderId: string): Promise<boolean> => {
    try {
      const detail = await shopApi.getOrder(orderId);
      setPatch((prev) => ({
        source: prev.source,
        map: new Map(prev.map).set(orderId, {
          order: detail.order,
          lines: Array.isArray(detail.lines) ? detail.lines : [],
        }),
      }));
      return true;
    } catch {
      return false;
    }
  }, []);

  const execute = useCallback(
    async (row: ShopOrderRow, move: Move, shipment?: Shipment) => {
      const orderId = row.order?.id;
      if (typeof orderId !== 'string' || orderId === '') return;
      if (running.current.has(orderId)) return;
      running.current.add(orderId);

      const from = columnOf(row);
      const number = row.order?.orderNumber ?? orderId;

      /*
       * `planMove` IS ASKED AGAIN WITH THE ROLE, though `movesFor` already
       * screened it. Two checks of one rule cost a parameter; one check costs an
       * owner-only call behind a writer's keyboard shortcut — `planMove`'s own
       * header makes the argument, and this is the caller it was written for.
       */
      const plan = planMove(row, move.key, role);
      if (plan === null) {
        running.current.delete(orderId);
        const reason =
          'That is no longer possible for this order — it has moved on since the board drew it.';
        notify(reason, { tone: 'danger' });
        announce(`Order ${number} stayed in ${COLUMN_LABEL[from]}. ${reason}`);
        void settle(orderId);
        return;
      }

      const before = patch.map.get(orderId) ?? null;

      setInflight((prev) =>
        new Map(prev).set(orderId, { label: move.label, needsDetail: plan.needsDetail }),
      );
      // The card moves NOW. Everything below is about putting it back if the
      // server disagrees.
      const projected = projectMove(row, move.key, now, shipment?.lines);
      setPatch((prev) => ({ source: prev.source, map: new Map(prev.map).set(orderId, projected) }));
      setPending(null);
      setExpanded(null);
      wantFocus(orderId);

      const to = columnOf(projected);
      announce(
        to === from
          ? `${move.label} for order ${number}. It stays in ${COLUMN_LABEL[from]}.`
          : `Moving order ${number} to ${COLUMN_LABEL[to]}.`,
      );

      try {
        await runPlan(plan, shipment);
        const reread = await settle(orderId);
        if (reread) {
          announce(`Order ${number}: ${move.label} done.`);
          notify(`${move.label} — done.`);
        } else {
          /*
           * THE ONE CASE THIS BOARD CANNOT RESOLVE ITSELF: the write landed and
           * the re-read did not, so the card is showing a projection nothing has
           * confirmed. Rolling back would be a worse lie than keeping it — the
           * move DID happen — so the card stays and the operator is told to
           * reload rather than left to assume.
           */
          announce(
            `Order ${number}: ${move.label} went through, but the board could not re-read it.`,
          );
          notify(
            `${move.label} went through. The board couldn’t re-read the order — reload to be sure.`,
            {
              tone: 'danger',
              action: onReload === undefined ? undefined : { label: 'Reload', run: onReload },
            },
          );
        }
        onMoved?.(orderId);
      } catch (err) {
        // Back where it was, and the reason said out loud. A card that springs
        // back with no explanation reads as a broken board.
        setPatch((prev) => {
          const map = new Map(prev.map);
          if (before === null) map.delete(orderId);
          else map.set(orderId, before);
          return { source: prev.source, map };
        });
        const reason = explainMove(err, move);
        notify(reason, { tone: 'danger' });
        announce(`Order ${number} stayed in ${COLUMN_LABEL[from]}. ${reason}`);
        /*
         * A CONFLICT IS REFETCHED, NEVER RETRIED. The server does
         * compare-and-swap on `revision`; a 409 means this board's copy of the
         * order is behind, so asking the same question again asks it with the
         * same stale premise. Re-reading the one order that lost is the only
         * move that can be right.
         */
        if (err instanceof ApiError && err.status === 409) void settle(orderId);
        wantFocus(orderId);
      } finally {
        running.current.delete(orderId);
        setInflight((prev) => {
          const map = new Map(prev);
          map.delete(orderId);
          return map;
        });
      }
    },
    [role, notify, announce, settle, patch, now, wantFocus, onMoved, onReload],
  );

  /**
   * THE ONE DOOR EVERY MOVE GOES THROUGH, whether it was dragged or clicked.
   *
   * `via` is the only thing the two paths disagree about, and the disagreement is
   * the point: a drop always asks, a menu entry obeys `Move.confirm`. See the
   * file header.
   */
  const openMove = useCallback(
    (row: ShopOrderRow, move: Move, via: 'drop' | 'menu', dropped: ColumnKey | null = null) => {
      const plan = planMove(row, move.key, role);
      if (plan === null) {
        const number = row.order?.orderNumber ?? row.order?.id ?? '';
        const reason =
          'That is no longer possible for this order — it has moved on since the board drew it.';
        notify(reason, { tone: 'danger' });
        announce(`Order ${number} did not move. ${reason}`);
        if (typeof row.order?.id === 'string' && row.order.id !== '') void settle(row.order.id);
        return;
      }

      seq.current += 1;

      /*
       * A SHIPMENT IS THE FORM CASE AND THE ONLY ONE. Its first step is the
       * `createFulfillment` write, and that step's body is `packableOf`'s answer
       * — the lines a parcel may name and the units nothing holds yet. The form
       * starts from exactly that rather than subtracting again.
       */
      if (move.key === 'pack') {
        const step = plan.steps[0];
        const lines =
          step !== undefined && step.kind === 'write' && step.call === 'createFulfillment'
            ? step.body.lines
            : [];
        if (lines.length === 0) {
          notify('There is nothing left to pack on this order.', { tone: 'danger' });
          return;
        }
        setPending({ kind: 'shipment', row, move, lines, seq: seq.current });
        return;
      }

      if (move.confirm || via === 'drop') {
        setPending({ kind: 'confirm', row, move, dropped: via === 'drop' ? dropped : null, seq: seq.current });
        return;
      }

      void execute(row, move);
    },
    [role, notify, announce, settle, execute],
  );

  // ─────────────────────────────────────────────────────────────── the drag

  /**
   * POINTER, TOUCH AND KEYBOARD — all three, from one API.
   *
   * The keyboard sensor is not a nicety: this board replaced a table that was
   * fully operable from a keyboard, and a board that needs a mouse would be a
   * regression for anybody who worked the old one at speed. The touch sensor
   * carries a DELAY so a scroll gesture on a phone — and on a phone a lane is
   * most of the screen, so scrolling is what a thumb mostly does here — is not
   * read as a drag.
   *
   * `start` IS SPACE ALONE, WHICH IS THE ONE DEPARTURE FROM THE DEFAULTS.
   * `KeyboardSensor` starts on Space OR Enter out of the box, and Enter is what
   * opens a card's move list — the COMPLETE path, the one that reaches the moves
   * no lane can express ("pack what is left", "mark delivered"). Left at the
   * default, pressing Enter on a card would pick it up instead, and those moves
   * would be unreachable from a keyboard. `end` keeps its defaults, so Enter and
   * Space both drop and Tab does not strand a card in mid-air.
   */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: laneCoordinateGetter,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter', 'Tab'] },
    }),
  );

  const legal = useMemo(
    () => (held === null ? [] : legalTargets(held.row, role, now)),
    [held, role, now],
  );

  function onDragStart(event: DragStartEvent): void {
    const row = rowOf(String(event.active.id));
    setExpanded(null);
    setOver(null);
    settled.current = false;
    setHeld(row === null ? null : { row, from: columnOf(row) });
  }

  /**
   * THE DRAG CONTRACT. This never calls a transition.
   *
   * It resolves the release to `(row, lane)`, asks `resolveDrop` — which asks
   * `movesFor`, which mirrors the server's guards — and opens whatever came
   * back. The card renders in its old lane until that dialog succeeds.
   */
  function onDragEnd(event: DragEndEvent): void {
    const current = held;
    setHeld(null);
    setOver(null);
    if (current === null || event.over === null) return;

    const target = String(event.over.id) as ColumnKey;
    /*
     * THE ROW IS RE-READ AT THE RELEASE, not taken from the snapshot the pick-up
     * captured. A drag lasts a second or two and a `settle` from an earlier move
     * can land inside it, which would leave this deciding what a release means
     * from an order the board has since replaced. The snapshot is only the
     * fallback, for the row that has left the page entirely while it was in hand.
     */
    const row = rowOf(String(event.active.id)) ?? current.row;
    const outcome = resolveDrop(row, target, role, now);
    const number = row.order?.orderNumber ?? '';

    if (outcome.kind === 'noop') {
      announce(`Order ${number} put back in ${COLUMN_LABEL[current.from]}.`);
      return;
    }
    if (outcome.kind === 'refused') {
      /* The card springs back WITH A LINE SAYING WHICH RULE STOPPED IT. A card
       * that refuses a drop silently reads as a broken board. */
      notify(outcome.reason, { tone: 'danger' });
      announce(`Order ${number} stayed in ${COLUMN_LABEL[current.from]}. ${outcome.reason}`);
      return;
    }
    openMove(row, outcome.move, 'drop', target);
  }

  /**
   * The drag layer's own narration, in this board's words rather than "Draggable
   * item 3 was moved over droppable area to_pack".
   *
   * `settled` IS THE FIX FOR A DUPLICATE THE FIRST VERSION SHIPPED. Collision
   * detection answers the moment a card is picked up, so `onDragOver` fires
   * immediately with the card's OWN lane and overwrote the pick-up sentence in
   * the same live region — a screen reader announcing only the latest would
   * read "To pack — where it already is" and never say what was picked up or
   * where it can go. The first over event is therefore silent when it says
   * nothing new; arrowing back home later still announces, because by then the
   * sentence is news.
   */
  const settled = useRef(false);
  const announcements: Announcements = useMemo(() => {
    const name = (id: unknown): string => {
      const row = rowOf(String(id));
      return row === null ? 'this order' : `order ${row.order?.orderNumber ?? ''}`;
    };
    const verdict = (activeId: unknown, overId: unknown): string => {
      const row = rowOf(String(activeId));
      if (row === null || overId === undefined || overId === null) return '';
      const lane = String(overId) as ColumnKey;
      const outcome = resolveDrop(row, lane, role, now);
      if (outcome.kind === 'noop') return `${COLUMN_LABEL[lane]} — where it already is.`;
      if (outcome.kind === 'refused') return `${COLUMN_LABEL[lane]} — ${outcome.reason}`;
      return `${COLUMN_LABEL[lane]} — ${outcome.move.label}.`;
    };
    return {
      onDragStart: ({ active }) => {
        const row = rowOf(String(active.id));
        const targets = row === null ? [] : legalTargets(row, role, now);
        return (
          `Picked up ${name(active.id)}. ` +
          (targets.length === 0
            ? 'No lane will take it — press escape, then enter, for what can be done to it.'
            : `Left and right arrows choose a lane: ${targets
                .map((lane) => COLUMN_LABEL[lane])
                .join(', ')}. Enter opens the move; escape puts it back.`)
        );
      },
      onDragOver: ({ active, over: target }) => {
        const first = !settled.current;
        settled.current = true;
        const said = verdict(active.id, target?.id);
        return first && said.endsWith('where it already is.') ? undefined : said;
      },
      onDragEnd: ({ active, over: target }) =>
        target === null || target === undefined
          ? `${name(active.id)} put back.`
          : verdict(active.id, target.id),
      onDragCancel: ({ active }) => `${name(active.id)} put back.`,
    };
  }, [rowOf, role, now]);

  // ────────────────────────────────────────────────────────────────── render

  const laneState = (lane: BoardLane): LaneState | null => {
    if (held === null) return null;
    /*
     * THE CARD'S OWN LANE IS NEITHER AN OFFER NOR A REFUSAL, whether or not the
     * card is currently over it. Dimming it would tell the operator that putting
     * the card back is illegal, which is the one thing a drag must always allow;
     * outlining it would offer a move that does not exist — and since collision
     * detection answers the instant a card is picked up, the outline would fire
     * on every pick-up and the lane you started in would glow as if it were a
     * destination. Quiet is the honest state, and "no lane is outlined" is
     * exactly what "you are back where you started" looks like.
     */
    if (lane === held.from) return null;
    if (over === lane) return legal.includes(lane) ? 'over' : 'illegal';
    return legal.includes(lane) ? 'legal' : 'illegal';
  };

  return (
    <div className="shopboard" ref={boardRef}>
      {/*
        The live region for what a MOVE did. `role="status"` is implicitly
        polite; both are written because a bare `aria-live` on a node React
        re-renders is the version that goes quiet in half the screen readers
        that matter. The drag itself is narrated by the drag layer's own region
        through `announcements` above — two regions, two jobs, never both
        speaking about the same event.
      */}
      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {live}
      </p>

      {/*
        THE VISIBLE "HOW TO DRIVE THIS BOARD" PROSE IS GONE, DELIBERATELY, and
        the keyboard affordance it described is NOT. Every sentence it carried
        is still reachable where the act happens: `announcements` (above) narrates
        pick-up, lane choice and drop to a screen reader the moment a card is
        focused, and `enter` on a card still opens the menu that lists every move.
        What was removed is a paragraph an operator reads once and then scrolls
        past forever — on the one screen where the rows below it are the job.

        The one fact with nowhere else to live is the localStorage warning: when
        `triage.persists` is false, "Seen" lasts until reload. That now rides on
        the card's own control (`seenPersists`, passed at the BoardCard below)
        rather than in a header nobody re-reads.
      */}

      <DndContext
        sensors={sensors}
        /*
         * NEAREST LANE BY CENTRE, NOT BIGGEST OVERLAP.
         *
         * `rectIntersection` — the default — answers `null` whenever the held
         * card overlaps no lane at all, which on this board is an ordinary
         * release: the lanes sit on a canvas with gutters between them and the
         * rail scrolls, so a card let go a few pixels short of a lane resolves
         * to nothing and the board silently does nothing. A drop that silently
         * does nothing is the exact failure a card springing back with a reason
         * exists to prevent.
         *
         * `closestCenter` always names the lane the card is nearest, so a
         * release always MEANS something — and because a drop only ever opens a
         * dialog, the cost of naming the wrong one is a question the operator
         * says no to, never a shipment.
         */
        collisionDetection={closestCenter}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              'Press space to pick up an order. Use the left and right arrow keys to choose a lane, ' +
              'enter to open the move, and escape to put the card back. Nothing is sent until the form or the question is answered.',
          },
        }}
        onDragStart={onDragStart}
        onDragOver={(event) =>
          setOver(event.over === null ? null : (String(event.over.id) as ColumnKey))
        }
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setHeld(null);
          setOver(null);
        }}
      >
        <DroppableLanes
          rows={effective}
          now={now}
          lanes={lanes}
          columnState={laneState}
          renderCard={(row, lane, cardId) => {
            const orderId = row.order?.id ?? '';
            return (
              <DraggableCard
                row={row}
                cardId={cardId}
                lane={lane}
                now={now}
                role={role}
                expanded={expanded === cardId}
                busy={inflight.get(orderId) ?? null}
                seen={triage.seen.has(orderId)}
                seenPersists={triage.persists}
                onToggleExpanded={() => setExpanded((prev) => (prev === cardId ? null : cardId))}
                onToggleSeen={() => triage.toggle(orderId)}
                onMove={(move) => openMove(row, move, 'menu')}
              />
            );
          }}
        />

        <DragOverlay
          /*
           * `null` IS "DO NOT ANIMATE" AND `undefined` IS "THE LIBRARY'S OWN
           * DEFAULT", which is why this is a ternary and not `reduceMotion &&
           * null`. See `usePrefersReducedMotion`: the settle is a scripted WAAPI
           * animation, so `tokens.css` cannot switch it off and this prop is the
           * only thing that can.
           */
          dropAnimation={reduceMotion ? null : undefined}
        >
          {held !== null && (
            /*
              THE HELD CARD IS DRAWN TWICE AND ONLY ONE OF THEM IS REAL.
              `DragOverlay` renders a COPY that follows the pointer while the
              original stays in its lane as the hole it left — so without this,
              a screen reader user browsing mid-drag meets the same order twice
              (measured: fifteen `.shopcard__face` nodes for fourteen cards) and
              cannot tell which one is the order. `aria-hidden` picks the
              original, because the original is the one the drag layer keeps
              focus on and the one the lane announcements are about.

              `inert` BESIDE IT, NOT INSTEAD OF IT. A subtree hidden from the
              accessibility tree that still holds tabbable buttons is a trap by
              construction — the reader is told nothing is there and the tab
              order disagrees. `inert` is what makes the copy as unreachable as
              it is unannounced; it also stops a stray click landing on a card
              that is about to stop existing.
            */
            <ul className="shoplist__cards shoplist__cards--overlay" aria-hidden="true" inert>
              <BoardCard row={held.row} now={now} role={role} lane={held.from} expanded={false} lifted />
            </ul>
          )}
        </DragOverlay>
      </DndContext>

      {/*
        MOUNTED ONLY WHEN THERE IS SOMETHING TO ASK, and that is a bug fix rather
        than a tidy-up. `ConfirmDialog`'s confirm button carries `autoFocus`, and
        React honours it on MOUNT — not on the dialog opening — so a permanently
        mounted `<ConfirmDialog open={false}>` pulled focus into a closed dialog
        the instant the board rendered. Measured, not reasoned:
        `document.activeElement` was `button.btn--primary` before a key was
        pressed, and the operator's first Tab then wrapped from the end of the
        document to `<body>` instead of reaching the first card.
      */}
      {pending !== null && pending.kind === 'confirm' && (
        <ConfirmDialog
          open
          onClose={() => setPending(null)}
          onConfirm={() => void execute(pending.row, pending.move)}
          title={pending.move.label}
          description={
            <>
              {pending.move.hint} This affects order {pending.row.order?.orderNumber ?? ''} for{' '}
              <bdi>{recipientOf(pending.row.order ?? {})}</bdi>.
              {pending.dropped !== null && (
                <>
                  {' '}
                  You dropped it on {COLUMN_LABEL[pending.dropped]}; nothing has moved yet, and the
                  card is still in {COLUMN_LABEL[columnOf(pending.row)]} until you answer.
                </>
              )}
            </>
          }
          confirmLabel={pending.move.label}
          /*
            NOT "Cancel" NEXT TO "Cancel this order". `ConfirmDialog`'s default
            dismiss label is right nearly everywhere and wrong here in the one
            way that costs money: read out of a screen reader's button list the
            two are "Cancel" and "Cancel this order", one under the other, on
            the dialog that ends an order and releases its stock. The safe way
            out is named after what it PRESERVES instead — which is also the
            honest label for the non-destructive drops, where declining really
            does put the card back where it was.
          */
          dismissLabel={pending.move.destructive ? 'Keep this order' : 'Go back'}
          danger={pending.move.destructive}
          sheet
        />
      )}

      {pending !== null && pending.kind === 'shipment' && (
        <Dialog
          open
          onClose={() => setPending(null)}
          title={`Pack order ${pending.row.order?.orderNumber ?? ''}`}
          description={
            <>
              This creates one parcel holding the units you name below, and nothing else changes.
              Carrier and tracking are optional. The card is still in{' '}
              {COLUMN_LABEL[columnOf(pending.row)]} until this form is submitted —{' '}
              {safeFormatMinor(pending.row.order?.grandTotal, pending.row.order?.currency)} to{' '}
              <bdi>{recipientOf(pending.row.order ?? {})}</bdi>.
            </>
          }
          width="34rem"
          sheet
          /*
            THE FORM SUPPLIES THE ACTIONS, SO THE DIALOG MUST NOT ALSO SUPPLY
            ITS OWN. Left undefined, `footer` falls back to a "Close" button —
            and this dialog then offered THREE buttons that all look like a way
            out of it: the form's "Cancel", that "Close", and a submit. Two of
            them do the identical thing under different names, which in a screen
            reader's button list is a choice the operator has to make and cannot.
            `<></>` is how every other form-in-a-dialog in this repo says "the
            body owns the buttons" (`LogReturn.tsx`, `ReturnDetail.tsx`,
            `MarketingCustomers.tsx`); the alternative — hoisting the form's
            state up here so the buttons could live in the footer slot — moves a
            dozen fields out of the component that validates them to win a
            layout that is already correct.
          */
          footer={<></>}
        >
          <ShipmentForm
            key={pending.seq}
            row={pending.row}
            plannedLines={pending.lines}
            busy={inflight.has(pending.row.order?.id ?? '')}
            onSubmit={(shipment) => void execute(pending.row, pending.move, shipment)}
            onCancel={() => setPending(null)}
          />
        </Dialog>
      )}
    </div>
  );
}
