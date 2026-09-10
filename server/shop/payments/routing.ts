import { readPaymentSettings } from './settings';
import type { Db } from '../../db/client';
import type { ProviderName } from './schema';
import type { PaymentProvider } from './provider/types';

/**
 * Choosing a gateway for a NEW payment, and resolving an EXISTING one back to
 * the gateway that already took it. Two different questions, kept as two
 * functions on purpose — see `providerFor`'s own comment below.
 *
 * NAMES GATEWAYS ONLY BY `ProviderName`. This module never imports
 * `paystack.ts`, never imports a Flutterwave adapter, and never constructs a
 * real `PaymentProvider` itself — `ProviderFactories` is passed in by the
 * caller (the composition root), so this file stays testable against
 * `provider/fake.ts` and stays inside the boundary `provider/types.ts`
 * documents: nothing outside `server/shop/payments/provider/` names a
 * provider.
 *
 * THE INTERSECTION RULE. `shop_payment_settings` (`settings.ts`) is a row an
 * admin edits and can name anything — it is data, not a guarantee.
 * `capabilities.currencies` (`provider/types.ts`) is the adapter's documented
 * ceiling — what the gateway's API can actually charge, account state aside.
 * A currency only counts when it is in BOTH: the row says it is switched on
 * for THIS account, and the adapter says the API can take it at all. A row
 * that over-claims (Paystack switched on for GHS, say, when Paystack's API
 * never takes cedis) must not win, or a charge is handed to a gateway that
 * will refuse it.
 */

/** Deterministic. Never "whichever key came first". */
export const PROVIDER_FALLBACK_ORDER: readonly ProviderName[] = ['paystack', 'flutterwave'];

export interface ProviderFactories {
  paystack: () => PaymentProvider;
  flutterwave: () => PaymentProvider;
}

/** Thrown when the currency is not chargeable by any gateway right now — see the intersection rule above. */
export class NoProviderForCurrencyError extends Error {
  readonly code = 'no_provider_for_currency';
  constructor(readonly currency: string) {
    super('no_provider_for_currency');
    // Every other custom error in `server/repo/errors.ts` sets this, and two
    // existing paths log `err.name` — left unset here, this class logged as
    // the generic `Error` instead of naming itself.
    this.name = 'NoProviderForCurrencyError';
  }
}

/**
 * Where a NEW payment should go.
 *
 * 1. Start from the switch: `activeProvider`, unless the destination is
 *    outside Nigeria AND an `internationalProvider` is configured — in which
 *    case start there instead.
 *
 *    An UNKNOWN destination (`country: null`) is DOMESTIC, not international.
 *    There is no address yet to base a country rule on, and guessing
 *    "international" would route a Nigerian shopper's card abroad on the
 *    strength of a form they have not filled in. `'NG'` itself is domestic
 *    for the same reason a country rule exists at all: it only ever fires for
 *    a destination that is confirmed to be outside Nigeria.
 *
 * 2. That starting gateway only wins if it can actually charge the currency —
 *    the intersection of what `shop_payment_settings` has switched on for it
 *    and what its adapter's `capabilities.currencies` admits. Otherwise walk
 *    `PROVIDER_FALLBACK_ORDER` and use the first gateway that can.
 *
 * 3. If nothing can, refuse with a typed `NoProviderForCurrencyError` rather
 *    than letting an unroutable charge reach a gateway that 4xxs on it.
 */
