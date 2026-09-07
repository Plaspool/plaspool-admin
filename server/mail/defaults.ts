/**
 * THE DEFAULT SYSTEM TEMPLATES — one per message the application sends by itself.
 *
 * ══════════ THESE ARE THE FALLBACK, AND THE FALLBACK IS WHAT MAKES EDITING SAFE
 *            ══════════
 *
 * Each of these is seeded into `email_templates` with its `system_key`, where an
 * owner can edit it, and the edited row is what sends. The definitions here stay
 * the last resort: if the row is missing, unreadable, or the database is simply
 * down at the moment an order is paid, the renderer falls back to the constant in
 * this file and the customer still gets a correct, branded message.
 *
 * THAT FALLBACK IS NOT DEFENSIVENESS, IT IS THE PRECONDITION FOR THE FEATURE
 * EXISTING AT ALL. `repo/orders.ts` writes the rendered message in the SAME
 * STATEMENT as the state change that owed it — the whole design of the outbox —
 * so a render that could throw would be a render that can roll back a capture
 * that genuinely happened. A template read that can fail is only acceptable
 * because failing means "use the built-in", never "raise". `system-templates.ts`
 * is where that guarantee is actually implemented; this file is what it falls
 * back TO.
 *
 * ══════════ WHY THE HTML IS BUILT BY CALLING `brand.ts` RATHER THAN WRITTEN OUT
 *            ══════════
 *
 * The alternative is one hand-written 200-line HTML document per message — a
 * separate copy of the masthead, the card, the shadow trick and the dark-mode
 * block in each. The first time the accent colour moves, most of them are
 * updated and the refund mail stays green for a year, because nobody re-reads
 * the message that only sends on a refund. (No count is named on purpose — this
 * paragraph said "eleven" until the list grew again. `SYSTEM_KEYS` below is the
 * count.)
 *
 * The cost is that the seeded HTML is GENERATED, so an owner who edits a template
 * in the admin is editing a snapshot of the generated document and no longer
 * tracks changes to `brand.ts`. That is the correct trade: an edited template is
 * one somebody deliberately took ownership of, and silently overwriting their
 * wording on the next deploy would be much worse than letting it age.
 *
 * ══════════ ON THE COPY ══════════
 * Plain, and it says what happened and what happens next, in that order. No
 * exclamation marks, no "Woohoo!", no order number in the greeting. The reader
 * opened this because they spent money and want to know where their parcel is.
 */

import {
  badge,
  button,
  divider,
  facts,
  h1,
  link,
  p,
  shell,
  small,
} from './brand';
import type { TemplateBody } from './transactional';

/**
 * The keys, and they are the SYSTEM'S OWN NAMES for these messages.
 *
 * DOTTED AND NAMESPACED, so `order.*` and `account.*` group in the admin list and
 * a future `review.*` does not have to be squeezed into a flat vocabulary. The
 * value is what goes in `email_templates.system_key` and it is part of a stored
 * contract: renaming one orphans the operator's edits to that template, because
 * the seeder would find no row and create a fresh one alongside it.
 */
export const SYSTEM_KEYS = [
  'order.placed',
  'order.confirmation',
  'order.shipment',
  'order.delivered',
  'order.cancellation',
  'order.refund',
  'order.refund_failed',
  'account.welcome',
  'account.invite',
  /*
   * `account.password_reset` and `account.login_code` were here until Clerk
   * became the only auth (2026-09-01). Nothing can send either one: the reset
   * flow and the emailed second factor went with the password routes, and
   * Clerk sends its own equivalents from its own dashboard.
   *
   * REMOVING A KEY DOES NOT REMOVE THE ROW. `ensureSystemTemplates` stops
   * seeding them and `resolve()` never looks them up, but any
   * `email_templates` row already seeded in production stays — visible on the
   * templates screen, editable, and unable to send. Deleting those rows is a
   * migration and destroys whatever wording an owner had put in them, so it
   * is the owner's call rather than a tidy-up.
   */
  'return.awarded',
  'return.rejected',
  /* The namespace the SYSTEM_KEYS comment predicted. Both are about a review,
     not about an order, even though both ride the order outbox — see the
     templates below for why that is the right table and not a shortcut. */
  'review.invite',
  'review.approved',
  /* The catalog namespace: staff-facing, not customer-facing — see the
     template for why it still lives beside the rest. */
  'catalog.export',
] as const;

export type SystemKey = (typeof SYSTEM_KEYS)[number];

