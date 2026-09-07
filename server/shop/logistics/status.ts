import type { CourierState, ProviderId } from './port';

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, '-');

const FEZ: Record<string, CourierState> = {
  'pending-payment': 'booked', 'pending-pick-up': 'booked', 'pending-drop-off': 'booked', 'dropped-off': 'booked',
  'picked-up': 'picked_up', dispatched: 'in_transit', delivered: 'delivered', returned: 'returned',
  'rejected-at-drop-off': 'failed', 'failed-pick-up': 'failed', cancelled: 'cancelled', canceled: 'cancelled',
};
const TERMINAL: Record<string, CourierState> = {
  draft: 'draft', confirmed: 'booked', pending: 'booked', 'in-transit': 'in_transit',
  delivered: 'delivered', cancelled: 'cancelled', canceled: 'cancelled',
};

export function fezState(raw: string): CourierState { return FEZ[norm(raw)] ?? 'unknown'; }
export function terminalState(raw: string): CourierState { return TERMINAL[norm(raw)] ?? 'unknown'; }
export function courierStateOf(provider: ProviderId, raw: string): CourierState {
  return provider === 'fez' ? fezState(raw) : terminalState(raw);
}
