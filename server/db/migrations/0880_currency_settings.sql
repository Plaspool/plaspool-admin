-- THE DOLLAR RATE, AS ONE ROW (range 0880-0899; owner's queue, 2026-09-04).
--
-- Companion to 0860. That migration gives a variant an explicit dollar price;
-- this one gives every variant that has NOT been given one a dollar price
-- anyway, by converting the naira price at a rate the owner controls. The pair
-- is the owner's instruction verbatim: "a default dollar equivalent of the
-- naira, but the user can change the dollar price on every variant".
--
-- A SINGLETON, the shop_delivery_settings idiom from 0760: id = 'main' pinned
-- by a CHECK, a revision for optimistic concurrency, updated_at/updated_by for
-- the audit trail. One row, so there is no "which settings" question to get
-- wrong and no ORDER BY hiding a second one.
--
-- usd_enabled DEFAULTS FALSE, AND THAT IS THE IMPORTANT DEFAULT. Paystack will
-- not accept a USD charge from this account until the owner has requested the
-- currency AND attached a Zenith Bank USD domiciliary account for payouts.
-- Until both are done a USD checkout would reach Paystack and come back
-- "Currency not supported by merchant" — a dead end the shopper cannot fix.
-- So the storefront's currency switcher is gated on this flag, and the shop
-- behaves exactly as it does today until somebody deliberately turns it on.
-- The failure mode of a forgotten flag is "the shop we already ship".
--
-- THE RATE IS NAIRA MINOR UNITS PER ONE DOLLAR. Kobo per dollar, integer. At
-- 1,600 naira to the dollar that is 160000. Storing it this way rather than as
-- a decimal keeps contract §10 (integer minor units, never a float) and makes
-- the conversion exact integer arithmetic:
--
--     usd_minor = ceil(ngn_minor * 100 / ngn_per_usd_minor)
--
-- The 100 is cents-per-dollar. A 26,500 naira price (2650000 kobo) at that
-- rate is 165625 hundredths of a cent -> 1657 cents -> $16.57 before rounding.
--
-- IT IS SEEDED NULL, NOT AT A GUESS. A wrong exchange rate is worse than an
-- absent one: absent is a switch that will not turn on, wrong is every product
-- in the shop mispriced in a currency the owner is not watching. The admin
-- screen refuses to enable USD without a rate, and the CHECK below makes that
-- pairing a property of the table rather than of the screen that edits it.
--
-- ROUNDING IS UP, TO A MULTIPLE OF usd_rounding_minor CENTS. 100 rounds to the
-- whole dollar, 1 disables it, 5 gives nickels. UP rather than nearest, because
-- the alternative sells below the naira price when the rate moves against you,
-- and a rounding rule that can quietly discount is not a rounding rule. The
-- default of 100 is what makes derived prices read as $17 rather than $16.57.
CREATE TABLE IF NOT EXISTS shop_currency_settings (
  id text PRIMARY KEY,
  /* The switch. See the header: false until Paystack has actually approved
   * USD for this business, whatever the rate says. */
  usd_enabled boolean NOT NULL DEFAULT false,
  /* Kobo per one US dollar. NULL means "no rate set", which is the seeded
   * state and which usd_enabled may not be true alongside. */
  ngn_per_usd_minor bigint,
  /* Cents. Derived dollar prices round UP to a multiple of this. */
  usd_rounding_minor integer NOT NULL DEFAULT 100,
  revision integer NOT NULL DEFAULT 1,
  updated_at bigint NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT shop_currency_settings_id_ck CHECK (id = 'main'),
  CONSTRAINT shop_currency_settings_revision_ck CHECK (revision > 0),
  /* A rate of zero would divide by zero in the conversion above; a negative
   * one is not a rate. NULL stays representable — it is "not set yet". */
  CONSTRAINT shop_currency_settings_rate_ck
    CHECK (ngn_per_usd_minor IS NULL OR ngn_per_usd_minor > 0),
  CONSTRAINT shop_currency_settings_rounding_ck
    CHECK (usd_rounding_minor >= 1),
  /* THE PAIRING, AT THE COLUMN AND NOT IN A ROUTE. Dollars cannot be switched
   * on without a rate to convert at, because the first thing that would happen
   * is a division by NULL on the storefront's price list. */
  CONSTRAINT shop_currency_settings_enabled_needs_rate_ck
    CHECK (usd_enabled = false OR ngn_per_usd_minor IS NOT NULL)
);--> statement-breakpoint

-- Seeded OFF and rateless, which reproduces today exactly. updated_at is the
-- migration's own moment; there is no updated_by because no person did this.
INSERT INTO shop_currency_settings (id, usd_enabled, ngn_per_usd_minor, usd_rounding_minor, revision, updated_at)
VALUES ('main', false, NULL, 100, 1, (EXTRACT(EPOCH FROM now()) * 1000)::bigint)
ON CONFLICT (id) DO NOTHING;
