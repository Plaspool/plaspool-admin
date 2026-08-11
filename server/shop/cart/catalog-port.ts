import type { Db } from '../../db/client';
import type { CatalogPort as SharedCatalogPort } from '../../../shared/commerce/ports';

export type {
  ReservationRequest,
  ReservationResult,
  VariantQuote,
} from '../../../shared/commerce/ports';

/**
 * `CatalogPort`, bound to this application's `Db`.
 *
 * The shared declaration is generic in `Db` (`CatalogPort<Db>`) so that
 * `shared/commerce/ports.ts` stays free of a `server/` import — it is compiled
 * into the browser bundle too. Every consumer inside `server/` wants the same
 * concrete instantiation, so it is made once, here, rather than spelled
 * `CatalogPort<Db>` at a dozen call sites where one of them would eventually be
 * spelled `CatalogPort<any>`.
 *
 * Cart briefly carried its own structural copy of this port while Catalog's
 * declaration was in flight (contract §11: code against the port, never against
 * the implementation, and never block). The copy is gone; this file is a
 * re-export and nothing more, which is the only state in which there is exactly
 * one definition of the seam.
 */
export type CatalogPort = SharedCatalogPort<Db>;

/**
 * The default injected port: one that refuses.
 *
 * A deployment that has not wired Catalog in has no prices and no stock counter,
 * so every cart read and every checkout start is unanswerable. Refusing loudly
 * is the only honest option — the alternative, a port that quotes nothing and
 * reserves everything, is a shop that takes orders it cannot fill. Named
 * `unavailableCatalog` rather than `nullCatalog` so nobody mistakes it for a
 * usable stub, and it throws a plain `Error` so it surfaces as a 500 with a
 * `requestId` rather than as something a client would retry into a sale.
 */
export function unavailableCatalog(): CatalogPort {
  const refuse = (): never => {
    throw new Error('CatalogPort is not configured for this deployment');
  };
  return {
    quote: refuse,
    reserve: refuse,
    release: refuse,
    commitReservation: refuse,
  };
}
