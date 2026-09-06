import { useState } from 'react';
import { marketingApi, type Program, type ProgramDraft } from '../../data/api-marketing';
import { Button } from '../ui/primitives';
import { TextField } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

/**
 * THE PROGRAMME EDITOR, shared by two screens that each own ONE type.
 *
 * Until 2026-09-06 this lived inside `Marketing.tsx` with a "Type" switch on
 * the create form — Per item returned or Manual points. The per-item
 * programme moved to Spools → Points and costs, so the type is no longer a
 * choice the person filling this in makes: Marketing opens it with
 * `kind="adhoc"`, Points and costs with `kind="unit_return"`, and the form
 * shows exactly the fields that type has. When an existing programme is
 * handed in, ITS kind wins — a programme never changes type.
 *
 * A PROGRAMME'S `key` IS IMMUTABLE AND NEVER PATCHED — the ledger's rows point
 * at it, so renaming moves the words and never the identity. The create form
 * asks for it; the edit form shows it as read-only prose; the PATCH body
 * structurally cannot carry `key` or `kind`.
 *
 * THE TWO MONEY NUMBERS (0920) are sent on every per-item PATCH, null
 * included, because a PATCH that omitted them could not express "clear this
 * rate" and a cleared rate must be undoable.
 */
export function ProgramModal({
  kind: fixedKind,
  program,
  onClose,
  onDone,
}: {
  /** The type this screen creates. Ignored when `program` is set. */
  kind: 'unit_return' | 'adhoc';
  program: Program | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const creating = program === null;
  const kind = program?.kind ?? fixedKind;
  const unit = kind === 'unit_return';
  const [key, setKey] = useState(program?.key ?? '');
  const [name, setName] = useState(program?.name ?? '');
  const [pointsOne, setPointsOne] = useState(program?.pointsLabelSingular ?? 'point');
  const [pointsMany, setPointsMany] = useState(program?.pointsLabelPlural ?? 'points');
  const [unitOne, setUnitOne] = useState(program?.unitLabelSingular ?? '');
  const [unitMany, setUnitMany] = useState(program?.unitLabelPlural ?? '');
  const [perUnit, setPerUnit] = useState(
    program?.pointsPerUnit != null ? String(program.pointsPerUnit) : '',
  );
  const [minUnits, setMinUnits] = useState(
    program?.minUnitsPerReturn != null ? String(program.minUnitsPerReturn) : '1',
  );
  /* Naira in the box, minor units on the wire. Empty means "we have not
     decided", which is a different claim from zero and the only way a figure
     typed by mistake is undone — so an empty box sends `null`. */
  const [unitCost, setUnitCost] = useState(
    program?.unitCostMinor != null ? String(program.unitCostMinor / 100) : '',
  );
  const [marketCost, setMarketCost] = useState(
    program?.unitMarketCostMinor != null ? String(program.unitMarketCostMinor / 100) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function commit() {
    if (!name.trim() || !pointsOne.trim() || !pointsMany.trim()) {
      setError('Fill in the name and both point words.');
      return;
    }
    const nPerUnit = Number(perUnit);
    const nMin = Number(minUnits);
    /* `undefined` here means "not a number" and stops the save; `null` means
       the box was cleared on purpose. */
    const naira = (text: string): number | null | undefined => {
      const trimmed = text.trim();
      if (trimmed === '') return null;
      const value = Number(trimmed);
      if (!Number.isFinite(value) || value < 0) return undefined;
      return Math.round(value * 100);
    };
    const nUnitCost = naira(unitCost);
    const nMarketCost = naira(marketCost);
    if (unit) {
      if (!unitOne.trim() || !unitMany.trim()) {
        setError('Fill in both item words — the word for one, and the word for many.');
        return;
      }
      if (!Number.isInteger(nPerUnit) || nPerUnit < 1) {
        setError('Points per item must be a whole number, 1 or more.');
        return;
      }
      if (!Number.isInteger(nMin) || nMin < 1) {
        setError('Fewest items must be a whole number, 1 or more.');
        return;
      }
      if (nUnitCost === undefined) {
        setError('What one item costs us must be an amount in naira, or empty.');
        return;
      }
      if (nMarketCost === undefined) {
        setError('What a new one costs must be an amount in naira, or empty.');
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        const machineKey = key.trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(machineKey)) {
          setError('The ID code needs 3–32 characters: lowercase letters, numbers, - or _.');
          setBusy(false);
          return;
        }
        const draft: ProgramDraft = {
          key: machineKey,
          kind,
          name: name.trim(),
          pointsLabelSingular: pointsOne.trim(),
          pointsLabelPlural: pointsMany.trim(),
          ...(unit
            ? {
                unitLabelSingular: unitOne.trim(),
                unitLabelPlural: unitMany.trim(),
                pointsPerUnit: nPerUnit,
                minUnitsPerReturn: nMin,
                /* Omitted when the box is empty rather than sent as null: the
                   create schema has no nullable arm, because "not decided" is
                   already what an absent field means on a new row. */
                ...(nUnitCost === null ? {} : { unitCostMinor: nUnitCost }),
                ...(nMarketCost === null ? {} : { unitMarketCostMinor: nMarketCost }),
              }
            : {}),
        };
        const created = await marketingApi.createProgram(draft);
        toast.show(`${created.name} created`);
      } else {
        await marketingApi.patchProgram(program.id, {
          expectedRevision: program.revision,
          name: name.trim(),
          pointsLabelSingular: pointsOne.trim(),
          pointsLabelPlural: pointsMany.trim(),
          ...(unit
            ? {
                unitLabelSingular: unitOne.trim(),
                unitLabelPlural: unitMany.trim(),
                pointsPerUnit: nPerUnit,
                minUnitsPerReturn: nMin,
                /* Sent even when null — clearing a rate is a real edit, and
                   `filled()` passes null through for exactly this. */
                unitCostMinor: nUnitCost ?? null,
                unitMarketCostMinor: nMarketCost ?? null,
              }
            : {}),
        });
        toast.show(`${name.trim()} saved`);
      }
      onDone();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={creating ? 'New programme' : `Edit ${program.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void commit()}>
            {creating ? 'Create programme' : 'Save programme'}
          </Button>
        </>
      }
    >
      <div className="stack">
        {creating ? (
          <span className="field__hint">
            {unit
              ? 'Pays points for each item a customer sends back and you accept.'
              : 'Lets you add points to a customer yourself, with a reason — goodwill, a prize, a thank-you.'}
          </span>
        ) : (
          <span className="field__hint">
            The type and ID code can’t be changed. Customers’ past points are linked to them.{' '}
            <span className="mono">{program.key}</span>
          </span>
        )}
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          {creating ? (
            <div style={{ flex: 0.8 }}>
              <TextField
                label="ID code"
                value={key}
                className="input mono"
                placeholder={unit ? 'item-returns' : 'thank-you'}
                spellCheck={false}
                hint="You can’t change this later."
                onChange={(e) => setKey(e.target.value)}
              />
            </div>
          ) : null}
          <div style={{ flex: 1.2 }}>
            <TextField
              label="Name"
              value={name}
              placeholder={unit ? 'Returns' : 'Thank you points'}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 1 }}>
            <TextField label="Word for one point" value={pointsOne} onChange={(e) => setPointsOne(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <TextField label="Word for many points" value={pointsMany} onChange={(e) => setPointsMany(e.target.value)} />
          </div>
        </div>
        {unit ? (
          <>
            <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
              <div style={{ flex: 1 }}>
                <TextField
                  label="Word for one item"
                  value={unitOne}
                  hint="What customers send back — used on every screen and email."
                  onChange={(e) => setUnitOne(e.target.value)}
                />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label="Word for many items" value={unitMany} onChange={(e) => setUnitMany(e.target.value)} />
              </div>
            </div>
            <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
              <div style={{ flex: 1 }}>
                <TextField
                  label="Points per item"
                  type="number"
                  min={1}
                  step={1}
                  value={perUnit}
                  hint="Saved onto each pickup as it comes in. Changing this won’t change older pickups."
                  onChange={(e) => setPerUnit(e.target.value)}
                />
              </div>
              <div style={{ flex: 1 }}>
                <TextField
                  label="Fewest items per pickup"
                  type="number"
                  min={1}
                  step={1}
                  value={minUnits}
                  hint="A customer can’t ask for a pickup with fewer than this."
                  onChange={(e) => setMinUnits(e.target.value)}
                />
              </div>
            </div>
            {/*
              THE TWO MONEY NUMBERS (0920). They are not what the customer is
              paid — that is the points rate above — they are what the business
              counts the reward AS, so the analytics can answer "what does an
              item really cost us". Editors only, like everything in this
              modal, because they change what a pickup is worth on paper.
            */}
            <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
              <div style={{ flex: 1 }}>
                <TextField
                  label="What one item costs us"
                  type="number"
                  min={0}
                  step={1}
                  inputMode="decimal"
                  value={unitCost}
                  placeholder="100"
                  hint="In naira. What we count each accepted item as costing us in points. Saved onto each pickup as it comes in, so changing it won’t change older pickups."
                  onChange={(e) => setUnitCost(e.target.value)}
                />
              </div>
              <div style={{ flex: 1 }}>
                <TextField
                  label="What a new one costs to buy"
                  type="number"
                  min={0}
                  step={1}
                  inputMode="decimal"
                  value={marketCost}
                  placeholder="850"
                  hint="In naira, today. Only used to show what taking items back saves against buying new."
                  onChange={(e) => setMarketCost(e.target.value)}
                />
              </div>
            </div>
          </>
        ) : null}
        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}
