/**
 * Variable substitution, which is the one part of this feature that runs once per
 * recipient and cannot be taken back.
 *
 * TWO PROPERTIES ARE WORTH A SUITE OF THEIR OWN and neither is visible from a route
 * test: that the validator and the renderer agree about what a placeholder IS (a
 * validator that misses `{{ name }}` and a renderer that also misses it produce a
 * template which passes every check and ships braces to five thousand readers), and
 * that a value substituted into the HTML part is escaped while the same value in the
 * text part is not.
 */
import { describe, expect, it } from 'vitest';
import { BadRequestError } from '../repo/errors';
import {
  TEMPLATE_VARIABLES,
  assertKnownVariables,
  escapeHtml,
  greetingName,
  hasUnsubscribeVariable,
  needsBasket,
  renderHtml,
  renderSubject,
  renderText,
} from './render';

const VALUES = {
  name: 'Ada & Co <VIP>',
  unsubscribeUrl: 'https://studio.test/api/public/unsubscribe?token=abc',
};

describe('the validator and the renderer agree about what a placeholder is', () => {
  it('accepts both variables, with or without inner whitespace', () => {
    for (const source of ['{{name}}', '{{ name }}', '{{unsubscribe_url}}', '{{  unsubscribe_url  }}']) {
      expect(() => assertKnownVariables(source, 'html')).not.toThrow();
      // ...and the renderer substitutes every one of them, rather than leaving the
      // spaced ones behind for the reader to find.
      expect(renderText(source, VALUES)).not.toContain('{{');
    }
  });

  it('refuses a variable this server cannot substitute, naming the FIELD', () => {
    /*
     * `detail` is a field name and never a value — the rule
     * `server/middleware/errors.ts` states. A template body is exactly the sort of
     * input somebody would paste a password into by accident.
     */
    try {
      assertKnownVariables('Hi {{firstname}}', 'text');
      throw new Error('it was accepted, and it must not be');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestError);
      expect((err as BadRequestError).detail).toBe('text');
    }
  });

  it('leaves a mistyped brace VISIBLE, whichever way it is mistyped', () => {
    /*
     * The pattern forbids a nested brace, which bounds what one placeholder can be.
     * An unclosed `{{` cannot swallow the document as far as the next `}}` a
     * hundred lines below; a stray extra brace substitutes the inner placeholder
     * and leaves the outer ones as text. Both survive into the message where
     * somebody notices — which is the point, as against a renderer that swallows
     * the mistake and produces a message that reads fine and says the wrong thing.
     */
    expect(renderText('{{name', VALUES)).toBe('{{name');
    expect(renderText('{{{name}}}', VALUES)).toBe('{Ada & Co <VIP>}');
  });

  it('leaves an unknown placeholder VISIBLE if one ever reaches the renderer', () => {
    /*
     * Reaching the renderer means a template was stored before the validator
     * existed, or by a path that skipped it. Of the two ways to be wrong, a visible
     * `{{firstname}}` gets reported and fixed; blanking it produces "Hi ," and a
     * support thread about a mail-merge that "sometimes" works.
     */
    expect(renderText('Hi {{firstname}}', VALUES)).toBe('Hi {{firstname}}');
  });

  it('knows exactly five variables, basket included', () => {
    // Pinned, because the list is what the composer's variable chips are built from
    // and what the validator refuses everything else against. Widened from two to
    // five so a "not bought yet" nudge can carry the reader's own basket.
    expect([...TEMPLATE_VARIABLES]).toEqual([
      'name',
      'unsubscribe_url',
      'basket',
      'basket_total',
      'basket_url',
    ]);
  });

  it('accepts the three new names at save time', () => {
    expect(() =>
      assertKnownVariables('{{basket}} {{basket_total}} {{basket_url}}', 'html'),
    ).not.toThrow();
  });
});

