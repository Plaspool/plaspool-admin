import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fmtPoints,
  fmtUnits,
  labelsOf,
  marketingApi,
  type ReturnDetail as ReturnDetailPayload,
  type ReturnListItem,
} from '../../data/api-marketing';
import { safeFormat } from '../../data/when';
import { QtyStepper } from '../../components/QtyStepper';
import { Skeleton } from '../../components/ui/Feedback';
import { WHEN, explainLoad } from './queue-shared';
import { STATUS_LABEL } from './StageForm';

/**
 * One card, opened — frame D: a centre modal over a blurred board.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A MODAL OVER THE BOARD RATHER THAN A PAGE YOU NAVIGATED TO.
 *
 * The board stays visibly there behind it, so the panel reads as a card LIFTED
 * OFF the board rather than as somewhere else. That matters because the next
 * thing an operator does is usually close it and move a different card: a full
 * page navigation makes that a back-button round trip and loses the board's
 * scroll position.
 *
 * The layout maps onto the card it came from. The left column is what the return
 * IS, what it is WORTH, and the one action that closes it; the right column is
 * the append-only history with a note composer above it.
 *
 * THE INSPECTION IS NOT IN HERE. "Count what arrived" navigates to the full
 * screen, because inspecting has derived quantities, a live award sentence and a
 * confirmation that restates it — squeezing that into a modal over a board would
 * be a second, smaller version of the screen that exists for it. This modal owns
 * the BONUS, which is the only money control that fits beside the arithmetic it
 * changes.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * The award, the top-up and the sum — the arithmetic the modal shows changing.
 *
 * A PURE FUNCTION because it is the one thing in this component somebody will
 * check by hand: 120 + 25 = 145, in front of them, before they commit it.
 */
export function bonusPreview(
  row: Pick<ReturnListItem, 'qtyDeclared' | 'pointsPerUnitSnapshot' | 'pointsAwarded'>,
  bonus: number,
): { base: number; bonus: number; total: number } {
  const base = row.pointsAwarded ?? row.qtyDeclared * row.pointsPerUnitSnapshot;
  const top = Number.isFinite(bonus) && bonus > 0 ? Math.floor(bonus) : 0;
  return { base, bonus: top, total: base + top };
}