export interface SystemTemplate extends TemplateBody {
  key: SystemKey;
  /** The `email_templates.name`, and what the admin list shows. */
  name: string;
  /** One line under the name on the admin list: when this message sends. */
  description: string;
  /**
   * Every placeholder this message can substitute, for the admin's "Insert"
   * strip. Ordered as they usually appear rather than alphabetically — a writer
   * scanning for the tracking number should not have to read past `{{amount}}`.
   */
  variables: readonly string[];
}

/* ------------------------------------------------------------ shared pieces */

/** The support address shown in every footer, as a placeholder so it is one edit. */
const SUPPORT = '{{support_email}}';

/**
 * The footer under the card.
 *
 * TRANSACTIONAL MAIL CARRIES NO UNSUBSCRIBE LINK, and that is a deliberate
 * asymmetry with `server/email/render.ts`, which REFUSES to broadcast a template
 * without one. A shipment notice is not marketing: it is a message about a
 * contract the reader entered by paying, and offering to stop sending it would be
 * offering to stop telling them where their parcel is. The marketing footer's
 * unsubscribe link is in `account.welcome` below, which IS a subscription.
 */
function orderFooter(): string {
  return (
    `You are receiving this because you placed an order with PlaSpool. ` +
    `Questions about this order? Reply to this message or write to ${SUPPORT}.`
  );
}

function orderFooterText(): string {
  return (
    `\n\nYou are receiving this because you placed an order with PlaSpool.\n` +
    `Questions? Reply to this message or write to ${SUPPORT}.`
  );
}

/** The button every order message carries, and the note about what it needs. */
function viewOrder(): string {
  return (
    button('View your order', '{{order_url}}') +
    small(
      'The link expires, and the order number on its own will not open it. ' +
      'If it has expired, reply here and we will send a fresh one.',
    )
  );
}

function viewOrderText(): string {
  return (
    `\nView your order: {{order_url}}\n` +
    `(The link expires; the order number alone will not open it.)\n`
  );
}

/** Order lines and totals, then the timeline. Every order message has both. */
function orderSummary(): string {
  return `{{order_lines}}` + divider() + `{{order_timeline}}`;
}

function orderSummaryText(): string {
  return `{{order_lines}}\n\nTotal: {{order_total}}\n\n{{order_timeline}}\n`;
}

/** The variables every order message has. Per-kind extras are appended. */
const ORDER_VARS = [
  '{{customer_name}}',
  '{{order_number}}',
  '{{order_total}}',
  '{{order_date}}',
  '{{order_url}}',
  '{{order_lines}}',
  '{{order_timeline}}',
  '{{support_email}}',
] as const;

/* ---------------------------------------------------------------- templates */

const ORDER_PLACED: SystemTemplate = {
  key: 'order.placed',
  name: 'Order placed',
  description: 'Sent the moment an order is created, before payment settles.',
  variables: ORDER_VARS,
  subject: 'We have your order {{order_number}}',
  html: shell({
    title: 'We have your order {{order_number}}',
    preheader: 'Your order is in. We are confirming the payment now.',
    body:
      badge('Order received', 'neutral') +
      h1('Thanks, {{customer_name}}') +
      p(
        'Your order <strong>{{order_number}}</strong> is in. We are confirming the ' +
        'payment with our provider now — that usually takes under a minute, and we ' +
        'will email you the moment it clears.',
      ) +
      orderSummary() +
      viewOrder(),
    footer: orderFooter(),
  }),
  text:
    `Thanks, {{customer_name}}.\n\n` +
    `Your order {{order_number}} is in. We are confirming the payment with our\n` +
    `provider now — that usually takes under a minute, and we will email you the\n` +
    `moment it clears.\n\n` +
    orderSummaryText() +
    viewOrderText() +
    orderFooterText(),
};

const ORDER_CONFIRMATION: SystemTemplate = {
  key: 'order.confirmation',
  name: 'Order confirmed',
  description: 'Sent when payment is captured and the order is confirmed.',
  variables: ORDER_VARS,
  subject: 'Order {{order_number}} confirmed',
  html: shell({
    title: 'Order {{order_number}} confirmed',
    preheader: 'Payment received. We are getting your order ready to ship.',
    body:
      badge('Payment received') +
      h1('Your order is confirmed') +
      p(
        'Thank you, {{customer_name}} — we have your payment for order ' +
        '<strong>{{order_number}}</strong>, placed {{order_date}}. We are getting it ' +
        'ready to ship and will email you tracking as soon as it leaves us.',
      ) +
      orderSummary() +
      viewOrder(),
    footer: orderFooter(),
  }),
  text:
    `Your order is confirmed.\n\n` +
    `Thank you, {{customer_name}} — we have your payment for order {{order_number}},\n` +
    `placed {{order_date}}. We are getting it ready to ship and will email you\n` +
    `tracking as soon as it leaves us.\n\n` +
    orderSummaryText() +
    viewOrderText() +
    orderFooterText(),
};