describe('the html part escapes values and the text part does not', () => {
  it('escapes a name into markup and leaves it alone in text', () => {
    /*
     * A name is a field somebody else typed — a CSV import row, most often.
     * Substituting it raw would put whatever that file contained into the markup of
     * a message sent to everybody, and while mail clients strip `<script>` they
     * render `<a>` and `<img>` perfectly well.
     */
    expect(renderHtml('<p>Hello {{name}}</p>', VALUES)).toBe(
      '<p>Hello Ada &amp; Co &lt;VIP&gt;</p>',
    );
    expect(renderText('Hello {{name}}', VALUES)).toBe('Hello Ada & Co <VIP>');
  });

  it('escapes the single quote, because a URL is substituted INSIDE an attribute', () => {
    // `href='{{unsubscribe_url}}'` is not an unusual thing for a template author to
    // write, and escaping only the four "obvious" characters leaves it open.
    expect(escapeHtml(`it's`)).toBe('it&#39;s');
    expect(renderHtml(`<a href='{{unsubscribe_url}}'>out</a>`, VALUES)).toContain(
      'token=abc',
    );
  });

  it('does not put &amp; in a subject line', () => {
    // A subject is not markup, so an escaped ampersand there is a bug the reader
    // sees rather than a defence against anything.
    expect(renderSubject('News for {{name}}', VALUES)).toBe('News for Ada & Co <VIP>');
  });
});

describe('the basket block channel', () => {
  it('substitutes a block raw into html and its own shape into text', () => {
    const values = {
      name: 'Ada',
      unsubscribeUrl: 'https://x.test/u',
      blocks: { basket: { html: '<table id="b"></table>', text: '1 x PLA' } },
    };
    expect(renderHtml('before {{basket}} after', values)).toContain('<table id="b">');
    expect(renderText('before {{basket}} after', values)).toContain('1 x PLA');
    expect(renderText('before {{basket}} after', values)).not.toContain('<table');
  });

  it('leaves {{basket}} VISIBLE in a subject rather than substituting it', () => {
    // A table's worth of text in a field mail clients truncate at ~60 characters
    // is obviously wrong to the operator previewing it. That is the point.
    const values = {
      name: 'Ada',
      unsubscribeUrl: 'https://x.test/u',
      blocks: { basket: { html: '<table></table>', text: 'lines' } },
    };
    expect(renderSubject('Your {{basket}}', values)).toBe('Your {{basket}}');
  });

  it('does not escape a block even into the html part — it is markup, not a value', () => {
    // The one asymmetry the whole channel exists for: a scalar with the same
    // characters would come out as &lt;b&gt;, and a block must not.
    const values = {
      name: 'Ada',
      unsubscribeUrl: 'https://x.test/u',
      blocks: { basket: { html: '<b>raw</b>', text: 'raw' } },
    };
    expect(renderHtml('{{basket}}', values)).toBe('<b>raw</b>');
  });

  it('substitutes basket_total and basket_url as ordinary escaped scalars', () => {
    const values = {
      name: 'Ada',
      unsubscribeUrl: 'https://x.test/u',
      basketTotal: '3000.00 NGN',
      basketUrl: 'https://plaspool.com/cart?a=1&b=2',
    };
    expect(renderHtml('{{basket_total}}', values)).toBe('3000.00 NGN');
    expect(renderText('{{basket_total}}', values)).toBe('3000.00 NGN');
    // The URL is escaped going into html — the same rule `unsubscribe_url` follows
    // — and left verbatim in text.
    expect(renderHtml('{{basket_url}}', values)).toBe(
      'https://plaspool.com/cart?a=1&amp;b=2',
    );
    expect(renderText('{{basket_url}}', values)).toBe('https://plaspool.com/cart?a=1&b=2');
  });

  it('leaves basket_total/basket_url VISIBLE when no basket was resolved for this recipient', () => {
    // The ordinary shape of a broadcast with no basket: the two scalars are
    // simply absent, and the unknown-placeholder branch leaves them exactly as
    // typed rather than blanking them to nothing.
    expect(renderText('Total: {{basket_total}}', VALUES)).toBe('Total: {{basket_total}}');
    expect(renderText('See {{basket_url}}', VALUES)).toBe('See {{basket_url}}');
  });

  it('leaves inherited Object.prototype keys VISIBLE even when blocks IS present', () => {
    /*
     * `values.blocks?.[name]` is a raw `Record` index into a plain object, and a
     * plain object inherits `constructor`/`toString`/`valueOf`/`hasOwnProperty`
     * (and, in most engines, `__proto__` as an accessor) from `Object.prototype`
     * — every one of those resolves to a truthy value with no guard at all. Once
     * `blocks` is present — i.e. every nudge that actually resolved a basket —
     * an unguarded `block !== undefined` check would pass for each of these
     * names, and `block.html`/`block.text` (a function, not a string) would
     * stringify to the literal word "undefined" in the message: "Hi undefined!"
     * The test above this one, `leaves an unknown placeholder VISIBLE if one
     * ever reaches the renderer`, proves NOTHING about this — its fixture
     * carries no `blocks` at all, so `values.blocks?.[name]` is `undefined` for
     * every placeholder regardless of whether the guard this test exists for is
     * even present. This fixture supplies `blocks`, which is the only way to
     * exercise the prototype-chain hazard at all.
     */
    const values = {
      name: 'Ada',
      unsubscribeUrl: 'https://x.test/u',
      blocks: { basket: { html: '<table></table>', text: 'lines' } },
    };
    expect(renderText('Hi {{constructor}}!', values)).toBe('Hi {{constructor}}!');
    expect(renderText('Hi {{toString}}!', values)).toBe('Hi {{toString}}!');
    expect(renderText('Hi {{valueOf}}!', values)).toBe('Hi {{valueOf}}!');
    expect(renderText('Hi {{hasOwnProperty}}!', values)).toBe('Hi {{hasOwnProperty}}!');
    expect(renderText('Hi {{__proto__}}!', values)).toBe('Hi {{__proto__}}!');
    // The guard narrows to the closed set — it must not also break the one name
    // that legitimately belongs in it.
    expect(renderHtml('{{basket}}', values)).toBe('<table></table>');
  });
});

