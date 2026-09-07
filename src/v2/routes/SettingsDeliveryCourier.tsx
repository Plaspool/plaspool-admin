import { useCallback, useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Lock, Settings as SettingsIcon, Truck } from 'lucide-react';
import {
  shopApi,
  type CourierProviderId,
  type ShopCourierDiagnosticRequest,
  type ShopCourierDiagnosticResult,
  type ShopCourierOption,
  type ShopCourierPackaging,
  type ShopCourierSettings,
  type ShopShipFrom,
} from '../../data/api-shop';
import { ApiError } from '../../data/errors';
import { getSession } from '../../data/session';
import { hasDomain } from '../../../shared/roles';
import { dateTime, money } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, EmptyState } from '../ui/primitives';
import { Card } from '../ui/Card';
import { AffixField, TextField } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { COURIER_COPY, PROVIDER_BLURB, PROVIDER_ENV, PROVIDER_LABEL } from './courier-copy';

/**
 * DELIVERY COURIER — `/settings/delivery-courier`: who carries a parcel to the
 * customer, and where they collect it from. One courier at a time, the whole
 * shop, because a parcel is booked against one account.
 *
 * THE TERMINAL MODAL GATES THE SAVE RATHER THAN NARRATING IT (spec §5.3).
 * Choosing Terminal Africa does not even move the selection: it opens the
 * warning, and only *Switch to Terminal* sets the choice — so nothing reaches
 * the server until somebody has read what Terminal needs (a weight on every
 * variant, a complete ship-from, money in the wallet, a connected webhook).
 * Cancelling leaves By hand exactly where it was.
 *
 * A COURIER WITH NO CREDENTIALS IS A DISABLED CARD THAT NAMES ITS ENV VARS.
 * The server would refuse the save with `provider_not_configured`, but a
 * control that flips and then bounces teaches nothing; the only action that
 * fixes this is a deploy, so the card says which variables are missing.
 *
 * THE SHIP-FROM REFUSAL FOR TERMINAL IS DECIDED HERE, BEFORE THE REQUEST. The
 * server keeps its own 409 `ship_from_incomplete` and stays the authority —
 * but the fields are on this screen, so a round trip buys nothing and the
 * refusal reads better attached to the form it is about.
 */

const C = COURIER_COPY.settings;
const D = C.diagnostics;
const PROVIDERS: CourierProviderId[] = ['manual', 'fez', 'terminal'];

/* ═════════════════════════════════════════════════ TEST THIS COURIER ════ */

/**
 * WHY EVERY READ OF A `detail` HERE IS DEFENSIVE.
 *
 * `detail` is a different shape per check and per courier, and it is the half
 * of the answer that carries the finding — the accepted city names, the two
 * legs of a simulation, the draft id the next check needs. A strict read would
 * turn "the courier answered something we have not seen before" into a blank
 * screen with a stack trace behind it, which is exactly the situation this
 * panel exists to get an operator out of. So each reader takes what it
 * recognises and ignores the rest.
 */
const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The names the courier said it WOULD take. The reason the price check exists. */
function readAccepted(detail: unknown): string[] {
  const list = asRecord(detail).accepted;
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
}

function readOptions(detail: unknown): ShopCourierOption[] {
  const list = asRecord(detail).options;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): ShopCourierOption[] => {
    const o = asRecord(entry);
    if (typeof o.id !== 'string' || typeof o.amountMinor !== 'number') return [];
    return [
      {
        id: o.id,
        carrier: typeof o.carrier === 'string' ? o.carrier : '',
        label: typeof o.label === 'string' ? o.label : '',
        amountMinor: o.amountMinor,
        currency: 'NGN',
        ...(typeof o.eta === 'string' ? { eta: o.eta } : {}),
        ...(typeof o.pickupEta === 'string' ? { pickupEta: o.pickupEta } : {}),
      },
    ];
  });
}

/** Terminal's draft, which is the only input `provider_simulate` takes. Null for Fez. */
function readDraftId(detail: unknown): string | null {
  const v = asRecord(detail).shipmentId;
  return typeof v === 'string' && v !== '' ? v : null;
}