const ORDER_SHIPMENT: SystemTemplate = {
  key: 'order.shipment',
  name: 'Order shipped',
  description: 'Sent per parcel when a fulfilment ships. A three-parcel order sends three.',
  variables: [...ORDER_VARS, '{{carrier}}', '{{tracking_number}}', '{{tracking_url}}'],
  subject: 'Order {{order_number}} has shipped',
  html: shell({
    title: 'Order {{order_number}} has shipped',
    preheader: 'Your parcel is on its way.',
    body:
      badge('On its way') +
      h1('Your parcel is on its way') +
      p(
        'Order <strong>{{order_number}}</strong> has left us. Here is what is in this ' +
        'parcel — if your order is coming in more than one, each gets its own email.',
      ) +
      /*
       * THE TRACKING PANEL IS ITS OWN BLOCK, not two `{{carrier}}` and
       * `{{tracking_number}}` scalars in a paragraph, because a fulfilment
       * routinely has NEITHER — `shop_fulfillments.tracking_number` is nullable
       * and hand-delivered orders never get one. A paragraph reading "Tracking:
       * (carrier)" with two blanks in it is what a scalar-only version produces,
       * and it looks like the email broke rather than like there is no tracking.
       * The server omits the whole panel instead.
       */
      `{{tracking_panel}}` +
      orderSummary() +
      viewOrder(),
    footer: orderFooter(),
  }),
  text:
    `Your parcel is on its way.\n\n` +
    `Order {{order_number}} has left us. Here is what is in this parcel — if your\n` +
    `order is coming in more than one, each gets its own email.\n\n` +
    `{{tracking_panel}}\n` +
    orderSummaryText() +
    viewOrderText() +
    orderFooterText(),
};

const ORDER_DELIVERED: SystemTemplate = {
  key: 'order.delivered',
  name: 'Order delivered',
  description: 'Sent when a parcel is marked delivered. The end of the happy path.',
  variables: ORDER_VARS,
  subject: 'Order {{order_number}} was delivered',
  html: shell({
    title: 'Order {{order_number}} was delivered',
    preheader: 'Your order has arrived. Tell us how it went.',
    body:
      badge('Delivered') +
      h1('Your order has arrived') +
      p(
        'Order <strong>{{order_number}}</strong> is marked delivered. We hope it is ' +
        'everything you wanted.',
      ) +
      orderSummary() +
      p(
        'If anything is missing, damaged, or not what you ordered, reply to this ' +
        'message within seven days and we will put it right.',
      ) +
      viewOrder(),
    footer: orderFooter(),
  }),
  text:
    `Your order has arrived.\n\n` +
    `Order {{order_number}} is marked delivered. We hope it is everything you\n` +
    `wanted.\n\n` +
    orderSummaryText() +
    `If anything is missing, damaged, or not what you ordered, reply to this\n` +
    `message within seven days and we will put it right.\n` +
    viewOrderText() +
    orderFooterText(),
};

const ORDER_CANCELLATION: SystemTemplate = {
  key: 'order.cancellation',
  name: 'Order cancelled',
  description: 'Sent when an order is cancelled and will not ship. A terminal state.',
  variables: [...ORDER_VARS, '{{cancel_reason}}'],
  subject: 'Order {{order_number}} cancelled',
  html: shell({
    title: 'Order {{order_number}} cancelled',
    preheader: 'This order has been cancelled and will not ship.',
    body:
      badge('Cancelled', 'danger') +
      h1('Your order has been cancelled') +
      p(
        'Order <strong>{{order_number}}</strong> has been cancelled and will not ship.',
      ) +
      facts([{ label: 'Reason', value: '{{cancel_reason}}' }], 'danger') +
      p(
        'Nothing further is owed. If a payment was taken, it is refunded separately ' +
        'and you will get its own email when it is done.',
      ) +
      orderSummary() +
      viewOrder(),
    footer: orderFooter(),
  }),
  text:
    `Your order has been cancelled.\n\n` +
    `Order {{order_number}} has been cancelled and will not ship.\n\n` +
    `Reason: {{cancel_reason}}\n\n` +
    `Nothing further is owed. If a payment was taken, it is refunded separately and\n` +
    `you will get its own email when it is done.\n\n` +
    orderSummaryText() +
    viewOrderText() +
    orderFooterText(),
};

