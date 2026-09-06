/**
 * Transactional email: the messages an order sends as it moves through its life,
 * an interface, and a rendering step that has nothing to do with delivery.
 *
 * ⚠️  **`LoggingMailer` STILL DOES NOT SEND EMAIL, AND IS STILL THE DEFAULT.** It
 *     records the fully rendered message and returns. `portMailer` at the bottom
 *     of this file adapts this subsystem's `Mailer` to `server/mail/port.ts`'s,
 *     and `server/index.ts` registers a real transport through it at the
 *     composition root — so a deployment with `RESEND_API_KEY` set delivers order
 *     mail, while a test that registers nothing still gets the honest logger. The
 *     name stays `LoggingMailer` for exactly the reason given below.
 *
 * ═══════════════════ SIX MESSAGES, NOT FOUR ═══════════════════
 * The brief specified four — confirmation, shipment, cancellation, refund — and
 * that left two holes a customer actually falls into:
 *
 *   * **`placed`.** Between pressing pay and the payment settling, this shop can
 *     take a full minute, because the outbox sweep does the work rather than the
 *     webhook (see the cron note in CLAUDE.md). Four messages meant sixty seconds
 *     of silence immediately after somebody spent money — the single worst moment
 *     to say nothing.
 *   * **`delivered`.** With four messages the last thing a customer ever heard was
 *     "on its way", so an order that arrived and an order lost in transit looked
 *     identical from their inbox.
 *
 * Migration 0320 widened `shop_order_email_intents_kind_ck` to admit both.
 *
 * ═══════════════════ AND SEVEN, NOT SIX ═══════════════════
 * `refund_failed` is the seventh, and it is the only message here that reports a
 * failure of OURS to the person it happened to: a refund the provider accepted
 * and later could not settle. task-d4 made that visible to an OPERATOR — a
 * timeline entry on the order — and named the customer's half as a follow-up
 * (§5 of its own report), which this is. Migration 0380 widened the same CHECK
 * a second time to admit it.
 *
 * ═══════════════════ THE HTML IS NO LONGER DERIVED FROM THE TEXT ═══════════════
 * It used to be: `textToHtml` wrapped the plain-text body in bare `<p>` elements
 * at DELIVERY time, which is why every order email this shop has sent looks like
 * a 1997 mailing-list digest. Both parts are now authored — the text part from
 * the template's `text` body, the HTML part from its `html` body, each rendered
 * against the same values — and BOTH are stored on the intent row
 * (`body` and the new `html` column) in the same statement as the state change.
 *
 * That keeps the property the old design was protecting: the intent row remains
 * the complete record of what a customer was told. It just records both parts
 * now instead of one and a recipe for the other. `textToHtml` survives at the
 * bottom of this file for rows written before 0320, which have no HTML part and
 * are history rather than a gap to backfill.
 *
 * DELIVERY IS STILL NOT IN THIS FILE'S CONTROL FLOW, and that is unchanged and
 * non-negotiable: the intent row is written with the state change and the sweeper
 * delivers it later (`repo/emails.ts`). A send failure must not roll back an order
 * that is genuinely paid, and an order that is paid must not depend on an email
 * provider being up.
 */

import { facts, lineTable, timeline } from '../../mail/brand';
import { normalizeBlobId, publicImageUrl } from '../../repo/public-projection';
import { BUILT_IN } from '../../email/system-templates';
import { render, textLines, textTimeline } from '../../mail/transactional';
import type { TemplateSet } from '../../email/system-templates';
import type { Step } from '../../mail/brand';
import type { SystemKey } from '../../mail/defaults';
import type { RenderedMessage, TemplateValues } from '../../mail/transactional';

