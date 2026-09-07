import { describe, expect, it } from 'vitest';
import { courierStateOf, fezState, terminalState } from './status';

describe('fezState', () => {
  it.each([
    ['Pending Payment', 'booked'], ['Pending Pick-Up', 'booked'], ['Pending Drop-off', 'booked'], ['Dropped-off', 'booked'],
    ['Picked-Up', 'picked_up'], ['Dispatched', 'in_transit'], ['Delivered', 'delivered'], ['Returned', 'returned'],
    ['Rejected At Drop-off', 'failed'], ['Failed Pick-Up', 'failed'], ['Cancelled', 'cancelled'],
    ['picked-up', 'picked_up'], ['  Delivered ', 'delivered'], ['Something New', 'unknown'], ['', 'unknown'],
  ])('%s → %s', (raw, state) => expect(fezState(raw)).toBe(state));
});

describe('terminalState', () => {
  it.each([
    ['draft', 'draft'], ['confirmed', 'booked'], ['pending', 'booked'], ['in-transit', 'in_transit'], ['in_transit', 'in_transit'],
    ['delivered', 'delivered'], ['cancelled', 'cancelled'], ['canceled', 'cancelled'], ['Delivered', 'delivered'], ['weird', 'unknown'],
  ])('%s → %s', (raw, state) => expect(terminalState(raw)).toBe(state));
});

it('courierStateOf dispatches on the provider', () => {
  expect(courierStateOf('fez', 'Dispatched')).toBe('in_transit');
  expect(courierStateOf('terminal', 'in-transit')).toBe('in_transit');
});