const ORDER_REFUND: SystemTemplate = {
  key: 'order.refund',
  name: 'Order refunded',
  description: 'Sent on each refund, whether partial or full. A terminal state.',
  variables: [
    ...ORDER_VARS,
    '{{refund_amount}}',
    '{{refunded_total}}',
    '{{outstanding_note}}',
  ],
  subject: 'Refund for order {{order_number}}',
  html: shell({
    title: 'Refund for order {{order_number}}',
    preheader: 'We have refunded {{refund_amount}} against your order.',
    body:
      badge('Refunded', 'warn') +
      h1('Your refund is on its way') +
      p(
        'We have refunded <strong>{{refund_amount}}</strong> against order ' +
        '<strong>{{order_number}}</strong>.',
      ) +
      facts(
        [
          { label: 'This refund', value: '{{refund_amount}}', mono: true },
          { label: 'Refunded so far', value: '{{refunded_total}}', mono: true },
          { label: 'Order total', value: '{{order_total}}', mono: true },
        ],
        'warn',
      ) +
      p('{{outstanding_note}}') +
      small(
        'Refunds are returned to the card or account you paid with. Most banks ' +
        'post them within five to ten working days — the delay is at their end, ' +
        'not ours.',
      ) +
      orderSummary() +
      viewOrder(),
    footer: orderFooter(),
  }),
  text:
    `Your refund is on its way.\n\n` +
    `We have refunded {{refund_amount}} against order {{order_number}}.\n\n` +
    `  This refund:     {{refund_amount}}\n` +
    `  Refunded so far: {{refunded_total}}\n` +
    `  Order total:     {{order_total}}\n\n` +
    `{{outstanding_note}}\n\n` +
    `Refunds are returned to the card or account you paid with. Most banks post\n` +
    `them within five to ten working days — the delay is at their end, not ours.\n\n` +
    orderSummaryText() +
    viewOrderText() +
    orderFooterText(),
};

/**
 * The one message in this file that reports a FAILURE OF OURS to the person it
 * happened to, which is why the wording below was settled with the owner rather
 * than written to match its neighbours.
 *
 * WHEN IT SENDS: a refund the provider ACCEPTED — a synchronous `succeeded`, or
 * Paystack's ordinary `pending` — later failed to settle. Usually that is a
 * cancelled order (`b9051ab` refunds a paid order before cancelling it), so the
 * reader has already had "Order cancelled", which carries no refund figure but
 * plainly implies money is coming back. This is the message that corrects it.
 * It can also reach somebody whose order was never cancelled at all — the
 * standalone refund box against a `paid`/`fulfilled` order — so nothing here
 * assumes the reader was expecting a refund, or knows one was attempted.
 *
 * FOUR DECISIONS IN THE COPY, each of which could have gone the other way:
 *
 *  - **The amount is named.** `{{refund_amount}}` is the failed refund alone,
 *    from the event's own `failedAmount`, so a reader can match it against
 *    their statement and see that nothing arrived. The alternative — no figure,
 *    so a later hand-made refund of a different amount cannot contradict this
 *    email — was considered and rejected: a message about money that names no
 *    money reads as a form letter.
 *  - **"The money is still with us, and it is still yours."** The single most
 *    important sentence here. A failed refund is the one payment failure where
 *    the customer's real fear — that the money has vanished between two
 *    companies — is wrong, and saying so costs one line.
 *  - **"You do not need to do anything."** The recovery IS human (see
 *    `recordRefundFailure`), so this promises a person, not a retry. Asking the
 *    reader to supply another payment route instead would resolve the common
 *    cause faster and put the work on somebody who did nothing wrong; the reply
 *    is offered, never required.
 *  - **`warn` and not `danger`.** `ORDER_CANCELLATION` is `danger` because the
 *    order is over. Nothing here is over — it is late. A red badge on a message
 *    whose whole job is to be reassuring undoes the sentence above it.
 *
 * NO `{{refunded_total}}` AND NO `{{outstanding_note}}`, unlike `ORDER_REFUND`.
 * Both describe money that HAS moved, and the entire subject of this message is
 * money that has not; a cumulative total beside a failure invites the reader to
 * work out a difference that means nothing.
 */
