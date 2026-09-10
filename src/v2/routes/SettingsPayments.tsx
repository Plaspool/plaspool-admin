import { useCallback, useEffect, useState } from 'react';
import { CreditCard, Lock } from 'lucide-react';
import {
  shopApi,
  type PaymentGatewaySettings,
  type PaymentProviderName,
  type PaymentSettings,
  type PaymentSettingsPatch,
} from '../../data/api-shop';
import { StaleWriteError } from '../../data/errors';
import { getSession } from '../../data/session';
import { hasDomain } from '../../../shared/roles';
import { PageHeader } from '../ui/Page';
import { Banner, Button, EmptyState, Loading } from '../ui/primitives';
import { Card } from '../ui/Card';
import { Checkbox, SelectField } from '../ui/Field';
import { useToast } from '../ui/Toast';

/**
 * HOW CUSTOMERS PAY — `/settings/payments`: which gateway takes a charge,
 * which one takes an order from outside Nigeria, and which currencies each
 * one is switched on for. `server/shop/payments/routes.ts`'s
 * `paymentSettingsResponse` is the frozen shape this screen is built
 * against — `GET` and `PATCH` answer the identical object, so every write
 * below re-renders from the response rather than guessing what it saved.
 *
 * SAVES ON CHANGE, the `defaultReturnProgramId` / "Where we ship" precedent
 * (`SpoolsRates.tsx`, `SettingsShipping.tsx`): there is no Save button,
 * every control commits on its own, and the write is CAS on `revision`. A
 * lost race (`StaleWriteError`, 409) re-reads rather than retries — someone
 * else's change is a real change, and overwriting it silently is exactly
 * the failure the revision exists to prevent.
 *
 * ⚠ EVERY `commit()` CALL BUILDS ITS PATCH BODY AS A FRESH OBJECT LITERAL,
 * never by spreading a shared partial. The server tells "leave alone" from
 * "clear" by whether `internationalProvider` is PRESENT on the body, so an
 * `undefined` sitting under a real key would silently clear the country
 * rule on a save that never meant to touch it (`routes.ts`'s own header has
 * the account). Each handler below names only the field it means.
 *
 * THE "NO KEY" WARNING IS ABOUT A SELECTED GATEWAY, NOT ANY UNCONFIGURED
 * ONE. `hasKey: false` on a gateway nobody has switched to is unremarkable —
 * plenty of shops never turn Flutterwave on at all. It only matters once
 * that gateway is `activeProvider` or `internationalProvider`, because THAT
 * is the state that can take the shop offline the moment a real order tries
 * to route there.
 *
 * `canCharge` BOUNDS THE CHECKBOXES, `currencies` IS WHAT IS ACTUALLY
 * SWITCHED ON. Paystack's adapter cannot charge cedis at all — offering the
 * box would let the owner "switch on" a currency that would fail on every
 * order — so each gateway's editor only ever renders `canCharge`'s codes.
 */

const GATEWAY_NAMES: readonly PaymentProviderName[] = ['paystack', 'flutterwave'];

const GATEWAY_LABEL: Record<PaymentProviderName, string> = {
  paystack: 'Paystack',
  flutterwave: 'Flutterwave',
};

function isProviderName(value: string): value is PaymentProviderName {
  return (GATEWAY_NAMES as readonly string[]).includes(value);
}

/**
 * Plain English for every currency either gateway's API can charge
 * (`provider/paystack.ts`'s two, `provider/flutterwave.ts`'s fourteen), so a
 * checkbox and a summary sentence read as words rather than codes. Anything
 * not named here still renders — as its own bare code — rather than
 * disappearing; a gateway can widen its ceiling before this map catches up.
 */
const CURRENCY_NAME: Record<string, string> = {
  NGN: 'naira',
  USD: 'dollars',
  GBP: 'pounds',
  EUR: 'euros',
  GHS: 'cedis',
  KES: 'Kenyan shillings',
  UGX: 'Ugandan shillings',
  TZS: 'Tanzanian shillings',
  ZAR: 'rand',
  XOF: 'West African CFA francs',
  XAF: 'Central African CFA francs',
  RWF: 'Rwandan francs',
  ZMW: 'Zambian kwacha',
  EGP: 'Egyptian pounds',
};

