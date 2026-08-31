import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { TicketPercent } from 'lucide-react';
import { moneyRefusalMessage, parseMajor } from '../../data/api-shop';
import {
  CODE_PATTERN,
  discountsApi,
  normaliseCode,
  parsePercentToBps,
  parseWhen,
  randomCode,
  type DiscountDraft,
} from '../data/discounts';
import { money } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Banner, Button } from '../ui/primitives';
import { AffixField, Checkbox, Segmented, SelectField, TextArea, TextField } from '../ui/Field';
import { useToast } from '../ui/Toast';

/**
 * CREATE DISCOUNT — form on the left, live summary on the right.
 *
 * THE SUMMARY IS NOT DECORATION. Every line in it is derived from the same
 * state the request will be built from, so what it says is what will be sent.
 * A summary panel assembled from separate strings is a panel that eventually
 * disagrees with the form beside it, which is worse than not having one.
 *
 * VALIDATION HAPPENS HERE AS WELL AS ON THE SERVER, and the local copy exists
 * to give a person a sentence rather than a 400. The regex, the 1–10000 basis
 * point range and the minor-unit conversion are all mirrored from the route in
 * `src/v2/data/discounts.ts` with the server named beside each one, so when the
 * contract changes there is one file to look in.
 */

const CURRENCIES = ['NGN', 'USD', 'GBP', 'EUR'];