const ORDER_REFUND_FAILED: SystemTemplate = {
  key: 'order.refund_failed',
  name: 'Refund did not go through',
  description:
    'Sent when a refund the provider accepted later fails to settle. Someone must then refund by hand.',
  variables: [...ORDER_VARS, '{{refund_amount}}'],
  subject: 'We could not complete your refund for order {{order_number}}',
  html: shell({
    title: 'We could not complete your refund for order {{order_number}}',
    preheader: 'The refund did not complete. Nothing is owed by you — we are arranging it.',
    body:
      badge('Refund delayed', 'warn') +
      h1('Your refund has not gone through yet') +
      p(
        'We tried to return <strong>{{refund_amount}}</strong> to you for order ' +
        '<strong>{{order_number}}</strong>, and our payment provider could not ' +
        'complete it. The money is still with us, and it is still yours.',
      ) +
      facts(
        [
          { label: 'This refund', value: '{{refund_amount}}', mono: true },
          { label: 'Order total', value: '{{order_total}}', mono: true },
        ],
        'warn',
      ) +
      p(
        'You do not need to do anything. Someone here is arranging it by hand and ' +
        'will email you as soon as it is on its way. If you would rather talk to us ' +
        'first, reply to this message and it comes straight to us.',
      ) +
      small(
        'Refunds sometimes fail because a card has expired or an account has changed ' +
        'since the payment. If either has happened, tell us in a reply and we will ' +
        'use another route.',
      ) +
      orderSummary() +
      viewOrder(),
    footer: orderFooter(),
  }),
  text:
    `Your refund has not gone through yet.\n\n` +
    `We tried to return {{refund_amount}} to you for order {{order_number}}, and our\n` +
    `payment provider could not complete it. The money is still with us, and it is\n` +
    `still yours.\n\n` +
    `  This refund:  {{refund_amount}}\n` +
    `  Order total:  {{order_total}}\n\n` +
    `You do not need to do anything. Someone here is arranging it by hand and will\n` +
    `email you as soon as it is on its way. If you would rather talk to us first,\n` +
    `reply to this message and it comes straight to us.\n\n` +
    `Refunds sometimes fail because a card has expired or an account has changed\n` +
    `since the payment. If either has happened, tell us in a reply and we will use\n` +
    `another route.\n\n` +
    orderSummaryText() +
    viewOrderText() +
    orderFooterText(),
};

/* ------------------------------------------------------------------ account */

const ACCOUNT_WELCOME: SystemTemplate = {
  key: 'account.welcome',
  name: 'Welcome',
  description: 'Sent once when somebody joins the mailing list.',
  variables: ['{{name}}', '{{shop_url}}', '{{unsubscribe_url}}', '{{support_email}}'],
  subject: 'Welcome to PlaSpool',
  html: shell({
    title: 'Welcome to PlaSpool',
    preheader: 'Thanks for joining. Here is what to expect from us.',
    body:
      badge('Welcome') +
      h1('Good to have you, {{name}}') +
      p(
        'Thanks for joining the PlaSpool list. We send new filament drops, restocks ' +
        'and the occasional print worth stealing — a few times a month, never daily.',
      ) +
      button('Browse the shop', '{{shop_url}}') +
      divider() +
      small(
        'You are on this list because you asked to be. ' +
        `${link('Unsubscribe', '{{unsubscribe_url}}')} at any time — it takes one click ` +
        'and we will not ask why.',
      ),
    /*
     * THE UNSUBSCRIBE LINK IS IN THE BODY AND ALSO HERE. This is the one system
     * template that is genuinely marketing, so `hasUnsubscribeVariable` must find
     * it — and `server/routes/email.ts` checks BOTH parts, so the text body below
     * carries it too. An owner who edits this template and removes the link gets
     * the composer's existing "cannot be sent" warning, which is exactly right.
     */
    footer: `PlaSpool &middot; ${link('Unsubscribe', '{{unsubscribe_url}}')} &middot; ${SUPPORT}`,
  }),
  text:
    `Good to have you, {{name}}.\n\n` +
    `Thanks for joining the PlaSpool list. We send new filament drops, restocks and\n` +
    `the occasional print worth stealing — a few times a month, never daily.\n\n` +
    `Browse the shop: {{shop_url}}\n\n` +
    `You are on this list because you asked to be.\n` +
    `Unsubscribe: {{unsubscribe_url}}\n` +
    `Questions: {{support_email}}\n`,
};