/** One half of a simulation: what they said when asked, and what their own log says. */
function readLeg(detail: unknown, key: 'simulate' | 'deliveries'): { ok: boolean; message: string | null } | null {
  const raw = asRecord(detail)[key];
  if (raw === null || typeof raw !== 'object') return null;
  const leg = asRecord(raw);
  return { ok: leg.ok === true, message: typeof leg.message === 'string' ? leg.message : null };
}

type DiagnosticKey = ShopCourierDiagnosticRequest['check'];
/** A finished check — the server's own envelope, or a refusal this screen decided. */
type DiagnosticOutcome = Pick<ShopCourierDiagnosticResult, 'ok' | 'summary' | 'detail'>;

/**
 * A REQUEST THAT COULD NOT BE RUN, IN WORDS.
 *
 * Never `ApiError.message`: `src/data/api.ts` passes no message, so that is
 * the server's CODE — an operator reading `ship_from_incomplete` on a courier
 * screen learns nothing and cannot tell whether they broke it.
 */
function describeCheckFailure(cause: unknown, provider: 'fez' | 'terminal'): string {
  if (cause instanceof ApiError) {
    if (cause.code === 'ship_from_incomplete') return D.shipFromIncomplete;
    if (cause.code === 'provider_not_configured') return C.notSetUp(PROVIDER_ENV[provider]);
    return D.failed;
  }
  /* A network failure DOES carry a sentence, and it is the useful one. */
  return cause instanceof Error && cause.message ? cause.message : D.failed;
}

/**
 * ONE OUTCOME, WITH A NAME.
 *
 * The region exists before the answer does, because a live region announced
 * into existence announces nothing, and it is named after its own button so
 * that four of them on one card are four different places rather than four
 * things called "result".
 *
 * A FAILED CHECK IS A NORMAL OUTCOME and gets a `warn` banner, never an error
 * state: the courier refusing is the finding the operator pressed the button
 * to get, and dressing it as a breakage would send them looking for a bug in
 * this admin instead of reading the sentence.
 */