describe('hasUnsubscribeVariable', () => {
  it('is the activation gate, and it is whitespace-tolerant like the renderer', () => {
    expect(hasUnsubscribeVariable('<a href="{{ unsubscribe_url }}">out</a>')).toBe(true);
    expect(hasUnsubscribeVariable('Hello {{name}}')).toBe(false);
    // The literal text is not the variable: a template that merely mentions the
    // words cannot be sent either.
    expect(hasUnsubscribeVariable('unsubscribe_url')).toBe(false);
  });
});

/**
 * `needsBasket` is `drainBroadcast`'s wider question: not "does this print the
 * block" (`usesBasket`) but "does resolving this recipient's basket matter at
 * all" — true for either scalar as well as the block, because a template can
 * depend on a reader's basket without ever printing the `{{basket}}` table.
 */
describe('needsBasket', () => {
  it('is true for any one of the three basket variables alone, not only the block', () => {
    expect(needsBasket('Yours: {{basket_total}}')).toBe(true);
    expect(needsBasket('Come back: {{basket_url}}')).toBe(true);
    expect(needsBasket('{{basket}}')).toBe(true);
  });

  it('is whitespace-tolerant, like usesBasket and hasUnsubscribeVariable', () => {
    expect(needsBasket('{{ basket_total }}')).toBe(true);
    expect(needsBasket('{{ basket_url }}')).toBe(true);
    expect(needsBasket('{{ basket }}')).toBe(true);
  });

  it('is false when none of the three appear', () => {
    expect(needsBasket('Hi {{name}}, <a href="{{unsubscribe_url}}">unsubscribe</a>')).toBe(false);
    // The literal words are not the variables, same rule as hasUnsubscribeVariable.
    expect(needsBasket('basket_total basket_url basket')).toBe(false);
  });
});

describe('greetingName', () => {
  it('prefers the name and falls back to the local part, never to blank', () => {
    /*
     * `email_subscribers.name` is nullable because an import or a checkout usually
     * hands over an address and nothing else, so the fallback is the common case
     * rather than the edge. The empty string is out because "Hi ," is the one output
     * nobody would ship on purpose; a canned English greeting is out because it is a
     * language decision a server would be taking on behalf of a message an operator
     * wrote and cannot see.
     */
    expect(greetingName('ada@test.local', 'Ada Lovelace')).toBe('Ada Lovelace');
    expect(greetingName('ada@test.local', null)).toBe('ada');
    expect(greetingName('ada@test.local', '   ')).toBe('ada');
    // Nothing before the `@` — the database refuses such an address, but the
    // function must still not return the empty string.
    expect(greetingName('@test.local', null)).toBe('@test.local');
  });
});