const ACCOUNT_INVITE: SystemTemplate = {
  key: 'account.invite',
  name: 'Invitation',
  description: 'Sent when somebody is invited to the admin.',
  variables: ['{{inviter_name}}', '{{invite_url}}', '{{expiry_days}}', '{{support_email}}'],
  subject: 'You have been invited to the PlaSpool admin',
  html: shell({
    title: 'You have been invited',
    preheader: '{{inviter_name}} invited you to the PlaSpool admin.',
    body:
      badge('Invitation') +
      h1('You have been invited') +
      p('<strong>{{inviter_name}}</strong> invited you to the PlaSpool admin.') +
      button('Open the admin', '{{invite_url}}') +
      small(
        'Sign in with Google, using this same email address. Your account is ' +
        'set up as you go, so there is no password to choose. The invitation ' +
        'is good for one account and runs out in {{expiry_days}} days. If you ' +
        'were not expecting this, you can ignore this message.',
      ),
    footer: `Sent by PlaSpool. Not expecting this? Ignore it, or write to ${SUPPORT}.`,
  }),
  text:
    `{{inviter_name}} invited you to the PlaSpool admin.\n\n` +
    `{{invite_url}}\n\n` +
    `Sign in with Google, using this same email address. Your account is set up as\n` +
    `you go, so there is no password to choose. The invitation is good for one\n` +
    `account and runs out in {{expiry_days}} days. If you were not expecting this,\n` +
    `you can ignore this message.\n`,
};

/* ------------------------------------------------------------------- returns */

/**
 * The footer under a returns message. TRANSACTIONAL, so no unsubscribe link —
 * same rule as `orderFooter()`.
 *
 * NO `{{support_email}}`, AND THAT IS DELIBERATE, unlike every other footer in
 * this file. The value a caller would fill it with here is
 * `server/marketing/returns/events.ts`'s own render function, which spec D9
 * bars from importing `server/shop/**` — so it cannot reach
 * `storefront-url.ts` — and which must not fall back to the literal address
 * `server/email/system-templates.ts` and `server/shop/orders/mailer.ts` both
 * use, because that address's domain contains this seed's forbidden noun
 * (`no-hardcoded-labels.test.ts`'s needle matches `plaspool.com` the same as it
 * matches the programme's own name). "Reply to this message" costs nothing and
 * needs no address spelled out: replies route off the message's own headers.
 */
function returnFooter(): string {
  return (
    'You are receiving this because of a return you made with PlaSpool. ' +
    'Reply to this message with any questions.'
  );
}

function returnFooterText(): string {
  return (
    '\n\nYou are receiving this because of a return you made with PlaSpool. ' +
    'Reply to this message with any questions.\n'
  );
}

/**
 * The award letter.
 *
 * EVERY PLACEHOLDER HERE IS THE PROGRAMME'S OWN WORD OR NUMBER, never this
 * file's — `server/marketing/returns/events.ts` fills them from `ProgramLabels`
 * and `shared/marketing/copy.ts`'s renderers at the instant an inspection
 * writes, exactly as `server/shop/orders/mailer.ts`'s `baseValues` fills the
 * order placeholders. `{{award_sentence}}` IS THE ONE STRING SPEC D11 PINS
 * ACROSS FIVE SURFACES (the inspection form, its confirm dialog, the success
 * toast, the timeline and this mail) — it travels here whole, as a single
 * placeholder, so an operator can move it around the letter but never
 * reassemble its arithmetic from smaller pieces.
 */
const RETURN_AWARDED_VARS = [
  '{{points_awarded}}',
  '{{award_sentence}}',
  '{{program_name}}',
  '{{qty_accepted_units}}',
  '{{shortfall_note}}',
] as const;

const RETURN_AWARDED: SystemTemplate = {
  key: 'return.awarded',
  name: 'Return: points awarded',
  description: 'Sent when a return is inspected and at least one unit is accepted.',
  variables: RETURN_AWARDED_VARS,
  subject: 'You earned {{points_awarded}}',
  html: shell({
    title: 'You earned {{points_awarded}}',
    preheader: '{{qty_accepted_units}} accepted — you earned {{points_awarded}}.',
    body:
      badge('Return inspected') +
      h1('You earned {{points_awarded}}') +
      p('{{award_sentence}}') +
      p(
        'We have finished checking your {{program_name}} return: ' +
          '{{qty_accepted_units}} accepted.{{shortfall_note}}',
      ),
    footer: returnFooter(),
  }),
  text:
    `{{award_sentence}}\n\n` +
    `We have finished checking your {{program_name}} return: ` +
    `{{qty_accepted_units}} accepted.{{shortfall_note}}` +
    returnFooterText(),
};

/**
 * The rejection letter — an inspection that accepted nothing.
 *
 * NO ARITHMETIC PLACEHOLDER, matching `renderReturnRejected`'s own rule: there
 * is no honest number to lead with when nothing was accepted.
 * `{{reason_note}}` is a BLOCK, not a scalar — it is either empty or a whole
 * extra paragraph, the same shape `{{tracking_panel}}` uses in
 * `ORDER_SHIPMENT` for a value that is sometimes entirely absent.
 */