export async function chooseProvider(
  db: Db,
  input: { currency: string; country: string | null },
  factories: ProviderFactories,
): Promise<{ name: ProviderName; provider: PaymentProvider }> {
  const settings = await readPaymentSettings(db);
  // Both sides of every comparison below are normalised here, once — the
  // settings columns and every adapter already store/declare uppercase, but
  // this function does not trust that rather than assume it.
  const currency = input.currency.toUpperCase();
  const country = input.country === null ? null : input.country.toUpperCase();

  const isInternational = country !== null && country !== 'NG';
  const start: ProviderName =
    isInternational && settings.internationalProvider
      ? settings.internationalProvider
      : settings.activeProvider;

  // Constructed at most once per gateway per call — success OR failure alike
  // (`failed` below), so a gateway whose factory throws is not re-attempted,
  // and not re-logged, just because it is checked twice in one call (e.g.
  // once as `start`, again inside the fallback loop).  The same instance is
  // what gets returned on success — a real adapter (an HTTP client) should
  // not be built twice over one routing decision just because `canCharge`
  // also needs it.
  const providers = new Map<ProviderName, PaymentProvider>();
  const failed = new Set<ProviderName>();

  /*
   * A GATEWAY THIS DEPLOYMENT CANNOT CONSTRUCT CANNOT CHARGE ANYTHING, SO A
   * THROWING FACTORY IS TREATED AS "NOT CHARGEABLE" HERE RATHER THAN LET TO
   * ESCAPE.
   *
   * The likely real sequence: an owner switches a gateway on in the admin,
   * then goes to add its secret keys — and until that lands,
   * `flutterwaveProvider()`/`paystackProvider()` (`config.ts`) throw a plain
   * `Error` for the whole window. Left uncaught, that throw would escape this
   * function and reach `POST /shop/payments/intents` as an unlabelled 500,
   * killing checkout even when a currency it CAN still reach (the other,
   * actually-configured gateway) should have taken the charge instead.
   * Consistent with the intersection rule this file already documents above:
   * a gateway that cannot authenticate genuinely cannot take a payment, same
   * as one the settings row never switched on for this currency — so it
   * falls out of `canCharge` the same way, and the fallback order or the
   * final `NoProviderForCurrencyError` takes it from there.
   *
   * `providerFor` BELOW MUST NOT GET THIS TREATMENT. It resolves an EXISTING
   * intent's gateway, fixed forever at creation — a missing key there is a
   * real, loud failure, and silently substituting another gateway would
   * refund (or re-verify) a payment through a gateway that never took it,
   * exactly the hazard `refunds.ts`'s header warns about. Only THIS routing
   * decision, for a payment that has not happened yet, is allowed to degrade.
   */
  const providerNamed = (name: ProviderName): PaymentProvider | null => {
    if (failed.has(name)) return null;
    const cached = providers.get(name);
    if (cached) return cached;
    try {
      const provider = factories[name]();
      providers.set(name, provider);
      return provider;
    } catch {
      failed.add(name);
      // NAMES ONLY — the gateway and an ENUMERATED reason, never the caught
      // error's message and never anything that could carry a key.
      // `config.ts` throws a names-only error by design (its own header);
      // logging the message here would undo that one layer up.
      // eslint-disable-next-line no-console -- the only record a routing decision silently degraded
      console.error(
        '[payments] gateway unavailable for routing',
        JSON.stringify({ gateway: name, reason: 'construction_failed' }),
      );
      return null;
    }
  };

  /** The intersection rule: the row's switched-on list AND the adapter's ceiling. */
  const canCharge = (name: ProviderName): boolean => {
    const switchedOn = new Set(settings.currencies[name].map((code) => code.toUpperCase()));
    if (!switchedOn.has(currency)) return false;
    const provider = providerNamed(name);
    if (!provider) return false;
    const chargeable = provider.capabilities.currencies;
    return chargeable.some((code) => code.toUpperCase() === currency);
  };

  if (canCharge(start)) {
    // Non-null: `canCharge` only returns true after `providerNamed` above
    // already returned a real provider for this exact name, which the cache
    // in `providers` now returns again rather than reconstructing.
    return { name: start, provider: providerNamed(start) as PaymentProvider };
  }
  for (const name of PROVIDER_FALLBACK_ORDER) {
    if (canCharge(name)) {
      return { name, provider: providerNamed(name) as PaymentProvider };
    }
  }
  throw new NoProviderForCurrencyError(currency);
}

/**
 * Where an EXISTING payment already went. NEVER routes.
 *
 * `shop_payment_intents.provider` is set once, at creation, and never
 * rewritten (`schema.ts`) — a refund, a capture, a webhook resolution all have
 * to reach the SAME gateway that took the money, for the intent's whole life,
 * regardless of what `shop_payment_settings` says today. This function is
 * kept apart from `chooseProvider` — no `db` parameter, no read of the
 * settings row at all — so that flipping the admin switch can never re-point
 * where an already-taken payment is refunded. If this ever grows a call to
 * `readPaymentSettings`, that guarantee is gone.
 */
export function providerFor(name: ProviderName, factories: ProviderFactories): PaymentProvider {
  return factories[name]();
}
