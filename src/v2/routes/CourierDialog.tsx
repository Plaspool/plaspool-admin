import { useEffect, useState } from 'react';
import { Truck } from 'lucide-react';
import {
  shopApi,
  type ShopCourierMissingWeight,
  type ShopCourierQuote,
  type ShopFulfillment,
  type ShopOrder,
} from '../../data/api-shop';
import { ApiError } from '../../data/errors';
import { getSession } from '../../data/session';
import { hasDomain } from '../../../shared/roles';
import { money, shortAddress } from '../lib/format';
import { Banner, Button } from '../ui/primitives';
import { AffixField, Radio } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { COURIER_COPY, PROVIDER_ENV, PROVIDER_LABEL } from './courier-copy';

/**
 * BOOKING A COURIER FOR ONE PARCEL — quote, weights, options, confirm.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WEIGHTS STEP IS A GATE FOR TERMINAL AND A WARNING FOR FEZ, and the
 * difference is the courier's, not this screen's opinion.
 *
 * Terminal prices by weight and refuses a shipment it cannot weigh: the
 * server answers 422 `weights_missing` and NAMES the lines, so the dialog
 * turns that into an inline step — a grams box per line, saved onto the
 * product variant, then the quote asked again. No options are rendered while
 * that refusal stands, because a rate list somebody can click through is a
 * gate with a hole in it.
 *
 * Fez prices by state and falls back to 1 kg for a weightless parcel, so the
 * same missing lines come back on a SUCCESSFUL quote as `missingWeights`. The
 * boxes are offered in exactly the same shape, above a live Book button:
 * refusing here would be this admin inventing a rule the courier does not
 * have, and the operator holding a parcel would have no way to send it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * EVERY VISIBLE STRING COMES FROM `COURIER_COPY` (spec §6.3). The quote's
 * `note` is deliberately not rendered: today the server only ever sets it for
 * the Fez weight fallback, which is the same fact `D.weightsSoft` states in
 * this admin's own words, and printing both reads like a bug.
 */

const D = COURIER_COPY.dialog;

/**
 * A COURIER'S REFUSAL IN WORDS THE OPERATOR CAN ACT ON.
 *
 * `ApiError.message` IS THE SERVER'S CODE. `src/data/api.ts` builds the error
 * from `{ error }` and passes no message, so anything that prints
 * `cause.message` puts `provider_rejected` in front of a person holding a
 * parcel. Every friendly sentence therefore needs its own branch.
 *
 * MODULE-LEVEL AND EXPORTED because the dialog is not the only door: the
 * parcel row's Refresh and Cancel buttons (`OrderDetail.tsx`) hit the same
 * four routes and get the same codes back, and two copies of this switch is
 * how one of them drifts into printing a code again.
 *
 * `provider_rejected` CARRIES THE COURIER'S OWN WORDS from the body rather
 * than a sentence of ours: only Fez or Terminal can say WHICH part of the
 * request they would not take.
 */
export function describeCourierError(cause: unknown, providerLabel: string): string {
  if (cause instanceof ApiError) {
    const body = cause.body as { message?: string; provider?: 'fez' | 'terminal' } | undefined;
    switch (cause.code) {
      case 'provider_not_configured':
        return D.notConfigured(
          PROVIDER_ENV[
            body?.provider ?? (providerLabel === PROVIDER_LABEL.terminal ? 'terminal' : 'fez')
          ],
        );
      case 'provider_rejected':
        return D.rejected(providerLabel, body?.message ?? cause.detail ?? 'no reason given');
      /* The one refusal that names the boxes to go and fill in — an order
         whose delivery address the courier cannot collect at. It is the
         courier's own sentence, which is the only thing that says WHICH
         part of the address is unusable. */
      case 'address_incomplete':
        return D.rejected(providerLabel, body?.message ?? 'the delivery address is incomplete');
      case 'provider_error':
        return D.unavailable(providerLabel);
      case 'already_booked':
        return D.alreadyBooked;
      /* The cancel lost a race with the courier's own webhook: the parcel is
         out, and the server refused rather than calling off a van it could
         not then record. */
      case 'already_shipped':
        return D.alreadyShipped;
      case 'provider_manual':
        return D.manual;
      /* A 403 from the variants PATCH behind the weights step: this dialog is
         `orders` and that write is `products`, so this code is reachable by a
         teammate rather than only by a bug. */
      case 'forbidden':
        return D.forbidden;
      default:
        break;
    }
  }
  return cause instanceof Error && cause.message ? cause.message : 'Something went wrong.';
}

