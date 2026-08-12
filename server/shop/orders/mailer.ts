/**
 * Transactional email (brief §5): four messages, an interface, and a rendering
 * step that has nothing to do with delivery.
 *
 * ⚠️  **`LoggingMailer` STILL DOES NOT SEND EMAIL, AND IS STILL THE DEFAULT.** It
 *     records the fully rendered message and returns. What HAS changed is that
 *     `portMailer` at the bottom of this file adapts this subsystem's `Mailer` to
 *     `server/mail/port.ts`'s, and `server/index.ts` registers a real transport
 *     through it at the composition root — so a deployment with `RESEND_API_KEY`
 *     set now delivers order mail, while a test that registers nothing still gets
 *     the honest logger. The name stays `LoggingMailer` for exactly the reason
 *     given below.
 *
 * FOUR MESSAGES IN v1 AND NO MORE (brief §5): confirmation on `paid`, shipment on
 * `shipped` with tracking, cancellation, refund.
 *
 * DELIVERY IS NOT IN THIS FILE'S CONTROL FLOW. The intent row is written in the
 * same statement as the state change that caused it and the sweeper delivers it
 * later (`repo/emails.ts`). That ordering is the whole design: a send failure must
 * not roll back an order that is genuinely paid, and an order that is paid must not
 * depend on an email provider being up.
 */

/** The kinds, matching `shop_order_email_intents_kind_ck`. */
export type EmailKind = 'confirmation' | 'shipment' | 'cancellation' | 'refund';

export interface RenderedEmail {
  to: string;
  subject: string;
  body: string;
}

/**
 * The seam a provider plugs into.
 *
 * ONE METHOD, AND IT MAY REJECT. A `Mailer` that could not fail would let every
 * caller forget that the network exists; the sweeper's whole job is to record the
 * failure and leave the intent unsent, so the failure has to be expressible.
 *
 * ═══ THIS IS NOT `server/mail/port.ts`'S `Mailer`, AND IT STAYS THAT WAY ═══
 * The port takes `{ to, subject, text, html }`; this takes `{ to, subject, body }`,
 * because `body` is a COLUMN. Every message this subsystem sends was rendered and
 * stored in `shop_order_email_intents.body` in the same statement as the state
 * change that owed it (`repo/orders.ts`, `repo/fulfillments.ts`) — that is the
 * whole design, and a two-part interface here would mean either a second column on
 * a table with rows in it or an HTML part invented at delivery time and therefore
 * absent from the record of what was sent.
 *
 * So the two shapes are reconciled by an ADAPTER (`portMailer`, at the foot of
 * this file) rather than by making one of them the other. The intent row stays the
 * single source of truth for what a customer was told; the port stays the one
 * interface a transport implements.
 */
export interface Mailer {
  send(message: RenderedEmail): Promise<void>;
}

/**
 * Records what would have been sent. **It sends nothing.**
 *
 * `sent` is kept in memory so a test can assert on the rendered text, and one line
 * per message goes to the log so the same is true of a deployment. The name is
 * `LoggingMailer` and not `DefaultMailer` on purpose: a name that did not say
 * "logging" would be read as "the mailer", and somebody would deploy believing
 * customers were being emailed.
 */
export class LoggingMailer implements Mailer {
  readonly sent: RenderedEmail[] = [];

  send(message: RenderedEmail): Promise<void> {
    this.sent.push(message);
    // eslint-disable-next-line no-console -- this record IS the delivery in this build
    console.info(
      '[shop/orders/mail] NOT SENT (logging mailer)',
      JSON.stringify({ to: message.to, subject: message.subject }),
    );
    return Promise.resolve();
  }
}

// ------------------------------------------------------------------- rendering

/**
 * What a message needs to render. Deliberately the ORDER'S OWN SNAPSHOT and never
 * a catalog read: brief §2's rule is that everything on a line is a snapshot, and
 * an email is the single place where rendering from live data would be most
 * visible and least recoverable — the customer has the message forever.
 */
export interface OrderMailView {
  orderNumber: string;
  email: string;
  currency: string;
  grandTotal: number;
  lines: { title: string; sku: string; qty: number; lineTotal: number }[];
}

