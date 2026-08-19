/**
 * Where Paystack sends the customer once they have finished paying.
 *
 * IN THE REPOSITORY, NOT THE ENVIRONMENT, and unlike the storefront's bridge
 * secret there is nothing to weigh up: this is a public URL. Paystack puts it in
 * a redirect the customer's browser follows, so it is visible in their address
 * bar and their history the moment it is used. Keeping it here means a fresh
 * clone and every preview behave like production, and there is one place to look
 * when the redirect lands somewhere wrong.
 *
 * IT IS PART OF AN EXTERNAL CONTRACT. Renaming the route it points at is not a
 * local refactor — the value is also configured at Paystack's end via the
 * intent's `callback_url`, and an in-flight payment redirects to whatever was
 * sent when the intent was created. Change this and the storefront route
 * together, and expect payments already in flight to land on the old path.
 *
 * WHY NOT THE STOREFRONT ROOT. Paystack redirects the instant the customer
 * finishes, and it does so for an abandoned or failed payment as well as a
 * successful one. The root would show a marketing page with no acknowledgement
 * that anything happened and no way to tell those cases apart. `/checkout/complete`
 * exists to answer that question — and to hold the customer while the order is
 * created, which can lag the payment by up to a minute because the outbox sweep
 * does the work rather than the webhook itself.
 *
 * `PAYMENTS_CALLBACK_URL` still overrides it, so a preview deployment can point
 * somewhere else without a code change.
 */
export const DEFAULT_PAYMENTS_CALLBACK_URL =
  'https://plaspool-storefront.uririnathaniel.workers.dev/checkout/complete';
