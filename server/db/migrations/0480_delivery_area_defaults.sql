-- DEFAULT DELIVERY OPINIONS (range 0480-0499) — one row per district, on the
-- owner's explicit instruction (2026-08-25): "set default values for
-- everything". DATA ONLY; no schema change.
--
-- Migration 0300's header says a row exists only when an owner has had an
-- opinion. That still holds: this seed IS the owner's opinion, stated once for
-- every district at once — deliver everywhere, at the state's zone rate. What
-- it buys is the admin screen showing an explicit, editable row per district
-- instead of an implicit blank; checkout behaviour does not move, because
-- `delivers = true` with `rate_minor = NULL` is exactly what the absence of a
-- row already meant to `districtRuling`.
--
-- EVERY district, active or not: an opinion about a district that is later
-- activated should already be sitting there, and rows for inactive districts
-- are invisible at checkout (the storefront only offers active keys). A
-- district created AFTER this migration gets no row — the pre-seed default —
-- until somebody edits it, which is the 0300 model unchanged.
--
-- The id is derived from the key with md5 rather than gen_random_uuid():
-- PGlite replays every migration in the test harness and this file must not
-- depend on pgcrypto being present there (`delivery-areas-repo.ts` generates
-- ids in JS for the same reason). Deterministic ids also make the seed
-- idempotent in spirit as well as via ON CONFLICT.
--
-- ON CONFLICT DO NOTHING, NOT DO UPDATE: an opinion the owner has already
-- written by hand outranks a default, always.
INSERT INTO shop_delivery_areas (id, area_key, delivers, rate_minor, revision, created_at, updated_at)
SELECT 'darea_' || substr(md5('seed-0480:' || a.key), 1, 18),
       a.key,
       true,
       NULL,
       1,
       (extract(epoch from now()) * 1000)::bigint,
       (extract(epoch from now()) * 1000)::bigint
  FROM marketing_service_areas a
ON CONFLICT (area_key) DO NOTHING;--> statement-breakpoint
