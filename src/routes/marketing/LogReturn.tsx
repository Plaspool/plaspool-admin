import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fmtUnits,
  labelsOf,
  marketingApi,
  type Program,
  type ProgramLabels,
} from '../../data/api-marketing';
import { ApiError } from '../../data/errors';
import { Dialog } from '../../components/Dialog';
import { QtyStepper } from '../../components/QtyStepper';
import { Select } from '../../components/ui/Select';
import { fieldMessage, explainWrite } from './queue-shared';


/**
 * What an admin fills in when a customer asks for a pickup.
 *
 * Its three named refusals are the reason it is a component rather than four
 * inputs in a ConfirmDialog: `below_minimum` belongs under the quantity box in
 * the program's own units, `return_already_open` is a LINK to the request that
 * is already in flight (a dead end otherwise — one open return per email is a
 * partial unique index, so there is nothing to retry), and `program_paused` is a
 * link to the screen that can unpause it.
 */
export function LogReturn({
  open,
  programs,
  onClose,
  onLogged,
}: {
  open: boolean;
  /** Already filtered to the programs that can take a return. */
  programs: Program[];
  onClose: () => void;
  onLogged: () => void | Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [chosenId, setChosenId] = useState('');
  const [typedQty, setTypedQty] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<IntakeProblem | null>(null);

  /*
   * The chosen program is DERIVED rather than seeded into state, because the
   * list arrives from its own request and may land after this dialog is open. A
   * `useState(programs[0])` would keep the empty first answer forever; falling
   * back on every render adopts the real one the moment it exists, and still
   * lets an explicit choice win.
   */
  const chosen = programs.find((p) => p.id === chosenId) ?? programs[0] ?? null;
  const labels: ProgramLabels | null = chosen === null ? null : labelsOf(chosen);
  const min = chosen?.minUnitsPerReturn ?? 1;
  // Likewise: the operator's number wins, the program's minimum is the start.
  // Switching program does NOT reset it — they typed what the customer sent.
  const qty = typedQty ?? min;

  const atLeast = (n: number): string =>
    labels === null ? `At least ${n} per request.` : `At least ${fmtUnits(n, labels)} per request.`;

  /** Which inputs are on screen — the program picker only exists above one. */
  const onScreen = new Set([
    'email',
    'qtyDeclared',
    'customerName',
    'customerPhone',
    'pickupAddress',
    'note',
    ...(programs.length > 1 ? ['programId'] : []),
  ]);

  const fieldError = (field: string): string | null =>
    problem !== null && problem.kind === 'field' && problem.field === field
      ? problem.message
      : null;

  /**
   * A message with nowhere to land, said at the foot of the form instead.
   *
   * The catalogue's rule is "inline, keyed by `detail`" — but `detail` is a
   * field path the SERVER chose, and it may name one this form is not showing
   * (`programId`, whenever there is only one program to pick from) or one it has
   * never heard of. Dropped, the dialog would refuse to save and say nothing.
   */
  const orphan =
    problem === null
      ? null
      : problem.kind === 'failed'
        ? problem.message
        : problem.kind === 'field' && !onScreen.has(problem.field)
          ? problem.message
          : null;

  async function submit(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await marketingApi.createReturn({
        email: email.trim(),
        qtyDeclared: qty,
        programId: chosen?.id,
        customerName: name.trim() || undefined,
        customerPhone: phone.trim() || undefined,
        pickupAddress: address.trim() || undefined,
        note: note.trim() || undefined,
      });
      await onLogged();
    } catch (err) {
      setProblem(readIntakeProblem(err, min, atLeast));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      sheet
      /*
        WIDER THAN THE 28rem DEFAULT, because this is the longest form in the
        section — six fields, two of which are paired side by side, each with a
        hint under it. At 28rem the pairs had about 12rem a side, "Where the
        driver is going" wrapped inside its own box, and the whole thing scrolled
        inside the panel with a stack of half-width controls. 36rem gives the
        pairs a usable line and takes the scroll off most screens entirely.
        The panel's own `max-width` still floors it at `100vw - 2rem`, and below
        640px this is a sheet, so the number only applies where there is room.
      */
      width="36rem"
      title="Log a return"
      description="What the customer says they are sending back. Nothing is awarded until it has been inspected."
      footer={<></>}
    >
      <form
        className="mktform"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {problem?.kind === 'already-open' && (
          <div className="notice notice--warn" role="alert">
            <div>
              This customer already has a return in progress — one at a time, so there is a
              driver for each.
            </div>
            <div className="notice__actions">
              <Link
                className="btn btn--outline btn--sm"
                to={{ pathname: '/marketing/returns', search: `?id=${problem.id}` }}
                onClick={onClose}
              >
                Open it
              </Link>
            </div>
          </div>
        )}

        {problem?.kind === 'paused' && (
          <div className="notice notice--warn" role="alert">
            <div>That program is paused, so it isn’t taking new returns.</div>
            <div className="notice__actions">
              <Link className="btn btn--outline btn--sm" to="/marketing/rewards" onClick={onClose}>
                Open Rewards
              </Link>
            </div>
          </div>
        )}

        <div className="mktform__field">
          <label className="label" htmlFor="mkt-intake-email">
            Customer email
          </label>
          <input
            id="mkt-intake-email"
            className="input"
            type="email"
            value={email}
            maxLength={320}
            autoComplete="off"
            onChange={(e) => setEmail(e.target.value)}
          />
          {fieldError('email') ? (
            <p className="mktform__error">{fieldError('email')}</p>
          ) : (
            <p className="mktform__hint">
              Guests earn under the address they checked out with.
            </p>
          )}
        </div>

        <div className="mktform__field">
          <span className="label">Quantity</span>
          {/* The program's minimum is the floor the BUTTONS respect, and the box
              still takes a smaller number typed into it: the operator records
              what the customer actually sent, and the route's `below_minimum`
              is the answer to it — not a quantity that changed itself. */}
          <QtyStepper label="Quantity" value={qty} min={min} onChange={setTypedQty} />
          {fieldError('qtyDeclared') ? (
            <p className="mktform__error">{fieldError('qtyDeclared')}</p>
          ) : (
            <p className="mktform__hint">{atLeast(min)}</p>
          )}
        </div>

        {programs.length > 1 && (
          <div className="mktform__field">
            <span className="label">Program</span>
            <Select
              label="Program"
              value={chosen?.id ?? ''}
              options={programs.map((p) => ({ value: p.id, label: p.name }))}
              onChange={setChosenId}
            />
            {fieldError('programId') && <p className="mktform__error">{fieldError('programId')}</p>}
          </div>
        )}

        <div className="mktform__split">
          <div className="mktform__field">
            <label className="label" htmlFor="mkt-intake-name">
              Name
            </label>
            <input
              id="mkt-intake-name"
              className="input"
              value={name}
              maxLength={300}
              placeholder="Optional"
              onChange={(e) => setName(e.target.value)}
            />
            {fieldError('customerName') && (
              <p className="mktform__error">{fieldError('customerName')}</p>
            )}
          </div>
          <div className="mktform__field">
            <label className="label" htmlFor="mkt-intake-phone">
              Phone
            </label>
            <input
              id="mkt-intake-phone"
              className="input"
              value={phone}
              maxLength={300}
              placeholder="Optional"
              onChange={(e) => setPhone(e.target.value)}
            />
            {fieldError('customerPhone') && (
              <p className="mktform__error">{fieldError('customerPhone')}</p>
            )}
          </div>
        </div>

        <div className="mktform__field">
          <label className="label" htmlFor="mkt-intake-address">
            Pickup address
          </label>
          <input
            id="mkt-intake-address"
            className="input"
            value={address}
            maxLength={2000}
            placeholder="Where the driver is going"
            onChange={(e) => setAddress(e.target.value)}
          />
          {fieldError('pickupAddress') && (
            <p className="mktform__error">{fieldError('pickupAddress')}</p>
          )}
        </div>

        <div className="mktform__field">
          <label className="label" htmlFor="mkt-intake-note">
            Note
          </label>
          <textarea
            id="mkt-intake-note"
            className="input"
            rows={2}
            value={note}
            maxLength={2000}
            placeholder="Optional — kept on the timeline"
            onChange={(e) => setNote(e.target.value)}
          />
          {fieldError('note') && <p className="mktform__error">{fieldError('note')}</p>}
        </div>

        {orphan !== null && (
          <p className="mktform__error" role="alert">
            {orphan}
          </p>
        )}

        <div className="mktform__actions">
          <button type="submit" className="btn btn--primary" disabled={busy || email.trim() === ''}>
            Log the return
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

type IntakeProblem =
  | { kind: 'field'; field: string; message: string }
  | { kind: 'already-open'; id: string }
  | { kind: 'paused' }
  | { kind: 'failed'; message: string };

function readIntakeProblem(
  err: unknown,
  min: number,
  atLeast: (n: number) => string,
): IntakeProblem {
  if (err instanceof ApiError) {
    if (err.code === 'below_minimum') {
      // The payload carries the minimum so the message can name it; the
      // program's own is the fallback, not the source.
      const body = (err.body ?? {}) as { min?: unknown };
      const stated = typeof body.min === 'number' ? body.min : min;
      return { kind: 'field', field: 'qtyDeclared', message: atLeast(stated) };
    }
    if (err.code === 'return_already_open') {
      const body = (err.body ?? {}) as { existingId?: unknown };
      if (typeof body.existingId === 'string') {
        return { kind: 'already-open', id: body.existingId };
      }
    }
    if (err.code === 'program_paused') return { kind: 'paused' };
    if (err.code === 'program_type_mismatch') {
      // The wire carries no message field by design — this copy is the client's.
      return { kind: 'field', field: 'programId', message: 'That program doesn’t take returns.' };
    }
    if (err.status === 400 && err.detail !== undefined) {
      return { kind: 'field', field: err.detail, message: fieldMessage(err.detail) };
    }
  }
  return { kind: 'failed', message: explainWrite(err) };
}