/** The kinds, matching `shop_order_email_intents_kind_ck` after migration 0640. */
export type EmailKind =
  | 'placed'
  | 'confirmation'
  | 'shipment'
  | 'delivered'
  | 'cancellation'
  | 'refund'
  | 'refund_failed'
  /* Both are ABOUT A REVIEW and both ride this outbox anyway — migration 0640's
     header carries the argument for why that is the right table rather than a
     shortcut, and names the one case it leaves unserved. */
  | 'review_invite'
  | 'review_approved';

/**
 * A rendered message. `html` is nullable ONLY because rows written before
 * migration 0320 have none — every render in this file produces both parts.
 */
export interface RenderedEmail {
  to: string;
  subject: string;
  body: string;
  html?: string | null;
}

/**
 * The seam a provider plugs into.
 *
 * ONE METHOD, AND IT MAY REJECT. A `Mailer` that could not fail would let every
 * caller forget that the network exists; the sweeper's whole job is to record the
 * failure and leave the intent unsent, so the failure has to be expressible.
 *
 * ═══ THIS IS NOT `server/mail/port.ts`'S `Mailer`, AND IT STAYS THAT WAY ═══
 * The port takes `{ to, subject, text, html }`; this takes `{ to, subject, body,
 * html }`, because `body` is a COLUMN and renaming it here would only move the
 * mismatch into the SQL. The two shapes are reconciled by an ADAPTER
 * (`portMailer`, at the foot of this file) rather than by making one of them the
 * other: the intent row stays the single source of truth for what a customer was
 * told, and the port stays the one interface a transport implements.
 */
export interface Mailer {
  send(message: RenderedEmail): Promise<void>;
}

/**
 * Records what would have been sent. **It sends nothing.**
 *
 * The name is `LoggingMailer` and not `DefaultMailer` on purpose: a name that did
 * not say "logging" would be read as "the mailer", and somebody would deploy
 * believing customers were being emailed.
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
  lines: {
    title: string;
    sku: string;
    qty: number;
    lineTotal: number;
    /** The photograph snapshotted onto the order line (migration 0340).
     * Absent or `null` for a variant with no picture, and for the `placed`
     * message, whose view is built from the checkout event. */
    imageId?: string | null;
  }[];
  /** The add-ons, after the goods. Optional so every fulfilment view compiles; absent renders nothing. */
  addOns?: { title: string; amount: number; mode: 'chosen' | 'included' }[];
  /** When the order was placed, epoch-ms. Optional so existing callers compile;
   * absent renders as an empty date rather than as "Invalid Date". */
  placedAt?: number | null;
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
 * A refund that did NOT move. One figure and no cumulative total, unlike
 * `RefundMailView` — see `ORDER_REFUND_FAILED` in `server/mail/defaults.ts` for
 * why a running total beside a failure is a number that means nothing.
 */
export interface RefundFailedMailView extends OrderMailView {
  /** This refund alone, minor units, positive — what failed to move. */
  failedAmount: number;
}

