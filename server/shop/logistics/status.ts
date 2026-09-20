import type { CourierState, ProviderId } from './port';

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, '-');

const FEZ: Record<string, CourierState> = {
  'pending-payment': 'booked', 'pending-pick-up': 'booked', 'pending-drop-off': 'booked', 'dropped-off': 'booked',
  'picked-up': 'picked_up', dispatched: 'in_transit', delivered: 'delivered', returned: 'returned',
  'rejected-at-drop-off': 'failed', 'failed-pick-up': 'failed', cancelled: 'cancelled', canceled: 'cancelled',
  /* OBSERVED ON PRODUCTION 2026-09-20, on a parcel that had read `unknown` for
     3.8 days while it was plainly moving: Fez sends this between pick-up and the
     final hop. `in_transit` because that is exactly what it describes — the
     parcel is with the courier, between hubs, not yet out for final delivery. */
  'enroute-to-last-mile-hub': 'in_transit',
};
const TERMINAL: Record<string, CourierState> = {
  draft: 'draft', confirmed: 'booked', pending: 'booked', 'in-transit': 'in_transit',
  delivered: 'delivered', cancelled: 'cancelled', canceled: 'cancelled',
};

/**
 * Map a courier's own status word, and SAY SO WHEN WE CANNOT.
 *
 * WHY THE LOG LINE EXISTS. `unknown` is a safe fallback — it breaks no lifecycle
 * and the parcel keeps its own `status` — but it is also SILENT, and that is how
 * a real parcel sat reading `unknown` on production for nearly four days while
 * Fez was perfectly happy to say `Enroute To Last Mile Hub`. Nothing was broken,
 * so nothing complained; the gap was only found by reading a sweep's `changed: 0`
 * and asking why. This line turns the next unmapped word into something that
 * shows up in `vercel logs` on the first sweep that sees it, instead of waiting
 * for somebody to notice a stale parcel.
 *
 * THE RAW WORD IS SAFE TO LOG, and the distinction matters because this codebase
 * is otherwise strict about never putting a provider's response text on an error
 * (`provider/scrub.ts`). A status vocabulary word is not response content in that
 * sense: it is already persisted verbatim in `shop_fulfillments.provider_status`
 * and already rendered to operators on the parcel. Logging it adds no exposure
 * and is the only thing that makes the line actionable — a log saying "an
 * unmapped status happened" without naming it would be a line nobody can fix.
 *
 * AN EMPTY STATUS IS NOT LOGGED. It means the courier sent us nothing, not that
 * it sent us a word we do not know, and it has no map entry to add.
 */
function mapStatus(
  provider: ProviderId,
  table: Record<string, CourierState>,
  raw: string,
): CourierState {
  const key = norm(raw);
  const state = table[key];
  if (state !== undefined) return state;
  if (key !== '') {
    // eslint-disable-next-line no-console -- see the doc comment: this is the
    // only place an unmapped courier word becomes visible to anyone.
    console.warn(
      '[logistics] unmapped courier status',
      JSON.stringify({ provider, raw, key, mappedTo: 'unknown' }),
    );
  }
  return 'unknown';
}

export function fezState(raw: string): CourierState { return mapStatus('fez', FEZ, raw); }
export function terminalState(raw: string): CourierState { return mapStatus('terminal', TERMINAL, raw); }
export function courierStateOf(provider: ProviderId, raw: string): CourierState {
  return provider === 'fez' ? fezState(raw) : terminalState(raw);
}
