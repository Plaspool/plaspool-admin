-- WHAT A RETURNED UNIT ACTUALLY COSTS US (range 0920-0939; owner's
-- instruction, 2026-09-04).
--
-- WHAT THE OWNER ASKED FOR, in their own arithmetic: if someone returns fifty
-- units, that is fifty times a hundred naira, so we got them at a hundred
-- each -- then also count what it cost to get them to the workshop, the long
-- leg in, the local run, the driver, the loading. Add all of it and say on
-- the dashboard that on average we are really getting one for three hundred
-- and something.
--
-- So the number the analytics screen exists to print is
--
--     (reward money + collection money) / units KEPT
--
-- and this migration adds the three things the database was missing for it:
-- what a unit is worth in MONEY, what one pickup COST, and what a pickup in a
-- given district normally costs when nobody wrote it down.
--
-- ===========================================================================
-- 1. THE REWARD SIDE IS MONEY, AND POINTS ARE NOT MONEY.
--
-- A return is paid in POINTS (points_per_unit_snapshot), and what a point is
-- worth is marketing_settings.redemption_rate_points/_minor -- which ships as
-- a placeholder (100 points -> 0 minor) with redemption disabled. Costing the
-- programme through that rate would print zero for every figure on the screen
-- until somebody set it, and would then re-price all of history the day they
-- did.
--
-- So the costing rate is its OWN column in minor units, beside the points
-- rate rather than derived from it: marketing_programs.unit_cost_minor is
-- what one accepted unit costs us, the naira number the owner already says
-- out loud. NULL means nobody has said, which the screen reports as missing
-- rather than as zero.
--
-- IT IS SNAPSHOTTED ONTO THE REQUEST, exactly as points_per_unit_snapshot
-- already is and for the same reason (spec D4): repricing to 120 next year
-- must not silently rewrite what last year's units cost. The snapshot is
-- NULLABLE and the reader falls back to the programme's current rate, which
-- is what makes this migration need no backfill -- every return that already
-- exists prices at whatever the owner types first, the only honest answer
-- available for rows created before the field existed.
--
-- 2. THE COLLECTION SIDE IS FOUR NAMED LINES, NOT ONE FIGURE.
--
-- The owner asked to see WHICH part is eating the money -- the long haul in,
-- the local run, the driver, the loading -- so four nullable columns rather
-- than one total. All four are optional and independent: a pickup with only a
-- transport figure is a real, common record, not a half-filled form.
--
-- NULL AND ZERO ARE DIFFERENT AND BOTH ARE REAL. Zero is "our own van was
-- already going, this leg cost nothing", typed by a person. NULL is "nobody
-- wrote it down", and the reader substitutes the district's standard for it
-- (below). A column that could not tell those apart would make an estimate
-- indistinguishable from a receipt, and the screen's honesty line -- 18 of 96
-- pickups have no cost recorded -- would have nothing to count.
--
-- 3. THE DISTRICT STANDARD IS A LIVE SETTING, NEVER COPIED ONTO A ROW.
--
-- marketing_service_areas.std_*_minor is what a pickup in that district
-- normally costs. It is resolved AT READ TIME and deliberately NOT
-- snapshotted onto the return -- the opposite of the decision taken for the
-- reward rate one paragraph up, because they are different kinds of number.
-- The reward is a PROMISE made to a customer and must never move. A transport
-- standard is an ESTIMATE nobody was promised: correcting one from 2,000 to
-- 2,600 should improve every estimate that leans on it rather than leave five
-- hundred stale copies behind. And a copied default would arrive on the row
-- looking exactly like a typed one.
--
-- 4. unit_market_cost_minor -- WHAT BUYING ONE NEW COSTS.
--
-- The benchmark the "against buying new" figure is measured against, on the
-- programme beside the costing rate. LIVE and not snapshotted, like the
-- district standard and for the same reason: it is a comparison against
-- today's market, and the sentence on screen says so.
--
-- EVERYTHING HERE IS ADDITIVE AND NULLABLE, so it is safe to apply ahead of
-- the code that reads it -- which is the order it will arrive in, always. The
-- deployed bundle neither writes nor reads any of these columns and keeps
-- working unchanged in between.
--
-- HAND-WRITTEN, for the reason every migration in this range is: the
-- marketing tables are invisible to drizzle-kit, so push and generate are
-- both out (CLAUDE.md section 3).

ALTER TABLE marketing_programs
  ADD COLUMN unit_cost_minor integer,
  ADD COLUMN unit_market_cost_minor integer;--> statement-breakpoint

ALTER TABLE marketing_programs
  ADD CONSTRAINT marketing_programs_unit_cost_ck
    CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
  ADD CONSTRAINT marketing_programs_unit_market_cost_ck
    CHECK (unit_market_cost_minor IS NULL OR unit_market_cost_minor >= 0);--> statement-breakpoint

ALTER TABLE marketing_service_areas
  ADD COLUMN std_transport_minor integer,
  ADD COLUMN std_local_minor integer,
  ADD COLUMN std_driver_minor integer,
  ADD COLUMN std_fees_minor integer;--> statement-breakpoint

ALTER TABLE marketing_service_areas
  ADD CONSTRAINT marketing_service_areas_std_costs_ck
    CHECK ((std_transport_minor IS NULL OR std_transport_minor >= 0)
       AND (std_local_minor IS NULL OR std_local_minor >= 0)
       AND (std_driver_minor IS NULL OR std_driver_minor >= 0)
       AND (std_fees_minor IS NULL OR std_fees_minor >= 0));--> statement-breakpoint

ALTER TABLE marketing_return_requests
  ADD COLUMN unit_cost_minor_snapshot integer,
  ADD COLUMN cost_transport_minor integer,
  ADD COLUMN cost_local_minor integer,
  ADD COLUMN cost_driver_minor integer,
  ADD COLUMN cost_fees_minor integer,
  ADD COLUMN cost_note text;--> statement-breakpoint

ALTER TABLE marketing_return_requests
  ADD CONSTRAINT marketing_return_requests_unit_cost_ck
    CHECK (unit_cost_minor_snapshot IS NULL OR unit_cost_minor_snapshot >= 0),
  ADD CONSTRAINT marketing_return_requests_costs_ck
    CHECK ((cost_transport_minor IS NULL OR cost_transport_minor >= 0)
       AND (cost_local_minor IS NULL OR cost_local_minor >= 0)
       AND (cost_driver_minor IS NULL OR cost_driver_minor >= 0)
       AND (cost_fees_minor IS NULL OR cost_fees_minor >= 0)),
  ADD CONSTRAINT marketing_return_requests_cost_note_ck
    CHECK (cost_note IS NULL OR cost_note <> '');--> statement-breakpoint

-- The timeline gains one entry type. Recording what a pickup cost is a change
-- to the row, so it belongs in the history beside every other change to it --
-- and a cost corrected three weeks later, when the transport invoice finally
-- arrived, is exactly the kind of edit somebody will later need to explain.
--
-- The CHECK is dropped and re-added rather than widened in place: Postgres has
-- no ALTER CONSTRAINT for a CHECK expression.
ALTER TABLE marketing_return_events
  DROP CONSTRAINT marketing_return_events_type_ck;--> statement-breakpoint

ALTER TABLE marketing_return_events
  ADD CONSTRAINT marketing_return_events_type_ck
    CHECK (type IN ('requested','scheduled','collected','received',
                    'inspected','rejected','cancelled','note','costed'));