export default function DiscountNew() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const kindParam = params.get('kind');
  const [kind, setKind] = useState<'percent' | 'fixed_amount'>(
    kindParam === 'fixed_amount' ? 'fixed_amount' : 'percent',
  );

  const [method, setMethod] = useState<'code' | 'automatic'>('code');
  const [code, setCode] = useState('');
  const [percent, setPercent] = useState('10');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('NGN');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [capped, setCapped] = useState(false);
  const [maxRedemptions, setMaxRedemptions] = useState('100');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  /* ── validation ───────────────────────────────────────────────────────── */

  const normalised = normaliseCode(code);

  const codeError = useMemo(() => {
    if (!normalised) return 'Enter a code.';
    if (!CODE_PATTERN.test(normalised))
      return 'Use 3–32 characters. Start with a letter or number, then letters, numbers, - or _.';
    return null;
  }, [normalised]);

  const bps = kind === 'percent' ? parsePercentToBps(percent) : null;
  const percentError =
    kind === 'percent' && bps === null ? 'Enter a percentage between 0.01 and 100.' : null;

  const parsedAmount = kind === 'fixed_amount' ? parseMajor(amount, currency) : null;
  const amountError =
    kind === 'fixed_amount' && parsedAmount && !parsedAmount.ok
      ? moneyRefusalMessage(parsedAmount.reason, currency)
      : null;

  const startMs = parseWhen(startsAt);
  const endMs = parseWhen(endsAt);
  const windowError =
    startMs !== null && endMs !== null && endMs <= startMs
      ? 'The end date must come after the start date.'
      : null;

  const capValue = Number(maxRedemptions);
  const capError =
    capped && (!Number.isInteger(capValue) || capValue < 1)
      ? 'The limit must be a whole number, 1 or more.'
      : null;

  const automaticBlocked = method === 'automatic';

  const invalid =
    Boolean(codeError || percentError || amountError || windowError || capError) || automaticBlocked;

  /* ── the request, built once and used by both the summary and the save ── */

  function buildDraft(): DiscountDraft | null {
    if (invalid) return null;
    const common = {
      code: normalised,
      startsAt: startMs,
      endsAt: endMs,
      maxRedemptions: capped ? capValue : null,
      note: note.trim() ? note.trim() : null,
    };
    if (kind === 'percent') {
      return { ...common, kind: 'percent', percentBps: bps! };
    }
    return {
      ...common,
      kind: 'fixed_amount',
      amountMinor: parsedAmount && parsedAmount.ok ? parsedAmount.minor : 0,
      currency: currency.toUpperCase(),
    };
  }

  async function save() {
    setSubmitted(true);
    const draft = buildDraft();
    if (!draft) return;
    setSaving(true);
    try {
      const created = await discountsApi.create(draft);
      toast.show(`${created.code} created`);
      navigate('/discounts');
    } catch (cause) {
      toast.show(
        cause instanceof Error && cause.message ? cause.message : 'Couldn’t create that code.',
        'critical',
      );
      setSaving(false);
    }
  }

  /* Errors are hidden until the field has been touched or Save pressed —
     a form that opens already red is a form telling somebody off for not having
     typed yet. */
  const show = (error: string | null, touched: boolean) => (submitted || touched ? error : null);

  const valueLine =
    kind === 'percent'
      ? bps !== null
        ? `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}% off the order`
        : 'Percentage not set'
      : parsedAmount && parsedAmount.ok
        ? `${money(parsedAmount.minor, currency)} off the order`
        : 'Amount not set';

  return (
    <div className="page">
      <PageHeader
        icon={<TicketPercent />}
        title="Create discount"
        backTo="/discounts"
        backLabel="Discounts"
        actions={
          <>
            <Button size="lg" onClick={() => navigate('/discounts')}>
              Discard
            </Button>
            <Button tone="primary" size="lg" busy={saving} onClick={() => void save()}>
              Save
            </Button>
          </>
        }
      />

      {automaticBlocked ? (
        <Banner tone="warn" title="Automatic discounts aren’t available yet">
          Right now a discount has to be a code the customer types in. Switch
          back to <strong>Discount code</strong> to save this.
        </Banner>
      ) : null}

      <div className="form2">
        <div className="form2__main">
          {/* ── method + code ─────────────────────────────────────────── */}
          <section className="card">
            <div className="card__head">
              <h2 className="card__title">
                {kind === 'percent' ? 'Percentage off the order' : 'Fixed amount off the order'}
              </h2>
            </div>
            <div className="card__body stack">
              <Segmented
                label="Method"
                value={method}
                onChange={setMethod}
                options={[
                  { value: 'code', label: 'Discount code' },
                  {
                    value: 'automatic',
                    label: 'Automatic discount',
                    disabled: false,
                    title: 'Not available yet',
                  },
                ]}
              />

              <div className="stack stack--tight">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="field__label">Discount code</span>
                  <button
                    type="button"
                    className="btn btn--plain"
                    style={{ height: '1.5rem', padding: '0 var(--s2)', color: 'var(--accent)' }}
                    onClick={() => setCode(randomCode())}
                  >
                    Generate random code
                  </button>
                </div>
                <TextField
                  label="Discount code"
                  hiddenLabel
                  value={code}
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="SUMMER20"
                  className="input mono"
                  error={show(codeError, code.length > 0)}
                  hint="Customers type this at checkout. It is saved in capitals."
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
            </div>
          </section>

          {/* ── value ─────────────────────────────────────────────────── */}
          <section className="card">
            <div className="card__head">
              <h2 className="card__title">Discount value</h2>
            </div>
            <div className="card__body stack">
              <SelectField
                label="Type"
                value={kind}
                onChange={(e) => setKind(e.target.value as 'percent' | 'fixed_amount')}
                hint="A code's value cannot be changed after it is created — the server refuses it. To change one, disable it and create another."
              >
                <option value="percent">Percentage</option>
                <option value="fixed_amount">Fixed amount</option>
              </SelectField>

              {kind === 'percent' ? (
                <AffixField
                  label="Percentage off"
                  suffix="%"
                  inputMode="decimal"
                  value={percent}
                  error={show(percentError, percent.length > 0)}
                  onChange={(e) => setPercent(e.target.value)}
                />
              ) : (
                <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
                  <div style={{ flex: 1 }}>
                    <AffixField
                      label="Amount off"
                      prefix={currency}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={amount}
                      error={show(amountError, amount.length > 0)}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </div>
                  <div style={{ width: '7.5rem' }}>
                    <SelectField
                      label="Currency"
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value)}
                    >
                      {CURRENCIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </SelectField>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* ── window ────────────────────────────────────────────────── */}
          <section className="card">
            <div className="card__head">
              <h2 className="card__title">Active dates</h2>
            </div>
            <div className="card__body stack">
              <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Starts"
                    type="datetime-local"
                    value={startsAt}
                    hint="Leave empty to start straight away."
                    onChange={(e) => setStartsAt(e.target.value)}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Ends"
                    type="datetime-local"
                    value={endsAt}
                    error={show(windowError, endsAt.length > 0)}
                    hint="Leave empty to keep it running until you turn it off."
                    onChange={(e) => setEndsAt(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* ── limits + note ─────────────────────────────────────────── */}
          <section className="card">
            <div className="card__head">
              <h2 className="card__title">Usage limits</h2>
            </div>
            <div className="card__body stack">
              <Checkbox
                label="Limit the number of times this code can be used"
                checked={capped}
                onChange={setCapped}
              />
              {capped ? (
                <TextField
                  label="Most times it can be used"
                  type="number"
                  min={1}
                  step={1}
                  value={maxRedemptions}
                  error={show(capError, true)}
                  onChange={(e) => setMaxRedemptions(e.target.value)}
                />
              ) : null}
              <TextArea
                label="Internal note"
                rows={3}
                value={note}
                hint="Customers never see this. Clearing the box deletes the note."
                onChange={(e) => setNote((e.target as HTMLTextAreaElement).value)}
              />
            </div>
          </section>
        </div>

        {/* ── summary ─────────────────────────────────────────────────── */}
        <aside className="form2__side">
          <section className="card">
            <div className="card__body stack stack--tight">
              <div className="mono" style={{ fontSize: 'var(--t-lg)', fontWeight: 'var(--w-bold)' }}>
                {normalised || 'No discount code yet'}
              </div>
              <div className="muted" style={{ fontSize: 'var(--t-sm)' }}>
                Code
              </div>

              <h3 style={{ marginTop: 'var(--s3)', fontSize: 'var(--t-md)' }}>Type</h3>
              <div className="muted">
                {kind === 'percent' ? 'Percentage off the order' : 'Fixed amount off the order'}
              </div>

              <h3 style={{ marginTop: 'var(--s3)', fontSize: 'var(--t-md)' }}>Details</h3>
              <ul className="summary">
                <li>{valueLine}</li>
                <li>Applies to the whole cart</li>
                <li>{startMs ? `Starts ${new Date(startMs).toLocaleString()}` : 'Active from today'}</li>
                <li>{endMs ? `Ends ${new Date(endMs).toLocaleString()}` : 'No end date'}</li>
                <li>{capped ? `Can be used ${capValue} times` : 'No usage limits'}</li>
                <li>Cannot be combined with other codes</li>
              </ul>
            </div>
          </section>

          <section className="card">
            <div className="card__body stack stack--tight">
              <h3 style={{ fontSize: 'var(--t-md)' }}>Storefront</h3>
              <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.5 }}>
                The code will be saved and counted, but checkout can’t use discount codes
                yet, so the cart total won’t change. Nothing is wasted — as soon as that
                is switched on, codes you have already made start working.
              </p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
