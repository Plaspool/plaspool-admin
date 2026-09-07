import { useCallback, useEffect, useState, type InputHTMLAttributes } from 'react';
import { Lock, Settings as SettingsIcon, Truck } from 'lucide-react';
import {
  shopApi,
  type CourierProviderId,
  type ShopCourierPackaging,
  type ShopCourierSettings,
  type ShopShipFrom,
} from '../../data/api-shop';
import { ApiError } from '../../data/errors';
import { getSession } from '../../data/session';
import { hasDomain } from '../../../shared/roles';
import { dateTime } from '../lib/format';
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
const PROVIDERS: CourierProviderId[] = ['manual', 'fez', 'terminal'];

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
            {(['fez', 'terminal'] as const).map((p) => (
              <div key={p} className="row" style={{ gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '14rem' }}>
                  <div style={{ fontWeight: 'var(--w-medium)' }}>{PROVIDER_LABEL[p]}</div>
                  <div className="muted mono" style={{ fontSize: 'var(--t-sm)', wordBreak: 'break-all' }}>{settings.providers[p].webhookUrl}</div>
                </div>
                <Button
                  aria-label={`${C.connect} for ${PROVIDER_LABEL[p]}`}
                  disabled={!settings.providers[p].configured}
                  busy={connecting === p}
                  onClick={() => void connect(p)}
                >
                  {C.connect}
                </Button>
              </div>
            ))}
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