const RETURN_REJECTED_VARS = [
  '{{program_name}}',
  '{{points_word}}',
  '{{reason_note}}',
] as const;

const RETURN_REJECTED: SystemTemplate = {
  key: 'return.rejected',
  name: 'Return: not accepted',
  description: 'Sent when a return is inspected and nothing is accepted.',
  variables: RETURN_REJECTED_VARS,
  subject: 'About your {{program_name}} return',
  html: shell({
    title: 'About your {{program_name}} return',
    preheader: 'We have finished checking your {{program_name}} return.',
    body:
      badge('Return inspected', 'neutral') +
      h1('About your {{program_name}} return') +
      p(
        'We have finished checking your {{program_name}} return, and it did not ' +
          'earn {{points_word}} this time.',
      ) +
      `{{reason_note}}` +
      small('If you think that is wrong, reply to this message and we will look again.'),
    footer: returnFooter(),
  }),
  text:
    `We have finished checking your {{program_name}} return, and it did not earn ` +
    `{{points_word}} this time.\n\n` +
    `{{reason_note}}` +
    `If you think that is wrong, reply to this message and we will look again.` +
    returnFooterText(),
};

/* --------------------------------------------------------------- reviews */

/**
 * THE INVITATION, sent once an order is delivered.
 *
 * IT NAMES THE PRODUCTS AND LINKS TO THE ORDER, not to each product page.
 * That is a deliberate narrowing of what the storefront brief first described,
 * and the reason is that this repository does not know the storefront's product
 * URL shape — `catalog/utils/revalidate-url.ts` knows its purge endpoint and
 * nothing else. Inventing `/products/<slug>` here would put an unagreed
 * external contract in a customer's inbox, where a wrong guess is a 404 for a
 * real buyer. The order page is a link this system already mints, already
 * expires safely, and already knows is correct.
 *
 * `{{order_lines}}` CARRIES THE TITLES, so the message still says what it is
 * about. Per-product deep links are a follow-up for the day the storefront
 * confirms its path — one constant, and this comment is where to start.
 *
 * IT IS THE ONE MESSAGE HERE THAT IS NOT STRICTLY TRANSACTIONAL. A shipment
 * notice is about a contract the reader entered by paying; an invitation to
 * write something is closer to marketing, and a shop that sends it twice is a
 * shop people filter. One per ORDER — never one per parcel — is enforced by the
 * dedupe key, not by this wording.
 */
const REVIEW_INVITE: SystemTemplate = {
  key: 'review.invite',
  name: 'Review invitation',
  description: 'Sent after an order is delivered, inviting a review of what was in it.',
  variables: ORDER_VARS,
  subject: 'How did your order go?',
  html: shell({
    title: 'How did your order go?',
    preheader: 'Tell other shoppers what you thought.',
    body:
      badge('Delivered') +
      h1('How did it go?') +
      p(
        'Your order <strong>{{order_number}}</strong> has arrived. If you have a ' +
          'moment, tell other shoppers what you thought — reviews on PlaSpool come ' +
          'only from people who actually bought the product, so yours carries weight.',
      ) +
      `{{order_lines}}` +
      viewOrder() +
      small(
        'Nothing to say yet? Ignore this — it is the only reminder we will send ' +
          'about this order.',
      ),
    footer: orderFooter(),
  }),
  text:
    `Your order {{order_number}} has arrived.

` +
    `If you have a moment, tell other shoppers what you thought — reviews on
` +
    `PlaSpool come only from people who actually bought the product, so yours
` +
    `carries weight.

` +
    `{{order_lines}}
` +
    viewOrderText() +
    `
Nothing to say yet? Ignore this — it is the only reminder we will send
` +
    `about this order.` +
    orderFooterText(),
};

/**
 * THE CONFIRMATION, sent when a human approves a pending review.
 *
 * WHY IT RIDES THE ORDER OUTBOX. `shop_order_email_intents.order_id` is NOT
 * NULL, and this message is not obviously an order message — but every review
 * that can trigger it has a proving order on it by construction (the gate
 * records one), and that order IS what the message is downstream of. The
 * alternative was a second outbox with its own sweeper, its own retry ceiling
 * and its own failure modes, to send one email. That is the wrong trade.
 *
 * THE CONSEQUENCE, NAMED: a review with no `order_id` — every row written
 * before the gate shipped — sends NOTHING when approved. Those are legacy rows
 * whose authors never expected a message, so silence is the right outcome, but
 * it is a real hole and not an oversight.
 */