type Phase =
  | { kind: 'quoting' }
  | { kind: 'weights'; lines: ShopCourierMissingWeight[] }
  | { kind: 'options'; quote: ShopCourierQuote; chosen: string | null }
  | { kind: 'failed'; message: string };

export function CourierDialog({
  parcel,
  index,
  order,
  providerLabel,
  onClose,
  onBooked,
}: {
  parcel: ShopFulfillment;
  index: number;
  order: ShopOrder;
  providerLabel: string;
  onClose: () => void;
  /** Booked, or found already booked: close and re-read the order. */
  onBooked: () => void;
}) {
  const toast = useToast();
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE WEIGHTS STEP CROSSES A PERMISSION DOMAIN, AND THIS IS WHERE THAT IS
   * NOTICED.
   *
   * Booking a courier is `orders` — that is why the four routes live under
   * `/admin/fulfillments/*` rather than beside the courier settings, so the
   * teammate who packs the box can book it. But the way PAST Terminal's
   * weights gate is a PATCH to `/admin/variants/:id`, which is `products`,
   * and Support and Marketing hold the first without the second.
   *
   * They used to reach a step whose only button answered `forbidden` — the
   * server's word, printed at a person, with nothing to do next. Read the
   * grant the same way every other screen does (`shared/roles.ts`) and offer
   * the truth instead: here is what needs weighing, and here is who can.
   * ═══════════════════════════════════════════════════════════════════════
   */
  const session = getSession();
  const viewer = 'user' in session ? session.user : null;
  const canWeigh = viewer !== null && hasDomain(viewer.role, 'products');

  const [phase, setPhase] = useState<Phase>({ kind: 'quoting' });
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const describe = (cause: unknown): string => describeCourierError(cause, providerLabel);

  /**
   * The lines a `weights_missing` refusal names, or `null` if that is not what
   * this failure was.
   *
   * BOTH THE QUOTE AND THE BOOKING CAN RAISE IT. The server re-asks the
   * question at booking time rather than trusting the quote (`bookParcel`),
   * because a quote and a booking are two requests with an operator in
   * between — somebody can clear a weight in that gap. Read in one place so
   * the second door leads to the same step as the first instead of printing
   * the server's code at a person.
   */
  function weightsRefused(cause: unknown): ShopCourierMissingWeight[] | null {
    if (cause instanceof ApiError && cause.code === 'weights_missing') {
      return (cause.body as { lines?: ShopCourierMissingWeight[] } | undefined)?.lines ?? [];
    }
    return null;
  }

  /** Seed a box per line, keeping anything already typed. */
  function askForWeights(lines: ShopCourierMissingWeight[]) {
    setWeights((w) => ({ ...Object.fromEntries(lines.map((l) => [l.variantId, ''])), ...w }));
    setPhase({ kind: 'weights', lines });
  }

  /** `already_booked` is not a failure to read — the parcel HAS a courier, so
   *  say so and let the row redraw from the server rather than stranding the
   *  operator in a dialog about a booking that exists. */
  function adopted(cause: unknown): boolean {
    if (cause instanceof ApiError && cause.code === 'already_booked') {
      toast.show(D.alreadyBooked);
      onBooked();
      return true;
    }
    return false;
  }

  async function quote() {
    setPhase({ kind: 'quoting' });
    setError(null);
    try {
      const answer = await shopApi.quoteCourier(parcel.id);
      /* `shopFetch<T>` is an unchecked assertion, and this dialog is the one
         place a missing key would be a blank screen over a parcel somebody
         needs to send — so the two lists are read defensively, once, here. */
      const q: ShopCourierQuote = {
        ...answer,
        options: answer.options ?? [],
        missingWeights: answer.missingWeights ?? [],
      };
      if (q.missingWeights.length > 0) {
        setWeights((w) => ({
          ...Object.fromEntries(q.missingWeights.map((l) => [l.variantId, ''])),
          ...w,
        }));
      }
      setPhase({
        kind: 'options',
        quote: q,
        chosen: q.options.length === 1 ? q.options[0]!.id : null,
      });
    } catch (cause) {
      const missing = weightsRefused(cause);
      if (missing) {
        askForWeights(missing);
        return;
      }
      if (adopted(cause)) return;
      setPhase({ kind: 'failed', message: describe(cause) });
    }
  }

  useEffect(() => {
    void quote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parcel.id]);

  /** Grams onto each variant, then ask the courier again. Every line is
   *  validated BEFORE the first write, so a bad third box cannot leave the
   *  first two saved and the operator unsure what went in. */
  async function saveWeights(lines: ShopCourierMissingWeight[]) {
    const writes: { variantId: string; grams: number }[] = [];
    for (const l of lines) {
      const raw = (weights[l.variantId] ?? '').trim();
      const n = Number(raw);
      if (raw === '' || !Number.isInteger(n) || n <= 0) {
        setError(D.weightsInvalid);
        return;
      }
      writes.push({ variantId: l.variantId, grams: n });
    }
    setBusy(true);
    setError(null);
    try {
      for (const w of writes) await shopApi.updateVariant(w.variantId, { weightGrams: w.grams });
      setBusy(false);
      await quote();
    } catch (cause) {
      setBusy(false);
      setError(describe(cause));
    }
  }

  /** The one call in this dialog that spends money. */
  async function book(q: ShopCourierQuote, optionId: string) {
    setBusy(true);
    setError(null);
    try {
      const f = await shopApi.bookCourier(parcel.id, { optionId, quoteRef: q.quoteRef });
      toast.show(D.booked(q.providerLabel, f.trackingNumber ?? f.providerRef ?? ''));
      onBooked();
    } catch (cause) {
      setBusy(false);
      if (adopted(cause)) return;
      /* A weight cleared between the quote and this click: back to the step
         that fixes it, not a code in a red line. */
      const missing = weightsRefused(cause);
      if (missing) {
        askForWeights(missing);
        return;
      }
      setError(describe(cause));
    }
  }

  /** The item on the left of a weights row — its title over its SKU. */
  const itemName = (l: ShopCourierMissingWeight) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 'var(--t-md)', fontWeight: 'var(--w-medium)' }}>{l.title}</div>
      <div className="muted mono" style={{ fontSize: 'var(--t-sm)' }}>{l.sku}</div>
    </div>
  );

  /* One grams box per line: the item on the left, the number on the right.
     The visible label is "Weight" — short enough to sit over a 9rem box —
     and the accessible name names the item, so a screen reader hears which
     of four boxes it is in. */
  const weightInputs = (lines: ShopCourierMissingWeight[]) => (
    <div className="stack stack--tight">
      {lines.map((l) => (
        <div key={l.variantId} className="row" style={{ gap: 'var(--s3)', alignItems: 'flex-end' }}>
          {itemName(l)}
          <div style={{ width: '9rem' }}>
            <AffixField
              label="Weight"
              aria-label={D.weightLabel(l.title)}
              suffix="g"
              inputMode="numeric"
              value={weights[l.variantId] ?? ''}
              onChange={(e) => {
                setWeights((w) => ({ ...w, [l.variantId]: e.target.value }));
                setError(null);
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );

  /* The same list with NO BOXES, for a viewer who cannot edit products. The
     items are still named because naming them is the whole of what this
     person can do with the screen: pass them to somebody who can weigh them. */
  const itemList = (lines: ShopCourierMissingWeight[]) => (
    <div className="stack stack--tight">
      {lines.map((l) => (
        <div key={l.variantId} className="row" style={{ gap: 'var(--s3)' }}>
          {itemName(l)}
        </div>
      ))}
    </div>
  );

  const footer = (() => {
    if (phase.kind === 'weights') {
      /* NO SAVE AT ALL WITHOUT THE `products` DOMAIN. The only action on this
         step writes a variant, so a Save here is a button whose single
         outcome is a 403 — Cancel is the honest whole of what is available. */
      if (!canWeigh) return <Button onClick={onClose}>Cancel</Button>;
      return (
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void saveWeights(phase.lines)}>
            {D.saveWeights}
          </Button>
        </>
      );
    }
    if (phase.kind === 'options') {
      const q = phase.quote;
      const chosen = phase.chosen;
      return (
        <>
          <Button onClick={onClose}>Cancel</Button>
          {q.missingWeights.length > 0 ? (
            <Button busy={busy} onClick={() => void saveWeights(q.missingWeights)}>
              {D.saveWeights}
            </Button>
          ) : null}
          <Button
            tone="primary"
            busy={busy}
            disabled={!chosen}
            onClick={() => chosen && void book(q, chosen)}
          >
            <Truck aria-hidden="true" />
            {D.bookNow}
          </Button>
        </>
      );
    }
    if (phase.kind === 'failed') {
      return (
        <>
          <Button onClick={onClose}>Close</Button>
          <Button tone="primary" onClick={() => void quote()}>
            Try again
          </Button>
        </>
      );
    }
    return <Button onClick={onClose}>Cancel</Button>;
  })();

  return (
    <Modal title={D.title(providerLabel, index)} onClose={onClose} footer={footer}>
      <div className="stack">
        <p className="muted" style={{ fontSize: 'var(--t-sm)', margin: 0 }}>
          {D.recipient}: {String((order.shippingAddress as { name?: unknown }).name ?? order.email)}{' '}
          · {shortAddress(order.shippingAddress)}
        </p>

        {phase.kind === 'quoting' ? <p style={{ margin: 0 }}>{D.quoting}</p> : null}

        {phase.kind === 'weights' ? (
          <>
            <Banner tone="warn" title={D.weightsTitle}>
              {canWeigh ? D.weightsBlocking : D.weightsNoPermission}
            </Banner>
            {canWeigh ? weightInputs(phase.lines) : itemList(phase.lines)}
          </>
        ) : null}

        {phase.kind === 'options' ? (
          <>
            {phase.quote.missingWeights.length > 0 ? (
              <>
                <Banner tone="warn" title={D.weightsTitle}>
                  {D.weightsSoft(phase.quote.missingWeights.length, phase.quote.weightKg)}
                </Banner>
                {weightInputs(phase.quote.missingWeights)}
              </>
            ) : null}
            <h3 style={{ fontSize: 'var(--t-md)', margin: 0 }}>
              {phase.quote.options.length === 1 ? D.optionsOne : D.optionsTitle}
              <span className="muted"> · {D.weight(phase.quote.weightKg)}</span>
            </h3>
            {phase.quote.options.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                {D.optionsEmpty}
              </p>
            ) : (
              <div className="stack stack--tight" role="radiogroup" aria-label={D.optionsTitle}>
                {phase.quote.options.map((o) => (
                  <Radio
                    key={o.id}
                    name="courier-option"
                    label={
                      <span
                        className="row"
                        style={{ gap: 'var(--s3)', justifyContent: 'space-between', flexWrap: 'wrap' }}
                      >
                        <span>{o.label}</span>
                        <strong className="num">{money(o.amountMinor, o.currency)}</strong>
                      </span>
                    }
                    hint={
                      [o.eta, o.pickupEta ? `pickup ${o.pickupEta}` : null]
                        .filter(Boolean)
                        .join(' · ') || undefined
                    }
                    checked={phase.chosen === o.id}
                    onChange={() => setPhase({ ...phase, chosen: o.id })}
                  />
                ))}
              </div>
            )}
          </>
        ) : null}

        {phase.kind === 'failed' ? (
          <span className="field__error" role="alert">
            {phase.message}
          </span>
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
