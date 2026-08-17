/**
 * Sentiment, version one: a lexicon and a negation window. No model, no
 * third-party call, no API key.
 *
 * Issue #4 says the priority is the pipeline end-to-end, not day-one
 * accuracy, and this takes that at face value. A service call here would add
 * a secret to provision, a per-review network hop on the submission path, a
 * failure mode ("review cannot be stored because the sentiment vendor is
 * down" — exactly backwards), and a bill — for accuracy nobody is reading
 * yet. A lexicon is deterministic, testable to the word, and runs in
 * microseconds inside the request.
 *
 * THE SEAM IS THE FUNCTION SIGNATURE. `analyseSentiment(text) → {label,
 * score}` is the whole contract; swapping in a real model later is a new
 * implementation of one function, and the stored `score` lets the two be
 * compared over the accumulated corpus before the switch is thrown.
 *
 * Scoring: each lexicon hit counts ±1 (±2 for the strong words). A negator
 * ("not", "never", "don't"…) within the two tokens before a hit flips its
 * sign — "not good" scores like "bad", "never disappointed" scores like
 * "satisfied". The label is the sign of the sum, with zero as neutral.
 * Deliberately no normalisation by length: a long rave that mentions one
 * flaw should stay positive, and the raw sum does that where a ratio would
 * wash it out.
 *
 * The wordlist leans toward how people actually talk about filament and
 * delivery — prints, stringing, tangles, refunds — not a general-purpose
 * corpus. It will misread sarcasm. So will version two.
 */

export interface Sentiment {
  label: 'positive' | 'neutral' | 'negative';
  score: number;
}

const POSITIVE = new Set([
  'good', 'great', 'nice', 'fine', 'solid', 'clean', 'smooth', 'crisp',
  'excellent', 'awesome', 'fantastic', 'wonderful', 'brilliant', 'superb',
  'quality', 'reliable', 'consistent', 'accurate', 'precise', 'sturdy',
  'happy', 'pleased', 'satisfied', 'impressed', 'recommend', 'recommended',
  'fast', 'quick', 'prompt', 'helpful', 'friendly', 'easy',
  'works', 'worked', 'flawless', 'beautiful', 'vibrant', 'strong',
]);

/** Two points: words nobody uses mildly. */
const STRONG_POSITIVE = new Set(['perfect', 'amazing', 'love', 'loved', 'best', 'outstanding']);

const NEGATIVE = new Set([
  'bad', 'poor', 'weak', 'brittle', 'rough', 'uneven', 'inconsistent',
  'disappointed', 'disappointing', 'frustrating', 'frustrated', 'annoying',
  'problem', 'problems', 'issue', 'issues', 'fault', 'faulty', 'defect',
  'defective', 'broken', 'broke', 'cracked', 'snapped', 'jammed', 'clogged',
  'tangle', 'tangled', 'tangles', 'stringing', 'warping', 'warped',
  'slow', 'late', 'delayed', 'missing', 'wrong', 'damaged',
  'refund', 'return', 'waste', 'useless', 'cheap', 'overpriced',
]);

/** Minus two: the words that end up in chargebacks. */
const STRONG_NEGATIVE = new Set(['terrible', 'horrible', 'awful', 'worst', 'scam', 'garbage', 'unusable', 'hate']);

const NEGATORS = new Set([
  'not', 'no', 'never', 'none', 'cannot', 'cant', 'dont', 'doesnt', 'didnt',
  'wont', 'wouldnt', 'isnt', 'wasnt', 'arent', 'werent', 'without', 'hardly',
]);

/** How far back a negator reaches, in tokens: "not very good" flips. */
const NEGATION_WINDOW = 2;

export function analyseSentiment(text: string): Sentiment {
  /* Lower-case, strip apostrophes so "don't" tokenises as "dont", then split
     on anything that is not a letter. Numbers carry no sentiment here. */
  const tokens = text
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z]+/)
    .filter(Boolean);

  let score = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    let value = 0;
    if (STRONG_POSITIVE.has(token)) value = 2;
    else if (POSITIVE.has(token)) value = 1;
    else if (STRONG_NEGATIVE.has(token)) value = -2;
    else if (NEGATIVE.has(token)) value = -1;
    if (value === 0) continue;

    for (let back = 1; back <= NEGATION_WINDOW && i - back >= 0; back += 1) {
      if (NEGATORS.has(tokens[i - back]!)) {
        value = -value;
        break;
      }
    }
    score += value;
  }

  return {
    label: score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral',
    score,
  };
}
