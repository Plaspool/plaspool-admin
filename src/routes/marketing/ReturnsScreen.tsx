import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  OUT_OF_AREA,
  marketingApi,
  type AreasView,
  type BulkAction,
  type Program,
  type ReturnCounts,
  type ReturnListItem,
  type ReturnRequest,
} from '../../data/api-marketing';
import { ApiError, NotFoundError, StaleWriteError } from '../../data/errors';
import { getSession } from '../../data/session';
import { useSidebarCounts } from '../../components/Sidebar';
import { useToast } from '../../components/Toast';
import { Dialog } from '../../components/Dialog';
import { Skeleton } from '../../components/ui/Feedback';
import { useDelayed } from '../../components/ui/useDelayed';
import { BoardSwitcher, busiestBoard, currentBoard } from './BoardSwitcher';
import { LogReturn } from './LogReturn';
import { ReturnCard } from './ReturnCard';
import { ReturnModal } from './ReturnModal';
import { ReturnsBoard, BOARD_COLUMNS, legalTargets, resolveDrop, type BoardColumn } from './ReturnsBoard';
import { ReturnsDesk, deskRows } from './ReturnsDesk';
import { SelectionBar } from './SelectionBar';
import {
  DIALOG_TITLE,
  DONE_MESSAGE,
  carriedRequest,
  explainLoad,
  explainWrite,
  fieldMessage,
  healed,
  withParams,
} from './queue-shared';
import {
  STATUS_LABEL,
  StageForm,
  submitStage,
  type StageAction,
  type StageProblem,
  type StageSubmission,
} from './StageForm';

/**
 * The returns screen — a desk above a board, one district at a time.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO READS, AND THEY ANSWER DIFFERENT QUESTIONS.
 *
 * The DESK is whole-of-city and asks `view=needs_action` with no district: "what
 * needs me" is a question about the day, and an operator must not have to visit
 * six boards to discover that two of them are on fire.
 *
 * The BOARD is one district and asks `view=all&district=…`: it is a dispatch
 * list, and dispatch decisions are made one district at a time.
 *
 * They overlap on purpose — a return legitimately appears on the desk AND on its
 * board, because "needs action" is a judgement about a card while a column is a
 * place the card IS.
 *
 * A DROP IS THE INTENT AND THE FORM IS THE ACT. `onDragEnd` never calls a
 * transition: it resolves the drop to an action, checks it against the SERVER's
 * `allowedActions`, and opens the form. The card stays in its old column until
 * the form succeeds. That is the whole reason this board cannot award points by
 * accident.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** A board is one district's dispatch list, and 100 is the API's ceiling. A
 *  district with more than a hundred open returns has a staffing problem rather
 *  than a pagination problem, and the footer says so out loud. */
const BOARD_LIMIT = 100;
const DESK_LIMIT = 50;

interface Page {
  rows: ReturnListItem[];
  counts: ReturnCounts | null;
  more: boolean;
}

/** One card, wired for drag. Split out so `ReturnsBoard` stays a presentational
 *  arrangement that a test can render without a `DndContext`. */
function DraggableCard({
  row,
  now,
  selection,
  onOpen,
  onToggle,
}: {
  row: ReturnListItem;
  now: number;
  selection: ReadonlySet<string> | undefined;
  onOpen: (row: ReturnListItem) => void;
  onToggle: (row: ReturnListItem) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: row.id });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className="mktcard__grip">
      <ReturnCard
        row={row}
        now={now}
        selected={selection === undefined ? undefined : selection.has(row.id)}
        onOpen={onOpen}
        onToggle={onToggle}
        dragging={isDragging}
      />
    </div>
  );
}

