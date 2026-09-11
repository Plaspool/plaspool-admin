-- MANUAL ORDERS: sales made outside the online checkout — a Flutterwave
-- payment link, a bank transfer, cash — recorded by the owner in the admin,
-- already completed, editable, and counted in analytics like any other order.
--
-- THEY LIVE IN shop_orders, NOT A SIDE TABLE. Every analytics figure, the
-- order list, the board and the customer's history already read shop_orders;
-- a second table would have to be taught to each of them and would drift. The
-- source column is what tells the two kinds apart, and online is the default,
-- so every existing row and every checkout insert is unchanged.
--
-- NUMBERED 1110 AND DATED BETWEEN 1100 AND THE CURRENCY BRANCH'S 1120, so the
-- journal stays in order whichever lands first on each database. A database
-- whose ledger is already past this date (dev, which has 1120-1160) skips it
-- silently and must have it applied by hand — see CLAUDE.md section 4.
ALTER TABLE shop_orders
  ADD COLUMN source text NOT NULL DEFAULT 'online',
  -- How the money arrived, and the reference that proves it. Manual orders only.
  ADD COLUMN payment_method text,
  ADD COLUMN payment_reference text,
  -- Where the sale came from (walk-in, WhatsApp...). Optional, for analytics.
  ADD COLUMN sales_channel text,
  -- The owner's own note. NEVER shown to a customer.
  ADD COLUMN staff_note text,
  -- Whether creating the order took its items out of stock, so an edit or a
  -- void knows whether to move stock back.
  ADD COLUMN stock_taken boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT shop_orders_source_ck CHECK (source IN ('online', 'manual')),
  ADD CONSTRAINT shop_orders_payment_method_ck CHECK (
    payment_method IS NULL
    OR payment_method IN ('flutterwave_link', 'paystack_link', 'bank_transfer', 'cash', 'pos', 'other')),
  ADD CONSTRAINT shop_orders_sales_channel_ck CHECK (
    sales_channel IS NULL
    OR sales_channel IN ('walk_in', 'whatsapp', 'instagram', 'phone', 'website', 'other')),
  ADD CONSTRAINT shop_orders_payment_reference_ck CHECK (
    payment_reference IS NULL OR length(payment_reference) BETWEEN 1 AND 200),
  ADD CONSTRAINT shop_orders_staff_note_ck CHECK (
    staff_note IS NULL OR length(staff_note) BETWEEN 1 AND 2000),
  -- A manual sale is recorded with how it was paid, always.
  ADD CONSTRAINT shop_orders_manual_payment_ck CHECK (source = 'online' OR payment_method IS NOT NULL);
--> statement-breakpoint
-- A walk-in sale may have no email at all. Online orders still must: the
-- receipt and the guest link are addressed by it.
ALTER TABLE shop_orders
  DROP CONSTRAINT shop_orders_email_ck,
  ADD CONSTRAINT shop_orders_email_ck CHECK (length(email) > 0 OR source = 'manual');
--> statement-breakpoint
CREATE INDEX shop_orders_source_idx ON shop_orders (source, paid_at);
--> statement-breakpoint
-- EVERY SAVE OF A MANUAL ORDER, KEPT WHOLE. The order row holds the current
-- figures; this holds what they were after each save, who saved it and when,
-- so a changed quantity or price is never lost from the history analytics
-- reads. Modelled on shop_product_revisions: a full snapshot, not a diff.
CREATE TABLE shop_order_revisions (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  kind text NOT NULL,
  snapshot jsonb NOT NULL,
  edited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  edited_at bigint NOT NULL,
  CONSTRAINT shop_order_revisions_kind_ck CHECK (kind IN ('created', 'edited', 'voided')),
  CONSTRAINT shop_order_revisions_revision_ck CHECK (revision > 0),
  CONSTRAINT shop_order_revisions_uq UNIQUE (order_id, revision)
);
--> statement-breakpoint
-- An edit is a timeline event too.
ALTER TABLE shop_order_events
  DROP CONSTRAINT shop_order_events_type_ck;
--> statement-breakpoint
ALTER TABLE shop_order_events
  ADD CONSTRAINT shop_order_events_type_ck CHECK (
    type IN ('placed', 'payment_authorized', 'payment_failed', 'paid',
             'fulfillment_created', 'shipped', 'delivered',
             'fulfillment_cancelled', 'cancelled', 'refunded', 'refund_failed',
             'courier_booked', 'courier_update', 'courier_cancelled', 'edited'));
--> statement-breakpoint
-- ORDER LINES STAY APPEND-ONLY — EXCEPT ON A MANUAL ORDER. An online line is
-- the snapshot of what a customer was charged for, and 0160 makes it
-- immutable for that reason. A manual order is the owner's own record of a
-- sale made elsewhere; correcting a quantity or a price is the point of being
-- able to edit it, and shop_order_revisions keeps every earlier version.
CREATE OR REPLACE FUNCTION shop_order_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT o.source FROM shop_orders o WHERE o.id = OLD.order_id) = 'manual' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shop_order_lines is append-only: an order is a financial record'
      USING ERRCODE = 'ORD01';
  END IF;
  IF (NEW.id, NEW.order_id, NEW.line_no, NEW.variant_id, NEW.sku, NEW.title,
      NEW.option_values, NEW.qty, NEW.unit_amount, NEW.line_total)
     IS DISTINCT FROM
     (OLD.id, OLD.order_id, OLD.line_no, OLD.variant_id, OLD.sku, OLD.title,
      OLD.option_values, OLD.qty, OLD.unit_amount, OLD.line_total) THEN
    RAISE EXCEPTION 'an order line snapshot is immutable; only fulfilled_qty may change'
      USING ERRCODE = 'ORD01';
  END IF;
  RETURN NEW;
END;
$$;