export interface ShipmentMailView extends OrderMailView {
  carrier: string | null;
  trackingNumber: string | null;
}

export interface RefundMailView extends OrderMailView {
  /** This refund alone, minor units, positive. */
  refundedAmount: number;
  /** Cumulative, so the message can say whether anything is still outstanding. */
  refundedTotal: number;
}

/**
 * Minor units to a human string, WITHOUT `Intl.NumberFormat`.
 *
 * `Intl` would need a locale, and a locale is a decision nobody has made here; it
 * also formats differently across Node builds with different ICU data, which would
 * make a test either brittle or untestable. Two-decimal minor units with the ISO
 * code beside them is unambiguous in every locale, which is what an invoice needs.
 *
 * `MINOR_UNIT_DIGITS` is 2 and is a KNOWN SIMPLIFICATION: JPY has none and KWD has
 * three. Contract §13 pins one store currency for v1, so this is correct for that
 * currency and wrong for a shop that switches to yen — which is why the digits are
 * a named constant with this note on it rather than a `/ 100` buried in a template.
 */
const MINOR_UNIT_DIGITS = 2;

export function formatAmount(minorUnits: number, currency: string): string {
  const negative = minorUnits < 0;
  const magnitude = Math.abs(minorUnits);
  const divisor = 10 ** MINOR_UNIT_DIGITS;
  const whole = Math.trunc(magnitude / divisor);
  const fraction = String(magnitude % divisor).padStart(MINOR_UNIT_DIGITS, '0');
  return `${negative ? '-' : ''}${whole}.${fraction} ${currency}`;
}

function lineTable(view: OrderMailView): string {
  return view.lines
    .map((line) => `  ${line.qty} × ${line.title} (${line.sku}) — ${formatAmount(line.lineTotal, view.currency)}`)
    .join('\n');
}

/**
 * The guest access link, if one was minted.
 *
 * `origin` is passed in from the request's own allow-list (`AppEnv.origins`) and
 * never built from a `Host` header — the same rule `server/routes/auth.ts` follows
 * for invite URLs, and for the same reason: a link built from an attacker-supplied
 * header is a phishing link the application sent itself.
 */
export interface AccessLink {
  origin: string;
  token: string;
}

function accessFooter(view: OrderMailView, link: AccessLink | null): string {
  if (!link) return '';
  const url = `${link.origin}/shop/orders/${encodeURIComponent(view.orderNumber)}?token=${encodeURIComponent(link.token)}`;
  return `\n\nView your order: ${url}\n(The link expires; the order number alone will not open it.)`;
}

export function renderConfirmation(view: OrderMailView, link: AccessLink | null): RenderedEmail {
  return {
    to: view.email,
    subject: `Order ${view.orderNumber} confirmed`,
    body:
      `Thank you — we have your payment for order ${view.orderNumber}.\n\n` +
      `${lineTable(view)}\n\n` +
      `Total: ${formatAmount(view.grandTotal, view.currency)}` +
      accessFooter(view, link),
  };
}

export function renderShipment(view: ShipmentMailView, link: AccessLink | null): RenderedEmail {
  const tracking =
    view.trackingNumber === null
      ? 'Your parcel is on its way.'
      : `Tracking: ${view.trackingNumber}${view.carrier === null ? '' : ` (${view.carrier})`}`;
  return {
    to: view.email,
    subject: `Order ${view.orderNumber} has shipped`,
    body:
      `Order ${view.orderNumber} is on its way.\n\n${tracking}\n\n` +
      `${lineTable(view)}` +
      accessFooter(view, link),
  };
}

export function renderCancellation(view: OrderMailView, link: AccessLink | null): RenderedEmail {
  return {
    to: view.email,
    subject: `Order ${view.orderNumber} cancelled`,
    body:
      `Order ${view.orderNumber} has been cancelled and will not ship.\n\n` +
      `${lineTable(view)}\n\n` +
      `Nothing further is owed. Any payment taken is refunded separately.` +
      accessFooter(view, link),
  };
}

