import { BadRequestError } from '../repo/errors';
import { isTemplateBlock, isTemplateVariable, placeholderPattern } from '../../shared/email/variables';

/**
 * Variable substitution, SERVER-SIDE (HANDOFF §2 A6).
 *
 * A CLOSED VOCABULARY AND NO MORE, AND THE LIST IS ENFORCED AT SAVE TIME RATHER
 * THAN AT SEND TIME. A template carrying `{{firstname}}` is not a template that
 * renders badly — it is a template that mails the literal string `{{firstname}}`
 * to every subscriber, once, unrecallably. There is no second chance to notice,
 * because the person who wrote it sees their own preview and not the five
 * thousand copies. So an unrecognised placeholder is a 400 on the SAVE, naming
 * the field it appeared in, and the send path can then substitute without
 * deciding anything.
 *
 * ONE PATTERN FOR EVERY JOB, AND IT NOW LIVES IN `shared/`.
 * `assertKnownVariables` scans with the same pattern `render` substitutes with, so
 * "what is refused" and "what is replaced" cannot drift apart — the failure that
 * would otherwise appear here is a validator that misses `{{ name }}` (with spaces)
 * and a renderer that also misses it, leaving a template that passes every check
 * and ships braces to the reader.
 *
 * The admin UI is a THIRD reader of the same rule, and it had drifted in exactly
 * that way: it scanned for the literal `{{unsubscribe_url}}` and warned about
 * perfectly good templates written `{{ unsubscribe_url }}`. So the vocabulary, the
 * pattern and the unsubscribe gate moved to `shared/email/variables.ts`, which both
 * codebases import. What stayed here is only what needs a server error to say.
 *
 * `basket`/`basket_total`/`basket_url` WIDENED THE VOCABULARY to let a "not
 * bought yet" nudge carry the reader's own basket. `basket` is a BLOCK — markup
 * this server built, inserted raw — and the other two are ordinary scalars; see
 * `TEMPLATE_BLOCKS` in `shared/email/variables.ts` for the whole of that
 * distinction, and `substitute` below for where it is enforced.
 */

/**
 * Re-exported so this module remains the server's one door to the vocabulary: the
 * routes and the suites import from here and do not need to know the rule is now
 * shared with the browser.
 */
export {
  TEMPLATE_VARIABLES,
  TEMPLATE_BLOCKS,
  hasUnsubscribeVariable,
  isTemplateBlock,
  usesBasket,
} from '../../shared/email/variables';
export type { TemplateVariable, TemplateBlock } from '../../shared/email/variables';

/**
 * Throw `BadRequestError(field)` if `source` uses a variable this server cannot
 * substitute. `field` is the FIELD NAME the caller sent — `html`, `text` or
 * `subject` — never the offending value, which is the rule
 * `server/middleware/errors.ts` states for every `detail`.
 */
export function assertKnownVariables(source: string, field: string): void {
  for (const match of source.matchAll(placeholderPattern())) {
    if (!isTemplateVariable(match[1].trim())) throw new BadRequestError(field);
  }
}

export interface TemplateValues {
  /** What to greet the reader as. Never empty — see `greetingName`. */
  name: string;
  /** Absolute, built from the deployment's own allow-list and never from a
   * request header. */
  unsubscribeUrl: string;
  /**
   * SCALARS, like `name` — escaped into the HTML part, verbatim into the text
   * part. Optional because a broadcast with no basket has neither, and an absent
   * value leaves its placeholder VISIBLE rather than blanking it.
   */
  basketTotal?: string;
  basketUrl?: string;
  /**
   * Markup this server generated a moment ago, inserted RAW — the one
   * unescaped insertion in this module. `text` is what the plain-text part gets
   * instead, because a table of basket lines has a completely different shape in
   * a message with no markup; it is not the HTML with the tags taken out.
   *
   * Optional so every existing caller compiles unchanged: a broadcast with no
   * basket passes nothing and `{{basket}}` stays visible, which is the same
   * "leave it where the operator can see it" rule the unknown-placeholder branch
   * below follows.
   */
  blocks?: Record<string, { html: string; text: string }>;
}

/**
 * The five characters that change the meaning of HTML.
 *
 * `'` IS INCLUDED and that is not superstition: `{{unsubscribe_url}}` is the one
 * value that is routinely substituted INSIDE an attribute, and a template author
 * writing `href='{{unsubscribe_url}}'` with single quotes is not doing anything
 * unusual. Escaping only the four "obvious" characters leaves that case open.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Substitute into an HTML body. **Scalar values are escaped; blocks and the
 * template itself are not.**
 *
 * That asymmetry is the whole point. The template is HTML written by an owner and
 * is meant to contain tags; the SCALAR VALUES are a subscriber's own name and a
 * URL this server built, and a name is a field somebody else typed. Substituting
 * it raw would put whatever a CSV import contained into the markup of a message
 * sent to everybody — and while mail clients strip `<script>`, they render `<a>`
 * and `<img>` perfectly well, which is enough to turn one poisoned import row
 * into a link the shop appears to have sent. A BLOCK is inserted raw for the
 * opposite reason: it is markup this server built a moment ago, and escaping it
 * would show the reader `&lt;table&gt;` instead of a table. See `TEMPLATE_BLOCKS`
 * in `shared/email/variables.ts`.
 */
