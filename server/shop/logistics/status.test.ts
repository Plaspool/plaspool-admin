import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('the status Fez actually sends mid-journey', () => {
  it('reads Enroute To Last Mile Hub as in transit, in every casing Fez might use', () => {
    /*
     * OBSERVED ON PRODUCTION, not invented: a parcel sat at `unknown` for 3.8
     * days while Fez was answering `Enroute To Last Mile Hub` on every sweep.
     * Nothing was broken — `unknown` is a safe fallback and the parcel kept its
     * own `shipped` status — which is exactly why nobody noticed.
     */
    for (const raw of ['Enroute To Last Mile Hub', 'enroute to last mile hub', '  Enroute_To_Last_Mile_Hub  ']) {
      expect(fezState(raw), raw).toBe('in_transit');
    }
  });
});

describe('an unmapped status is logged, because unknown is otherwise silent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names the provider and the word, so the map entry can be written from the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(fezState('Arrived At Some New Hub')).toBe('unknown');

    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]!.join(' ');
    /* The RAW word and the NORMALISED key both: the first is what an operator
       sees in Fez's dashboard, the second is the map key they would add. */
    expect(line).toContain('Arrived At Some New Hub');
    expect(line).toContain('arrived-at-some-new-hub');
    expect(line).toContain('fez');
  });

  it('logs for Terminal too, named as Terminal', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(terminalState('some-new-terminal-state')).toBe('unknown');
    expect(warn.mock.calls[0]!.join(' ')).toContain('terminal');
  });

  it('says NOTHING for a known status — the log must stay a signal', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fezState('Delivered');
    fezState('Enroute To Last Mile Hub');
    terminalState('in-transit');
    expect(warn).not.toHaveBeenCalled();
  });

  it('says nothing for an EMPTY status, which is a missing value not a new word', () => {
    /* There is no map entry to add for `''`, so a line about it would be noise
       in the one log an operator is meant to act on. */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(fezState('')).toBe('unknown');
    expect(fezState('   ')).toBe('unknown');
    expect(warn).not.toHaveBeenCalled();
  });
});
