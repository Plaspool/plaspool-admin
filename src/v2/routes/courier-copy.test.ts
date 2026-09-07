import { describe, expect, it } from 'vitest';
import { COURIER_COPY, PROVIDER_LABEL, courierStateBadge } from './courier-copy';

describe('courier copy', () => {
  it('names every provider in plain words', () => {
    expect(PROVIDER_LABEL).toEqual({ manual: 'By hand', fez: 'Fez Delivery', terminal: 'Terminal Africa' });
  });
  it('maps every courier state to a badge with a plain label', () => {
    const states = ['draft', 'booked', 'picked_up', 'in_transit', 'delivered', 'returned', 'cancelled', 'failed', 'unknown'] as const;
    for (const s of states) {
      const badge = courierStateBadge(s);
      expect(badge.label).toMatch(/^[A-Z][a-z ]+$/);
      expect(['neutral', 'ok', 'warn', 'critical', 'info']).toContain(badge.tone);
    }
    expect(courierStateBadge('in_transit')).toEqual({ label: 'On its way', tone: 'info' });
    expect(courierStateBadge('delivered')).toEqual({ label: 'Delivered', tone: 'ok' });
    expect(courierStateBadge('failed')).toEqual({ label: 'Failed', tone: 'critical' });
    expect(courierStateBadge(null)).toBeNull();
  });
  it('never uses the banned words on screen', () => {
    const banned = /\b(provider|manual|shipment|fulfil?lment|label)\b/i;
    const walk = (v: unknown): string[] =>
      typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(walk) : [];
    for (const s of walk(COURIER_COPY)) expect(s, s).not.toMatch(banned);
  });

  /* The line that replaces "Carrier"/"Tracking number" when a courier is on:
     it has to name the courier and say the booking is a SEPARATE step, or the
     operator reads the modal as the whole job (which is what happened). */
  it('tells the packer that the booking happens on the next screen, and names the courier', () => {
    const line = COURIER_COPY.parcel.packFirst('Terminal Africa');
    expect(line).toContain('Terminal Africa');
    expect(line).toMatch(/next screen/);
  });

  /* Four outcome regions all called "result" are four regions called nothing —
     a screen reader lands on them and cannot tell which button they belong to. */
  it('names each courier test outcome region after its own button', () => {
    const d = COURIER_COPY.settings.diagnostics;
    const buttons = [d.connection, d.quote, d.selfTest, d.simulate];
    const names = buttons.map((b) => d.outcome(b));
    expect(new Set(names).size).toBe(4);
    for (const [i, name] of names.entries()) expect(name).toContain(buttons[i]);
  });
});