/**
 * THE FOUR COLUMNS, REGISTERED AS DROP TARGETS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A DROPPABLE IS A REF ON A NODE, and there are two ways to end up with neither
 * while the screen still looks entirely correct.
 *
 * THE REF HAS TO REACH AN ELEMENT. What stood here called `useDroppable` for
 * each column and returned `null`, so dnd-kit held four drop targets whose node
 * was never a node. It measures `node ? rect : null` and keeps only the rects
 * it got, so all four were absent from the collision set: `event.over` was
 * `null` on every release and `onDragEnd` returned on its first line. Cards
 * lifted, columns lit up, and no drop ever landed — in production, silently.
 *
 * THE HOOK HAS TO RUN BELOW THE PROVIDER. Called from `ReturnsScreen`, which
 * RENDERS the `<DndContext>`, `useDroppable` reads the context from ABOVE
 * itself, finds the default and registers with nobody. Nothing warns, and the
 * board is dead in the same way. Hence a child with a render prop: sitting
 * below the provider is structural here rather than remembered.
 *
 * FOUR CALLS WRITTEN OUT rather than a loop over `BOARD_COLUMNS`, because a
 * hook inside a `.map` callback is the thing `react/rules-of-hooks` forbids —
 * and the columns are a fixed, ordered set precisely so this can be a list.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function ColumnDropTargets({
  children,
}: {
  children: (
    columnRef: (status: BoardColumn) => (node: HTMLElement | null) => void,
  ) => React.ReactNode;
}) {
  const requested = useDroppable({ id: 'requested' });
  const scheduled = useDroppable({ id: 'scheduled' });
  const collected = useDroppable({ id: 'collected' });
  const received = useDroppable({ id: 'received' });

  /* dnd-kit's `setNodeRef` is identity-stable, so handing the same function
   * back on every render leaves React's ref attached — rather than detaching
   * and reattaching a column while a card is over it. */
  const setNodeRef: Record<BoardColumn, (node: HTMLElement | null) => void> = {
    requested: requested.setNodeRef,
    scheduled: scheduled.setNodeRef,
    collected: collected.setNodeRef,
    received: received.setNodeRef,
  };

  return <>{children((status) => setNodeRef[status])}</>;
}

