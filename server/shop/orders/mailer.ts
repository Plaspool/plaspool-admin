/**
 * Transactional email (brief §5): four messages, an interface, and a rendering
 * step that has nothing to do with delivery.
 *
 * ⚠️  **THE MAILER SHIPPED HERE DOES NOT SEND EMAIL.** `LoggingMailer` records the
 *     fully rendered message and returns. It exists so the whole path — state
 *     change → intent row → sweeper → rendered message — is real and tested, and
 *     so that wiring a provider later is one object, not a refactor. Nothing in
 *     this file will put a message in a customer's inbox. What the user has to
 *     authorize to change that is written out in the report and in
 *     `AMENDMENTS.md`; it is not something a non-interactive session can do.
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