function Outcome({ name, result, children }: { name: string; result?: DiagnosticOutcome; children?: ReactNode }) {
  return (
    <div role="status" aria-label={D.outcome(name)}>
      {result ? (
        <div className="stack stack--tight">
          {result.ok ? (
            <p style={{ margin: 0, fontSize: 'var(--t-sm)' }}>{result.summary}</p>
          ) : (
            <Banner tone="warn">{result.summary}</Banner>
          )}
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * WHAT A PRICE CHECK FOUND — the rates, or the names it would have taken.
 *
 * `detail.accepted` IS THE POINT OF THE WHOLE CHECK. Terminal answers an
 * unknown city with the list it would have accepted; printing that list is how
 * an operator learns that "Gwarinpa" is not a city Terminal knows and
 * "Maitama" is, which until now could only be discovered by failing a live
 * booking.
 */
function QuoteDetail({ result }: { result: DiagnosticOutcome }) {
  const options = readOptions(result.detail);
  const accepted = readAccepted(result.detail);
  if (options.length === 0 && accepted.length === 0) return null;
  return (
    <div className="stack stack--tight">
      {options.map((o) => (
        <div key={o.id} className="row" style={{ gap: 'var(--s3)', alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: '10rem' }}>
            <span style={{ fontWeight: 'var(--w-medium)' }}>{o.label || o.carrier}</span>
            {o.label && o.carrier && o.label !== o.carrier ? (
              <span className="muted" style={{ fontSize: 'var(--t-sm)', display: 'block' }}>{o.carrier}</span>
            ) : null}
          </span>
          <span style={{ fontWeight: 'var(--w-semi)' }}>{money(o.amountMinor, o.currency)}</span>
          {o.eta ? <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>{o.eta}</span> : null}
          {o.pickupEta ? <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>{o.pickupEta}</span> : null}
        </div>
      ))}
      {accepted.length > 0 ? (
        <>
          <p style={{ margin: 0, fontSize: 'var(--t-sm)', fontWeight: 'var(--w-medium)' }}>{D.accepted}</p>
          <div className="row" style={{ gap: 'var(--s2)', flexWrap: 'wrap' }}>
            {accepted.map((name) => (
              <Badge key={name}>{name}</Badge>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * BOTH LEGS OF A SIMULATION, ALWAYS.
 *
 * Terminal's simulator answers "queued" and its own delivery log then reports
 * an error — those two have been disagreeing in the sandbox all along, and
 * either half alone reads as the opposite of the truth. The pair is what goes
 * into the support ticket, so the pair is what gets rendered.
 */
function SimulateDetail({ result }: { result: DiagnosticOutcome }) {
  const legs = (
    [
      [D.simulateAsked, readLeg(result.detail, 'simulate')],
      [D.simulateLog, readLeg(result.detail, 'deliveries')],
    ] as const
  ).flatMap(([name, leg]) => (leg ? [{ name, leg }] : []));
  if (legs.length === 0) return null;
  return (
    <div className="stack stack--tight">
      {legs.map(({ name, leg }) => (
        <div key={name} className="row" style={{ gap: 'var(--s2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 'var(--w-medium)' }}>{name}</span>
          <Badge tone={leg.ok ? 'ok' : 'warn'}>{leg.ok ? D.legOk : D.legBad}</Badge>
          <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>{leg.message ?? D.simulateSilent}</span>
        </div>
      ))}
    </div>
  );
}

type ShipFromDraft = Record<keyof Omit<ShopShipFrom, 'countryCode'>, string>;
const EMPTY_SHIP_FROM: ShipFromDraft = { name: '', phone: '', email: '', line1: '', line2: '', city: '', region: '', postalCode: '' };
const REQUIRED_SHIP_FROM: (keyof ShipFromDraft)[] = ['name', 'phone', 'line1', 'city', 'region', 'postalCode'];

function toDraft(from: ShopShipFrom | null): ShipFromDraft {
  if (!from) return EMPTY_SHIP_FROM;
  return {
    name: from.name, phone: from.phone, email: from.email ?? '', line1: from.line1, line2: from.line2 ?? '',
    city: from.city, region: from.region, postalCode: from.postalCode,
  };
}

/** `null` when every field is blank (nothing to send); the address when complete; a list of missing keys otherwise. */
function fromDraft(d: ShipFromDraft): { value: ShopShipFrom | null } | { missing: (keyof ShipFromDraft)[] } {
  const blank = Object.values(d).every((v) => v.trim() === '');
  if (blank) return { value: null };
  const missing = REQUIRED_SHIP_FROM.filter((k) => d[k].trim() === '');
  if (missing.length > 0) return { missing };
  return {
    value: {
      name: d.name.trim(), phone: d.phone.trim(), line1: d.line1.trim(), city: d.city.trim(),
      region: d.region.trim(), postalCode: d.postalCode.trim(), countryCode: 'NG',
      ...(d.email.trim() ? { email: d.email.trim() } : {}),
      ...(d.line2.trim() ? { line2: d.line2.trim() } : {}),
    },
  };
}

export default function SettingsDeliveryCourier() {
  const toast = useToast();
  /* The settings domain is owner/developer territory (shared/roles.ts) — the
     same graceful absence Team and Shipping render. */
  const session = getSession();
  const viewer = 'user' in session ? session.user : null;
  const scoped = viewer !== null && hasDomain(viewer.role, 'settings');

  const [settings, setSettings] = useState<ShopCourierSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [provider, setProvider] = useState<CourierProviderId>('manual');
  const [shipFrom, setShipFrom] = useState<ShipFromDraft>(EMPTY_SHIP_FROM);
  const [packaging, setPackaging] = useState<Record<keyof ShopCourierPackaging, string>>({ name: '', lengthCm: '', widthCm: '', heightCm: '', weightKg: '' });
  const [terminalModal, setTerminalModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState<'fez' | 'terminal' | null>(null);

  /* ── Test this courier ─────────────────────────────────────────────────
     A busy flag and a result PER CHECK, not one of each: these four ask four
     unrelated questions, and a single result slot would have the answer to
     "can this admin hear back" quietly replace the list of city names the
     operator is halfway through reading. */
  const [diagBusy, setDiagBusy] = useState<Partial<Record<DiagnosticKey, boolean>>>({});
  const [diagOut, setDiagOut] = useState<Partial<Record<DiagnosticKey, DiagnosticOutcome>>>({});
  /**
   * `region: null` means "follow the ship-from address", so the test state
   * defaults to the one the shop actually ships from and keeps following it
   * until somebody types a different one. Blank when there is no ship-from.
   */
  const [diagTo, setDiagTo] = useState<{ line1: string; city: string; region: string | null; postalCode: string; weightGrams: string }>(
    { line1: '', city: '', region: null, postalCode: '', weightGrams: '' },
  );
  /** Terminal's draft from the last price that produced one — `provider_simulate`'s only input. */
  const [draftId, setDraftId] = useState<string | null>(null);

  const adopt = useCallback((s: ShopCourierSettings) => {
    setSettings(s);
    setProvider(s.provider);
    setShipFrom(toDraft(s.shipFrom));
    setPackaging({
      name: s.packaging.name, lengthCm: String(s.packaging.lengthCm), widthCm: String(s.packaging.widthCm),
      heightCm: String(s.packaging.heightCm), weightKg: String(s.packaging.weightKg),
    });
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      adopt(await shopApi.getCourierSettings(signal));
      setLoadError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setLoadError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
    }
  }, [adopt]);

  /**
   * WHAT CONNECT WEBHOOK IS ALLOWED TO RE-READ, AND WHAT IT MUST NOT TOUCH.
   *
   * Registering a webhook changes exactly one thing this screen shows: the
   * list of inbound updates (and, in time, the connected flags). Re-adopting
   * the whole settings response would ALSO reset `provider`, `shipFrom` and
   * `packaging` from the server — silently throwing away every edit the
   * operator has typed and not saved, which on this screen is usually the
   * ship-from address they came here to fill in before connecting.
   *
   * `revision` is deliberately NOT adopted either: it is the base of the next
   * save's compare-and-swap, and quietly moving it forward would let this tab
   * overwrite a change another person made while this form sat open.
   */
  const refreshWebhookLog = useCallback(async () => {
    try {
      const fresh = await shopApi.getCourierSettings();
      setSettings((current) =>
        current === null
          ? current
          : {
              ...current,
              providers: fresh.providers,
              recentWebhooks: fresh.recentWebhooks,
              variantsMissingWeight: fresh.variantsMissingWeight,
              variantsTotal: fresh.variantsTotal,
              updatedAt: fresh.updatedAt,
            },
      );
    } catch {
      /* The webhook IS registered — the toast already said so. A failed
         re-read of the log is not worth a second, contradicting message; the
         list catches up on the next load. */
    }
  }, []);

  useEffect(() => {
    if (!scoped) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, scoped]);

  if (!scoped) {
    return (
      <div className="page">
        <PageHeader icon={<SettingsIcon />} title={C.title} backTo="/settings" backLabel="Settings" />
        <div className="card">
          <EmptyState icon={<Lock />} title={C.onlyOwners} body={C.onlyOwnersBody} />
        </div>
      </div>
    );
  }

  function choose(next: CourierProviderId) {
    setError(null);
    /* The warning comes BEFORE the choice moves, not before the save: a
       selection that sits switched on while the reader is still reading is a
       state somebody can walk away from. */
    if (next === 'terminal' && provider !== 'terminal') {
      setTerminalModal(true);
      return;
    }
    setProvider(next);
  }

  async function save() {
    if (!settings) return;
    const from = fromDraft(shipFrom);
    if ('missing' in from) {
      setMissing(from.missing);
      setError(provider === 'terminal' ? C.shipFromIncomplete : 'Finish the ship-from address, or clear it.');
      return;
    }
    if (provider === 'terminal' && from.value === null) {
      setMissing(REQUIRED_SHIP_FROM);
      setError(C.shipFromIncomplete);
      return;
    }
    const pack: ShopCourierPackaging = {
      name: packaging.name.trim() || settings.packaging.name,
      lengthCm: Number(packaging.lengthCm), widthCm: Number(packaging.widthCm),
      heightCm: Number(packaging.heightCm), weightKg: Number(packaging.weightKg),
    };
    for (const k of ['lengthCm', 'widthCm', 'heightCm', 'weightKg'] as const) {
      if (!Number.isFinite(pack[k]) || pack[k] <= 0) {
        setError('Packaging sizes are numbers above 0.');
        return;
      }
    }
    setMissing([]);
    setBusy(true);
    setError(null);
    try {
      adopt(await shopApi.saveCourierSettings({ expectedRevision: settings.revision, provider, shipFrom: from.value, packaging: pack }));
      toast.show(C.saved);
    } catch (cause) {
      /* `stale_write` AND `conflict`: the settings CAS answers the former
         (`repo.ts` raises `StaleWriteError`) and the shop's other settings
         routes answer the latter. They are the same sentence to the reader. */
      if (cause instanceof ApiError && (cause.code === 'conflict' || cause.code === 'stale_write')) setError(C.conflict);
      else if (cause instanceof ApiError && cause.code === 'ship_from_incomplete') {
        setError(C.shipFromIncomplete);
        const body = cause.body as { missing?: string[] } | undefined;
        setMissing(body?.missing ?? REQUIRED_SHIP_FROM);
      } else if (cause instanceof ApiError && cause.code === 'provider_not_configured') {
        const p = (cause.body as { provider?: 'fez' | 'terminal' } | undefined)?.provider ?? (provider as 'fez' | 'terminal');
        setError(C.notSetUp(PROVIDER_ENV[p]));
      } else setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function connect(p: 'fez' | 'terminal') {
    setConnecting(p);
    try {
      await shopApi.registerCourierWebhook(p);
      toast.show(C.connected_toast(PROVIDER_LABEL[p]));
      void refreshWebhookLog();
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
    } finally {
      setConnecting(null);
    }
  }

  /**
   * RUN ONE CHECK.
   *
   * A courier refusing arrives here as a normal RETURN (200, `ok: false`) and
   * is rendered as the finding it is. The only throws are requests that could
   * not be run at all, and the two that a person can fix from this screen get
   * their own sentence — `ship_from_incomplete` also MARKS the fields it is
   * about, because a sentence pointing at a card is weaker than the card
   * pointing at itself.
   */
  async function runCheck(body: ShopCourierDiagnosticRequest) {
    const key = body.check;
    setDiagBusy((b) => ({ ...b, [key]: true }));
    try {
      const result = await shopApi.runCourierDiagnostic(body);
      setDiagOut((o) => ({ ...o, [key]: result }));
      /* Kept only when a price actually produced one: a refusal that minted no
         draft must not disarm a button the previous price legitimately armed. */
      const draft = result.check === 'quote' ? readDraftId(result.detail) : null;
      if (draft) setDraftId(draft);
    } catch (cause) {
      setDiagOut((o) => ({ ...o, [key]: { ok: false, summary: describeCheckFailure(cause, body.provider) } }));
      if (cause instanceof ApiError && cause.code === 'ship_from_incomplete') {
        const detail = cause.body as { missing?: string[] } | undefined;
        setMissing(detail?.missing ?? REQUIRED_SHIP_FROM);
      }
    } finally {
      setDiagBusy((b) => ({ ...b, [key]: false }));
    }
  }

  /** The price check's own guard, so a body the server's `.strict()` Zod would
   *  reject with a code never leaves this screen. */
  function askForPrice(p: 'fez' | 'terminal') {
    const to = {
      line1: diagTo.line1.trim(),
      city: diagTo.city.trim(),
      region: (diagTo.region ?? shipFrom.region).trim(),
    };
    const postalCode = diagTo.postalCode.trim();
    const grams = diagTo.weightGrams.trim();
    if (!to.line1 || !to.city || !to.region) {
      setDiagOut((o) => ({ ...o, quote: { ok: false, summary: D.addressIncomplete } }));
      return;
    }
    if (grams !== '' && (!/^\d+$/.test(grams) || Number(grams) <= 0)) {
      setDiagOut((o) => ({ ...o, quote: { ok: false, summary: D.weightInvalid } }));
      return;
    }
    void runCheck({
      check: 'quote',
      provider: p,
      to: { ...to, ...(postalCode ? { postalCode } : {}) },
      ...(grams ? { weightGrams: Number(grams) } : {}),
    });
  }

  /** The courier the four checks would ask, or `null` when there is nobody to ask. */
  const testable: 'fez' | 'terminal' | null =
    provider !== 'manual' && settings !== null && settings.providers[provider].configured ? provider : null;

  const field = (
    key: keyof ShipFromDraft,
    label: string,
    extra: Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'value' | 'onChange'> = {},
  ) => (
    <TextField
      label={label}
      value={shipFrom[key]}
      error={missing.includes(key) ? 'Required' : null}
      onChange={(e) => {
        setShipFrom((d) => ({ ...d, [key]: e.target.value }));
        setError(null);
      }}
      {...extra}
    />
  );

  return (
    <div className="page">
      <PageHeader
        icon={<Truck />}
        title={C.title}
        backTo="/settings"
        backLabel="Settings"
        subtitle={C.subtitle}
        actions={
          <Button tone="primary" size="lg" busy={busy} disabled={!settings} onClick={() => void save()}>
            {C.save}
          </Button>
        }
      />

      {loadError ? (
        <Banner tone="critical" title="Couldn’t load the courier settings" action={<Button onClick={() => void load()}>Retry</Button>}>
          {loadError}
        </Banner>
      ) : null}

      {settings ? (
        <>
          <Card title={C.choiceLegend}>
            <div className="stack stack--tight" role="radiogroup" aria-label={C.choiceLegend}>
              {PROVIDERS.map((p) => {
                const status = p === 'manual' ? null : settings.providers[p];
                const off = status !== null && !status.configured;
                /* BOOKABLE BUT DEAF — see `webhookNotReady`. Not `off`: the
                   courier works for everything this card decides, and greying
                   it out would stop a shop booking parcels over a status feed
                   it can live without for a day. */
                const deaf = status !== null && status.configured && !status.webhookReady;
                const picked = provider === p;
                return (
                  <label
                    key={p}
                    className="check"
                    style={{
                      alignItems: 'flex-start',
                      border: `1px solid ${picked ? 'var(--ink-strong)' : 'var(--border)'}`,
                      borderRadius: 'var(--r-md)',
                      padding: 'var(--s3)',
                      background: picked ? 'var(--surface-sunken)' : 'transparent',
                      opacity: off ? 0.7 : 1,
                    }}
                  >
                    <input type="radio" name="courier" checked={picked} disabled={off} onChange={() => choose(p)} />
                    <span>
                      <span className="row" style={{ gap: 'var(--s2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 'var(--w-semi)' }}>{PROVIDER_LABEL[p]}</span>
                        {status ? (
                          <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>
                            {status.configured
                              ? `${C.envLine(status.environment)} · ${C.connected}`
                              : C.notSetUp(PROVIDER_ENV[p as 'fez' | 'terminal'])}
                          </span>
                        ) : null}
                      </span>
                      <span className="field__hint" style={{ display: 'block', marginTop: 2 }}>
                        {PROVIDER_BLURB[p]}
                      </span>
                      {deaf ? (
                        <span className="field__error" style={{ display: 'block', marginTop: 4 }}>
                          {C.webhookNotReady(p as 'fez' | 'terminal')}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
          </Card>

          <Card title={C.shipFromTitle}>
            <p className="muted" style={{ fontSize: 'var(--t-sm)', margin: 0 }}>{C.shipFromHint}</p>
            <div className="row" style={{ gap: 'var(--s3)', alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>{field('name', 'Name')}</div>
              <div style={{ flex: 1 }}>{field('phone', 'Phone', { inputMode: 'tel', placeholder: '+234…' })}</div>
            </div>
            {field('email', 'Email', { type: 'email' })}
            {field('line1', 'Address line 1')}
            {field('line2', 'Address line 2')}
            <div className="row" style={{ gap: 'var(--s3)', alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>{field('city', 'City')}</div>
              <div style={{ flex: 1 }}>{field('region', 'State', { placeholder: 'Lagos, FCT…' })}</div>
              <div style={{ flex: 1 }}>{field('postalCode', 'Postal code')}</div>
            </div>
          </Card>

          {provider === 'terminal' ? (
            <Card title={C.packagingTitle}>
              <p className="muted" style={{ fontSize: 'var(--t-sm)', margin: 0 }}>{C.packagingHint}</p>
              <TextField label="Box name" value={packaging.name} onChange={(e) => setPackaging((p) => ({ ...p, name: e.target.value }))} />
              <div className="row" style={{ gap: 'var(--s3)', alignItems: 'flex-start' }}>
                {(['lengthCm', 'widthCm', 'heightCm'] as const).map((k) => (
                  <div key={k} style={{ flex: 1 }}>
                    <AffixField
                      label={k === 'lengthCm' ? 'Length' : k === 'widthCm' ? 'Width' : 'Height'}
                      suffix="cm"
                      inputMode="decimal"
                      value={packaging[k]}
                      onChange={(e) => setPackaging((p) => ({ ...p, [k]: e.target.value }))}
                    />
                  </div>
                ))}
                <div style={{ flex: 1 }}>
                  <AffixField label="Empty weight" suffix="kg" inputMode="decimal" value={packaging.weightKg} onChange={(e) => setPackaging((p) => ({ ...p, weightKg: e.target.value }))} />
                </div>
              </div>
            </Card>
          ) : null}

          <Card title={C.webhooksTitle}>
            <p className="muted" style={{ fontSize: 'var(--t-sm)', margin: 0 }}>{C.webhooksHint}</p>
            {(['fez', 'terminal'] as const).map((p) => {
              /* NO SIGNING KEY, NO BUTTON. Registering the URL would succeed
                 and every callback it produced would then be refused as
                 unverifiable — a "connected" state that quietly means the
                 opposite. The reason travels with the control, and the same
                 sentence sits on the courier's card above. */
              const deaf = settings.providers[p].configured && !settings.providers[p].webhookReady;
              return (
                <div key={p} className="row" style={{ gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: '14rem' }}>
                    <div style={{ fontWeight: 'var(--w-medium)' }}>{PROVIDER_LABEL[p]}</div>
                    <div className="muted mono" style={{ fontSize: 'var(--t-sm)', wordBreak: 'break-all' }}>{settings.providers[p].webhookUrl}</div>
                  </div>
                  <Button
                    aria-label={`${C.connect} for ${PROVIDER_LABEL[p]}`}
                    title={deaf ? C.webhookNotReady(p) : undefined}
                    disabled={!settings.providers[p].configured || deaf}
                    busy={connecting === p}
                    onClick={() => void connect(p)}
                  >
                    {C.connect}
                  </Button>
                </div>
              );
            })}
            <h3 style={{ fontSize: 'var(--t-md)', margin: 0 }}>{C.recentTitle}</h3>
            {settings.recentWebhooks.length === 0 ? (
              <p className="muted" style={{ fontSize: 'var(--t-sm)', margin: 0 }}>{C.recentEmpty}</p>
            ) : (
              <div className="tscroll">
                <table className="table">
                  <caption className="sr">{C.recentTitle}</caption>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Courier</th>
                      <th scope="col">Reference</th>
                      <th scope="col">Status</th>
                      <th scope="col">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settings.recentWebhooks.map((w) => (
                      <tr key={w.id}>
                        <td>{dateTime(w.receivedAt)}</td>
                        <td>{PROVIDER_LABEL[w.provider]}</td>
                        <td className="mono">{w.providerRef ?? '—'}</td>
                        <td>{w.rawStatus ?? '—'}</td>
                        <td>
                          <Badge tone={w.applied === 'applied' ? 'ok' : w.applied === 'rejected' ? 'critical' : 'warn'}>
                            {w.verified ? w.applied : 'bad signature'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/*
            TEST THIS COURIER — after the webhooks card, because two of the
            four checks are about the address printed on it, and only for a
            courier that is actually set up here: everything below asks the
            server to talk to a courier, and with no credentials all four
            would answer the same 409 the card above already explains.
          */}
          {testable ? (
            <Card title={D.title}>
              <p className="muted" style={{ fontSize: 'var(--t-sm)', margin: 0 }}>{D.hint}</p>

              <div className="stack stack--tight">
                <div className="row" style={{ gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Button
                    busy={diagBusy.connection === true}
                    onClick={() => void runCheck({ check: 'connection', provider: testable })}
                  >
                    {D.connection}
                  </Button>
                  <span className="field__hint">{D.connectionHint}</span>
                </div>
                <Outcome name={D.connection} result={diagOut.connection} />
              </div>

              <div className="stack stack--tight">
                <p className="muted" style={{ fontSize: 'var(--t-sm)', margin: 0 }}>{D.quoteHint}</p>
                <div className="row" style={{ gap: 'var(--s3)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ flex: 2, minWidth: '12rem' }}>
                    <TextField
                      label={D.addressLine}
                      value={diagTo.line1}
                      onChange={(e) => setDiagTo((d) => ({ ...d, line1: e.target.value }))}
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: '8rem' }}>
                    <TextField
                      label={D.city}
                      value={diagTo.city}
                      onChange={(e) => setDiagTo((d) => ({ ...d, city: e.target.value }))}
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: '8rem' }}>
                    <TextField
                      label={D.region}
                      value={diagTo.region ?? shipFrom.region}
                      onChange={(e) => setDiagTo((d) => ({ ...d, region: e.target.value }))}
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: '8rem' }}>
                    <TextField
                      label={D.postalCode}
                      value={diagTo.postalCode}
                      onChange={(e) => setDiagTo((d) => ({ ...d, postalCode: e.target.value }))}
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: '8rem' }}>
                    <TextField
                      label={D.weight}
                      hint={D.weightHint}
                      inputMode="numeric"
                      value={diagTo.weightGrams}
                      onChange={(e) => setDiagTo((d) => ({ ...d, weightGrams: e.target.value }))}
                    />
                  </div>
                </div>
                <div>
                  <Button busy={diagBusy.quote === true} onClick={() => askForPrice(testable)}>
                    {D.quote}
                  </Button>
                </div>
                <Outcome name={D.quote} result={diagOut.quote}>
                  {diagOut.quote ? <QuoteDetail result={diagOut.quote} /> : null}
                </Outcome>
              </div>

              <div className="stack stack--tight">
                <div className="row" style={{ gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Button
                    busy={diagBusy.webhook_self_test === true}
                    onClick={() => void runCheck({ check: 'webhook_self_test', provider: testable })}
                  >
                    {D.selfTest}
                  </Button>
                  <span className="field__hint">{D.selfTestHint}</span>
                </div>
                <Outcome name={D.selfTest} result={diagOut.webhook_self_test} />
              </div>

              {/* Terminal alone: Fez has no simulator, so the button would be a
                  request the server refuses by its schema rather than a check. */}
              {testable === 'terminal' ? (
                <div className="stack stack--tight">
                  <div className="row" style={{ gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' }}>
                    <Button
                      busy={diagBusy.provider_simulate === true}
                      disabled={draftId === null}
                      onClick={() =>
                        draftId === null
                          ? undefined
                          : void runCheck({ check: 'provider_simulate', provider: 'terminal', shipmentId: draftId })
                      }
                    >
                      {D.simulate}
                    </Button>
                    <span className="field__hint">{D.simulateHint}</span>
                  </div>
                  <Outcome name={D.simulate} result={diagOut.provider_simulate}>
                    {diagOut.provider_simulate ? <SimulateDetail result={diagOut.provider_simulate} /> : null}
                  </Outcome>
                </div>
              ) : null}
            </Card>
          ) : null}

          {error ? (
            <span className="field__error" role="alert">
              {error}
            </span>
          ) : null}
        </>
      ) : null}

      {terminalModal && settings ? (
        <Modal
          title={C.terminalModal.title}
          onClose={() => setTerminalModal(false)}
          footer={
            <>
              <Button onClick={() => setTerminalModal(false)}>{C.terminalModal.cancel}</Button>
              <Button
                tone="primary"
                onClick={() => {
                  setTerminalModal(false);
                  setProvider('terminal');
                }}
              >
                {C.terminalModal.confirm}
              </Button>
            </>
          }
        >
          <div className="stack stack--tight" style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
            <p style={{ margin: 0 }}>{C.terminalModal.intro}</p>
            <ul style={{ margin: 0, paddingLeft: 'var(--s5)' }}>
              <li>{C.terminalModal.weights(settings.variantsMissingWeight, settings.variantsTotal)}</li>
              <li>{C.terminalModal.shipFrom}</li>
              <li>{C.terminalModal.wallet}</li>
              <li>{C.terminalModal.webhook}</li>
            </ul>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
