import { useCallback, useEffect, useState } from 'react';
import {
  currencyApi,
  type CurrencyRow,
  type CurrencySettings,
} from '../../data/api-currency';
import { ForbiddenError, StaleWriteError } from '../../data/errors';
import {
  REASON_LABEL,
  SOURCE_LABEL,
  ageWords,
  currencyLabel,
  currencyName,
  hoursWords,
  inverseSentence,
  multiplierProblem,
  rateSentence,
  trimMultiplier,
} from '../lib/currency';
import { Badge, Banner, Button, Loading } from '../ui/primitives';
import { Card } from '../ui/Card';
import { SelectField, TextField, Toggle } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

/**
 * CURRENCIES — the second card on `/settings/payments`.
 *
 * NAIRA IS THE ONLY REAL PRICE. Every other currency is a published
 * MULTIPLIER (units of it per one naira) that the storefront applies for
 * display; the amount only becomes real money when the payment link is made.
 * This card shows each one's rate, where it came from, and whether shoppers
 * are offered it — and when not, why, in the owner's words.
 *
 * EVERY WRITE RE-RENDERS FROM THE RESPONSE. All four routes answer the same
 * object, so nothing here guesses what it saved.
 *
 * THE ON/OFF SWITCH IS CAS on `revision`, like the gateway card above it: a
 * lost race re-reads and says so, never re-sends. The rate writes carry no
 * revision (the server's routes take none), so they cannot conflict.
 *
 * `refreshKey` re-reads when the gateway card saves: "no payment gateway
 * takes it" is decided by the gateway card's currency boxes, so a box ticked
 * there has to be able to clear the reason here without a page reload.
 */
export default function CurrenciesCard({ refreshKey }: { refreshKey?: number }) {
  const toast = useToast();
  const [data, setData] = useState<CurrencySettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /* One write at a time for the whole card — the switch is CAS on one
     revision, so two in flight would race each other onto it. Carries WHICH
     control is working, so only that button shows its spinner. */
  const [saving, setSaving] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [editing, setEditing] = useState<CurrencyRow | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await currencyApi.getSettings(signal);
      setData(next);
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
  }, [load, refreshKey]);

  async function run(key: string, write: () => Promise<CurrencySettings>, done?: string): Promise<boolean> {
    if (saving) return false;
    setSaving(key);
    setConflict(false);
    try {
      setData(await write());
      if (done) toast.show(done);
      return true;
    } catch (cause) {
      if (cause instanceof StaleWriteError) {
        /* THEIRS WINS — the same rule as the gateway card. */
        setConflict(true);
        await load();
      } else if (cause instanceof ForbiddenError) {
        toast.show('You don’t have access to this. Only the owner and developers can change currencies.', 'critical');
      } else {
        toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
      }
      return false;
    } finally {
      setSaving(null);
    }
  }

  function switchTo(code: string, on: boolean) {
    if (!data) return;
    const listed = data.currencies.some((c) => c.code === code);
    const enabled = data.currencies
      .filter((c) => (c.code === code ? on : c.enabled))
      .map((c) => c.code);
    if (on && !listed) enabled.push(code);
    void run(`switch:${code}`, () => currencyApi.setEnabled(enabled, data.revision));
  }

  if (data === null) {
    return (
      <Card title="Currencies">
        {loadError ? (
          <Banner
            tone="critical"
            title="Couldn’t load currencies"
            action={<Button onClick={() => void load()}>Retry</Button>}
          >
            {loadError}
          </Banner>
        ) : (
          <Loading what="currencies" />
        )}
      </Card>
    );
  }

  const listed = new Set(data.currencies.map((c) => c.code));
  const addable = data.known.filter((code) => !listed.has(code));

  return (
    <Card title="Currencies">
      <p className="field__hint" style={{ margin: 0 }}>
        Every price is set in naira. Shoppers who pay in another currency pay the naira price times its rate.
      </p>

      {conflict ? (
        <Banner tone="warn" title="Someone else changed this while you had it open">
          Their version is on screen now. Check it before changing anything else.
        </Banner>
      ) : null}

      <div className="stack" style={{ gap: 0 }} role="list" aria-label="Currencies">
        {data.currencies.map((row, i) => (
          <CurrencyItem
            key={row.code}
            row={row}
            first={i === 0}
            stalenessHours={data.stalenessHours}
            saving={saving}
            onSwitch={(on) => switchTo(row.code, on)}
            onSetByHand={() => setEditing(row)}
            onUseDaily={() =>
              void run(
                `daily:${row.code}`,
                () => currencyApi.clearMultiplier(row.code),
                `${currencyLabel(row.code)} goes back to the daily rate`,
              )
            }
          />
        ))}
      </div>

      {addable.length > 0 ? (
        <SelectField
          label="Switch on another currency"
          value=""
          disabled={saving !== null}
          onChange={(e) => {
            const code = e.target.value;
            if (code) switchTo(code, true);
          }}
        >
          <option value="">Choose a currency…</option>
          {addable.map((code) => (
            <option key={code} value={code}>
              {currencyLabel(code)}
            </option>
          ))}
        </SelectField>
      ) : null}

      <span className="field__hint">
        {`Shoppers see their own country’s currency when it’s offered. Everyone else pays in ${currencyName(data.fallbackCurrency)}.`}
      </span>

      {editing ? (
        <ManualRateModal
          row={editing}
          busy={saving === `rate:${editing.code}`}
          onClose={() => setEditing(null)}
          onSave={async (text) => {
            const ok = await run(
              `rate:${editing.code}`,
              () => currencyApi.setMultiplier(editing.code, text),
              `${currencyLabel(editing.code)} rate saved`,
            );
            if (ok) setEditing(null);
          }}
        />
      ) : null}
    </Card>
  );
}