export interface CancelMailView extends OrderMailView {
  /** Why, in the operator's own words. Optional; a generic line stands in. */
  reason?: string | null;
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

/**
 * The guest access link, if one was minted.
 *
 * `origin` IS THE STOREFRONT'S, NOT THIS APPLICATION'S — see
 * `server/shop/storefront-url.ts`, which carries the full account of the bug this
 * caused. It is still never built from a `Host` header, for the reason
 * `server/routes/auth.ts` gives: a link built from an attacker-supplied header is
 * a phishing link the application sent itself.
 */
export interface AccessLink {
  origin: string;
  token: string;
}

/**
 * THE PATH IS `/account/orders/:orderNumber`, NOT `/shop/orders/:orderNumber`.
 * Every order email built the latter until 2026-08-23 — it 404s on the deployed
 * storefront, which serves this page from
 * `apps/storefront/app/(shop)/account/orders/[orderNumber]/page.tsx` and reads
 * `?token=` there. See `server/shop/storefront-url.ts`'s `orderUrl`, which builds
 * the identical shape and carries the same fix; this function is the second of
 * the two places that duplicated the path rather than calling it.
 */
function accessUrl(view: OrderMailView, link: AccessLink | null): string {
  if (!link) return '';
  return (
    `${link.origin}/account/orders/${encodeURIComponent(view.orderNumber)}` +
    `?token=${encodeURIComponent(link.token)}`
  );
}

/**
 * What `{{customer_name}}` becomes.
 *
 * THE LOCAL PART OF THE ADDRESS, and the same decision `server/email/render.ts`
 * documents at length for `greetingName`: an order carries an address and, often,
 * no name at all. "there" and "friend" are canned English chosen by a server for a
 * message an operator wrote and cannot see; the local part is the only thing about
 * the person this system actually knows, and it is what they chose themselves.
 */
/**
 * The snapshotted image id as an ABSOLUTE url, or `null`.
 *
 * ABSOLUTE, BECAUSE THIS IS AN EMAIL. `publicImageUrl` returns a ROOT-RELATIVE
 * path, which is exactly right in a browser on the site and meaningless in a
 * mail client — there is no document origin to resolve it against, so a relative
 * `src` is a broken image in every one of them.
 *
 * THE SAME ORIGIN THE LOGO USES, and for the same reason: `/api/public/images/`
 * is served by this deployment, without authentication, and the storefront is a
 * separate Worker that does not carry these routes.
 *
 * `normalizeBlobId` IS NOT OPTIONAL. `server/repo/public-projection.ts` records
 * that the id is stored both bare and `asset:`/`idb:`-prefixed depending on when
 * it was written — and building the URL without stripping that prefix produces
 * `/api/public/images/asset:img_x`, which 404s. It is the same one-line trap the
 * storefront projection already fell into once.
 */
function imageUrlFor(imageId: string | null | undefined): string | null {
  if (imageId == null) return null;
  const id = normalizeBlobId(imageId);
  if (id === '') return null;
  return `${storefrontAssetOrigin()}${publicImageUrl(id)}`;
}

/**
 * Where `/api/public/images/…` is served from.
 *
 * A SECOND COPY of `brand.ts`'s `assetOrigin`, kept private there because it is
 * about the masthead and this one is about product photographs — but they must
 * resolve identically, and `BRAND_ASSET_ORIGIN` is what makes that true with one
 * variable rather than two.
 */
function storefrontAssetOrigin(): string {
  const configured = process.env.BRAND_ASSET_ORIGIN?.trim();
  return (configured || 'https://blog-admin-app-gold.vercel.app').replace(/\/+$/, '');
}

function greeting(email: string): string {
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

/**
 * The support address shown in every footer.
 *
 * FALLS BACK TO `MAIL_FROM`, then to a literal, and never to the empty string. A
 * footer reading "write to us at" with nothing after it is worse than a wrong
 * address, because the reader cannot tell it is broken — they conclude the shop
 * has no support and do not write.
 */
function supportEmail(): string {
  const explicit = process.env.SHOP_SUPPORT_EMAIL?.trim();
  if (explicit) return explicit;
  const from = process.env.MAIL_FROM?.trim();
  // `MAIL_FROM` is routinely `PlaSpool <noreply@…>`; take the address out of it.
  const angled = from?.match(/<([^>]+)>/);
  if (angled) return angled[1];
  if (from) return from;
  return 'support@plaspool.com';
}

/** `2026-08-21` rather than a locale-formatted date, for `formatAmount`'s reason:
 * ICU data differs across Node builds, and an unambiguous date beats a pretty one
 * that reads as a different day in another country. */
function formatDate(ms: number | null | undefined): string {
  if (ms == null) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ timeline */

/**
 * Where this message sits in the order's life.
 *
 * THE HAPPY PATH IS FOUR STEPS AND THE TERMINAL STATES ARE THREE, rather than one
 * six-step strip with two of them crossed out. A cancelled order never had a
 * "shipped" step to fail — showing one greyed out invites the reader to wonder
 * whether it might still happen. `brand.ts` documents why `stopped` is a state of
 * its own and not a variety of `done`.
 */
function stepsFor(kind: EmailKind): Step[] {
  const path = (at: number): Step[] =>
    ['Placed', 'Paid', 'Shipped', 'Delivered'].map((label, i) => ({
      label,
      state: i < at ? 'done' : i === at ? 'now' : 'next',
    }));

  switch (kind) {
    case 'placed':
      return path(0);
    case 'confirmation':
      return path(1);
    case 'shipment':
      return path(2);
    case 'delivered':
    /* The invitation follows a delivery, so it shows the same finished strip —
       the reader is looking at a parcel that arrived either way. */
    case 'review_invite':
    /* And so does the published note: the order behind it is complete, and a
       review is not a fifth step in a delivery. */
    case 'review_approved':
      return path(3);
    case 'cancellation':
      return [
        { label: 'Placed', state: 'done' },
        { label: 'Cancelled', state: 'stopped' },
      ];
    case 'refund':
      return [
        { label: 'Placed', state: 'done' },
        { label: 'Paid', state: 'done' },
        { label: 'Refunded', state: 'stopped' },
      ];
    /*
     * `Refund` AS `now`, NOT `Refunded` AS `stopped`. The refund is the step the
     * order is sitting on — attempted, not landed — and drawing it the way the
     * `refund` message above does would tell a reader in a strip that their
     * money came back, three lines under a paragraph saying it did not. The
     * label loses its past tense for the same reason.
     */
    case 'refund_failed':
      return [
        { label: 'Placed', state: 'done' },
        { label: 'Paid', state: 'done' },
        { label: 'Refund', state: 'now' },
      ];
  }
}

/* -------------------------------------------------------------------- values */

/** The scalars and blocks every order message shares. */
function baseValues(
  view: OrderMailView,
  link: AccessLink | null,
  kind: EmailKind,
): TemplateValues {
  const rows = view.lines.map((l) => ({
    title: l.title,
    sku: l.sku,
    qty: l.qty,
    amount: formatAmount(l.lineTotal, view.currency),
    imageUrl: imageUrlFor(l.imageId),
  }));
  const addOnRows = (view.addOns ?? []).map((a) => ({
    title: a.title,
    sku: a.mode === 'included' ? 'Included' : 'Add-on',
    qty: 1,
    amount: a.mode === 'included' && a.amount === 0 ? 'Included' : formatAmount(a.amount, view.currency),
    imageUrl: null,
  }));
  const total = formatAmount(view.grandTotal, view.currency);
  const steps = stepsFor(kind);

  return {
    scalars: {
      order_number: view.orderNumber,
      customer_name: greeting(view.email),
      order_total: total,
      order_date: formatDate(view.placedAt),
      order_url: accessUrl(view, link),
      support_email: supportEmail(),
    },
    blocks: {
      order_lines: {
        html: lineTable([...rows, ...addOnRows], [{ label: 'Total', amount: total, strong: true }]),
        text: textLines([...rows, ...addOnRows]),
      },
      order_timeline: {
        html: timeline(steps),
        text: textTimeline(steps),
      },
    },
  };
}

/**
 * Render one message from the template set.
 *
 * `templates` DEFAULTS TO THE BUILT-INS so every existing caller and every test
 * compiles unchanged and still gets a correct message. That default is also the
 * belt to `system-templates.ts`'s braces: even a caller that forgets to thread the
 * set through sends a properly branded email rather than nothing.
 */
function renderKind(
  key: SystemKey,
  view: OrderMailView,
  values: TemplateValues,
  templates: TemplateSet,
): RenderedEmail {
  const message: RenderedMessage = render(templates.get(key), view.email, values);
  return {
    to: message.to,
    subject: message.subject,
    body: message.body,
    html: message.html,
  };
}

export function renderPlaced(
  view: OrderMailView,
  link: AccessLink | null,
  templates: TemplateSet = BUILT_IN,
): RenderedEmail {
  return renderKind('order.placed', view, baseValues(view, link, 'placed'), templates);
}

export function renderConfirmation(
  view: OrderMailView,
  link: AccessLink | null,
  templates: TemplateSet = BUILT_IN,
): RenderedEmail {
  return renderKind('order.confirmation', view, baseValues(view, link, 'confirmation'), templates);
}

export function renderShipment(
  view: ShipmentMailView,
  link: AccessLink | null,
  templates: TemplateSet = BUILT_IN,
): RenderedEmail {
  const values = baseValues(view, link, 'shipment');
  values.scalars.carrier = view.carrier ?? '';
  values.scalars.tracking_number = view.trackingNumber ?? '';

  /*
   * THE PANEL IS OMITTED ENTIRELY WHEN THERE IS NO TRACKING, rather than rendered
   * with blanks in it. `shop_fulfillments.tracking_number` is nullable and a
   * hand-delivered order never gets one; a panel reading "Tracking: —" looks like
   * the email broke. `defaults.ts` explains why this is a block and not two
   * scalars dropped into a sentence.
   */
  const rows = [
    ...(view.carrier === null ? [] : [{ label: 'Carrier', value: view.carrier }]),
    ...(view.trackingNumber === null
      ? []
      : [{ label: 'Tracking', value: view.trackingNumber, mono: true }]),
  ];
  values.blocks.tracking_panel =
    rows.length === 0
      ? { html: '', text: 'Your parcel is on its way.' }
      : {
          html: facts(rows, 'accent'),
          text: rows.map((r) => `  ${r.label}: ${r.value}`).join('\n'),
        };

  return renderKind('order.shipment', view, values, templates);
}

export function renderDelivered(
  view: OrderMailView,
  link: AccessLink | null,
  templates: TemplateSet = BUILT_IN,
): RenderedEmail {
  return renderKind('order.delivered', view, baseValues(view, link, 'delivered'), templates);
}

/**
 * The invitation to review what was just delivered.
 *
 * ONE PER ORDER, NOT PER PARCEL — enforced by the dedupe key at the call site,
 * not here. A three-parcel order already sends three delivery notices, which is
 * right because each is about a different box; three invitations to review the
 * same order is how a shop teaches people to filter it.
 */
export function renderReviewInvite(
  view: OrderMailView,
  link: AccessLink | null,
  templates: TemplateSet = BUILT_IN,
): RenderedEmail {
  return renderKind('review.invite', view, baseValues(view, link, 'review_invite'), templates);
}

/**
 * "Your review is live", for the reviewer.
 *
 * IT TAKES AN ORDER VIEW because the whole rendering pipeline is built on one,
 * and because the order is genuinely what this message descends from — see
 * migration 0640. The template uses almost none of it: a greeting, the order
 * link, and the support address.
 *
 * THE ADDRESS IS THE CALLER'S PROBLEM, NOT THIS FUNCTION'S. A review carries
 * its own `author_email`, which is the session's address at submission time and
 * need not be the address on the order — a shopper may have checked out as a
 * guest under one and signed up under another. The caller passes the review's.
 */
export function renderReviewApproved(
  view: OrderMailView,
  link: AccessLink | null,
  templates: TemplateSet = BUILT_IN,
): RenderedEmail {
  return renderKind('review.approved', view, baseValues(view, link, 'review_approved'), templates);
}

export function renderCancellation(
  view: CancelMailView,
  link: AccessLink | null,
  templates: TemplateSet = BUILT_IN,
): RenderedEmail {
  const values = baseValues(view, link, 'cancellation');
  const reason = (view.reason ?? '').trim();
  values.scalars.cancel_reason = reason === '' ? 'Cancelled by the shop' : reason;
  return renderKind('order.cancellation', view, values, templates);
}

export function renderRefund(
  view: RefundMailView,
  link: AccessLink | null,
  templates: TemplateSet = BUILT_IN,
): RenderedEmail {
  const values = baseValues(view, link, 'refund');
  const outstanding = view.grandTotal - view.refundedTotal;
  values.scalars.refund_amount = formatAmount(view.refundedAmount, view.currency);
  values.scalars.refunded_total = formatAmount(view.refundedTotal, view.currency);
  /*
   * ONE SENTENCE RATHER THAN AN AMOUNT, because the two cases need different
   * words and not a different number. "Still charged: 0.00 NGN" is technically
   * true of a fully refunded order and reads as though something went wrong.
   */
  values.scalars.outstanding_note =
    outstanding > 0
      ? `You are still charged ${formatAmount(outstanding, view.currency)} for the ` +
        `rest of this order.`
      : 'This order is now refunded in full. Nothing is still charged.';
  return renderKind('order.refund', view, values, templates);
}

/**
 * "We tried to refund you and it did not go through."
 *
 * `{{refund_amount}}` IS THE SAME PLACEHOLDER `renderRefund` USES, deliberately
 * — an owner editing either template in the admin meets one name for "the money
 * this message is about" rather than two. It is filled from a different figure:
 * the event's `failedAmount`, which is this refund alone and is what did NOT
 * move, never a cumulative total.
 */
export function renderRefundFailed(
  view: RefundFailedMailView,
  link: AccessLink | null,
  templates: TemplateSet = BUILT_IN,
): RenderedEmail {
  const values = baseValues(view, link, 'refund_failed');
  values.scalars.refund_amount = formatAmount(view.failedAmount, view.currency);
  return renderKind('order.refund_failed', view, values, templates);
}

// -------------------------------------------------------------- the adapter

/**
 * A `server/mail/port.ts` transport, seen as one of this subsystem's `Mailer`s.
 *
 * THIS IS THE OBJECT HANDOFF §1.11 SAID WAS MISSING. Two `Mailer` interfaces
 * existed in this repository and nothing adapted them, so a complete transactional
 * outbox with dedupe keys and eight-attempt retries delivered precisely nothing.
 * One function closes that, and `server/index.ts` registers it at the composition
 * root.
 *
 * THE STORED HTML IS PREFERRED AND `textToHtml` IS THE FALLBACK. Since migration
 * 0320 both parts are authored and stored on the intent row, so `message.html` is
 * present for anything rendered by this build. A row written BEFORE 0320 has none,
 * and deriving one from its text is exactly what the old code did — so those rows
 * deliver today as they always would have, rather than failing or being silently
 * skipped.
 *
 * `assertConfigured` IS NOT FORWARDED, DELIBERATELY. This subsystem's `Mailer` has
 * no such method and the sweeper has no use for one: it never asks "could this
 * possibly work" ahead of time, because there is no caller to answer 501 to — the
 * intent is already committed and a configuration failure is recorded on the row
 * like any other refusal.
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
        html:
          message.html != null && message.html !== ''
            ? message.html
            : textToHtml(message.body),
      }),
  };
}

/**
 * Plain text to the simplest HTML that renders it faithfully.
 *
 * ⚠️  THIS IS NO LONGER THE RENDERER — it is the fallback for intent rows written
 *     before migration 0320, which have no `html` column value. Do not reach for
 *     it when adding a message; add a template to `server/mail/defaults.ts`.
 *
 * ESCAPE FIRST, THEN LINKIFY, AND THE ORDER IS THE WHOLE CORRECTNESS ARGUMENT. A
 * product title is a string somebody typed — `Mug <3` reaches this function
 * verbatim. Escaping after linkifying would either double-escape the `&` in a URL
 * or leave a title's `<` as markup; escaping first means the linkifier only ever
 * sees text it produced itself.
 *
 * The one thing this must get right is that the guest access link is CLICKABLE: a
 * bare URL in an HTML part is not a link in several clients, and an order
 * confirmation whose "view your order" link is dead is a support ticket per order.
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
