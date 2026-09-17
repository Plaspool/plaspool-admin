import { useEffect, useState } from 'react';
import {
  currencyApi,
  type CurrencyRow,
  type VariantMultiplier,
} from '../../data/api-currency';
import { currencyLabel, multiplierProblem, rateSentence, trimMultiplier } from '../lib/currency';
import { Button } from '../ui/primitives';
import { SelectField } from '../ui/Field';
import { useToast } from '../ui/Toast';

/**
 * A VARIANT'S OWN RATE, per currency — inside the variant modal, below
 * Pricing. `server/shop/currency/routes.ts`'s `/admin/variants/:id/multipliers`.
 *
 * Optional and rare: most variants follow the currency's normal rate. One
 * with its own rate uses it instead, for that currency only.
 *
 * SAVES ON ITS OWN BUTTONS, NOT ON "Save variant". These are separate rows on
 * a separate route, and folding them into the variant PATCH would make one
 * button two writes that can half-succeed. Every write answers the variant's
 * whole list, so the rows re-render from the response.
 *
 * NO `role="alert"` HERE, on purpose: the modal's own validation line is the
 * one alert in the dialog, and a second one would make "the" alert ambiguous.
 * A refusal from this section is a toast; a bad rate is an inline error.
 */
export function VariantMultipliers({ variantId }: { variantId: string }) {
  const toast = useToast();
  const [items, setItems] = useState<VariantMultiplier[] | null>(null);
  const [currencies, setCurrencies] = useState<CurrencyRow[]>([]);
  /** Every currency the shop knows how to charge, switched on or not. */
  const [known, setKnown] = useState<string[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [settingsFailed, setSettingsFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [addCode, setAddCode] = useState('');
  const [addText, setAddText] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      /* Settled separately: without the currency list the overrides still
         show and can still be edited or removed — only adding needs it. */
      const [overrides, settings] = await Promise.allSettled([
        currencyApi.getVariantMultipliers(variantId, controller.signal),
        currencyApi.getSettings(controller.signal),
      ]);
      if (controller.signal.aborted) return;
      if (settings.status === 'fulfilled') {
        setCurrencies(settings.value.currencies);
        setKnown(settings.value.known);
      } else setSettingsFailed(true);
      if (overrides.status === 'fulfilled') setItems(overrides.value);
      else setLoadError(true);
    })();
    return () => controller.abort();
  }, [variantId]);

  async function write(key: string, call: () => Promise<VariantMultiplier[]>, done: string): Promise<boolean> {
    if (busy) return false;
    setBusy(key);
    try {
      setItems(await call());
      toast.show(done);
      return true;
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (loadError) {
    return (
      <div className="stack stack--tight">
        <span className="field__label">Rates in other currencies</span>
        <span className="field__hint">Couldn’t load this variant’s rates. Close and reopen to try again.</span>
      </div>
    );
  }
  if (items === null) return null;

  const normal = new Map(currencies.map((c) => [c.code, c]));
  const taken = new Set(items.map((i) => i.currency));
  /* EVERY CURRENCY THE SHOP KNOWS, not only the switched-on ones (owner,
     2026-09-11: "all supported currencies I want to be able to charge them
     separately"). A rate for a switched-off currency is stored and simply
     waits until that currency is switched on. Never naira: its rate is 1. */
  const storeCode = currencies.find((c) => c.store)?.code ?? 'NGN';
  const choices = known.filter((code) => code !== storeCode && !taken.has(code));
  const switchedOn = (code: string) => normal.get(code)?.enabled === true;

  async function add() {
    if (!addCode) {
      setAddError('Choose a currency.');
      return;
    }
    const text = addText.trim();
    const problem = multiplierProblem(text);
    if (problem) {
      setAddError(problem);
      return;
    }
    const ok = await write(
      `add:${addCode}`,
      () => currencyApi.setVariantMultiplier(variantId, addCode, text),
      `${currencyLabel(addCode)} rate saved for this variant`,
    );
    if (ok) {
      setAddCode('');
      setAddText('');
      setAddError(null);
    }
  }

  return (
    <div className="stack stack--tight">
      <span className="field__label">Rates in other currencies</span>
      <span className="field__hint">
        Optional. A rate here replaces the currency’s normal rate for this variant only.
      </span>

      {items.map((item) => (
        <OverrideRow
          key={`${item.currency}:${item.multiplier}`}
          item={item}
          normal={normal.get(item.currency)?.multiplier ?? null}
          busy={busy}
          onSave={(text) =>
            void write(
              `save:${item.currency}`,
              () => currencyApi.setVariantMultiplier(variantId, item.currency, text),
              `${currencyLabel(item.currency)} rate saved for this variant`,
            )
          }
          onRemove={() =>
            void write(
              `remove:${item.currency}`,
              () => currencyApi.clearVariantMultiplier(variantId, item.currency),
              `${currencyLabel(item.currency)} back to its normal rate`,
            )
          }
        />
      ))}

      {choices.length > 0 ? (
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 10rem' }}>
            <SelectField
              label="Currency"
              value={addCode}
              onChange={(e) => {
                setAddCode(e.target.value);
                setAddError(null);
              }}
            >
              <option value="">Choose…</option>
              {choices.map((code) => (
                <option key={code} value={code}>
                  {currencyLabel(code)}
                  {switchedOn(code) ? '' : ' — switched off'}
                </option>
              ))}
            </SelectField>
            {addCode && !switchedOn(addCode) ? (
              <span className="field__hint">
                Shoppers won’t see this rate until {currencyLabel(addCode)} is switched on in Settings → Payments.
              </span>
            ) : null}
          </div>
          <div style={{ flex: '1 1 10rem' }} className="field">
            <label className="field__label" htmlFor={`vm-add-${variantId}`}>
              Rate for this variant
            </label>
            <input
              id={`vm-add-${variantId}`}
              className={addError ? 'input input--invalid mono' : 'input mono'}
              inputMode="decimal"
              spellCheck={false}
              autoComplete="off"
              placeholder={addCode && normal.get(addCode)?.multiplier ? trimMultiplier(normal.get(addCode)!.multiplier!) : '0.0085'}
              value={addText}
              aria-invalid={addError ? true : undefined}
              onChange={(e) => {
                setAddText(e.target.value);
                setAddError(null);
              }}
            />
            {addError ? <span className="field__error">{addError}</span> : null}
          </div>
          <div style={{ paddingTop: '1.375rem' }}>
            <Button busy={busy === `add:${addCode}`} disabled={busy !== null} onClick={() => void add()}>
              Add rate
            </Button>
          </div>
        </div>
      ) : items.length === 0 && !settingsFailed ? (
        <span className="field__hint">Switch on another currency in Settings → Payments first.</span>
      ) : null}
    </div>
  );
}

function OverrideRow({
  item,
  normal,
  busy,
  onSave,
  onRemove,
}: {
  item: VariantMultiplier;
  normal: string | null;
  busy: string | null;
  onSave: (text: string) => void;
  onRemove: () => void;
}) {
  const [text, setText] = useState(trimMultiplier(item.multiplier));
  const [error, setError] = useState<string | null>(null);
  const label = currencyLabel(item.currency);
  const changed = text.trim() !== trimMultiplier(item.multiplier);

  function save() {
    const t = text.trim();
    const problem = multiplierProblem(t);
    if (problem) {
      setError(problem);
      return;
    }
    onSave(t);
  }

  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 10rem' }} className="field">
        <label className="field__label" htmlFor={`vm-${item.currency}`}>
          {label}
        </label>
        <input
          id={`vm-${item.currency}`}
          className={error ? 'input input--invalid mono' : 'input mono'}
          inputMode="decimal"
          spellCheck={false}
          autoComplete="off"
          value={text}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />
        {error ? (
          <span className="field__error">{error}</span>
        ) : (
          <span className="field__hint">
            {normal ? `Normal rate: ${rateSentence(item.currency, normal)}` : 'No normal rate yet.'}
          </span>
        )}
      </div>
      <div className="row" style={{ paddingTop: '1.375rem' }}>
        <Button
          busy={busy === `save:${item.currency}`}
          disabled={busy !== null || !changed}
          onClick={save}
          aria-label={`Save ${label} rate`}
        >
          Save
        </Button>
        <Button
          tone="plain"
          busy={busy === `remove:${item.currency}`}
          disabled={busy !== null}
          onClick={onRemove}
          aria-label={`Remove ${label} rate`}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}