export function renderHtml(template: string, values: TemplateValues): string {
  return substitute(template, values, 'html');
}

/** Substitute into a plain-text body. Scalars pass through unescaped: there is
 * no markup to escape INTO, and `&amp;` in a text part is a bug the reader sees.
 * A block gets its OWN `text` shape rather than the html with tags stripped —
 * see `TemplateValues.blocks`. */
export function renderText(template: string, values: TemplateValues): string {
  return substitute(template, values, 'text');
}

/**
 * A subject line. Text rules, plus two of its own.
 *
 * `{{unsubscribe_url}}` IN A SUBJECT IS SUBSTITUTED LIKE ANYTHING ELSE rather
 * than refused, because refusing it would need a second variable list and a second
 * validator for one field. It is a strange thing to write and it produces a
 * strange subject; it is not a hazard, and the composer's preview shows it.
 *
 * `{{basket}}` IS NOT SUBSTITUTED AT ALL — `blocks` is dropped before this ever
 * reaches `substitute`, so the branch that would insert it never fires and the
 * unknown-placeholder branch leaves the braces exactly as typed. A table's worth
 * of basket lines in the one field a mail client truncates at about sixty
 * characters is obviously wrong to the operator previewing it, which is the
 * point: visible and mistyped-looking beats silently wrong.
 */
export function renderSubject(template: string, values: TemplateValues): string {
  return substitute(template, { ...values, blocks: undefined }, 'text');
}

function substitute(
  template: string,
  values: TemplateValues,
  part: 'html' | 'text',
): string {
  const encode = part === 'html' ? escapeHtml : (value: string) => value;

  return template.replaceAll(placeholderPattern(), (whole, raw: string) => {
    const name = raw.trim();

    /*
     * BLOCKS DISPATCH FIRST, AND NEVER THROUGH `encode`. A block is markup this
     * server built a moment ago; `html`/`text` on it are already the two shapes
     * the two parts need, chosen by `part` rather than run through the scalar
     * escaping path.
     *
     * GATED ON `isTemplateBlock(name)` BEFORE THE LOOKUP, NOT ON
     * `values.blocks?.[name] !== undefined` ALONE. `blocks` is a plain object,
     * so once it is present at all — every nudge that resolved a basket —
     * `{{constructor}}`, `{{toString}}`, `{{valueOf}}`, `{{__proto__}}` and
     * `{{hasOwnProperty}}` each resolve to a truthy INHERITED value from
     * `Object.prototype`, and an unguarded index would pass `block !==
     * undefined` and then stringify `block.html` (itself a function, not a
     * string) as the literal word "undefined" into the message. Checking
     * membership in the closed set FIRST is what makes `TEMPLATE_BLOCKS` in
     * `shared/email/variables.ts` an ENFORCED contract rather than an
     * aspirational comment — only `basket` can ever reach the index below.
     */
    if (isTemplateBlock(name)) {
      const block = values.blocks?.[name];
      if (block !== undefined) return part === 'html' ? block.html : block.text;
    }

    if (name === 'name') return encode(values.name);
    if (name === 'unsubscribe_url') return encode(values.unsubscribeUrl);
    if (name === 'basket_total' && values.basketTotal !== undefined) {
      return encode(values.basketTotal);
    }
    if (name === 'basket_url' && values.basketUrl !== undefined) {
      return encode(values.basketUrl);
    }
    /*
     * LEFT ALONE RATHER THAN BLANKED. Reaching here means either a template was
     * stored before `assertKnownVariables` existed (or by a path that skipped
     * it), or it is a known scalar — `basket_total`/`basket_url` — whose value
     * this caller did not supply, which is the ordinary shape of a broadcast
     * with no basket. Of the two ways to be wrong, leaving `{{firstname}}` or
     * `{{basket_total}}` visible in the message is the one that gets reported
     * and fixed. Silently blanking it produces "Hi ," and a support thread about
     * a mail-merge that "sometimes" works.
     */
    return whole;
  });
}

/**
 * What `{{name}}` becomes.
 *
 * THE LOCAL PART, WHEN THERE IS NO NAME — not "there", not "friend", and not the
 * empty string. `email_subscribers.name` is nullable because an import or a
 * checkout usually hands over an address and nothing else, so this case is the
 * common one rather than the edge.
 *
 * The empty string is out because "Hi ," is the one output nobody would ever ship
 * on purpose. A canned English greeting is out because it is a language decision
 * taken by a server for a message an operator wrote, and the operator cannot see
 * it, override it or translate it. The local part is the only thing about the
 * person this system actually knows, and it is what they themselves chose — an
 * operator who does not want it writes a template without `{{name}}`, which is a
 * decision they CAN see.
 */
export function greetingName(email: string, name: string | null): string {
  const trimmed = (name ?? '').trim();
  if (trimmed !== '') return trimmed;
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}