export function renderRefund(view: RefundMailView, link: AccessLink | null): RenderedEmail {
  const outstanding = view.grandTotal - view.refundedTotal;
  return {
    to: view.email,
    subject: `Refund for order ${view.orderNumber}`,
    body:
      `We have refunded ${formatAmount(view.refundedAmount, view.currency)} ` +
      `against order ${view.orderNumber}.\n\n` +
      `Refunded so far: ${formatAmount(view.refundedTotal, view.currency)} of ` +
      `${formatAmount(view.grandTotal, view.currency)}.\n` +
      (outstanding > 0
        ? `Still charged: ${formatAmount(outstanding, view.currency)}.`
        : `The order is refunded in full.`) +
      accessFooter(view, link),
  };
}

// -------------------------------------------------------------- the adapter

/**
 * A `server/mail/port.ts` transport, seen as one of this subsystem's `Mailer`s.
 *
 * THIS IS THE OBJECT HANDOFF §1.11 SAYS IS MISSING. Two `Mailer` interfaces existed
 * in this repository — `{ to, subject, body }` here, `{ to, subject, text, html }`
 * there — and nothing adapted them, so a complete transactional outbox with dedupe
 * keys and eight-attempt retries delivered precisely nothing, while a single
 * password-reset route was the only real email the application sent. One function
 * closes that, and `server/index.ts` registers it at the composition root.
 *
 * THE PLAIN-TEXT BODY IS THE ORIGINAL AND THE HTML IS DERIVED, NEVER THE OTHER WAY
 * ROUND. `body` is what is stored in the intent row, what the admin order view
 * shows and what a test asserts on; deriving text FROM html would make the record
 * of what a customer was told a lossy round trip through a tag stripper.
 *
 * `assertConfigured` IS NOT FORWARDED, DELIBERATELY. This subsystem's `Mailer` has
 * no such method and the sweeper has no use for one: it never asks "could this
 * possibly work" ahead of time, because there is no caller to answer 501 to — the
 * intent is already committed and a configuration failure is recorded on the row
 * like any other refusal. The parameter type accepts a transport that has one so a
 * `resendMailer()` can be passed straight in.
 */
export function portMailer(transport: {
  send(msg: { to: string; subject: string; text: string; html: string }): Promise<void>;
  assertConfigured?(): void;
}): Mailer {
  return {
    send: (message) =>
      transport.send({
        to: message.to,
        subject: message.subject,
        text: message.body,
        html: textToHtml(message.body),
      }),
  };
}

/**
 * Plain text to the simplest HTML that renders it faithfully.
 *
 * ESCAPE FIRST, THEN LINKIFY, AND THE ORDER IS THE WHOLE CORRECTNESS ARGUMENT. The
 * bodies passed through here are rendered from order snapshots, and a product title
 * is a string somebody typed — `Mug <3` reaches this function verbatim. Escaping
 * after linkifying would either double-escape the `&` in a URL or leave a title's
 * `<` as markup; escaping first means the linkifier only ever sees text it produced
 * itself, and `&amp;` inside an `href` is what HTML requires anyway.
 *
 * NO `<html>`, NO `<head>`, NO STYLE. Every mail client rewrites the document
 * wrapper and most strip a `<style>` block, so anything beyond paragraphs and links
 * is work discarded in transit. The one thing this must get right is that the guest
 * access link is CLICKABLE: a bare URL in an HTML part is not a link in several
 * clients, and an order confirmation whose "view your order" link is dead is a
 * support ticket per order.
 *
 * DELIBERATELY LOCAL RATHER THAN SHARED WITH `server/email/render.ts`. That module
 * belongs to the marketing subsystem; importing it here would couple Orders to a
 * feature it has no business knowing about, for eight lines.
 */
function textToHtml(body: string): string {
  const escaped = body
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

  const linked = escaped.replace(
    // `[^\s<]` rather than a URL grammar: the input is already escaped, so the
    // only way a `<` can appear is as `&lt;`, and stopping at whitespace is what
    // keeps a trailing full stop out of the href.
    /https?:\/\/[^\s<]+/g,
    (url) => `<a href="${url}">${url}</a>`,
  );

  return linked
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replaceAll('\n', '<br>')}</p>`)
    .join('\n');
}
