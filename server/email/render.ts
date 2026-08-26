import { BadRequestError } from '../repo/errors';
import { isTemplateVariable, placeholderPattern } from '../../shared/email/variables';

/**
 * Variable substitution, SERVER-SIDE (HANDOFF §2 A6).
 *
 * TWO VARIABLES AND NO MORE, AND THE LIST IS ENFORCED AT SAVE TIME RATHER THAN AT
 * SEND TIME. A template carrying `{{firstname}}` is not a template that renders
 * badly — it is a template that mails the literal string `{{firstname}}` to every
 * subscriber, once, unrecallably. There is no second chance to notice, because the
 * person who wrote it sees their own preview and not the five thousand copies. So
 * an unrecognised placeholder is a 400 on the SAVE, naming the field it appeared
 * in, and the send path can then substitute without deciding anything.
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
 */

/**
 * Re-exported so this module remains the server's one door to the vocabulary: the
 * routes and the suites import from here and do not need to know the rule is now
 * shared with the browser.
 */
export { TEMPLATE_VARIABLES, hasUnsubscribeVariable } from '../../shared/email/variables';
export type { TemplateVariable } from '../../shared/email/variables';

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
 * Substitute into an HTML body. **Values are escaped; the template is not.**
 *
 * That asymmetry is the whole point. The template is HTML written by an owner and
 * is meant to contain tags; the VALUES are a subscriber's own name and a URL this
 * server built, and a name is a field somebody else typed. Substituting it raw
 * would put whatever a CSV import contained into the markup of a message sent to
 * everybody — and while mail clients strip `<script>`, they render `<a>` and
 * `<img>` perfectly well, which is enough to turn one poisoned import row into a
 * link the shop appears to have sent.
 */
export function renderHtml(template: string, values: TemplateValues): string {
  return substitute(template, values, escapeHtml);
}

/** Substitute into a plain-text body. No escaping: there is no markup to escape
 * INTO, and `&amp;` in a text part is a bug the reader sees. */
export function renderText(template: string, values: TemplateValues): string {
  return substitute(template, values, (value) => value);
}

/**
 * A subject line. Text rules, plus one of its own.
 *
 * `{{unsubscribe_url}}` IN A SUBJECT IS SUBSTITUTED LIKE ANYTHING ELSE rather
 * than refused, because refusing it would need a second variable list and a second
 * validator for one field. It is a strange thing to write and it produces a
 * strange subject; it is not a hazard, and the composer's preview shows it.
 */
export function renderSubject(template: string, values: TemplateValues): string {
  return renderText(template, values);
}

function substitute(
  template: string,
  values: TemplateValues,
  encode: (value: string) => string,
): string {
  return template.replaceAll(placeholderPattern(), (whole, raw: string) => {
    const name = raw.trim();
    if (name === 'name') return encode(values.name);
    if (name === 'unsubscribe_url') return encode(values.unsubscribeUrl);
    /*
     * LEFT ALONE RATHER THAN BLANKED. Reaching here means a template was stored
     * before `assertKnownVariables` existed, or by a path that skipped it; and of
     * the two ways to be wrong, leaving `{{firstname}}` visible in the message is
     * the one that gets reported and fixed. Silently deleting it produces "Hi ,"
     * and a support thread about a mail-merge that "sometimes" works.
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