/** One currency: its rate in words and exactly, where the rate came from, and whether shoppers get it. */
function CurrencyItem({
  row,
  first,
  stalenessHours,
  saving,
  onSwitch,
  onSetByHand,
  onUseDaily,
}: {
  row: CurrencyRow;
  first: boolean;
  stalenessHours: number;
  saving: string | null;
  onSwitch: (on: boolean) => void;
  onSetByHand: () => void;
  onUseDaily: () => void;
}) {
  const label = currencyLabel(row.code);
  const age = ageWords(row.ageHours);

  return (
    <div
      role="listitem"
      aria-label={label}
      className="stack stack--tight"
      style={{
        padding: 'var(--s3) 0',
        borderTop: first ? undefined : '1px solid var(--border)',
      }}
    >
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 'var(--w-semi)' }}>{label}</span>
        <StatusBadge row={row} />
        <span className="spacer" />
        {row.store ? (
          <span className="field__hint">Always on</span>
        ) : (
          <div style={saving !== null ? { opacity: 0.6, pointerEvents: 'none' } : undefined}>
            <Toggle
              label={
                <>
                  <span className="sr">{`${label} `}</span>
                  Switched on
                </>
              }
              checked={row.enabled}
              onChange={onSwitch}
            />
          </div>
        )}
      </div>

      {row.store ? (
        <span className="field__hint">The shop’s own currency. Every price is set in it.</span>
      ) : (
        <>
          {row.multiplier ? (
            <div className="stack" style={{ gap: 'var(--s1)' }}>
              <span>
                {rateSentence(row.code, row.multiplier)}
                <span className="muted">{` · ${inverseSentence(row.code, row.multiplier) ?? ''}`}</span>
              </span>
              <span className="field__hint">
                <span className="mono num">{row.multiplier}</span>
                {row.source ? ` · ${SOURCE_LABEL[row.source]}` : ''}
                {row.source === 'manual' ? ', never goes out of date' : age ? `, ${age}` : ''}
              </span>
            </div>
          ) : (
            <span className="field__hint">No rate yet.</span>
          )}

          <ReasonLine row={row} stalenessHours={stalenessHours} />

          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Button disabled={saving !== null} onClick={onSetByHand} aria-label={`Set ${label} rate by hand`}>
              Set by hand…
            </Button>
            {row.source === 'manual' ? (
              <Button
                tone="plain"
                busy={saving === `daily:${row.code}`}
                disabled={saving !== null}
                onClick={onUseDaily}
                aria-label={`Use the daily rate for ${label}`}
              >
                Use the daily rate
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function StatusBadge({ row }: { row: CurrencyRow }) {
  if (row.offered) return <Badge tone="ok">Offered to shoppers</Badge>;
  if (row.reason === 'disabled' || row.reason === null) return <Badge>Switched off</Badge>;
  return <Badge tone="warn">{`Not offered: ${REASON_LABEL[row.reason].toLowerCase()}`}</Badge>;
}

/** What to do about a switched-on currency shoppers still don't get. */
function ReasonLine({ row, stalenessHours }: { row: CurrencyRow; stalenessHours: number }) {
  if (!row.enabled || row.offered) return null;
  const text =
    row.reason === 'no_rate'
      ? 'Shoppers can’t pay in it until it has a rate. Set one by hand, or wait for the daily rate.'
      : row.reason === 'stale'
        ? `The daily rate hasn’t updated in over ${hoursWords(stalenessHours)}. Set one by hand to keep offering it.`
        : row.reason === 'no_gateway'
          ? 'Neither payment gateway charges it. Switch it on for a gateway above.'
          : row.reason === 'unknown_currency'
            ? 'The shop doesn’t know how to charge this currency.'
            : null;
  return text ? <span className="field__hint">{text}</span> : null;
}

/** "Set by hand": a rate as text, checked with the server's own parser before it is sent. */
function ManualRateModal({
  row,
  busy,
  onClose,
  onSave,
}: {
  row: CurrencyRow;
  busy: boolean;
  onClose: () => void;
  onSave: (text: string) => void;
}) {
  const [text, setText] = useState(row.multiplier ? trimMultiplier(row.multiplier) : '');
  const [error, setError] = useState<string | null>(null);
  const name = currencyName(row.code);
  const trimmed = text.trim();
  const valid = multiplierProblem(trimmed) === null;

  function save() {
    const problem = multiplierProblem(trimmed);
    if (problem) {
      setError(problem);
      return;
    }
    /* THE TEXT, NEVER A NUMBER: `Number("0.008496176720")` is already a
       rounding the server would have to trust. */
    onSave(trimmed);
  }

  return (
    <Modal
      title={`Set the ${name} rate by hand`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={save}>
            Save rate
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField
          label={`${row.code} per 1 naira`}
          value={text}
          inputMode="decimal"
          className={error ? 'input input--invalid mono' : 'input mono'}
          spellCheck={false}
          autoComplete="off"
          error={error}
          hint={
            valid
              ? `${rateSentence(row.code, trimmed)} · ${inverseSentence(row.code, trimmed) ?? ''}`
              : 'Up to 12 digits after the point.'
          }
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
        />
        <p className="field__hint" style={{ margin: 0 }}>
          A rate set by hand never goes out of date, and the daily rate won’t replace it.
        </p>
      </div>
    </Modal>
  );
}