const currencyName = (code: string): string => CURRENCY_NAME[code] ?? code;

const capFirst = (s: string): string => (s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1));

/** `['naira']` → "naira". `['naira','dollars']` → "naira and dollars".
 *  `['naira','dollars','pounds']` → "naira, dollars and pounds" — no comma
 *  before the last one, matching the copy this screen is required to show. */
function joinNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "Switched on for naira." / "Switched on for naira, dollars and pounds." —
 *  §7's phrase for on-or-off, never "active" or "enabled". */
function switchedOnSentence(codes: string[]): string {
  if (codes.length === 0) return 'Not switched on for any currency yet.';
  return `Switched on for ${joinNames(codes.map(currencyName))}.`;
}

/** A `Partial<Record<...>>` with exactly one key, built without a computed
 *  property — so there is no risk of a mistyped gateway name compiling into
 *  the wrong key silently. */
function currencyPatchFor(
  name: PaymentProviderName,
  codes: string[],
): Partial<Record<PaymentProviderName, string[]>> {
  return name === 'paystack' ? { paystack: codes } : { flutterwave: codes };
}

export default function SettingsPayments() {
  const toast = useToast();
  /* The `payments` domain is owner/developer only — the same graceful
     absence Shipping, Notifications and Team render, instead of a screen of
     controls that all 403 (shared/roles.ts). */
  const session = getSession();
  const viewer = 'user' in session ? session.user : null;
  const scoped = viewer !== null && hasDomain(viewer.role, 'payments');

  const [settings, setSettings] = useState<PaymentSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /* Set only by a lost CAS, cleared the moment another change is tried —
     the banner it draws is about one refusal, not a standing condition. */
  const [conflict, setConflict] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await shopApi.getPaymentSettings(signal);
      setSettings(next);
      setLoadError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setLoadError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
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
        <PageHeader
          icon={<CreditCard />}
          title="Payments"
          backTo="/settings"
          backLabel="Settings"
        />
        <div className="card">
          <EmptyState
            icon={<Lock />}
            title="Only the owner and developers can change this"
            body="This decides which gateway takes the money for a real order, so only the owner and developers can change it."
          />
        </div>
      </div>
    );
  }

  /**
   * Every field on this screen commits through here. `saving` is a single
   * flag for the whole card rather than one per control: the card writes to
   * one row, so at most one write is ever in flight, and guarding here
   * (rather than trusting every caller to disable its own control) is what
   * stops two rapid changes racing each other onto the same `revision`.
   */
  async function commit(change: Omit<PaymentSettingsPatch, 'revision'>) {
    if (!settings || saving) return;
    setSaving(true);
    setConflict(false);
    try {
      const next = await shopApi.savePaymentSettings({ ...change, revision: settings.revision });
      setSettings(next);
    } catch (cause) {
      if (cause instanceof StaleWriteError) {
        /* THEIRS WINS. Re-sending with the fresh revision would silently
           overwrite whatever they changed with a click this person never
           made — the banner is what makes that honest instead of a dead
           screen that quietly did nothing. */
        setConflict(true);
        await load();
      } else {
        toast.show(
          cause instanceof Error && cause.message ? cause.message : 'Something went wrong.',
          'critical',
        );
      }
    } finally {
      setSaving(false);
    }
  }

  function toggleCurrency(name: PaymentProviderName, code: string, checked: boolean) {
    if (!settings) return;
    const current = settings.gateways[name].currencies;
    const next = checked ? [...current, code] : current.filter((c) => c !== code);
    void commit({ currencies: currencyPatchFor(name, next) });
  }

  /* Which gateways are actually SELECTED right now (as either role) and lack
     a key — the state that can take the shop offline, not merely a gateway
     nobody has switched to yet. */
  const missingKeySelections = settings
    ? GATEWAY_NAMES.filter(
        (name) =>
          !settings.gateways[name].hasKey &&
          (settings.activeProvider === name || settings.internationalProvider === name),
      )
    : [];

  return (
    <div className="page">
      <PageHeader
        icon={<CreditCard />}
        title="Payments"
        backTo="/settings"
        backLabel="Settings"
        subtitle="Which gateway takes a payment, and which currencies each one can charge."
      />

      {loadError ? (
        <Banner
          tone="critical"
          title="Couldn’t load payment settings"
          action={<Button onClick={() => void load()}>Retry</Button>}
        >
          {loadError}
        </Banner>
      ) : null}

      {conflict ? (
        <Banner tone="warn" title="Somebody else changed this while you had it open">
          Their version is on screen now. Check it before changing anything else.
        </Banner>
      ) : null}

      {missingKeySelections.map((name) => (
        <Banner key={name} tone="warn">
          {`${GATEWAY_LABEL[name]} has no key set on this deployment. Orders sent there will fail.`}
        </Banner>
      ))}

      {settings === null ? (
        loadError ? null : (
          <Card title="How customers pay">
            <Loading what="payment settings" />
          </Card>
        )
      ) : (
        <Card title="How customers pay">
          <SelectField
            label="Card payments go through"
            value={settings.activeProvider}
            disabled={saving}
            onChange={(e) => {
              const value = e.target.value;
              if (!isProviderName(value)) return;
              void commit({ activeProvider: value });
            }}
          >
            {GATEWAY_NAMES.map((name) => (
              <option key={name} value={name}>
                {GATEWAY_LABEL[name]}
              </option>
            ))}
          </SelectField>

          <SelectField
            label="Orders from outside Nigeria go through"
            value={settings.internationalProvider ?? ''}
            disabled={saving}
            onChange={(e) => {
              const value = e.target.value;
              if (value === '') {
                void commit({ internationalProvider: null });
                return;
              }
              if (!isProviderName(value)) return;
              void commit({ internationalProvider: value });
            }}
          >
            <option value="">Same as above</option>
            {GATEWAY_NAMES.map((name) => (
              <option key={name} value={name}>
                {GATEWAY_LABEL[name]}
              </option>
            ))}
          </SelectField>

          {GATEWAY_NAMES.map((name) => (
            <CurrencyEditor
              key={name}
              name={name}
              gateway={settings.gateways[name]}
              saving={saving}
              onToggle={(code, checked) => toggleCurrency(name, code, checked)}
            />
          ))}
        </Card>
      )}

      <p className="page__learn">
        A gateway switched off here refuses nothing already in flight — an order already paid for
        keeps the gateway it was actually charged through.
      </p>
    </div>
  );
}

/** One gateway's currency editor: its checkboxes, bounded by `canCharge`, and
 *  the plain-words summary of what is actually switched on. */
function CurrencyEditor({
  name,
  gateway,
  saving,
  onToggle,
}: {
  name: PaymentProviderName;
  gateway: PaymentGatewaySettings;
  saving: boolean;
  onToggle: (code: string, checked: boolean) => void;
}) {
  return (
    <div className="stack stack--tight">
      <h3 style={{ fontSize: 'var(--t-md)', fontWeight: 'var(--w-semi)' }}>{GATEWAY_LABEL[name]}</h3>
      <span className="field__label">Currencies this gateway can charge</span>
      <div
        role="group"
        aria-label={GATEWAY_LABEL[name]}
        className="stack stack--tight"
        style={saving ? { opacity: 0.6, pointerEvents: 'none' } : undefined}
      >
        {gateway.canCharge.map((code) => (
          <Checkbox
            key={code}
            label={`${capFirst(currencyName(code))} (${code})`}
            checked={gateway.currencies.includes(code)}
            onChange={(checked) => onToggle(code, checked)}
          />
        ))}
      </div>
      <span className="field__hint">{switchedOnSentence(gateway.currencies)}</span>
    </div>
  );
}