export function ReturnsScreen() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { notify } = useToast();

  const district = params.get('district');
  const openId = params.get('id');
  /* OWNER-ONLY CONTROLS ARE ABSENT FOR A WRITER, never disabled (spec D12), so
   * the role is read here rather than left to a 403 the screen would have to
   * explain after the fact. `status !== 'authed'` cannot render this route at
   * all — `RequireAuth` is above it — but narrowing keeps the union honest. */
  const session = getSession();
  const isOwner = session.status === 'authed' && session.user.role === 'owner';

  const [areas, setAreas] = useState<AreasView | null>(null);
  const [board, setBoard] = useState<Page | null>(null);
  const [desk, setDesk] = useState<ReturnListItem[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const showSkeletons = useDelayed(loading);

  // ------------------------------------------------------------------ reads
  useEffect(() => {
    const ac = new AbortController();
    marketingApi
      .listAreas(true, ac.signal)
      .then((next) => {
        if (ac.signal.aborted) return;
        setAreas(next);
        /*
         * THE URL WINS, AND THE BUSIEST BOARD IS THE FALLBACK. Landing an
         * operator on the district with the most work waiting is the one default
         * that is never wrong; `replace` so the fallback does not become a
         * history entry Back has to walk through.
         */
        if (district === null) {
          const opening = busiestBoard(next.areas);
          if (opening !== null) {
            setParams((prev) => withParams(prev, { district: opening.id }), { replace: true });
          }
        }
      })
      .catch((err: unknown) => {
        if (!ac.signal.aborted) setProblem(explainLoad(err, 'The boards didn’t load.'));
      });
    return () => ac.abort();
  }, [district, setParams]);

  const loadBoard = useCallback(
    (signal?: AbortSignal) => {
      if (district === null) return Promise.resolve();
      setLoading(true);
      return marketingApi
        .listReturns('all', { district, limit: BOARD_LIMIT }, signal)
        .then((next) => {
          if (signal?.aborted) return;
          setBoard({
            rows: next.items ?? [],
            counts: next.counts ?? null,
            more: (next.nextCursor ?? null) !== null,
          });
          setProblem(null);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (signal?.aborted) return;
          setProblem(explainLoad(err));
          setLoading(false);
        });
    },
    [district],
  );

  const loadDesk = useCallback((signal?: AbortSignal) => {
    /* NO DISTRICT ON THIS ONE. The desk is whole-of-city by design — see the
     * file header. */
    return marketingApi
      .listReturns('needs_action', { limit: DESK_LIMIT }, signal)
      .then((next) => {
        if (!signal?.aborted) setDesk(next.items ?? []);
      })
      .catch(() => {
        /* Soft: a desk that failed must not take the board down with it. */
      });
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void loadBoard(ac.signal);
    return () => ac.abort();
  }, [loadBoard]);

  useEffect(() => {
    const ac = new AbortController();
    void loadDesk(ac.signal);
    return () => ac.abort();
  }, [loadDesk]);

  useEffect(() => {
    const ac = new AbortController();
    marketingApi
      .listPrograms(ac.signal)
      .then((next) => {
        if (!ac.signal.aborted) setPrograms(next);
      })
      .catch(() => {
        /* Decoration on this screen: without them the intake asks the server to
         * pick the default program, which is what it does anyway. */
      });
    return () => ac.abort();
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([loadBoard(), loadDesk()]);
    /* The badges move with the work, so the switcher is re-read too — otherwise
     * a district emptied by a bulk action keeps its count until a reload. */
    try {
      setAreas(await marketingApi.listAreas(true));
    } catch {
      /* Soft, as above. */
    }
  }, [loadBoard, loadDesk]);

  const rows = board?.rows ?? [];
  const counts = board?.counts ?? null;
  useSidebarCounts(counts === null ? null : { returns: counts.needsAction });

  // -------------------------------------------------------------- selection
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const pickedRows = useMemo(
    () => rows.filter((row) => picked.has(row.id)),
    [rows, picked],
  );

  /* A selection is about THIS board. Changing district with cards still picked
   * would carry a selection onto rows that are no longer on screen, and the
   * bulk call would move returns the operator can no longer see. */
  useEffect(() => setPicked(new Set()), [district]);

  const toggle = (row: ReturnListItem): void =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });

  // ------------------------------------------------------------ the dialogs
  const [intake, setIntake] = useState<{ open: boolean; seq: number }>({ open: false, seq: 0 });
  const [quick, setQuick] = useState<
    { open: boolean; action: StageAction; ids: string[]; seq: number } | null
  >(null);
  const [stageProblem, setStageProblem] = useState<StageProblem | null>(null);
  const [conflict, setConflict] = useState<ReturnRequest | null>(null);
  const [stageBusy, setStageBusy] = useState(false);

  const quickRows = quick === null ? [] : rows.filter((row) => quick.ids.includes(row.id));

  function openStage(action: StageAction, ids: string[]): void {
    setStageProblem(null);
    setConflict(null);
    setQuick((prev) => ({ open: true, action, ids, seq: (prev?.seq ?? 0) + 1 }));
  }

  const closeQuick = (): void =>
    setQuick((prev) => (prev === null ? null : { ...prev, open: false }));

  // ------------------------------------------------------------- navigation
  const openCard = (row: ReturnListItem): void =>
    setParams((prev) => withParams(prev, { id: row.id }), { replace: false });

  const closeCard = (): void => setParams((prev) => withParams(prev, { id: null }));

  // ------------------------------------------------------------------ drag
  const [held, setHeld] = useState<ReturnListItem | null>(null);
  const [over, setOver] = useState<BoardColumn | null>(null);
  const springBack = useRef<string | null>(null);

  /**
   * POINTER, TOUCH AND KEYBOARD — all three, from one API.
   *
   * The keyboard sensor is not a nicety: this screen replaced a list that was
   * fully operable from a keyboard, and a board that needs a mouse would be a
   * regression for anybody who worked the old one at speed. The touch sensor
   * carries a DELAY so a scroll gesture on a phone does not become a drag.
   */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  function onDragStart(event: DragStartEvent): void {
    setHeld(rows.find((row) => row.id === String(event.active.id)) ?? null);
  }

  /**
   * THE DRAG CONTRACT. This never calls a transition.
   *
   * It resolves the drop to `(card, targetColumn)`, asks `resolveDrop` — which
   * asks the SERVER's `allowedActions` — and opens the form for whatever came
   * back. The card renders in its old list until that form succeeds.
   */
  function onDragEnd(event: DragEndEvent): void {
    const card = held;
    setHeld(null);
    setOver(null);
    if (card === null || event.over === null) return;

    const target = String(event.over.id) as BoardColumn;
    const outcome = resolveDrop(card, target);

    if (outcome.kind === 'noop') return;
    if (outcome.kind === 'refused') {
      /* The card springs back WITH A LINE SAYING WHICH RULE STOPPED IT. A card
       * that refuses a drop silently reads as a broken board. */
      springBack.current = card.id;
      notify(outcome.reason, { tone: 'danger' });
      return;
    }
    /* A drop on a card that is part of a SELECTION moves the whole selection —
     * frame C's "drag the selection as one stack". */
    const ids = picked.has(card.id) ? [...picked] : [card.id];
    openStage(outcome.action, ids);
  }

  // ------------------------------------------------------------- the writes
  async function runStage(submission: StageSubmission): Promise<void> {
    if (quick === null || quickRows.length === 0) return;
    setStageBusy(true);
    setStageProblem(null);
    setConflict(null);

    try {
      if (quickRows.length === 1) {
        await submitStage(quickRows[0].id, submission);
        notify(DONE_MESSAGE[submission.action]);
      } else {
        /*
         * PARTIAL SUCCESS IS THE TRUTH, so the report is per item. There are no
         * transactions on the server, so a bulk call IS a loop of single
         * statements — "4 of 5 scheduled" is what happened, and pretending
         * otherwise would leave four transitions applied behind an error.
         */
        const { action, ...body } = submission as StageSubmission & Record<string, unknown>;
        const results = await marketingApi.bulk({
          action: action as BulkAction,
          items: quickRows.map((row) => ({ id: row.id, expectedRevision: row.revision })),
          body: body as Record<string, unknown>,
        });
        const failed = results.filter((result) => !result.ok);
        if (failed.length === 0) {
          notify(`${results.length} returns updated`);
        } else {
          const names = failed
            .map((result) => rows.find((row) => row.id === result.id))
            .map((row) => row?.customerName ?? row?.customerEmail ?? 'one return')
            .join(', ');
          notify(
            `${results.length - failed.length} of ${results.length} updated — ${names} moved on while you were choosing.`,
            { tone: 'danger' },
          );
        }
        setPicked(new Set());
      }
      closeQuick();
      await refresh();
    } catch (err) {
      const fresh = carriedRequest(err);

      if (err instanceof StaleWriteError && fresh !== null) {
        setConflict(fresh);
      } else if (err instanceof ApiError && err.code === 'invalid_transition' && fresh !== null) {
        setBoard((prev) =>
          prev === null
            ? prev
            : { ...prev, rows: prev.rows.map((r) => (r.id === fresh.id ? healed(r, fresh) : r)) },
        );
        closeQuick();
        notify(`That return is now ${STATUS_LABEL[fresh.status]}.`, { tone: 'danger' });
      } else if (err instanceof ApiError && err.status === 400 && err.detail !== undefined) {
        setStageProblem({ field: err.detail, message: fieldMessage(err.detail) });
      } else if (err instanceof NotFoundError) {
        setBoard((prev) =>
          prev === null
            ? prev
            : { ...prev, rows: prev.rows.filter((r) => !quick.ids.includes(r.id)) },
        );
        closeQuick();
        notify('That return no longer exists.', { tone: 'danger' });
      } else {
        notify(explainWrite(err), {
          tone: 'danger',
          action: { label: 'Try again', run: () => void runStage(submission) },
        });
      }
    } finally {
      setStageBusy(false);
    }
  }

  // ------------------------------------------------------------------ paint
  const now = Date.now();
  const area = areas === null ? null : currentBoard(areas.areas, district);
  const eligible = programs.filter((p) => p.kind === 'unit_return' && p.status === 'active');
  const openCardRow = openId === null ? null : (rows.find((row) => row.id === openId) ?? null);
  const legal = held === null ? [] : legalTargets(held);

  return (
    <>
      <header className="mktscr__head">
        <div className="mktscr__headrow">
          <div>
            <h1 className="mktscr__title">Returns</h1>
            <p className="mktscr__lede">
              Book a pickup, collect it, receive it — then count what arrived.
            </p>
          </div>
          {/*
            THE BOARD PICKER IS ALONE UP HERE, and the create button that used
            to sit beside it is gone rather than moved. Two reasons, and the
            second is the real one:

            The picker's popup opens downward from the right corner and landed
            straight on top of that button — so the control most likely to be
            pressed by accident on the way to a district was the one that opens
            a modal over the board you were trying to reach.

            And it was the SECOND "Log a return" on the screen. The first lives
            under Requested, which is the one list a return can be born into,
            and is where the act belongs: a return is a card that starts in a
            column, not a global action the header happens to offer. One door,
            in the room the thing appears in.
          */}
          <div className="mktscr__headacts">
            <BoardSwitcher
              view={areas}
              district={district}
              onChoose={(next) => setParams((prev) => withParams(prev, { district: next }))}
            />
          </div>
        </div>
      </header>

      {problem !== null && <p className="mktform__error">{problem}</p>}

      <ReturnsDesk rows={deskRows(desk)} now={now} onAct={(row) => openCard(row)} />

      <SelectionBar
        picked={pickedRows}
        onRun={(action) => openStage(action as StageAction, [...picked])}
        onClear={() => setPicked(new Set())}
      />

      {showSkeletons && board === null ? (
        <div className="mktboard__canvas">
          {BOARD_COLUMNS.map((column) => (
            <div className="mktlist" key={column}>
              <Skeleton height="4rem" />
            </div>
          ))}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          /*
           * CLOSEST CENTRE, NOT THE DEFAULT INTERSECTION. `rectIntersection`
           * answers with the column the dragged card OVERLAPS MOST — and a
           * release that lands clear of all four (past the foot of the lists,
           * in a gutter, back up on the desk) overlaps none of them. It answers
           * with nothing, so the release does nothing AND SAYS NOTHING, which
           * is the same dead board this screen has already shipped once.
           *
           * `closestCenter` always names a column, and an illegal one is then
           * REFUSED OUT LOUD by `resolveDrop`. The cost is that a release far
           * off the board resolves to the nearest column instead of being
           * ignored — and a refusal somebody can read beats a silence they
           * cannot.
           */
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragOver={(event) => setOver(event.over === null ? null : (String(event.over.id) as BoardColumn))}
          onDragEnd={onDragEnd}
          onDragCancel={() => {
            setHeld(null);
            setOver(null);
          }}
        >
          <ColumnDropTargets>
            {(columnRef) => (
              <ReturnsBoard
                rows={rows}
                now={now}
                areaName={district === OUT_OF_AREA ? null : (area?.name ?? null)}
                selection={picked}
                onOpen={openCard}
                onToggle={toggle}
                onLog={() => setIntake((prev) => ({ open: true, seq: prev.seq + 1 }))}
                columnRef={columnRef}
                columnState={(column) => {
                  if (held === null) return null;
                  if (over === column) return legal.includes(column) ? 'over' : 'illegal';
                  return legal.includes(column) ? 'legal' : 'illegal';
                }}
                renderCard={(row) => (
                  <DraggableCard
                    row={row}
                    now={now}
                    selection={picked}
                    onOpen={openCard}
                    onToggle={toggle}
                  />
                )}
              />
            )}
          </ColumnDropTargets>
          <DragOverlay>
            {held !== null && (
              <ReturnCard row={held} now={now} onOpen={() => {}} dragging />
            )}
          </DragOverlay>
        </DndContext>
      )}

      {board?.more === true && (
        <p className="mktboard__more">
          This board has more than {BOARD_LIMIT} open returns — the oldest {BOARD_LIMIT} are shown.
        </p>
      )}

      {openId !== null && (
        <ReturnModal
          id={openId}
          row={openCardRow}
          isOwner={isOwner}
          onClose={closeCard}
          onNoted={() => void refresh()}
          onInspect={(bonus) =>
            navigate({
              pathname: '/marketing/returns',
              search: `?${withParams(params, {
                id: openId,
                act: 'inspect',
                ...(bonus === null
                  ? {}
                  : { bonus: String(bonus.points), bonusWhy: bonus.reason }),
              }).toString()}`,
            })
          }
        />
      )}

      <LogReturn
        key={intake.seq}
        open={intake.open}
        programs={eligible}
        onClose={() => setIntake((prev) => ({ ...prev, open: false }))}
        onLogged={() => {
          setIntake((prev) => ({ ...prev, open: false }));
          void refresh();
        }}
      />

      {quick !== null && quickRows.length > 0 && (
        <Dialog
          open={quick.open}
          title={
            quickRows.length > 1
              ? `${DIALOG_TITLE[quick.action]} — ${quickRows.length} returns`
              : DIALOG_TITLE[quick.action]
          }
          onClose={closeQuick}
          sheet
        >
          <StageForm
            key={quick.seq}
            action={quick.action}
            /*
             * THE FIRST CARD STANDS FOR THE SELECTION. One body is applied to
             * every item (that is what a bulk call IS), and the form needs a
             * shape to prefill from — an address for a pickup, a stage to
             * validate against. The `banner` above it says how many this will
             * move, so nobody mistakes one card's details for all of them.
             */
            target={quickRows[0]}
            banner={
              quickRows.length > 1 ? (
                <p className="notice">
                  This will be applied to all {quickRows.length} selected returns.
                </p>
              ) : (
                conflict !== null && (
                  <p className="notice">
                    Somebody else moved this to {STATUS_LABEL[conflict.status]} while you were
                    typing.
                  </p>
                )
              )
            }
            problem={stageProblem}
            busy={stageBusy}
            onSubmit={(submission) => void runStage(submission)}
            onCancel={closeQuick}
          />
        </Dialog>
      )}
    </>
  );
}