export function ReturnModal({
  id,
  row,
  isOwner,
  onClose,
  onInspect,
  onNoted,
}: {
  id: string;
  /** The card as the board already holds it, so the modal paints IMMEDIATELY
   *  and the fetch fills in the history behind it. A modal that opened empty
   *  and waited would make every card feel slower than the board it sits on. */
  row: ReturnListItem | null;
  /** The bonus stepper is ABSENT for a writer, not disabled (spec D12). The
   *  server answers 403 as a backstop; this is the workflow. */
  isOwner: boolean;
  onClose: () => void;
  onInspect: (bonus: { points: number; reason: string } | null) => void;
  onNoted: () => void;
}) {
  const [detail, setDetail] = useState<ReturnDetailPayload | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noting, setNoting] = useState(false);
  const [bonus, setBonus] = useState(0);
  const [bonusReason, setBonusReason] = useState('');

  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<Element | null>(null);

  /*
   * FOCUS IS TAKEN ON OPEN AND GIVEN BACK ON CLOSE — to the card it came from,
   * which is where the operator was looking. Without the restore, closing a
   * modal drops focus onto `document.body` and the next keystroke goes nowhere;
   * on a board of forty cards that is a scroll back to the top.
   */
  useEffect(() => {
    restoreTo.current = document.activeElement;
    panel.current?.focus();
    return () => {
      if (restoreTo.current instanceof HTMLElement) restoreTo.current.focus();
    };
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    marketingApi
      .getReturn(id, ac.signal)
      .then((next) => {
        if (!ac.signal.aborted) setDetail(next);
      })
      .catch((err: unknown) => {
        if (!ac.signal.aborted) setProblem(explainLoad(err, 'That return didn’t load.'));
      });
    return () => ac.abort();
  }, [id]);

  const request = detail?.request ?? row;
  const labels = row !== null ? labelsOf(row.program) : detail === null ? null : labelsOf(detail.program);
  const money = row === null ? null : bonusPreview(row, bonus);

  async function addNote(): Promise<void> {
    if (note.trim() === '' || noting) return;
    setNoting(true);
    try {
      await marketingApi.addNote(id, note.trim());
      setNote('');
      const fresh = await marketingApi.getReturn(id);
      setDetail(fresh);
      onNoted();
    } catch (err) {
      setProblem(explainLoad(err, 'That note didn’t save.'));
    } finally {
      setNoting(false);
    }
  }

  return (
    <div
      className="mktmodal__scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="mktmodal"
        role="dialog"
        aria-modal="true"
        aria-label="Return"
        tabIndex={-1}
        ref={panel}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <header className="mktmodal__head">
          <div>
            <p className="mktmodal__stage">
              {request === null ? '—' : STATUS_LABEL[request.status]}
              {row?.serviceArea !== null && row !== null && (
                <span className="mktmodal__where"> · {row.serviceArea?.name}</span>
              )}
              {row?.serviceArea === null && (
                <span className="mktmodal__nowhere"> · No served area</span>
              )}
            </p>
            <h2 className="mktmodal__who">{row?.customerName ?? row?.customerEmail ?? id}</h2>
            <p className="mktmodal__id">{id}</p>
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </header>

        {problem !== null && <p className="mktform__error">{problem}</p>}

        <div className="mktmodal__cols">
          <div className="mktmodal__left">
            <h3 className="mktmodal__section">This return</h3>
            {row !== null && labels !== null && (
              <dl className="kv">
                <dt>Declared</dt>
                <dd>{fmtUnits(row.qtyDeclared, labels)}</dd>
                <dt>Programme</dt>
                <dd>{row.program.name}</dd>
                <dt>Rate promised</dt>
                <dd>
                  {fmtPoints(row.pointsPerUnitSnapshot, labels)} /{' '}
                  {row.program.unitLabelSingular ?? 'unit'}
                </dd>
                <dt>Requested</dt>
                <dd>{safeFormat(WHEN, row.createdAt)}</dd>
                {row.pickupAddress !== null && (
                  <>
                    <dt>Address</dt>
                    <dd>{row.pickupAddress}</dd>
                  </>
                )}
              </dl>
            )}

            {money !== null && labels !== null && (
              <>
                <h3 className="mktmodal__section">What it is worth</h3>
                <p className="mktmodal__money">{fmtPoints(money.base, labels)}</p>
                <p className="mktmodal__sum">
                  {row?.qtyDeclared} × {row?.pointsPerUnitSnapshot}
                </p>

                {/*
                  THE BONUS LIVES INSIDE "what it is worth" BECAUSE THAT IS THE
                  ONLY PLACE THE ARITHMETIC IS VISIBLE. 120 becomes 145 in front
                  of the person committing it, with a reason kept forever.

                  ABSENT FOR A WRITER, not disabled: minting points above the
                  programme's rate is money, and the role matrix reserves money
                  for the owner. A disabled control would advertise a capability
                  and then refuse it.
                */}
                {isOwner && row?.pointsAwarded === null && (
                  <div className="mktmodal__bonus">
                    <h4 className="mktmodal__section">Add a bonus</h4>
                    <QtyStepper
                      value={bonus}
                      min={0}
                      onChange={setBonus}
                      label="Bonus points"
                    />
                    {bonus > 0 && (
                      <>
                        <label className="mktform__label" htmlFor="mkt-bonus-why">
                          Reason — kept for good
                        </label>
                        <input
                          id="mkt-bonus-why"
                          className="mktform__input"
                          value={bonusReason}
                          onChange={(event) => setBonusReason(event.target.value)}
                          placeholder="Why this return earned extra"
                        />
                        <p className="mktmodal__total">
                          {fmtPoints(money.total, labels)} total to award
                          <span className="mktmodal__sum">
                            {' '}
                            {money.base} + {money.bonus} bonus
                          </span>
                        </p>
                      </>
                    )}
                  </div>
                )}

                {request?.status === 'received' && (
                  <button
                    type="button"
                    className="btn btn--primary"
                    /* The bonus travels WITH the inspection — one statement, two
                       ledger rows — rather than being a second write somebody
                       could forget to make. */
                    disabled={bonus > 0 && bonusReason.trim() === ''}
                    onClick={() =>
                      onInspect(
                        bonus > 0 ? { points: bonus, reason: bonusReason.trim() } : null,
                      )
                    }
                  >
                    Count what arrived…
                  </button>
                )}
              </>
            )}
          </div>

          <div className="mktmodal__right">
            <h3 className="mktmodal__section">Activity</h3>
            <div className="mktmodal__compose">
              <input
                className="mktform__input"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Write a note…"
                aria-label="Write a note"
              />
              <button
                type="button"
                className="btn btn--sm"
                disabled={note.trim() === '' || noting}
                onClick={() => void addNote()}
              >
                Add
              </button>
            </div>

            {detail === null && problem === null && (
              <div className="mktmodal__waiting">
                {[0, 1, 2].map((line) => (
                  <Skeleton key={line} height="1.1rem" />
                ))}
              </div>
            )}
            {detail !== null && (
              <ol className="mkttimeline">
                {/* NEWEST FIRST here and oldest-first on the wire: the server
                    hands them over in the order they happened, and a history
                    panel is read from the top. */}
                {[...detail.events].reverse().map((event) => (
                  <li className="mkttimeline__row" key={event.id}>
                    <p className="mkttimeline__what">
                      {event.note ?? event.type}
                      <span className="mkttimeline__when">
                        {' '}
                        {safeFormat(WHEN, event.occurredAt)}
                      </span>
                    </p>
                  </li>
                ))}
              </ol>
            )}

            {row !== null && (
              <p className="mktmodal__ledger">
                <Link to={`/marketing/customers?email=${encodeURIComponent(row.customerEmail)}`}>
                  Open their ledger →
                </Link>
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
