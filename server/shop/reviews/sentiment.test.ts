import { describe, expect, it } from 'vitest';
import { analyseSentiment } from './sentiment';

/**
 * The lexicon is version one and says so — these tests pin the CONTRACT
 * (label thresholds, negation, determinism), not linguistic subtlety. When a
 * model replaces the wordlist, the label semantics tested here must survive
 * it: that is what lets the two implementations be compared on the stored
 * corpus.
 */
describe('analyseSentiment', () => {
  it('scores an ordinary happy review positive', () => {
    const s = analyseSentiment('Great filament, prints clean and the colour is beautiful.');
    expect(s.label).toBe('positive');
    expect(s.score).toBeGreaterThan(0);
  });

  it('scores an ordinary unhappy review negative', () => {
    const s = analyseSentiment('Spool arrived tangled and the prints keep stringing. Disappointed.');
    expect(s.label).toBe('negative');
    expect(s.score).toBeLessThan(0);
  });

  it('scores sentiment-free text neutral, including empty text', () => {
    expect(analyseSentiment('Printed at 210 degrees on a Bambu A1 with a 0.4 nozzle.').label).toBe(
      'neutral',
    );
    expect(analyseSentiment('').label).toBe('neutral');
    expect(analyseSentiment('').score).toBe(0);
  });

  it('flips a hit inside the negation window', () => {
    // "not good" must not read as praise…
    expect(analyseSentiment('not good').score).toBeLessThan(0);
    // …and a negated complaint reads as its opposite.
    expect(analyseSentiment('never disappointed').score).toBeGreaterThan(0);
    // The window is two tokens: "not very good" still flips.
    expect(analyseSentiment('not very good').score).toBeLessThan(0);
  });

  it('weighs the strong words double', () => {
    expect(analyseSentiment('perfect').score).toBe(2);
    expect(analyseSentiment('terrible').score).toBe(-2);
    // A strong negative outweighs an ordinary positive in the same sentence.
    expect(analyseSentiment('nice spool, terrible delivery').label).toBe('negative');
  });

  it('tokenises apostrophes so contracted negators work', () => {
    expect(analyseSentiment("doesn't work, don't recommend").label).toBe('negative');
  });

  it('is deterministic', () => {
    const text = 'Good quality but the delivery was late.';
    expect(analyseSentiment(text)).toEqual(analyseSentiment(text));
  });
});
