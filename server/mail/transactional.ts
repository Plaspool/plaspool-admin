/**
 * The rendering engine for SYSTEM mail — the messages the application sends by
 * itself, as against the broadcasts an operator composes and presses send on.
 *
 * ══════════ WHY THIS IS NOT `server/email/render.ts`, WHICH ALSO SUBSTITUTES
 *            `{{…}}` INTO HTML AND TEXT ══════════
 *
 * That module has ONE variable list — `name` and `unsubscribe_url` — shared by
 * every message, because every broadcast goes to a subscriber and a subscriber
 * has exactly those two things. System mail is the opposite shape: a shipment
 * message has a carrier and a tracking number, a refund has three amounts that
 * must add up, and a password reset has neither and must never be given an order
 * number to leak. The variable set is PER KIND, and making it per kind is what
 * lets the admin screen tell a writer which placeholders are available in the
 * template actually open in front of them rather than listing all thirty.
 *
 * The `{{…}}` SYNTAX IS SHARED ON PURPOSE even though the engines are not. An
 * operator moving between the broadcast composer and a system template should not
 * have to learn a second placeholder language, and the two regexes are pinned to
 * each other by `transactional.test.ts` so they cannot drift into "this one takes
 * spaces and that one does not".
 *
 * ══════════ TWO CLASSES OF PLACEHOLDER, AND THE DIFFERENCE IS A SECURITY
 *            BOUNDARY RATHER THAN A CONVENIENCE ══════════
 *
 * **Scalars** (`{{order_number}}`, `{{customer_name}}`) are VALUES — a product
 * title somebody typed into the catalogue, a name from a checkout form. They are
 * escaped on the way into the HTML part and passed through verbatim into the text
 * part. `Mug <3` has reached this code path in production.
 *
 * **Blocks** (`{{order_lines}}`, `{{order_timeline}}`) are MARKUP this server
 * generated a moment ago from `brand.ts` components, and are inserted raw —
 * escaping them would show the customer a screenful of `&lt;table&gt;`. Nothing
 * a customer or an operator supplies can become a block: the map is built here,
 * by name, from a closed set.
 *
 * The two are kept apart by TYPE (`TemplateValues.scalars` / `.blocks`) rather
 * than by a naming convention, because a convention is a thing a future caller
 * has to know and a type is a thing the compiler enforces.
 *
 * ══════════ AN UNKNOWN PLACEHOLDER IS LEFT VISIBLE, NEVER BLANKED ══════════
 * Identical reasoning to `server/email/render.ts`, and it is worth repeating
 * because the temptation to "clean up" is strongest exactly here: of the two ways
 * to be wrong, mailing a visible `{{firstname}}` is the one that gets reported and
 * fixed. Silently deleting it produces "Hi ," and a support thread about a
 * mail-merge that "sometimes" works.
 */

import { esc } from './brand';

/**
 * `{{…}}` with NO NESTED BRACE — character-for-character the pattern in
 * `server/email/render.ts`, and pinned to it by test.
 *
 * An unclosed `{{` therefore cannot swallow the document as far as the next `}}`
 * a hundred lines below it.
 */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

export interface TemplateValues {
  /** Escaped into HTML, verbatim into text. Anything a person supplied. */
  scalars: Record<string, string>;
  /**
   * Inserted raw into HTML. The `text` member is what the plain-text part gets
   * instead, because a table of order lines has a completely different shape in
   * a message with no markup — it is not the HTML with the tags taken out.
   */
  blocks: Record<string, { html: string; text: string }>;
}

/** Every placeholder name a given value set can substitute. */
export function knownNames(values: TemplateValues): string[] {
  return [...Object.keys(values.scalars), ...Object.keys(values.blocks)].sort();
}

function substitute(
  template: string,
  values: TemplateValues,
  part: 'html' | 'text',
): string {
  return template.replaceAll(PLACEHOLDER, (whole, raw: string) => {
    const name = raw.trim();
    const block = values.blocks[name];
    if (block !== undefined) return part === 'html' ? block.html : block.text;
    const scalar = values.scalars[name];
    if (scalar !== undefined) return part === 'html' ? esc(scalar) : scalar;
    return whole; // visible, on purpose — see the header.
  });
}

export function renderHtml(template: string, values: TemplateValues): string {
  return substitute(template, values, 'html');
}

export function renderText(template: string, values: TemplateValues): string {
  return substitute(template, values, 'text');
}

/**
 * A subject line. Text rules, and the blocks are unavailable to it.
 *
 * A SUBJECT CANNOT CARRY A BLOCK, and that is enforced rather than discouraged:
 * `{{order_lines}}` in a subject would put a table's worth of text in the one
 * field a mail client truncates at about sixty characters, and the result in an
 * inbox is an order number followed by markup. Left visible as `{{order_lines}}`
 * it is obviously wrong to the operator previewing it, which is the point.
 */
export function renderSubject(template: string, values: TemplateValues): string {
  return substitute(template, { scalars: values.scalars, blocks: {} }, 'text')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/**
 * Everything a system message needs to be handed to a transport.
 *
 * `body` IS THE TEXT PART AND IT KEEPS THAT NAME because it is a COLUMN —
 * `shop_order_email_intents.body`, the stored record of what a customer was told.
 * `html` is the new column beside it. Renaming either to something tidier here
 * would only move the mismatch to the SQL.
 */
export interface RenderedMessage {
  to: string;
  subject: string;
  body: string;
  html: string;
}

export interface TemplateBody {
  subject: string;
  html: string;
  text: string;
}

/** Render one template against one value set. */
export function render(
  template: TemplateBody,
  to: string,
  values: TemplateValues,
): RenderedMessage {
  return {
    to,
    subject: renderSubject(template.subject, values),
    body: renderText(template.text, values),
    html: renderHtml(template.html, values),
  };
}

/* ------------------------------------------------------------ text helpers */

/**
 * The plain-text counterpart of `brand.ts`'s `lineTable`.
 *
 * A SEPARATE RENDERING RATHER THAN A TAG-STRIPPED ONE. Running the HTML table
 * through a stripper produces every cell on its own line with the amounts orphaned
 * from their titles — which is what "the text part is the html with the tags
 * removed" always produces, and why `server/mail/port.ts` requires both parts to
 * be authored rather than derived.
 */
export function textLines(
  rows: { title: string; sku: string; qty: number; amount: string }[],
): string {
  /* `×` (U+00D7), not the letter x. These messages have said "2 × Enamel Mug"
   * since the first version, and a customer comparing an old mail to a new one
   * should not find the arithmetic rendered differently. Pinned by
   * `server/shop/orders/emails.test.ts`, which is how the regression was caught. */
  return rows.map((r) => `  ${r.qty} × ${r.title} (${r.sku}) — ${r.amount}`).join('\n');
}

/** The timeline, for a client with no markup: the current step marked. */
export function textTimeline(steps: { label: string; state: string }[]): string {
  return steps
    .map((s) => {
      if (s.state === 'now') return `  > ${s.label}`;
      if (s.state === 'done') return `  x ${s.label}`;
      if (s.state === 'stopped') return `  ! ${s.label}`;
      return `  . ${s.label}`;
    })
    .join('\n');
}