const REVIEW_APPROVED: SystemTemplate = {
  key: 'review.approved',
  name: 'Review published',
  description: 'Sent to the reviewer when staff approve their review.',
  variables: ['{{customer_name}}', '{{order_url}}', '{{support_email}}'],
  subject: 'Your review is live',
  html: shell({
    title: 'Your review is live',
    preheader: 'Thank you — other shoppers can read it now.',
    body:
      badge('Published') +
      h1('Your review is live') +
      p(
        'Thank you for writing it. Other shoppers can read it now, and it shows the ' +
          'verified-buyer mark because you bought the product.',
      ) +
      viewOrder() +
      small(
        'Changed your mind about what you wrote? Reply to this message and we will ' +
          'take it down.',
      ),
    footer: orderFooter(),
  }),
  text:
    `Your review is live.

` +
    `Thank you for writing it. Other shoppers can read it now, and it shows the
` +
    `verified-buyer mark because you bought the product.
` +
    viewOrderText() +
    `
Changed your mind about what you wrote? Reply to this message and we will
` +
    `take it down.` +
    orderFooterText(),
};

/* ------------------------------------------------------------------ catalog */

/**
 * THE EXPORT LINK, sent when an admin asks for the product catalogue as CSV
 * (`POST /api/shop/admin/products/export`, migration 0720).
 *
 * TO AN ADMIN, NOT A CUSTOMER — the one message in this file whose reader is
 * staff. It rides the same shell anyway, so the templates screen previews and
 * edits it like any other, and the structure mirrors ACCOUNT_INVITE: one
 * badge, one sentence, one button, one small print.
 *
 * THE LINK IS THE CREDENTIAL. The download route asks for no session — the
 * mail lands in inboxes and gets opened from phones — so the URL's token is
 * its whole authority, and the small print says so rather than letting the
 * reader treat it as an ordinary page. {{expiry_days}} is enforced at read
 * time against the row's created_at; nothing sweeps the table.
 */
const CATALOG_EXPORT: SystemTemplate = {
  key: 'catalog.export',
  name: 'Product export ready',
  description: 'Sent to the admin who asked for a CSV export of the product catalogue.',
  variables: ['{{download_url}}', '{{row_count}}', '{{expiry_days}}', '{{support_email}}'],
  subject: 'Your product export is ready',
  html: shell({
    title: 'Your product export is ready',
    preheader: 'The product CSV you asked for is ready to download.',
    body:
      badge('Export ready') +
      h1('Your product export is ready') +
      p(
        'The product catalogue you asked for has been prepared — ' +
        '<strong>{{row_count}}</strong> rows, one per variant, as CSV.',
      ) +
      button('Download the CSV', '{{download_url}}') +
      small(
        'The link works for {{expiry_days}} days and needs no sign-in — anyone ' +
        'holding it can download the file, so treat it like the spreadsheet ' +
        'itself. Not expecting this? Ignore it, or write to ' + SUPPORT + '.',
      ),
    footer: `Sent by PlaSpool. Did not ask for this? Write to ${SUPPORT}.`,
  }),
  text:
    `Your product export is ready — {{row_count}} rows, one per variant, as CSV.\n\n` +
    `{{download_url}}\n\n` +
    `The link works for {{expiry_days}} days and needs no sign-in — anyone holding\n` +
    `it can download the file, so treat it like the spreadsheet itself.\n`,
};

/**
 * Every default, by key.
 *
 * A `Record` KEYED BY `SystemKey` rather than an array, so adding a key to
 * `SYSTEM_KEYS` without writing its template is a COMPILE ERROR rather than a
 * template that silently never seeds.
 */
export const DEFAULT_TEMPLATES: Record<SystemKey, SystemTemplate> = {
  'order.placed': ORDER_PLACED,
  'order.confirmation': ORDER_CONFIRMATION,
  'order.shipment': ORDER_SHIPMENT,
  'order.delivered': ORDER_DELIVERED,
  'order.cancellation': ORDER_CANCELLATION,
  'order.refund': ORDER_REFUND,
  'order.refund_failed': ORDER_REFUND_FAILED,
  'account.welcome': ACCOUNT_WELCOME,
  'account.invite': ACCOUNT_INVITE,
  'return.awarded': RETURN_AWARDED,
  'return.rejected': RETURN_REJECTED,
  'review.invite': REVIEW_INVITE,
  'review.approved': REVIEW_APPROVED,
  'catalog.export': CATALOG_EXPORT,
};

export function defaultTemplate(key: SystemKey): SystemTemplate {
  return DEFAULT_TEMPLATES[key];
}
