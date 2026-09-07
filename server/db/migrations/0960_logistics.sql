-- DELIVERY COURIERS (range 0960-0979; spec docs/superpowers/specs/2026-09-07-logistics-providers-design.md).
--
-- HAND-WRITTEN IN FULL, as every commerce migration is: drizzle-kit has never
-- seen these tables and can neither generate nor undo this DDL.
--
-- Three pieces, three owners, one file. Logistics owns the singleton settings
-- row (which courier is switched on, the ship-from address, the packaging
-- Terminal quotes against) and the inbound webhook log. Orders keeps owning
-- shop_fulfillments; the courier columns added to it are the booking's
-- write-back (which courier, its reference, its last raw status and our
-- reading of it, the tracking and waybill links, what it cost us) and are
-- NULL for every parcel shipped by hand. The timeline CHECK is widened for
-- the three courier events.
--
-- provider IS the feature flag: manual / fez / terminal is one column with one
-- value, so two couriers cannot be switched on at once by construction.
--
-- courier_state is OUR normalised reading of provider_status (the raw string
-- the courier last sent, kept verbatim so a new status they invent is visible
-- rather than lost). Both are nullable: NULL means no courier was ever booked.

CREATE TABLE shop_logistics_settings (
  id text PRIMARY KEY,
  provider text NOT NULL DEFAULT 'manual',
  -- { name, phone, email?, line1, line2?, city, region, postalCode, countryCode }
  ship_from jsonb,
  -- { name, lengthCm, widthCm, heightCm, weightKg } -- the box Terminal is quoted against
  packaging jsonb NOT NULL DEFAULT '{"name":"Spool box","lengthCm":22,"widthCm":22,"heightCm":8,"weightKg":0.25}'::jsonb,
  -- Terminal's PA-... id, created lazily on the first quote, cleared when packaging changes
  terminal_packaging_id text,
  revision integer NOT NULL DEFAULT 1,
  updated_at bigint NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT shop_logistics_settings_id_ck CHECK (id = 'main'),
  CONSTRAINT shop_logistics_settings_provider_ck CHECK (provider IN ('manual', 'fez', 'terminal')),
  CONSTRAINT shop_logistics_settings_revision_ck CHECK (revision > 0),
  CONSTRAINT shop_logistics_settings_packaging_ck CHECK (jsonb_typeof(packaging) = 'object'),
  CONSTRAINT shop_logistics_settings_ship_from_ck CHECK (ship_from IS NULL OR jsonb_typeof(ship_from) = 'object')
);--> statement-breakpoint
INSERT INTO shop_logistics_settings (id, provider, updated_at) VALUES ('main', 'manual', 1786600005100);--> statement-breakpoint
ALTER TABLE shop_fulfillments
  ADD COLUMN provider text,
  ADD COLUMN provider_ref text,
  ADD COLUMN provider_status text,
  ADD COLUMN courier_state text,
  ADD COLUMN tracking_url text,
  ADD COLUMN label_url text,
  ADD COLUMN provider_cost_minor bigint,
  ADD COLUMN provider_synced_at bigint,
  ADD COLUMN provider_last_error text;--> statement-breakpoint
ALTER TABLE shop_fulfillments
  ADD CONSTRAINT shop_fulfillments_provider_ck CHECK (provider IS NULL OR provider IN ('fez', 'terminal')),
  ADD CONSTRAINT shop_fulfillments_courier_state_ck CHECK (
    courier_state IS NULL OR courier_state IN ('draft', 'booked', 'picked_up', 'in_transit',
                                              'delivered', 'returned', 'cancelled', 'failed', 'unknown')
  ),
  ADD CONSTRAINT shop_fulfillments_provider_ref_ck CHECK (provider IS NOT NULL OR provider_ref IS NULL),
  ADD CONSTRAINT shop_fulfillments_provider_cost_ck CHECK (provider_cost_minor IS NULL OR provider_cost_minor >= 0);--> statement-breakpoint
CREATE UNIQUE INDEX shop_fulfillments_provider_ref_uq
  ON shop_fulfillments (provider, provider_ref) WHERE provider_ref IS NOT NULL;--> statement-breakpoint
CREATE INDEX shop_fulfillments_courier_sync_idx
  ON shop_fulfillments (provider_synced_at NULLS FIRST)
  WHERE provider_ref IS NOT NULL AND status IN ('pending', 'shipped');--> statement-breakpoint
-- DROP-THEN-ADD, as 0360: Postgres cannot widen a CHECK in place. Strictly
-- wider than 0360's list, so no existing row can fail it.
ALTER TABLE shop_order_events
  DROP CONSTRAINT shop_order_events_type_ck;--> statement-breakpoint
ALTER TABLE shop_order_events
  ADD CONSTRAINT shop_order_events_type_ck CHECK (
    type IN ('placed', 'payment_authorized', 'payment_failed', 'paid',
             'fulfillment_created', 'shipped', 'delivered',
             'fulfillment_cancelled', 'cancelled', 'refunded', 'refund_failed',
             'courier_booked', 'courier_update', 'courier_cancelled')
  );--> statement-breakpoint
-- Every inbound courier webhook, verified or not, so the settings screen can
-- show that a courier's calls actually reach this admin.
CREATE TABLE shop_logistics_webhooks (
  id text PRIMARY KEY,
  provider text NOT NULL,
  provider_ref text,
  raw_status text,
  verified boolean NOT NULL,
  applied text NOT NULL,
  payload jsonb NOT NULL,
  received_at bigint NOT NULL,
  CONSTRAINT shop_logistics_webhooks_provider_ck CHECK (provider IN ('fez', 'terminal')),
  CONSTRAINT shop_logistics_webhooks_applied_ck CHECK (applied IN ('applied', 'ignored', 'unmatched', 'rejected'))
);--> statement-breakpoint
CREATE INDEX shop_logistics_webhooks_recent_idx ON shop_logistics_webhooks (received_at DESC, id);
