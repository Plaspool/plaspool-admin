import type { Db } from '../../db/client';
import { logisticsEnv } from './config';
import type { FezEnv, TerminalEnv } from './config';
import type { LogisticsProvider, ProviderId } from './port';

/**
 * What this subsystem needs from the ones it cannot see, **taken by injection**
 * — the same shape and the same reasons as `server/shop/orders/ports.ts`.
 *
 * TWO SEAMS. Catalog owns variant weights and this subsystem must never write a
 * query against `shop_variants`; the couriers themselves are built from
 * `logisticsEnv()`, which a test must be able to replace without setting real
 * credentials on `process.env`.
 *
 * A REGISTRY RATHER THAN CONSTRUCTOR ARGUMENTS, for the reason Orders' file
 * gives at length: `server/shop/app.ts` composes routers with no arguments
 * (`shop.route('/', logisticsRoutes)`), Hono resolves two routers claiming one
 * path by registration order, so a second injected copy mounted alongside would
 * simply never be reached. Read PER REQUEST, so "mount the router" and
 * "register the dependency" can happen in either order.
 */

export interface LogisticsCatalog {
  /**
   * Grams per variant, `null` where the catalogue does not know. **Absent keys
   * mean absent variants** — a caller must not read a missing key as zero, which
   * is a parcel booked as weightless.
   */
  weightsFor(db: Db, variantIds: readonly string[]): Promise<Map<string, number | null>>;
  /** How much of the sellable catalogue could be quoted for at all. */
  weightCoverage(db: Db): Promise<{ missing: number; total: number }>;
}

export interface LogisticsDeps {
  catalog?: LogisticsCatalog;
  /**
   * Explicit adapters, for tests. `null` is a REGISTERED ANSWER meaning "this
   * courier is not configured" — distinct from an absent key, which means
   * "build one from the environment". Collapsing the two would make a suite
   * unable to say "Terminal is off" without unsetting environment variables it
   * does not own.
   */
  providers?: Partial<Record<ProviderId, LogisticsProvider | null>>;
  /** Injectable so route tests are deterministic. Defaults to the wall clock. */
  now?: () => number;
}

export interface ResolvedLogisticsDeps {
  catalog: LogisticsCatalog;
  /** `null` means "not configured" — never a throw, because the settings screen
   *  has to be able to RENDER a deployment with no courier credentials. */
  providerFor(id: ProviderId): LogisticsProvider | null;
  now: () => number;
}

/**
 * The env-built adapters, filled by the tasks that write them:
 * `fez: (env) => createFezProvider(env)` and the Terminal counterpart.
 *
 * A MUTABLE RECORD RATHER THAN A DIRECT IMPORT, so this module does not depend
 * on either adapter — which is what lets the settings screen and its tests exist
 * before a single HTTP call to a courier does. Both `null` means every
 * deployment reports both couriers as not configured, which is honest and is
 * exactly what a half-shipped feature should say.
 */
export const envProviders: {
  fez: ((env: FezEnv) => LogisticsProvider) | null;
  terminal: ((env: TerminalEnv) => LogisticsProvider) | null;
} = { fez: null, terminal: null };

let registered: LogisticsDeps = {};
let defaults: LogisticsDeps = {};

/**
 * Adapters built from the environment, memoised for the process.
 *
 * Cleared by every registration, because a suite that registers a fake after one
 * has been built must not keep getting the built one — and because
 * `resetLogisticsEnv()` exists, so the environment a built adapter closed over
 * can legitimately change between cases.
 */
const built = new Map<ProviderId, LogisticsProvider | null>();

/**
 * Wire a dependency. Called by a test, or by whoever owns the real thing.
 *
 * THE MERGE IS SHALLOW, so a second call passing `providers` REPLACES the map
 * rather than adding to it — name every courier you mean, or the unnamed ones
 * fall back to the environment.
 */
export function registerLogisticsDeps(deps: LogisticsDeps): void {
  registered = { ...registered, ...deps };
  built.clear();
}

/**
 * Register a fallback nobody else has claimed. **For the composition root.**
 *
 * `shopApp()` runs for EVERY server suite in this repository, so a last-write
 * -wins registration there would silently replace a fake a test had already
 * registered — the failure Orders' `registerOrdersDefaults` documents, where the
 * test still passes having asserted on a recorder nothing ever called. Kept in a
 * SEPARATE map rather than merged fill-only, so the two orders of "build the
 * app" and "register a fake" are equivalent however many times either happens.
 */
export function registerLogisticsDefaults(deps: LogisticsDeps): void {
  defaults = { ...defaults, ...deps };
  built.clear();
}

/**
 * Forget everything a test registered. The composition root's defaults survive,
 * because they describe the application rather than one suite.
 */
export function resetLogisticsDeps(): void {
  registered = {};
  built.clear();
}

/**
 * The catalog seam, unfilled. **Throws rather than answering zero**: a coverage
 * of `0 missing of 0` on a shop with a hundred variants reads as "everything is
 * fine" on the one screen whose job is to say it is not.
 */
const missingCatalog: LogisticsCatalog = {
  weightsFor: () => Promise.reject(new Error('logistics catalog port not registered')),
  weightCoverage: () => Promise.reject(new Error('logistics catalog port not registered')),
};

export function resolveLogisticsDeps(): ResolvedLogisticsDeps {
  const merged: LogisticsDeps = { ...defaults, ...registered };
  return {
    catalog: merged.catalog ?? missingCatalog,
    now: merged.now ?? (() => Date.now()),
    providerFor(id: ProviderId): LogisticsProvider | null {
      /* `in` and not `?? `: a registered `null` is an answer, not an absence. */
      if (merged.providers && id in merged.providers) return merged.providers[id] ?? null;
      if (built.has(id)) return built.get(id) ?? null;

      const env = logisticsEnv();
      const adapter =
        id === 'fez'
          ? env.fez && envProviders.fez
            ? envProviders.fez(env.fez)
            : null
          : env.terminal && envProviders.terminal
            ? envProviders.terminal(env.terminal)
            : null;
      built.set(id, adapter);
      return adapter;
    },
  };
}
