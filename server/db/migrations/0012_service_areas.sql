-- SERVICE AREAS (plan `docs/superpowers/plans/2026-08-13-returns-board.md` §5):
-- the places a van goes, the column that ties a return to one of them, and the
-- CHECK that makes "an address we do not serve cannot earn points" true even if
-- every route above it were wrong.
--
-- HAND-WRITTEN, for the reason 0011 states at length: `drizzle.config.ts`
-- declares `schema: './server/db/schema.ts'` and nothing else, and every object
-- below belongs to `server/marketing/schema.ts`, which drizzle-kit has never
-- seen. That is the condition `server/db/migrations.test.ts` states for a
-- hand-written migration. `meta/0012_snapshot.json` deliberately does not exist.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE MODEL IS NATIONAL FROM THE FIRST DAY; ONLY THE DATA IS ONE CITY.
--
-- The rewards programme works where there are drivers, because a return comes
-- back only if somebody fetches it. So the shape of this table is "an area is a
-- name in a region with an active flag" and NOTHING in the schema, the API or
-- the screens names the city that is served today — the served set is editable
-- by the owner, so anything that matched on the place would be wrong the first
-- time a district was switched off. Both grep guards
-- (`server/marketing/no-hardcoded-labels.test.ts`,
-- `src/routes/marketing-no-spool.test.ts`) fail on the city's name in source for
-- exactly that reason, and this file is not an exception either: the region is
-- stored under its full legal name, which is what the shipped dataset calls it.
--
-- `active` DEFAULTS TO false AND THE SEED SWITCHES ON TWENTY-EIGHT ROWS. The
-- failure mode of a forgotten flag is then "we do not serve there", which loses
-- a sale, rather than "we promised a van we cannot send", which loses a
-- customer. Expanding is switching a region's areas on from the Areas screen —
-- not a migration, and not a developer.
-- ═══════════════════════════════════════════════════════════════════════════

/*
 * A place a van goes.
 *
 * A REAL TABLE RATHER THAN CONFIG JSON, and the switcher is the argument: it
 * renders a count of what is waiting PER AREA, which is a join, and a json blob
 * cannot be joined against without unnesting it on every read. The other half is
 * that an area is editable — renamed, retired, added — by an owner who must not
 * need a deploy, and a table has a PATCH route while a constant has a pull
 * request.
 *
 * `key` IS THE STABLE HANDLE, `name` IS WHAT PEOPLE READ. The shipped dataset
 * has real errors in it — it spells Badagry "Badagary" and carries at least one
 * entry that is not an LGA of the state it is filed under — and the fix for that
 * is a rename on the Areas screen, not an edit to a migration that has already
 * run. So the name moves and the key does not, and `seeded` keeps meaning "this
 * row was not typed by a person" across any number of renames.
 *
 * `aliases` IS WHAT STOPS A CUSTOMER BEING REFUSED FOR SPELLING THEIR OWN
 * NEIGHBOURHOOD THEIR OWN WAY. `wuse 2`, `wuse ii`, `cbd` — the resolver folds
 * case and punctuation out of both sides, so this column holds only the OTHER
 * spellings and never a second copy of the name.
 *
 * THE ALIAS CHECK COMPARES THE ARRAY'S OWN TEXT FORM, because a CHECK may not
 * contain a subquery and `unnest` in one is a subquery. `aliases::text` renders
 * the array literal, and an element with a capital letter in it is the only way
 * that literal can differ from its own `lower()`. Blunt, total, and it costs one
 * cast on a table that is written to a handful of times a year.
 */
CREATE TABLE marketing_service_areas (
  id text PRIMARY KEY,
  key text NOT NULL,
  region text NOT NULL,
  name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT false,
  seeded boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 1,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CONSTRAINT marketing_service_areas_key_ck
    CHECK (key <> '' AND key = lower(key) AND key ~ '^[a-z0-9][a-z0-9_-]*$'),
  CONSTRAINT marketing_service_areas_region_ck
    CHECK (region <> '' AND region = btrim(region)),
  CONSTRAINT marketing_service_areas_name_ck
    CHECK (name <> '' AND name = btrim(name)),
  CONSTRAINT marketing_service_areas_aliases_ck
    CHECK (aliases::text = lower(aliases::text)
           AND array_position(aliases, '') IS NULL
           AND array_position(aliases, NULL) IS NULL),
  CONSTRAINT marketing_service_areas_sort_order_ck CHECK (sort_order >= 0),
  CONSTRAINT marketing_service_areas_revision_ck CHECK (revision > 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX marketing_service_areas_key_uq
  ON marketing_service_areas (key);--> statement-breakpoint

/*
 * A REGION MAY NOT HOLD TWO AREAS WHOSE NAMES DIFFER ONLY IN CASE, which is the
 * uniqueness a person means by "that one already exists". It is an EXPRESSION
 * index because that is the only place `lower()` can be applied to a stored
 * value without a generated column, and drizzle-kit cannot model either — so it
 * lives here and `schema.test.ts` asserts the refusal rather than the name.
 *
 * SCOPED TO THE REGION AND NOT GLOBAL, because place names repeat across states
 * and both are real: "Obi" is an LGA of two of them. A global unique would make
 * the second state silently lose an area.
 */
CREATE UNIQUE INDEX marketing_service_areas_region_name_uq
  ON marketing_service_areas (region, lower(name));--> statement-breakpoint

/* The Areas screen's read: every region in turn, served rows first, in the order
 * the seed laid them out. */
CREATE INDEX marketing_service_areas_region_idx
  ON marketing_service_areas (region, active, sort_order);--> statement-breakpoint

/*
 * WHICH BOARD A RETURN IS ON. NULL means out of area, which is a LEGAL state and
 * an unrewardable one: a phone-in from out of town is a real request that a
 * driver cannot serve, and it belongs in the switcher's out-of-area footer where
 * it can be cancelled or rejected — not thrown away at the door.
 *
 * A REAL FOREIGN KEY, unlike `customer_id` and `order_id` on the same table.
 * Those are the shop's ids and marketing never joins on them (spec §Global);
 * this one is marketing's own row in marketing's own table, and the switcher's
 * counts join against it on every read.
 *
 * NO `ON DELETE` CLAUSE, so the default NO ACTION stands and an area that has
 * ever held a return cannot be deleted. That is not an oversight — plan §6.1b
 * says there is no DELETE at all: switching an area off is the retirement, and a
 * van that stops running does not make its old pickups disappear.
 */
ALTER TABLE marketing_return_requests
  ADD COLUMN service_area_id text REFERENCES marketing_service_areas(id);--> statement-breakpoint

/* The board's read: one district, grouped into its four open lists, oldest
 * first. Same shape as `marketing_return_requests_keyset_idx` with the area in
 * front of it, because the board always knows which district it is. */
CREATE INDEX marketing_return_requests_area_idx
  ON marketing_return_requests (service_area_id, status, created_at DESC, id DESC);--> statement-breakpoint

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GATE'S TEETH.
 *
 * Every other layer that keeps an unserved address from earning points is a
 * COURTESY: the picker only lists served districts, the intake route answers
 * `409 outside_service_area`, and the board has nowhere to put a return with no
 * area. Each of those is code, and code is edited.
 *
 * This is the one that is not. A return with no service area can never reach
 * `awarded`, so "outside the served set cannot earn" stays true with every guard
 * above it deleted — the same posture `marketing_return_requests_award_ck` takes
 * towards the arithmetic and `marketing_ledger_award_uq` towards paying twice.
 *
 * IT DOES NOT BLOCK `rejected` OR `cancelled`. An out-of-area return must still
 * be closable, and closing it with a reason is exactly what an operator should
 * be able to do.
 * ═══════════════════════════════════════════════════════════════════════════
 */
ALTER TABLE marketing_return_requests
  ADD CONSTRAINT marketing_return_requests_area_award_ck
  CHECK (status <> 'awarded' OR service_area_id IS NOT NULL);--> statement-breakpoint

/*
 * THE LEDGER'S AWARD COUPLING BECOMES AN IMPLICATION.
 *
 * It read `(kind = 'return_award') = (return_request_id IS NOT NULL)` — an
 * EQUALITY, so a `manual` row could never point at a return. The bonus needs
 * exactly that: an inspection may now mint a second, discretionary row on top of
 * the award, and that row has to say which return earned it or it is an
 * unexplained credit in somebody's history.
 *
 * WHY A SECOND ROW RATHER THAN A BIGGER AWARD. `marketing_return_requests_award_ck`
 * pins `points_awarded = qty_accepted * points_per_unit_snapshot`, and that
 * equality is what makes the arithmetic unforgeable — a number anybody can
 * recompute from the row. Folding a bonus into it would break the check or, far
 * worse, force it to be relaxed. So the award stays exactly quantity times rate
 * and the bonus is its own sentence: the customer sees one balance, and the
 * ledger keeps two honest lines that add up to it.
 *
 * The half of the old constraint that mattered is KEPT — an award still cannot
 * exist without a return. Only the reverse direction is dropped.
 */
ALTER TABLE marketing_ledger
  DROP CONSTRAINT marketing_ledger_award_link_ck;--> statement-breakpoint
ALTER TABLE marketing_ledger
  ADD CONSTRAINT marketing_ledger_award_link_ck
  CHECK (kind <> 'return_award' OR return_request_id IS NOT NULL);--> statement-breakpoint

/*
 * A BONUS, LIKE AN AWARD, CANNOT BE PAID TWICE — and for the same reason it is
 * an index rather than a guard: `marketing_ledger_award_uq` already makes double
 * awarding a 23505 with every application check deleted, and a bonus is money
 * minted by hand, which is if anything the more attractive thing to replay.
 *
 * The predicate carries `return_request_id IS NOT NULL` as well as the kind,
 * because a partial unique over a nullable column would otherwise cover every
 * ordinary manual adjustment — and those legitimately have no return, so the
 * index would be indexing a column full of NULLs for no reader. (Postgres treats
 * NULLs as distinct in a unique index, so it would not actually collide; the
 * predicate keeps the index small and says what it is for.)
 */
CREATE UNIQUE INDEX marketing_ledger_bonus_uq
  ON marketing_ledger (return_request_id)
  WHERE kind = 'manual' AND return_request_id IS NOT NULL;--> statement-breakpoint

/*
 * THE SEED — twenty-eight served districts and seven hundred and sixty-eight
 * local government areas that are not served yet.
 *
 * GENERATED, NOT TYPED. Everything between the two markers below is the output
 * of `npx tsx scripts/gen-service-areas.ts`, which reads
 * `docs/superpowers/data/ng-states-lgas.json` (37 regions, 774 LGAs, MIT
 * licensed, checked in so the seed does not depend on a URL that may not exist
 * next year) and the curated district list that script holds. It is COMMITTED
 * rather than run at migration time — migrations are SQL — and
 * `scripts/gen-service-areas.test.ts` re-runs the generator and asserts the
 * block below is byte-identical to what it produces. Edit the generator, re-run
 * it, paste the result back.
 *
 * THE SERVED REGION'S OWN SIX LGAs ARE ABSENT ON PURPOSE. They are
 * administrative units, not dispatch units — one of them contains every district
 * in the list — so seeding them would put a second, overlapping answer to "where
 * is this address" in the same table as the first.
 *
 * ⚠️  WHICH DISTRICTS ARE SERVED IS A BUSINESS DECISION AWAITING THE OWNER.
 *     All twenty-eight ship active because that is the honest default for a city
 *     the shop already collects in — but if the real answer is six, switching the
 *     rest off on the Areas screen makes the switcher tell the truth, and takes
 *     five seconds rather than a developer.
 *
 * `ON CONFLICT DO NOTHING` WITH NO INFERENCE TARGET, unlike 0011's
 * `ON CONFLICT (key)`. This table has TWO unique indexes and a conflict target
 * names only one of them, so a re-run that collided on the other would raise
 * 23505 and abort a migration whose whole point is to be replayable. The seed
 * writes no column it would want to update anyway: a rename an owner has made
 * must survive a replay, which is the same argument 0011 makes for its presets.
 */
-- >>> generated by scripts/gen-service-areas.ts — do not edit by hand
INSERT INTO marketing_service_areas
  (id, key, region, name, aliases, active, seeded, sort_order,
   revision, created_at, updated_at)
VALUES
  -- Federal Capital Territory
  ('area_federal_capital_territory_maitama_district', 'federal-capital-territory-maitama-district', 'Federal Capital Territory', 'Maitama District', ARRAY['maitama'], true, true, 0, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_wuse_district', 'federal-capital-territory-wuse-district', 'Federal Capital Territory', 'Wuse District', ARRAY['wuse'], true, true, 1, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_wuse_ii_district', 'federal-capital-territory-wuse-ii-district', 'Federal Capital Territory', 'Wuse II District', ARRAY['wuse 2', 'wuse ii', 'wuse2'], true, true, 2, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_garki', 'federal-capital-territory-garki', 'Federal Capital Territory', 'Garki', ARRAY['garki 1', 'garki i', 'garki district'], true, true, 3, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_garki_ii_district', 'federal-capital-territory-garki-ii-district', 'Federal Capital Territory', 'Garki II District', ARRAY['garki 2', 'garki ii', 'garki2'], true, true, 4, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_asokoro_district', 'federal-capital-territory-asokoro-district', 'Federal Capital Territory', 'Asokoro District', ARRAY['asokoro'], true, true, 5, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_central_business_district', 'federal-capital-territory-central-business-district', 'Federal Capital Territory', 'Central Business District', ARRAY['cbd', 'central area'], true, true, 6, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_guzape', 'federal-capital-territory-guzape', 'Federal Capital Territory', 'Guzape', ARRAY['guzape district'], true, true, 7, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_gudu', 'federal-capital-territory-gudu', 'Federal Capital Territory', 'Gudu', ARRAY['gudu district'], true, true, 8, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_durumi', 'federal-capital-territory-durumi', 'Federal Capital Territory', 'Durumi', ARRAY['durumi district'], true, true, 9, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_jabi', 'federal-capital-territory-jabi', 'Federal Capital Territory', 'Jabi', ARRAY['jabi district'], true, true, 10, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_jahi', 'federal-capital-territory-jahi', 'Federal Capital Territory', 'Jahi', ARRAY['jahi district'], true, true, 11, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_kado', 'federal-capital-territory-kado', 'Federal Capital Territory', 'Kado', ARRAY['kado district'], true, true, 12, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_katampe', 'federal-capital-territory-katampe', 'Federal Capital Territory', 'Katampe', ARRAY['katampe district', 'katampe extension'], true, true, 13, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_kaura', 'federal-capital-territory-kaura', 'Federal Capital Territory', 'Kaura', ARRAY['kaura district'], true, true, 14, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_kukwaba', 'federal-capital-territory-kukwaba', 'Federal Capital Territory', 'Kukwaba', ARRAY['kukwaba district'], true, true, 15, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_mabushi', 'federal-capital-territory-mabushi', 'Federal Capital Territory', 'Mabushi', ARRAY['mabushi district'], true, true, 16, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_utako', 'federal-capital-territory-utako', 'Federal Capital Territory', 'Utako', ARRAY['utako district'], true, true, 17, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_wuye', 'federal-capital-territory-wuye', 'Federal Capital Territory', 'Wuye', ARRAY['wuye district'], true, true, 18, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_dakibiyu', 'federal-capital-territory-dakibiyu', 'Federal Capital Territory', 'Dakibiyu', ARRAY['dakibiyu district'], true, true, 19, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_gwarinpa', 'federal-capital-territory-gwarinpa', 'Federal Capital Territory', 'Gwarinpa', ARRAY['gwarimpa', 'gwarinpa estate'], true, true, 20, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_wuse_zone_1', 'federal-capital-territory-wuse-zone-1', 'Federal Capital Territory', 'Wuse Zone 1', ARRAY['zone 1'], true, true, 21, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_wuse_zone_2', 'federal-capital-territory-wuse-zone-2', 'Federal Capital Territory', 'Wuse Zone 2', ARRAY['zone 2'], true, true, 22, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_wuse_zone_3', 'federal-capital-territory-wuse-zone-3', 'Federal Capital Territory', 'Wuse Zone 3', ARRAY['zone 3'], true, true, 23, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_wuse_zone_4', 'federal-capital-territory-wuse-zone-4', 'Federal Capital Territory', 'Wuse Zone 4', ARRAY['zone 4'], true, true, 24, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_wuse_zone_5', 'federal-capital-territory-wuse-zone-5', 'Federal Capital Territory', 'Wuse Zone 5', ARRAY['zone 5'], true, true, 25, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_wuse_zone_6', 'federal-capital-territory-wuse-zone-6', 'Federal Capital Territory', 'Wuse Zone 6', ARRAY['zone 6'], true, true, 26, 1, 1786600001100, 1786600001100),
  ('area_federal_capital_territory_wuse_zone_7', 'federal-capital-territory-wuse-zone-7', 'Federal Capital Territory', 'Wuse Zone 7', ARRAY['zone 7'], true, true, 27, 1, 1786600001100, 1786600001100),
  -- Abia
  ('area_abia_aba_north', 'abia-aba-north', 'Abia', 'Aba North', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_abia_aba_south', 'abia-aba-south', 'Abia', 'Aba South', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_abia_arochukwu', 'abia-arochukwu', 'Abia', 'Arochukwu', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_abia_bende', 'abia-bende', 'Abia', 'Bende', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_abia_ikwuano', 'abia-ikwuano', 'Abia', 'Ikwuano', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_abia_isiala_ngwa_north', 'abia-isiala-ngwa-north', 'Abia', 'Isiala Ngwa North', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_abia_isiala_ngwa_south', 'abia-isiala-ngwa-south', 'Abia', 'Isiala Ngwa South', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_abia_isuikwuato', 'abia-isuikwuato', 'Abia', 'Isuikwuato', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_abia_oboma_ngwa', 'abia-oboma-ngwa', 'Abia', 'Oboma Ngwa', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_abia_ohafia', 'abia-ohafia', 'Abia', 'Ohafia', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_abia_osisioma', 'abia-osisioma', 'Abia', 'Osisioma', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_abia_ugwunagbo', 'abia-ugwunagbo', 'Abia', 'Ugwunagbo', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_abia_ukwa_east', 'abia-ukwa-east', 'Abia', 'Ukwa East', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_abia_ukwa_west', 'abia-ukwa-west', 'Abia', 'Ukwa West', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_abia_umu_nneochi', 'abia-umu-nneochi', 'Abia', 'Umu-Nneochi', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_abia_umuahia_north', 'abia-umuahia-north', 'Abia', 'Umuahia North', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_abia_umuahia_south', 'abia-umuahia-south', 'Abia', 'Umuahia South', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  -- Adamawa
  ('area_adamawa_demsa', 'adamawa-demsa', 'Adamawa', 'Demsa', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_adamawa_fufore', 'adamawa-fufore', 'Adamawa', 'Fufore', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_adamawa_ganye', 'adamawa-ganye', 'Adamawa', 'Ganye', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_adamawa_girie', 'adamawa-girie', 'Adamawa', 'Girie', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_adamawa_gombi', 'adamawa-gombi', 'Adamawa', 'Gombi', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_adamawa_guyuk', 'adamawa-guyuk', 'Adamawa', 'Guyuk', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_adamawa_hong', 'adamawa-hong', 'Adamawa', 'Hong', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_adamawa_jada', 'adamawa-jada', 'Adamawa', 'Jada', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_adamawa_lamurde', 'adamawa-lamurde', 'Adamawa', 'Lamurde', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_adamawa_madagali', 'adamawa-madagali', 'Adamawa', 'Madagali', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_adamawa_maiha', 'adamawa-maiha', 'Adamawa', 'Maiha', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_adamawa_mayo_belwa', 'adamawa-mayo-belwa', 'Adamawa', 'Mayo-Belwa', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_adamawa_michika', 'adamawa-michika', 'Adamawa', 'Michika', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_adamawa_mubi_north', 'adamawa-mubi-north', 'Adamawa', 'Mubi North', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_adamawa_mubi_south', 'adamawa-mubi-south', 'Adamawa', 'Mubi South', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_adamawa_numan', 'adamawa-numan', 'Adamawa', 'Numan', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_adamawa_shelleng', 'adamawa-shelleng', 'Adamawa', 'Shelleng', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_adamawa_song', 'adamawa-song', 'Adamawa', 'Song', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_adamawa_teungo', 'adamawa-teungo', 'Adamawa', 'Teungo', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_adamawa_yola_north', 'adamawa-yola-north', 'Adamawa', 'Yola North', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_adamawa_yola_south', 'adamawa-yola-south', 'Adamawa', 'Yola South', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  -- Akwa Ibom
  ('area_akwa_ibom_abak', 'akwa-ibom-abak', 'Akwa Ibom', 'Abak', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_eastern_obolo', 'akwa-ibom-eastern-obolo', 'Akwa Ibom', 'Eastern Obolo', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_eket', 'akwa-ibom-eket', 'Akwa Ibom', 'Eket', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_esit_eket', 'akwa-ibom-esit-eket', 'Akwa Ibom', 'Esit Eket', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_essien_udim', 'akwa-ibom-essien-udim', 'Akwa Ibom', 'Essien Udim', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_etim_ekpo', 'akwa-ibom-etim-ekpo', 'Akwa Ibom', 'Etim Ekpo', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_etinan', 'akwa-ibom-etinan', 'Akwa Ibom', 'Etinan', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_ibeno', 'akwa-ibom-ibeno', 'Akwa Ibom', 'Ibeno', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_ibesikpo_asutan', 'akwa-ibom-ibesikpo-asutan', 'Akwa Ibom', 'Ibesikpo Asutan', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_ibiono_ibom', 'akwa-ibom-ibiono-ibom', 'Akwa Ibom', 'Ibiono Ibom', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_ika', 'akwa-ibom-ika', 'Akwa Ibom', 'Ika', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_ikono', 'akwa-ibom-ikono', 'Akwa Ibom', 'Ikono', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_ikot_abasi', 'akwa-ibom-ikot-abasi', 'Akwa Ibom', 'Ikot Abasi', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_ikot_ekpene', 'akwa-ibom-ikot-ekpene', 'Akwa Ibom', 'Ikot Ekpene', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_ini', 'akwa-ibom-ini', 'Akwa Ibom', 'Ini', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_itu', 'akwa-ibom-itu', 'Akwa Ibom', 'Itu', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_mbo', 'akwa-ibom-mbo', 'Akwa Ibom', 'Mbo', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_mkpat_enin', 'akwa-ibom-mkpat-enin', 'Akwa Ibom', 'Mkpat Enin', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_nsit_atai', 'akwa-ibom-nsit-atai', 'Akwa Ibom', 'Nsit Atai', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_nsit_ibom', 'akwa-ibom-nsit-ibom', 'Akwa Ibom', 'Nsit Ibom', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_nsit_ubium', 'akwa-ibom-nsit-ubium', 'Akwa Ibom', 'Nsit Ubium', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_obot_akara', 'akwa-ibom-obot-akara', 'Akwa Ibom', 'Obot Akara', '{}', false, true, 21, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_okobo', 'akwa-ibom-okobo', 'Akwa Ibom', 'Okobo', '{}', false, true, 22, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_onna', 'akwa-ibom-onna', 'Akwa Ibom', 'Onna', '{}', false, true, 23, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_oron', 'akwa-ibom-oron', 'Akwa Ibom', 'Oron', '{}', false, true, 24, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_oruk_anam', 'akwa-ibom-oruk-anam', 'Akwa Ibom', 'Oruk Anam', '{}', false, true, 25, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_udung_uko', 'akwa-ibom-udung-uko', 'Akwa Ibom', 'Udung Uko', '{}', false, true, 26, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_ukanafun', 'akwa-ibom-ukanafun', 'Akwa Ibom', 'Ukanafun', '{}', false, true, 27, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_uruan', 'akwa-ibom-uruan', 'Akwa Ibom', 'Uruan', '{}', false, true, 28, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_urue_offong_oruko', 'akwa-ibom-urue-offong-oruko', 'Akwa Ibom', 'Urue Offong|Oruko', '{}', false, true, 29, 1, 1786600001100, 1786600001100),
  ('area_akwa_ibom_uyo', 'akwa-ibom-uyo', 'Akwa Ibom', 'Uyo', '{}', false, true, 30, 1, 1786600001100, 1786600001100),
  -- Anambra
  ('area_anambra_aguata', 'anambra-aguata', 'Anambra', 'Aguata', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_anambra_anambra_east', 'anambra-anambra-east', 'Anambra', 'Anambra East', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_anambra_anambra_west', 'anambra-anambra-west', 'Anambra', 'Anambra West', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_anambra_anaocha', 'anambra-anaocha', 'Anambra', 'Anaocha', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_anambra_awka_north', 'anambra-awka-north', 'Anambra', 'Awka North', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_anambra_awka_south', 'anambra-awka-south', 'Anambra', 'Awka South', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_anambra_ayamelum', 'anambra-ayamelum', 'Anambra', 'Ayamelum', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_anambra_dunukofia', 'anambra-dunukofia', 'Anambra', 'Dunukofia', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_anambra_ekwusigo', 'anambra-ekwusigo', 'Anambra', 'Ekwusigo', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_anambra_idemili_north', 'anambra-idemili-north', 'Anambra', 'Idemili North', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_anambra_idemili_south', 'anambra-idemili-south', 'Anambra', 'Idemili South', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_anambra_ihiala', 'anambra-ihiala', 'Anambra', 'Ihiala', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_anambra_njikoka', 'anambra-njikoka', 'Anambra', 'Njikoka', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_anambra_nnewi_north', 'anambra-nnewi-north', 'Anambra', 'Nnewi North', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_anambra_nnewi_south', 'anambra-nnewi-south', 'Anambra', 'Nnewi South', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_anambra_ogbaru', 'anambra-ogbaru', 'Anambra', 'Ogbaru', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_anambra_onitsha_north', 'anambra-onitsha-north', 'Anambra', 'Onitsha North', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_anambra_onitsha_south', 'anambra-onitsha-south', 'Anambra', 'Onitsha South', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_anambra_orumba_north', 'anambra-orumba-north', 'Anambra', 'Orumba North', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_anambra_orumba_south', 'anambra-orumba-south', 'Anambra', 'Orumba South', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_anambra_oyi', 'anambra-oyi', 'Anambra', 'Oyi', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  -- Bauchi
  ('area_bauchi_alkaleri', 'bauchi-alkaleri', 'Bauchi', 'Alkaleri', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_bauchi_bauchi', 'bauchi-bauchi', 'Bauchi', 'Bauchi', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_bauchi_bogoro', 'bauchi-bogoro', 'Bauchi', 'Bogoro', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_bauchi_damban', 'bauchi-damban', 'Bauchi', 'Damban', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_bauchi_darazo', 'bauchi-darazo', 'Bauchi', 'Darazo', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_bauchi_dass', 'bauchi-dass', 'Bauchi', 'Dass', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_bauchi_gamawa', 'bauchi-gamawa', 'Bauchi', 'Gamawa', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_bauchi_gamjuwa', 'bauchi-gamjuwa', 'Bauchi', 'Gamjuwa', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_bauchi_giade', 'bauchi-giade', 'Bauchi', 'Giade', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_bauchi_itas_gadau', 'bauchi-itas-gadau', 'Bauchi', 'Itas/Gadau', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_bauchi_jama_are', 'bauchi-jama-are', 'Bauchi', 'Jama''are', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_bauchi_katagum', 'bauchi-katagum', 'Bauchi', 'Katagum', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_bauchi_kirfi', 'bauchi-kirfi', 'Bauchi', 'Kirfi', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_bauchi_misau', 'bauchi-misau', 'Bauchi', 'Misau', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_bauchi_ningi', 'bauchi-ningi', 'Bauchi', 'Ningi', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_bauchi_shira', 'bauchi-shira', 'Bauchi', 'Shira', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_bauchi_tafawa_balewa', 'bauchi-tafawa-balewa', 'Bauchi', 'Tafawa-Balewa', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_bauchi_toro', 'bauchi-toro', 'Bauchi', 'Toro', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_bauchi_warji', 'bauchi-warji', 'Bauchi', 'Warji', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_bauchi_zaki', 'bauchi-zaki', 'Bauchi', 'Zaki', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  -- Bayelsa
  ('area_bayelsa_brass', 'bayelsa-brass', 'Bayelsa', 'Brass', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_bayelsa_ekeremor', 'bayelsa-ekeremor', 'Bayelsa', 'Ekeremor', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_bayelsa_kolokuma_opokuma', 'bayelsa-kolokuma-opokuma', 'Bayelsa', 'Kolokuma-Opokuma', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_bayelsa_nembe', 'bayelsa-nembe', 'Bayelsa', 'Nembe', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_bayelsa_ogbia', 'bayelsa-ogbia', 'Bayelsa', 'Ogbia', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_bayelsa_sagbama', 'bayelsa-sagbama', 'Bayelsa', 'Sagbama', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_bayelsa_southern_ijaw', 'bayelsa-southern-ijaw', 'Bayelsa', 'Southern Ijaw', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_bayelsa_yenagoa', 'bayelsa-yenagoa', 'Bayelsa', 'Yenagoa', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  -- Benue
  ('area_benue_ado', 'benue-ado', 'Benue', 'Ado', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_benue_agatu', 'benue-agatu', 'Benue', 'Agatu', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_benue_apa', 'benue-apa', 'Benue', 'Apa', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_benue_buruku', 'benue-buruku', 'Benue', 'Buruku', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_benue_gboko', 'benue-gboko', 'Benue', 'Gboko', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_benue_guma', 'benue-guma', 'Benue', 'Guma', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_benue_gwer_east', 'benue-gwer-east', 'Benue', 'Gwer East', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_benue_gwer_west', 'benue-gwer-west', 'Benue', 'Gwer West', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_benue_katsina_ala', 'benue-katsina-ala', 'Benue', 'Katsina- Ala', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_benue_konshisha', 'benue-konshisha', 'Benue', 'Konshisha', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_benue_kwande', 'benue-kwande', 'Benue', 'Kwande', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_benue_logo', 'benue-logo', 'Benue', 'Logo', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_benue_makurdi', 'benue-makurdi', 'Benue', 'Makurdi', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_benue_obi', 'benue-obi', 'Benue', 'Obi', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_benue_ogbadibo', 'benue-ogbadibo', 'Benue', 'Ogbadibo', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_benue_ohimini', 'benue-ohimini', 'Benue', 'Ohimini', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_benue_oju', 'benue-oju', 'Benue', 'Oju', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_benue_okpokwu', 'benue-okpokwu', 'Benue', 'Okpokwu', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_benue_oturkpo', 'benue-oturkpo', 'Benue', 'Oturkpo', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_benue_tarka', 'benue-tarka', 'Benue', 'Tarka', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_benue_ukum', 'benue-ukum', 'Benue', 'Ukum', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  ('area_benue_ushongo', 'benue-ushongo', 'Benue', 'Ushongo', '{}', false, true, 21, 1, 1786600001100, 1786600001100),
  ('area_benue_vandeikya', 'benue-vandeikya', 'Benue', 'Vandeikya', '{}', false, true, 22, 1, 1786600001100, 1786600001100),
  -- Borno
  ('area_borno_abadam', 'borno-abadam', 'Borno', 'Abadam', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_borno_askira_uba', 'borno-askira-uba', 'Borno', 'Askira/Uba', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_borno_bama', 'borno-bama', 'Borno', 'Bama', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_borno_bayo', 'borno-bayo', 'Borno', 'Bayo', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_borno_biu', 'borno-biu', 'Borno', 'Biu', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_borno_chibok', 'borno-chibok', 'Borno', 'Chibok', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_borno_damboa', 'borno-damboa', 'Borno', 'Damboa', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_borno_dikwa', 'borno-dikwa', 'Borno', 'Dikwa', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_borno_gubio', 'borno-gubio', 'Borno', 'Gubio', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_borno_guzamala', 'borno-guzamala', 'Borno', 'Guzamala', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_borno_gwoza', 'borno-gwoza', 'Borno', 'Gwoza', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_borno_hawul', 'borno-hawul', 'Borno', 'Hawul', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_borno_jere', 'borno-jere', 'Borno', 'Jere', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_borno_kaga', 'borno-kaga', 'Borno', 'Kaga', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_borno_kala_balge', 'borno-kala-balge', 'Borno', 'Kala/Balge', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_borno_konduga', 'borno-konduga', 'Borno', 'Konduga', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_borno_kukawa', 'borno-kukawa', 'Borno', 'Kukawa', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_borno_kwaya_kusar', 'borno-kwaya-kusar', 'Borno', 'Kwaya Kusar', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_borno_mafa', 'borno-mafa', 'Borno', 'Mafa', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_borno_magumeri', 'borno-magumeri', 'Borno', 'Magumeri', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_borno_maiduguri', 'borno-maiduguri', 'Borno', 'Maiduguri', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  ('area_borno_marte', 'borno-marte', 'Borno', 'Marte', '{}', false, true, 21, 1, 1786600001100, 1786600001100),
  ('area_borno_mobbar', 'borno-mobbar', 'Borno', 'Mobbar', '{}', false, true, 22, 1, 1786600001100, 1786600001100),
  ('area_borno_monguno', 'borno-monguno', 'Borno', 'Monguno', '{}', false, true, 23, 1, 1786600001100, 1786600001100),
  ('area_borno_ngala', 'borno-ngala', 'Borno', 'Ngala', '{}', false, true, 24, 1, 1786600001100, 1786600001100),
  ('area_borno_nganzai', 'borno-nganzai', 'Borno', 'Nganzai', '{}', false, true, 25, 1, 1786600001100, 1786600001100),
  ('area_borno_shani', 'borno-shani', 'Borno', 'Shani', '{}', false, true, 26, 1, 1786600001100, 1786600001100),
  -- Cross River
  ('area_cross_river_abi', 'cross-river-abi', 'Cross River', 'Abi', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_cross_river_akamkpa', 'cross-river-akamkpa', 'Cross River', 'Akamkpa', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_cross_river_akpabuyo', 'cross-river-akpabuyo', 'Cross River', 'Akpabuyo', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_cross_river_bakassi', 'cross-river-bakassi', 'Cross River', 'Bakassi', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_cross_river_bekwarra', 'cross-river-bekwarra', 'Cross River', 'Bekwarra', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_cross_river_biase', 'cross-river-biase', 'Cross River', 'Biase', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_cross_river_boki', 'cross-river-boki', 'Cross River', 'Boki', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_cross_river_calabar_municipality', 'cross-river-calabar-municipality', 'Cross River', 'Calabar Municipality', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_cross_river_calabar_south', 'cross-river-calabar-south', 'Cross River', 'Calabar South', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_cross_river_etung', 'cross-river-etung', 'Cross River', 'Etung', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_cross_river_ikom', 'cross-river-ikom', 'Cross River', 'Ikom', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_cross_river_obanliku', 'cross-river-obanliku', 'Cross River', 'Obanliku', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_cross_river_obubra', 'cross-river-obubra', 'Cross River', 'Obubra', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_cross_river_obudu', 'cross-river-obudu', 'Cross River', 'Obudu', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_cross_river_odukpani', 'cross-river-odukpani', 'Cross River', 'Odukpani', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_cross_river_ogoja', 'cross-river-ogoja', 'Cross River', 'Ogoja', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_cross_river_yakurr', 'cross-river-yakurr', 'Cross River', 'Yakurr', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_cross_river_yala', 'cross-river-yala', 'Cross River', 'Yala', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  -- Delta
  ('area_delta_aniochan', 'delta-aniochan', 'Delta', 'AniochaN', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_delta_aniochas', 'delta-aniochas', 'Delta', 'AniochaS', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_delta_bomadi', 'delta-bomadi', 'Delta', 'Bomadi', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_delta_burutu', 'delta-burutu', 'Delta', 'Burutu', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_delta_ethiope_west', 'delta-ethiope-west', 'Delta', 'Ethiope West', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_delta_ethiopee', 'delta-ethiopee', 'Delta', 'EthiopeE', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_delta_ikanorth', 'delta-ikanorth', 'Delta', 'IkaNorth', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_delta_ikasouth', 'delta-ikasouth', 'Delta', 'IkaSouth', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_delta_isokonor', 'delta-isokonor', 'Delta', 'IsokoNor', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_delta_isokosou', 'delta-isokosou', 'Delta', 'IsokoSou', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_delta_ndokwa_east', 'delta-ndokwa-east', 'Delta', 'Ndokwa East', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_delta_ndokwa_west', 'delta-ndokwa-west', 'Delta', 'Ndokwa West', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_delta_okpe', 'delta-okpe', 'Delta', 'Okpe', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_delta_oshimili_north', 'delta-oshimili-north', 'Delta', 'Oshimili North', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_delta_oshimili_south', 'delta-oshimili-south', 'Delta', 'Oshimili South', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_delta_patani', 'delta-patani', 'Delta', 'Patani', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_delta_sapele', 'delta-sapele', 'Delta', 'Sapele', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_delta_udu', 'delta-udu', 'Delta', 'Udu', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_delta_ughelli_north', 'delta-ughelli-north', 'Delta', 'Ughelli North', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_delta_ughelli_south', 'delta-ughelli-south', 'Delta', 'Ughelli South', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_delta_ukwuani', 'delta-ukwuani', 'Delta', 'Ukwuani', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  ('area_delta_uvwie', 'delta-uvwie', 'Delta', 'Uvwie', '{}', false, true, 21, 1, 1786600001100, 1786600001100),
  ('area_delta_warri_north', 'delta-warri-north', 'Delta', 'Warri North', '{}', false, true, 22, 1, 1786600001100, 1786600001100),
  ('area_delta_warri_south', 'delta-warri-south', 'Delta', 'Warri South', '{}', false, true, 23, 1, 1786600001100, 1786600001100),
  ('area_delta_warri_south_west', 'delta-warri-south-west', 'Delta', 'Warri South-West', '{}', false, true, 24, 1, 1786600001100, 1786600001100),
  -- Ebonyi
  ('area_ebonyi_abakalik', 'ebonyi-abakalik', 'Ebonyi', 'Abakalik', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_ebonyi_afikpo_north', 'ebonyi-afikpo-north', 'Ebonyi', 'Afikpo North', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_ebonyi_afikpo_south', 'ebonyi-afikpo-south', 'Ebonyi', 'Afikpo South', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_ebonyi_ebonyi', 'ebonyi-ebonyi', 'Ebonyi', 'Ebonyi', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_ebonyi_ezza_north', 'ebonyi-ezza-north', 'Ebonyi', 'Ezza North', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_ebonyi_ezza_south', 'ebonyi-ezza-south', 'Ebonyi', 'Ezza South', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_ebonyi_ikwo', 'ebonyi-ikwo', 'Ebonyi', 'Ikwo', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_ebonyi_ishielu', 'ebonyi-ishielu', 'Ebonyi', 'Ishielu', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_ebonyi_ivo', 'ebonyi-ivo', 'Ebonyi', 'Ivo', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_ebonyi_izzi', 'ebonyi-izzi', 'Ebonyi', 'Izzi', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_ebonyi_ohaozara', 'ebonyi-ohaozara', 'Ebonyi', 'Ohaozara', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_ebonyi_ohaukwu', 'ebonyi-ohaukwu', 'Ebonyi', 'Ohaukwu', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_ebonyi_onicha', 'ebonyi-onicha', 'Ebonyi', 'Onicha', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  -- Edo
  ('area_edo_akoko_edo', 'edo-akoko-edo', 'Edo', 'Akoko Edo', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_edo_egor', 'edo-egor', 'Edo', 'Egor', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_edo_esan_centtral', 'edo-esan-centtral', 'Edo', 'Esan Centtral', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_edo_esan_north_east', 'edo-esan-north-east', 'Edo', 'Esan North East', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_edo_esan_south_east', 'edo-esan-south-east', 'Edo', 'Esan South East', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_edo_esan_west', 'edo-esan-west', 'Edo', 'Esan West', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_edo_etsako_central', 'edo-etsako-central', 'Edo', 'Etsako Central', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_edo_etsako_east', 'edo-etsako-east', 'Edo', 'Etsako East', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_edo_etsako_west', 'edo-etsako-west', 'Edo', 'Etsako West', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_edo_igueben', 'edo-igueben', 'Edo', 'Igueben', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_edo_ikpoba_okha', 'edo-ikpoba-okha', 'Edo', 'Ikpoba-Okha', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_edo_oredo', 'edo-oredo', 'Edo', 'Oredo', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_edo_orhionmw', 'edo-orhionmw', 'Edo', 'Orhionmw', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_edo_ovia_north_east', 'edo-ovia-north-east', 'Edo', 'Ovia North East', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_edo_ovia_south_west', 'edo-ovia-south-west', 'Edo', 'Ovia South West', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_edo_owan_east', 'edo-owan-east', 'Edo', 'Owan East', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_edo_owan_west', 'edo-owan-west', 'Edo', 'Owan West', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_edo_uhunmwonde', 'edo-uhunmwonde', 'Edo', 'Uhunmwonde', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  -- Ekiti
  ('area_ekiti_ado_ekiti', 'ekiti-ado-ekiti', 'Ekiti', 'Ado-Ekiti', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_ekiti_efon', 'ekiti-efon', 'Ekiti', 'Efon', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_ekiti_ekiti_east', 'ekiti-ekiti-east', 'Ekiti', 'Ekiti East', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_ekiti_ekiti_south_west', 'ekiti-ekiti-south-west', 'Ekiti', 'Ekiti South West', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_ekiti_ekiti_west', 'ekiti-ekiti-west', 'Ekiti', 'Ekiti West', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_ekiti_emure', 'ekiti-emure', 'Ekiti', 'Emure', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_ekiti_gboyin', 'ekiti-gboyin', 'Ekiti', 'Gboyin', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_ekiti_ido_osi', 'ekiti-ido-osi', 'Ekiti', 'Ido-Osi', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_ekiti_ijero', 'ekiti-ijero', 'Ekiti', 'Ijero', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_ekiti_ikere', 'ekiti-ikere', 'Ekiti', 'Ikere', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_ekiti_ikole', 'ekiti-ikole', 'Ekiti', 'Ikole', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_ekiti_ilejemeje', 'ekiti-ilejemeje', 'Ekiti', 'Ilejemeje', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_ekiti_irepodun_ifelodun', 'ekiti-irepodun-ifelodun', 'Ekiti', 'Irepodun-Ifelodun', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_ekiti_ise_orun', 'ekiti-ise-orun', 'Ekiti', 'Ise-Orun', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_ekiti_moba', 'ekiti-moba', 'Ekiti', 'Moba', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_ekiti_oye', 'ekiti-oye', 'Ekiti', 'Oye', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  -- Enugu
  ('area_enugu_aninri', 'enugu-aninri', 'Enugu', 'Aninri', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_enugu_awgu', 'enugu-awgu', 'Enugu', 'Awgu', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_enugu_enugu_east', 'enugu-enugu-east', 'Enugu', 'Enugu East', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_enugu_enugu_north', 'enugu-enugu-north', 'Enugu', 'Enugu North', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_enugu_enugusou', 'enugu-enugusou', 'Enugu', 'EnuguSou', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_enugu_ezeagu', 'enugu-ezeagu', 'Enugu', 'Ezeagu', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_enugu_igbo_eti', 'enugu-igbo-eti', 'Enugu', 'Igbo-Eti', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_enugu_igbo_eze_north', 'enugu-igbo-eze-north', 'Enugu', 'Igbo-eze North', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_enugu_igbo_eze_south', 'enugu-igbo-eze-south', 'Enugu', 'Igbo-eze South', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_enugu_isi_uzo', 'enugu-isi-uzo', 'Enugu', 'Isi-Uzo', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_enugu_nkanu_east', 'enugu-nkanu-east', 'Enugu', 'Nkanu East', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_enugu_nkanu_west', 'enugu-nkanu-west', 'Enugu', 'Nkanu West', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_enugu_nsukka', 'enugu-nsukka', 'Enugu', 'Nsukka', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_enugu_oji_river', 'enugu-oji-river', 'Enugu', 'Oji-River', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_enugu_udenu', 'enugu-udenu', 'Enugu', 'Udenu', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_enugu_udi', 'enugu-udi', 'Enugu', 'Udi', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_enugu_uzo_uwani', 'enugu-uzo-uwani', 'Enugu', 'Uzo-Uwani', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  -- Gombe
  ('area_gombe_akko', 'gombe-akko', 'Gombe', 'Akko', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_gombe_balanga', 'gombe-balanga', 'Gombe', 'Balanga', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_gombe_billiri', 'gombe-billiri', 'Gombe', 'Billiri', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_gombe_dukku', 'gombe-dukku', 'Gombe', 'Dukku', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_gombe_funakaye', 'gombe-funakaye', 'Gombe', 'Funakaye', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_gombe_gombe', 'gombe-gombe', 'Gombe', 'Gombe', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_gombe_kaltungo', 'gombe-kaltungo', 'Gombe', 'Kaltungo', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_gombe_kwami', 'gombe-kwami', 'Gombe', 'Kwami', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_gombe_nafada', 'gombe-nafada', 'Gombe', 'Nafada', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_gombe_shomgom', 'gombe-shomgom', 'Gombe', 'Shomgom', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_gombe_yalmatu_deba', 'gombe-yalmatu-deba', 'Gombe', 'Yalmatu / Deba', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  -- Imo
  ('area_imo_aboh_mbaise', 'imo-aboh-mbaise', 'Imo', 'Aboh-Mbaise', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_imo_ahiazu_mbaise', 'imo-ahiazu-mbaise', 'Imo', 'Ahiazu-Mbaise', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_imo_ehime_mbano', 'imo-ehime-mbano', 'Imo', 'Ehime-Mbano', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_imo_ezinihitte_mbaise', 'imo-ezinihitte-mbaise', 'Imo', 'Ezinihitte Mbaise', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_imo_ideato_north', 'imo-ideato-north', 'Imo', 'Ideato North', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_imo_ideato_south', 'imo-ideato-south', 'Imo', 'Ideato South', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_imo_ihitte_uboma_isinweke', 'imo-ihitte-uboma-isinweke', 'Imo', 'Ihitte-Uboma Isinweke', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_imo_ikeduru', 'imo-ikeduru', 'Imo', 'Ikeduru', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_imo_isiala_mbano', 'imo-isiala-mbano', 'Imo', 'Isiala Mbano', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_imo_isu', 'imo-isu', 'Imo', 'Isu', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_imo_mbaitoli', 'imo-mbaitoli', 'Imo', 'Mbaitoli', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_imo_ngor_okpala', 'imo-ngor-okpala', 'Imo', 'Ngor-Okpala', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_imo_njaba', 'imo-njaba', 'Imo', 'Njaba', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_imo_nkwerre', 'imo-nkwerre', 'Imo', 'Nkwerre', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_imo_nwangele', 'imo-nwangele', 'Imo', 'Nwangele', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_imo_obowo', 'imo-obowo', 'Imo', 'Obowo', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_imo_oguta', 'imo-oguta', 'Imo', 'Oguta', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_imo_ohaji_egbema', 'imo-ohaji-egbema', 'Imo', 'Ohaji-Egbema', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_imo_okigwe', 'imo-okigwe', 'Imo', 'Okigwe', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_imo_orlu', 'imo-orlu', 'Imo', 'Orlu', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_imo_orsu', 'imo-orsu', 'Imo', 'Orsu', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  ('area_imo_oru_east', 'imo-oru-east', 'Imo', 'Oru-East', '{}', false, true, 21, 1, 1786600001100, 1786600001100),
  ('area_imo_oru_west', 'imo-oru-west', 'Imo', 'Oru-West', '{}', false, true, 22, 1, 1786600001100, 1786600001100),
  ('area_imo_owerri_municipal', 'imo-owerri-municipal', 'Imo', 'Owerri Municipal', '{}', false, true, 23, 1, 1786600001100, 1786600001100),
  ('area_imo_owerri_north', 'imo-owerri-north', 'Imo', 'Owerri North', '{}', false, true, 24, 1, 1786600001100, 1786600001100),
  ('area_imo_owerri_west', 'imo-owerri-west', 'Imo', 'Owerri West', '{}', false, true, 25, 1, 1786600001100, 1786600001100),
  ('area_imo_unuimo', 'imo-unuimo', 'Imo', 'Unuimo', '{}', false, true, 26, 1, 1786600001100, 1786600001100),
  -- Jigawa
  ('area_jigawa_auyo', 'jigawa-auyo', 'Jigawa', 'Auyo', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_jigawa_babura', 'jigawa-babura', 'Jigawa', 'Babura', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_jigawa_biriniwa', 'jigawa-biriniwa', 'Jigawa', 'Biriniwa', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_jigawa_birnin_kudu', 'jigawa-birnin-kudu', 'Jigawa', 'Birnin Kudu', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_jigawa_buji', 'jigawa-buji', 'Jigawa', 'Buji', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_jigawa_dutse', 'jigawa-dutse', 'Jigawa', 'Dutse', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_jigawa_gagarawa', 'jigawa-gagarawa', 'Jigawa', 'Gagarawa', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_jigawa_garki', 'jigawa-garki', 'Jigawa', 'Garki', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_jigawa_gumel', 'jigawa-gumel', 'Jigawa', 'Gumel', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_jigawa_guri', 'jigawa-guri', 'Jigawa', 'Guri', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_jigawa_gwaram', 'jigawa-gwaram', 'Jigawa', 'Gwaram', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_jigawa_gwiwa', 'jigawa-gwiwa', 'Jigawa', 'Gwiwa', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_jigawa_hadejia', 'jigawa-hadejia', 'Jigawa', 'Hadejia', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_jigawa_jahun', 'jigawa-jahun', 'Jigawa', 'Jahun', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_jigawa_kafin_hausa', 'jigawa-kafin-hausa', 'Jigawa', 'Kafin Hausa', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_jigawa_kaugama', 'jigawa-kaugama', 'Jigawa', 'Kaugama', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_jigawa_kazaure', 'jigawa-kazaure', 'Jigawa', 'Kazaure', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_jigawa_kirika_samma', 'jigawa-kirika-samma', 'Jigawa', 'Kirika Samma', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_jigawa_kiyawa', 'jigawa-kiyawa', 'Jigawa', 'Kiyawa', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_jigawa_maigatari', 'jigawa-maigatari', 'Jigawa', 'Maigatari', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_jigawa_malam_mado', 'jigawa-malam-mado', 'Jigawa', 'Malam Mado', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  ('area_jigawa_miga', 'jigawa-miga', 'Jigawa', 'Miga', '{}', false, true, 21, 1, 1786600001100, 1786600001100),
  ('area_jigawa_ringim', 'jigawa-ringim', 'Jigawa', 'Ringim', '{}', false, true, 22, 1, 1786600001100, 1786600001100),
  ('area_jigawa_roni', 'jigawa-roni', 'Jigawa', 'Roni', '{}', false, true, 23, 1, 1786600001100, 1786600001100),
  ('area_jigawa_sule_tankarkar', 'jigawa-sule-tankarkar', 'Jigawa', 'Sule Tankarkar', '{}', false, true, 24, 1, 1786600001100, 1786600001100),
  ('area_jigawa_taura', 'jigawa-taura', 'Jigawa', 'Taura', '{}', false, true, 25, 1, 1786600001100, 1786600001100),
  ('area_jigawa_yankwashi', 'jigawa-yankwashi', 'Jigawa', 'Yankwashi', '{}', false, true, 26, 1, 1786600001100, 1786600001100),
  -- Kaduna
  ('area_kaduna_birnin_gwari', 'kaduna-birnin-gwari', 'Kaduna', 'Birnin Gwari', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_kaduna_chikun', 'kaduna-chikun', 'Kaduna', 'Chikun', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_kaduna_giwa', 'kaduna-giwa', 'Kaduna', 'Giwa', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_kaduna_igabi', 'kaduna-igabi', 'Kaduna', 'Igabi', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_kaduna_ikara', 'kaduna-ikara', 'Kaduna', 'Ikara', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_kaduna_jaba', 'kaduna-jaba', 'Kaduna', 'Jaba', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_kaduna_jema_a', 'kaduna-jema-a', 'Kaduna', 'Jema''a', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_kaduna_kachia', 'kaduna-kachia', 'Kaduna', 'Kachia', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_kaduna_kaduna_north', 'kaduna-kaduna-north', 'Kaduna', 'Kaduna North', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_kaduna_kaduna_south', 'kaduna-kaduna-south', 'Kaduna', 'Kaduna South', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_kaduna_kagarko', 'kaduna-kagarko', 'Kaduna', 'Kagarko', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_kaduna_kajuru', 'kaduna-kajuru', 'Kaduna', 'Kajuru', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_kaduna_kaura', 'kaduna-kaura', 'Kaduna', 'Kaura', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_kaduna_kauru', 'kaduna-kauru', 'Kaduna', 'Kauru', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_kaduna_kubau', 'kaduna-kubau', 'Kaduna', 'Kubau', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_kaduna_kudan', 'kaduna-kudan', 'Kaduna', 'Kudan', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_kaduna_lere', 'kaduna-lere', 'Kaduna', 'Lere', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_kaduna_makarfi', 'kaduna-makarfi', 'Kaduna', 'Makarfi', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_kaduna_sabon_gari', 'kaduna-sabon-gari', 'Kaduna', 'Sabon Gari', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_kaduna_sanga', 'kaduna-sanga', 'Kaduna', 'Sanga', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_kaduna_soba', 'kaduna-soba', 'Kaduna', 'Soba', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  ('area_kaduna_zangon_kataf', 'kaduna-zangon-kataf', 'Kaduna', 'Zangon Kataf', '{}', false, true, 21, 1, 1786600001100, 1786600001100),
  ('area_kaduna_zaria', 'kaduna-zaria', 'Kaduna', 'Zaria', '{}', false, true, 22, 1, 1786600001100, 1786600001100),
  -- Kano
  ('area_kano_ajingi', 'kano-ajingi', 'Kano', 'Ajingi', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_kano_albasu', 'kano-albasu', 'Kano', 'Albasu', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_kano_bagwai', 'kano-bagwai', 'Kano', 'Bagwai', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_kano_bebeji', 'kano-bebeji', 'Kano', 'Bebeji', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_kano_bichi', 'kano-bichi', 'Kano', 'Bichi', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_kano_bunkure', 'kano-bunkure', 'Kano', 'Bunkure', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_kano_dala', 'kano-dala', 'Kano', 'Dala', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_kano_dambatta', 'kano-dambatta', 'Kano', 'Dambatta', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_kano_dawakin_kudu', 'kano-dawakin-kudu', 'Kano', 'Dawakin Kudu', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_kano_dawakin_tofa', 'kano-dawakin-tofa', 'Kano', 'Dawakin Tofa', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_kano_doguwa', 'kano-doguwa', 'Kano', 'Doguwa', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_kano_fagge', 'kano-fagge', 'Kano', 'Fagge', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_kano_gabasawa', 'kano-gabasawa', 'Kano', 'Gabasawa', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_kano_garko', 'kano-garko', 'Kano', 'Garko', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_kano_garum_mallam', 'kano-garum-mallam', 'Kano', 'Garum Mallam', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_kano_gaya', 'kano-gaya', 'Kano', 'Gaya', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_kano_gezawa', 'kano-gezawa', 'Kano', 'Gezawa', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_kano_gwale', 'kano-gwale', 'Kano', 'Gwale', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_kano_gwarzo', 'kano-gwarzo', 'Kano', 'Gwarzo', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_kano_kabo', 'kano-kabo', 'Kano', 'Kabo', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_kano_kano_municipal', 'kano-kano-municipal', 'Kano', 'Kano Municipal', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  ('area_kano_karaye', 'kano-karaye', 'Kano', 'Karaye', '{}', false, true, 21, 1, 1786600001100, 1786600001100),
  ('area_kano_kibiya', 'kano-kibiya', 'Kano', 'Kibiya', '{}', false, true, 22, 1, 1786600001100, 1786600001100),
  ('area_kano_kiru', 'kano-kiru', 'Kano', 'Kiru', '{}', false, true, 23, 1, 1786600001100, 1786600001100),
  ('area_kano_kumbotso', 'kano-kumbotso', 'Kano', 'Kumbotso', '{}', false, true, 24, 1, 1786600001100, 1786600001100),
  ('area_kano_kunchi', 'kano-kunchi', 'Kano', 'Kunchi', '{}', false, true, 25, 1, 1786600001100, 1786600001100),
  ('area_kano_kura', 'kano-kura', 'Kano', 'Kura', '{}', false, true, 26, 1, 1786600001100, 1786600001100),
  ('area_kano_madobi', 'kano-madobi', 'Kano', 'Madobi', '{}', false, true, 27, 1, 1786600001100, 1786600001100),
  ('area_kano_makoda', 'kano-makoda', 'Kano', 'Makoda', '{}', false, true, 28, 1, 1786600001100, 1786600001100),
  ('area_kano_minjibir', 'kano-minjibir', 'Kano', 'Minjibir', '{}', false, true, 29, 1, 1786600001100, 1786600001100),
  ('area_kano_nasarawa', 'kano-nasarawa', 'Kano', 'Nasarawa', '{}', false, true, 30, 1, 1786600001100, 1786600001100),
  ('area_kano_rano', 'kano-rano', 'Kano', 'Rano', '{}', false, true, 31, 1, 1786600001100, 1786600001100),
  ('area_kano_rimin_gado', 'kano-rimin-gado', 'Kano', 'Rimin Gado', '{}', false, true, 32, 1, 1786600001100, 1786600001100),
  ('area_kano_rogo', 'kano-rogo', 'Kano', 'Rogo', '{}', false, true, 33, 1, 1786600001100, 1786600001100),
  ('area_kano_shanono', 'kano-shanono', 'Kano', 'Shanono', '{}', false, true, 34, 1, 1786600001100, 1786600001100),
  ('area_kano_sumaila', 'kano-sumaila', 'Kano', 'Sumaila', '{}', false, true, 35, 1, 1786600001100, 1786600001100),
  ('area_kano_takai', 'kano-takai', 'Kano', 'Takai', '{}', false, true, 36, 1, 1786600001100, 1786600001100),
  ('area_kano_tarauni', 'kano-tarauni', 'Kano', 'Tarauni', '{}', false, true, 37, 1, 1786600001100, 1786600001100),
  ('area_kano_tofa', 'kano-tofa', 'Kano', 'Tofa', '{}', false, true, 38, 1, 1786600001100, 1786600001100),
  ('area_kano_tsanyawa', 'kano-tsanyawa', 'Kano', 'Tsanyawa', '{}', false, true, 39, 1, 1786600001100, 1786600001100),
  ('area_kano_tundun_wada', 'kano-tundun-wada', 'Kano', 'Tundun Wada', '{}', false, true, 40, 1, 1786600001100, 1786600001100),
  ('area_kano_ungogo', 'kano-ungogo', 'Kano', 'Ungogo', '{}', false, true, 41, 1, 1786600001100, 1786600001100),
  ('area_kano_warawa', 'kano-warawa', 'Kano', 'Warawa', '{}', false, true, 42, 1, 1786600001100, 1786600001100),
  ('area_kano_wudil', 'kano-wudil', 'Kano', 'Wudil', '{}', false, true, 43, 1, 1786600001100, 1786600001100),
  -- Katsina
  ('area_katsina_bakori', 'katsina-bakori', 'Katsina', 'Bakori', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_katsina_batagarawa', 'katsina-batagarawa', 'Katsina', 'Batagarawa', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_katsina_batsari', 'katsina-batsari', 'Katsina', 'Batsari', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_katsina_baure', 'katsina-baure', 'Katsina', 'Baure', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_katsina_bindawa', 'katsina-bindawa', 'Katsina', 'Bindawa', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_katsina_charanchi', 'katsina-charanchi', 'Katsina', 'Charanchi', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_katsina_dandume', 'katsina-dandume', 'Katsina', 'Dandume', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_katsina_danja', 'katsina-danja', 'Katsina', 'Danja', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_katsina_danmusa', 'katsina-danmusa', 'Katsina', 'Danmusa', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_katsina_daura', 'katsina-daura', 'Katsina', 'Daura', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_katsina_dutsi', 'katsina-dutsi', 'Katsina', 'Dutsi', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_katsina_dutsin_m', 'katsina-dutsin-m', 'Katsina', 'Dutsin-M', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_katsina_faskari', 'katsina-faskari', 'Katsina', 'Faskari', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_katsina_funtua', 'katsina-funtua', 'Katsina', 'Funtua', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_katsina_ingawa', 'katsina-ingawa', 'Katsina', 'Ingawa', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_katsina_jibia', 'katsina-jibia', 'Katsina', 'Jibia', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_katsina_kafur', 'katsina-kafur', 'Katsina', 'Kafur', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_katsina_kaita', 'katsina-kaita', 'Katsina', 'Kaita', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_katsina_kankara', 'katsina-kankara', 'Katsina', 'Kankara', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_katsina_kankiya', 'katsina-kankiya', 'Katsina', 'Kankiya', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_katsina_katsina_k', 'katsina-katsina-k', 'Katsina', 'Katsina (K)', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  ('area_katsina_kurfi', 'katsina-kurfi', 'Katsina', 'Kurfi', '{}', false, true, 21, 1, 1786600001100, 1786600001100),
  ('area_katsina_kusada', 'katsina-kusada', 'Katsina', 'Kusada', '{}', false, true, 22, 1, 1786600001100, 1786600001100),
  ('area_katsina_mai_adua', 'katsina-mai-adua', 'Katsina', 'Mai''Adua', '{}', false, true, 23, 1, 1786600001100, 1786600001100),
  ('area_katsina_malumfashi', 'katsina-malumfashi', 'Katsina', 'Malumfashi', '{}', false, true, 24, 1, 1786600001100, 1786600001100),
  ('area_katsina_mani', 'katsina-mani', 'Katsina', 'Mani', '{}', false, true, 25, 1, 1786600001100, 1786600001100),
  ('area_katsina_mashi', 'katsina-mashi', 'Katsina', 'Mashi', '{}', false, true, 26, 1, 1786600001100, 1786600001100),
  ('area_katsina_matazu', 'katsina-matazu', 'Katsina', 'Matazu', '{}', false, true, 27, 1, 1786600001100, 1786600001100),
  ('area_katsina_musawa', 'katsina-musawa', 'Katsina', 'Musawa', '{}', false, true, 28, 1, 1786600001100, 1786600001100),
  ('area_katsina_rimi', 'katsina-rimi', 'Katsina', 'Rimi', '{}', false, true, 29, 1, 1786600001100, 1786600001100),
  ('area_katsina_sabuwa', 'katsina-sabuwa', 'Katsina', 'Sabuwa', '{}', false, true, 30, 1, 1786600001100, 1786600001100),
  ('area_katsina_safana', 'katsina-safana', 'Katsina', 'Safana', '{}', false, true, 31, 1, 1786600001100, 1786600001100),
  ('area_katsina_sandamu', 'katsina-sandamu', 'Katsina', 'Sandamu', '{}', false, true, 32, 1, 1786600001100, 1786600001100),
  ('area_katsina_zango', 'katsina-zango', 'Katsina', 'Zango', '{}', false, true, 33, 1, 1786600001100, 1786600001100),
  -- Kebbi
  ('area_kebbi_aleiro', 'kebbi-aleiro', 'Kebbi', 'Aleiro', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_kebbi_arewa', 'kebbi-arewa', 'Kebbi', 'Arewa', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_kebbi_argungu', 'kebbi-argungu', 'Kebbi', 'Argungu', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_kebbi_augie', 'kebbi-augie', 'Kebbi', 'Augie', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_kebbi_bagudo', 'kebbi-bagudo', 'Kebbi', 'Bagudo', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_kebbi_birnin_kebbi', 'kebbi-birnin-kebbi', 'Kebbi', 'Birnin Kebbi', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_kebbi_bunza', 'kebbi-bunza', 'Kebbi', 'Bunza', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_kebbi_dandi', 'kebbi-dandi', 'Kebbi', 'Dandi', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_kebbi_danko_wasagu', 'kebbi-danko-wasagu', 'Kebbi', 'Danko Wasagu', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_kebbi_fakai', 'kebbi-fakai', 'Kebbi', 'Fakai', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_kebbi_gwandu', 'kebbi-gwandu', 'Kebbi', 'Gwandu', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_kebbi_jega', 'kebbi-jega', 'Kebbi', 'Jega', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_kebbi_kalgo', 'kebbi-kalgo', 'Kebbi', 'Kalgo', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_kebbi_koko_bes', 'kebbi-koko-bes', 'Kebbi', 'Koko/Bes', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_kebbi_maiyama', 'kebbi-maiyama', 'Kebbi', 'Maiyama', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_kebbi_ngaski', 'kebbi-ngaski', 'Kebbi', 'Ngaski', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_kebbi_sakaba', 'kebbi-sakaba', 'Kebbi', 'Sakaba', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_kebbi_shanga', 'kebbi-shanga', 'Kebbi', 'Shanga', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_kebbi_suru', 'kebbi-suru', 'Kebbi', 'Suru', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_kebbi_yauri', 'kebbi-yauri', 'Kebbi', 'Yauri', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_kebbi_zuru', 'kebbi-zuru', 'Kebbi', 'Zuru', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  -- Kogi
  ('area_kogi_adavi', 'kogi-adavi', 'Kogi', 'Adavi', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_kogi_ajaokuta', 'kogi-ajaokuta', 'Kogi', 'Ajaokuta', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_kogi_ankpa', 'kogi-ankpa', 'Kogi', 'Ankpa', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_kogi_bassa', 'kogi-bassa', 'Kogi', 'Bassa', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_kogi_dekina', 'kogi-dekina', 'Kogi', 'Dekina', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_kogi_ibaji', 'kogi-ibaji', 'Kogi', 'Ibaji', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_kogi_idah', 'kogi-idah', 'Kogi', 'Idah', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_kogi_igalamela_odolu', 'kogi-igalamela-odolu', 'Kogi', 'Igalamela-Odolu', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_kogi_ijumu', 'kogi-ijumu', 'Kogi', 'Ijumu', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_kogi_kabba_bunu', 'kogi-kabba-bunu', 'Kogi', 'Kabba-Bunu', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_kogi_koton_karfe', 'kogi-koton-karfe', 'Kogi', 'Koton-Karfe', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_kogi_lokoja', 'kogi-lokoja', 'Kogi', 'Lokoja', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_kogi_mopa_muro', 'kogi-mopa-muro', 'Kogi', 'Mopa-Muro', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_kogi_ofu', 'kogi-ofu', 'Kogi', 'Ofu', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_kogi_ogori_magongo', 'kogi-ogori-magongo', 'Kogi', 'Ogori Magongo', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_kogi_okehi', 'kogi-okehi', 'Kogi', 'Okehi', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_kogi_okene', 'kogi-okene', 'Kogi', 'Okene', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_kogi_olamaboro', 'kogi-olamaboro', 'Kogi', 'Olamaboro', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_kogi_omala', 'kogi-omala', 'Kogi', 'Omala', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_kogi_yagba_east', 'kogi-yagba-east', 'Kogi', 'Yagba East', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_kogi_yagba_west', 'kogi-yagba-west', 'Kogi', 'Yagba West', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  -- Kwara
  ('area_kwara_asa', 'kwara-asa', 'Kwara', 'Asa', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_kwara_baruten', 'kwara-baruten', 'Kwara', 'Baruten', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_kwara_edu', 'kwara-edu', 'Kwara', 'Edu', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_kwara_ekiti', 'kwara-ekiti', 'Kwara', 'Ekiti', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_kwara_ifelodun', 'kwara-ifelodun', 'Kwara', 'Ifelodun', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_kwara_ilorin_east', 'kwara-ilorin-east', 'Kwara', 'Ilorin East', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_kwara_ilorin_south', 'kwara-ilorin-south', 'Kwara', 'Ilorin South', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_kwara_ilorin_west', 'kwara-ilorin-west', 'Kwara', 'Ilorin West', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_kwara_irepodun', 'kwara-irepodun', 'Kwara', 'Irepodun', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_kwara_isin', 'kwara-isin', 'Kwara', 'Isin', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_kwara_kaiama', 'kwara-kaiama', 'Kwara', 'Kaiama', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_kwara_moro', 'kwara-moro', 'Kwara', 'Moro', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_kwara_offa', 'kwara-offa', 'Kwara', 'Offa', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_kwara_oke_ero', 'kwara-oke-ero', 'Kwara', 'Oke-Ero', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_kwara_oyun', 'kwara-oyun', 'Kwara', 'Oyun', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_kwara_pategi', 'kwara-pategi', 'Kwara', 'Pategi', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  -- Lagos
  ('area_lagos_agege', 'lagos-agege', 'Lagos', 'Agege', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_lagos_ajeromi_ifelodun', 'lagos-ajeromi-ifelodun', 'Lagos', 'Ajeromi/Ifelodun', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_lagos_alimosho', 'lagos-alimosho', 'Lagos', 'Alimosho', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_lagos_amuwo_odofin', 'lagos-amuwo-odofin', 'Lagos', 'Amuwo Odofin', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_lagos_apapa', 'lagos-apapa', 'Lagos', 'Apapa', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_lagos_badagary', 'lagos-badagary', 'Lagos', 'Badagary', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_lagos_epe', 'lagos-epe', 'Lagos', 'Epe', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_lagos_eti_osa', 'lagos-eti-osa', 'Lagos', 'Eti-Osa', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_lagos_ibeju_lekki', 'lagos-ibeju-lekki', 'Lagos', 'Ibeju/Lekki', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_lagos_ifako_ijaye', 'lagos-ifako-ijaye', 'Lagos', 'Ifako/Ijaye', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_lagos_ikeja', 'lagos-ikeja', 'Lagos', 'Ikeja', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_lagos_ikorodu', 'lagos-ikorodu', 'Lagos', 'Ikorodu', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_lagos_kosofe', 'lagos-kosofe', 'Lagos', 'Kosofe', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_lagos_lagos_island', 'lagos-lagos-island', 'Lagos', 'Lagos Island', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_lagos_lagos_mainland', 'lagos-lagos-mainland', 'Lagos', 'Lagos Mainland', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_lagos_mushin', 'lagos-mushin', 'Lagos', 'Mushin', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_lagos_ojo', 'lagos-ojo', 'Lagos', 'Ojo', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_lagos_oshodi_isolo', 'lagos-oshodi-isolo', 'Lagos', 'Oshodi/Isolo', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_lagos_shomolu', 'lagos-shomolu', 'Lagos', 'Shomolu', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_lagos_surulere', 'lagos-surulere', 'Lagos', 'Surulere', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  -- Nassarawa
  ('area_nassarawa_akwanga', 'nassarawa-akwanga', 'Nassarawa', 'Akwanga', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_nassarawa_awe', 'nassarawa-awe', 'Nassarawa', 'Awe', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_nassarawa_doma', 'nassarawa-doma', 'Nassarawa', 'Doma', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_nassarawa_karu', 'nassarawa-karu', 'Nassarawa', 'Karu', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_nassarawa_keana', 'nassarawa-keana', 'Nassarawa', 'Keana', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_nassarawa_keffi', 'nassarawa-keffi', 'Nassarawa', 'Keffi', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_nassarawa_kokona', 'nassarawa-kokona', 'Nassarawa', 'Kokona', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_nassarawa_lafia', 'nassarawa-lafia', 'Nassarawa', 'Lafia', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_nassarawa_nasarawa', 'nassarawa-nasarawa', 'Nassarawa', 'Nasarawa', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_nassarawa_nassarawa_egon', 'nassarawa-nassarawa-egon', 'Nassarawa', 'Nassarawa Egon', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_nassarawa_obi', 'nassarawa-obi', 'Nassarawa', 'Obi', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_nassarawa_toto', 'nassarawa-toto', 'Nassarawa', 'Toto', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_nassarawa_wamba', 'nassarawa-wamba', 'Nassarawa', 'Wamba', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  -- Niger
  ('area_niger_agaie', 'niger-agaie', 'Niger', 'Agaie', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_niger_agwara', 'niger-agwara', 'Niger', 'Agwara', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_niger_bida', 'niger-bida', 'Niger', 'Bida', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_niger_borgu', 'niger-borgu', 'Niger', 'Borgu', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_niger_bosso', 'niger-bosso', 'Niger', 'Bosso', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_niger_chanchaga', 'niger-chanchaga', 'Niger', 'Chanchaga', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_niger_edati', 'niger-edati', 'Niger', 'Edati', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_niger_gbako', 'niger-gbako', 'Niger', 'Gbako', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_niger_gurara', 'niger-gurara', 'Niger', 'Gurara', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_niger_katcha', 'niger-katcha', 'Niger', 'Katcha', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_niger_kontogur', 'niger-kontogur', 'Niger', 'Kontogur', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_niger_lapai', 'niger-lapai', 'Niger', 'Lapai', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_niger_lavun', 'niger-lavun', 'Niger', 'Lavun', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_niger_magama', 'niger-magama', 'Niger', 'Magama', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_niger_mariga', 'niger-mariga', 'Niger', 'Mariga', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_niger_mashegu', 'niger-mashegu', 'Niger', 'Mashegu', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_niger_mokwa', 'niger-mokwa', 'Niger', 'Mokwa', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_niger_muya', 'niger-muya', 'Niger', 'Muya', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_niger_paikoro', 'niger-paikoro', 'Niger', 'Paikoro', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_niger_rafi', 'niger-rafi', 'Niger', 'Rafi', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_niger_rijau', 'niger-rijau', 'Niger', 'Rijau', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  ('area_niger_shiroro', 'niger-shiroro', 'Niger', 'Shiroro', '{}', false, true, 21, 1, 1786600001100, 1786600001100),
  ('area_niger_suleja', 'niger-suleja', 'Niger', 'Suleja', '{}', false, true, 22, 1, 1786600001100, 1786600001100),
  ('area_niger_tafa', 'niger-tafa', 'Niger', 'Tafa', '{}', false, true, 23, 1, 1786600001100, 1786600001100),
  ('area_niger_wushishi', 'niger-wushishi', 'Niger', 'Wushishi', '{}', false, true, 24, 1, 1786600001100, 1786600001100),
  -- Ogun
  ('area_ogun_abeokuta_north', 'ogun-abeokuta-north', 'Ogun', 'Abeokuta North', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_ogun_abeokuta_south', 'ogun-abeokuta-south', 'Ogun', 'Abeokuta South', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_ogun_ado_odo_ota', 'ogun-ado-odo-ota', 'Ogun', 'Ado Odo-Ota', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_ogun_egbado_north', 'ogun-egbado-north', 'Ogun', 'Egbado North', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_ogun_egbado_south', 'ogun-egbado-south', 'Ogun', 'Egbado South', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_ogun_ewekoro', 'ogun-ewekoro', 'Ogun', 'Ewekoro', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_ogun_ifo', 'ogun-ifo', 'Ogun', 'Ifo', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_ogun_ijebu_east', 'ogun-ijebu-east', 'Ogun', 'Ijebu East', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_ogun_ijebu_north', 'ogun-ijebu-north', 'Ogun', 'Ijebu North', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_ogun_ijebu_north_east', 'ogun-ijebu-north-east', 'Ogun', 'Ijebu North-East', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_ogun_ijebu_ode', 'ogun-ijebu-ode', 'Ogun', 'Ijebu-Ode', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_ogun_ikenne', 'ogun-ikenne', 'Ogun', 'Ikenne', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_ogun_imeko_afon', 'ogun-imeko-afon', 'Ogun', 'Imeko-Afon', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_ogun_ipokia', 'ogun-ipokia', 'Ogun', 'Ipokia', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_ogun_obafemi_owode', 'ogun-obafemi-owode', 'Ogun', 'Obafemi-Owode', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_ogun_odeda', 'ogun-odeda', 'Ogun', 'Odeda', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_ogun_odogbolu', 'ogun-odogbolu', 'Ogun', 'Odogbolu', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_ogun_ogun_waterside', 'ogun-ogun-waterside', 'Ogun', 'Ogun Waterside', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_ogun_remo_north', 'ogun-remo-north', 'Ogun', 'Remo North', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_ogun_shagamu', 'ogun-shagamu', 'Ogun', 'Shagamu', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  -- Ondo
  ('area_ondo_akoko_north_east', 'ondo-akoko-north-east', 'Ondo', 'Akoko North-East', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_ondo_akoko_south_east', 'ondo-akoko-south-east', 'Ondo', 'Akoko South-East', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_ondo_akoko_south_west', 'ondo-akoko-south-west', 'Ondo', 'Akoko South-West', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_ondo_akokonorthwest', 'ondo-akokonorthwest', 'Ondo', 'AkokoNorthWest', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_ondo_akure_north', 'ondo-akure-north', 'Ondo', 'Akure North', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_ondo_akure_south', 'ondo-akure-south', 'Ondo', 'Akure South', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_ondo_ese_odo', 'ondo-ese-odo', 'Ondo', 'Ese-Odo', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_ondo_idanre', 'ondo-idanre', 'Ondo', 'Idanre', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_ondo_ifedore', 'ondo-ifedore', 'Ondo', 'Ifedore', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_ondo_ilaje', 'ondo-ilaje', 'Ondo', 'Ilaje', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_ondo_ileoluji_okeigbo', 'ondo-ileoluji-okeigbo', 'Ondo', 'IleOluji/Okeigbo', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_ondo_irele', 'ondo-irele', 'Ondo', 'Irele', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_ondo_odigbo', 'ondo-odigbo', 'Ondo', 'Odigbo', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_ondo_okitipupa', 'ondo-okitipupa', 'Ondo', 'Okitipupa', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_ondo_ondo_east', 'ondo-ondo-east', 'Ondo', 'Ondo East', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_ondo_ondo_west', 'ondo-ondo-west', 'Ondo', 'Ondo West', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_ondo_ose', 'ondo-ose', 'Ondo', 'Ose', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_ondo_owo', 'ondo-owo', 'Ondo', 'Owo', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  -- Osun
  ('area_osun_atakumosa_east', 'osun-atakumosa-east', 'Osun', 'Atakumosa East', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_osun_atakumosa_west', 'osun-atakumosa-west', 'Osun', 'Atakumosa West', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_osun_ayedaade', 'osun-ayedaade', 'Osun', 'Ayedaade', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_osun_ayedire', 'osun-ayedire', 'Osun', 'Ayedire', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_osun_boluwaduro', 'osun-boluwaduro', 'Osun', 'Boluwaduro', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_osun_boripe', 'osun-boripe', 'Osun', 'Boripe', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_osun_ede_north', 'osun-ede-north', 'Osun', 'Ede North', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_osun_ede_south', 'osun-ede-south', 'Osun', 'Ede South', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_osun_egbedore', 'osun-egbedore', 'Osun', 'Egbedore', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_osun_ejigbo', 'osun-ejigbo', 'Osun', 'Ejigbo', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_osun_ife_east', 'osun-ife-east', 'Osun', 'Ife East', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_osun_ife_north', 'osun-ife-north', 'Osun', 'Ife North', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_osun_ife_south', 'osun-ife-south', 'Osun', 'Ife South', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_osun_ifecentral', 'osun-ifecentral', 'Osun', 'IfeCentral', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_osun_ifedayo', 'osun-ifedayo', 'Osun', 'Ifedayo', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_osun_ifelodun', 'osun-ifelodun', 'Osun', 'Ifelodun', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_osun_ila', 'osun-ila', 'Osun', 'Ila', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_osun_ilesha_east', 'osun-ilesha-east', 'Osun', 'Ilesha East', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_osun_ilesha_west', 'osun-ilesha-west', 'Osun', 'Ilesha West', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_osun_irepodun', 'osun-irepodun', 'Osun', 'Irepodun', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_osun_irewole', 'osun-irewole', 'Osun', 'Irewole', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  ('area_osun_isokan', 'osun-isokan', 'Osun', 'Isokan', '{}', false, true, 21, 1, 1786600001100, 1786600001100),
  ('area_osun_iwo', 'osun-iwo', 'Osun', 'Iwo', '{}', false, true, 22, 1, 1786600001100, 1786600001100),
  ('area_osun_obokun', 'osun-obokun', 'Osun', 'Obokun', '{}', false, true, 23, 1, 1786600001100, 1786600001100),
  ('area_osun_odo_otin', 'osun-odo-otin', 'Osun', 'Odo Otin', '{}', false, true, 24, 1, 1786600001100, 1786600001100),
  ('area_osun_ola_oluwa', 'osun-ola-oluwa', 'Osun', 'Ola-Oluwa', '{}', false, true, 25, 1, 1786600001100, 1786600001100),
  ('area_osun_olorunda', 'osun-olorunda', 'Osun', 'Olorunda', '{}', false, true, 26, 1, 1786600001100, 1786600001100),
  ('area_osun_oriade', 'osun-oriade', 'Osun', 'Oriade', '{}', false, true, 27, 1, 1786600001100, 1786600001100),
  ('area_osun_orolu', 'osun-orolu', 'Osun', 'Orolu', '{}', false, true, 28, 1, 1786600001100, 1786600001100),
  ('area_osun_osogbo', 'osun-osogbo', 'Osun', 'Osogbo', '{}', false, true, 29, 1, 1786600001100, 1786600001100),
  -- Oyo
  ('area_oyo_afijio', 'oyo-afijio', 'Oyo', 'Afijio', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_oyo_akinyele', 'oyo-akinyele', 'Oyo', 'Akinyele', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_oyo_atiba', 'oyo-atiba', 'Oyo', 'Atiba', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_oyo_atisbo', 'oyo-atisbo', 'Oyo', 'Atisbo', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_oyo_egbeda', 'oyo-egbeda', 'Oyo', 'Egbeda', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_oyo_ibadan_north', 'oyo-ibadan-north', 'Oyo', 'Ibadan North', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_oyo_ibadan_north_east', 'oyo-ibadan-north-east', 'Oyo', 'Ibadan North East', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_oyo_ibadan_north_west', 'oyo-ibadan-north-west', 'Oyo', 'Ibadan North West', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_oyo_ibadan_south_east', 'oyo-ibadan-south-east', 'Oyo', 'Ibadan South East', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_oyo_ibadan_south_west', 'oyo-ibadan-south-west', 'Oyo', 'Ibadan South West', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_oyo_ibarapa_central', 'oyo-ibarapa-central', 'Oyo', 'Ibarapa Central', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_oyo_ibarapa_east', 'oyo-ibarapa-east', 'Oyo', 'Ibarapa East', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_oyo_ibarapa_north', 'oyo-ibarapa-north', 'Oyo', 'Ibarapa North', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_oyo_ido', 'oyo-ido', 'Oyo', 'Ido', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_oyo_irepo', 'oyo-irepo', 'Oyo', 'Irepo', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_oyo_iseyin', 'oyo-iseyin', 'Oyo', 'Iseyin', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_oyo_itesiwaju', 'oyo-itesiwaju', 'Oyo', 'Itesiwaju', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_oyo_iwajowa', 'oyo-iwajowa', 'Oyo', 'Iwajowa', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_oyo_kajola', 'oyo-kajola', 'Oyo', 'Kajola', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_oyo_lagelu', 'oyo-lagelu', 'Oyo', 'Lagelu', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_oyo_ogbomosho_north', 'oyo-ogbomosho-north', 'Oyo', 'Ogbomosho North', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  ('area_oyo_ogbomosho_south', 'oyo-ogbomosho-south', 'Oyo', 'Ogbomosho South', '{}', false, true, 21, 1, 1786600001100, 1786600001100),
  ('area_oyo_ogo_oluwa', 'oyo-ogo-oluwa', 'Oyo', 'Ogo-Oluwa', '{}', false, true, 22, 1, 1786600001100, 1786600001100),
  ('area_oyo_olorunsogo', 'oyo-olorunsogo', 'Oyo', 'Olorunsogo', '{}', false, true, 23, 1, 1786600001100, 1786600001100),
  ('area_oyo_oluyole', 'oyo-oluyole', 'Oyo', 'Oluyole', '{}', false, true, 24, 1, 1786600001100, 1786600001100),
  ('area_oyo_ona_ara', 'oyo-ona-ara', 'Oyo', 'Ona-Ara', '{}', false, true, 25, 1, 1786600001100, 1786600001100),
  ('area_oyo_orelope', 'oyo-orelope', 'Oyo', 'Orelope', '{}', false, true, 26, 1, 1786600001100, 1786600001100),
  ('area_oyo_ori_ire', 'oyo-ori-ire', 'Oyo', 'Ori-Ire', '{}', false, true, 27, 1, 1786600001100, 1786600001100),
  ('area_oyo_oyo_east', 'oyo-oyo-east', 'Oyo', 'Oyo East', '{}', false, true, 28, 1, 1786600001100, 1786600001100),
  ('area_oyo_oyo_west', 'oyo-oyo-west', 'Oyo', 'Oyo West', '{}', false, true, 29, 1, 1786600001100, 1786600001100),
  ('area_oyo_saki_east', 'oyo-saki-east', 'Oyo', 'Saki East', '{}', false, true, 30, 1, 1786600001100, 1786600001100),
  ('area_oyo_saki_west', 'oyo-saki-west', 'Oyo', 'Saki West', '{}', false, true, 31, 1, 1786600001100, 1786600001100),
  ('area_oyo_surulere', 'oyo-surulere', 'Oyo', 'Surulere', '{}', false, true, 32, 1, 1786600001100, 1786600001100),
  -- Plateau
  ('area_plateau_barkin_ladi', 'plateau-barkin-ladi', 'Plateau', 'Barkin Ladi', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_plateau_bassa', 'plateau-bassa', 'Plateau', 'Bassa', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_plateau_bokkos', 'plateau-bokkos', 'Plateau', 'Bokkos', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_plateau_jos_east', 'plateau-jos-east', 'Plateau', 'Jos East', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_plateau_jos_north', 'plateau-jos-north', 'Plateau', 'Jos North', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_plateau_jos_south', 'plateau-jos-south', 'Plateau', 'Jos South', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_plateau_kanam', 'plateau-kanam', 'Plateau', 'Kanam', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_plateau_kanke', 'plateau-kanke', 'Plateau', 'Kanke', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_plateau_langtang_north', 'plateau-langtang-north', 'Plateau', 'Langtang North', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_plateau_langtang_south', 'plateau-langtang-south', 'Plateau', 'Langtang South', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_plateau_mangu', 'plateau-mangu', 'Plateau', 'Mangu', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_plateau_mikang', 'plateau-mikang', 'Plateau', 'Mikang', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_plateau_pankshin', 'plateau-pankshin', 'Plateau', 'Pankshin', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_plateau_qua_anpa', 'plateau-qua-anpa', 'Plateau', 'Qua''anpa', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_plateau_riyom', 'plateau-riyom', 'Plateau', 'Riyom', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_plateau_shendam', 'plateau-shendam', 'Plateau', 'Shendam', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_plateau_wase', 'plateau-wase', 'Plateau', 'Wase', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  -- Rivers
  ('area_rivers_abua_odu', 'rivers-abua-odu', 'Rivers', 'Abua/Odu', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_rivers_ahoada_east', 'rivers-ahoada-east', 'Rivers', 'Ahoada East', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_rivers_ahoada_west', 'rivers-ahoada-west', 'Rivers', 'Ahoada West', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_rivers_akukutor', 'rivers-akukutor', 'Rivers', 'Akukutor', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_rivers_andoni_odual', 'rivers-andoni-odual', 'Rivers', 'Andoni/Odual', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_rivers_asari_toru', 'rivers-asari-toru', 'Rivers', 'Asari-Toru', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_rivers_bonny', 'rivers-bonny', 'Rivers', 'Bonny', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_rivers_degema', 'rivers-degema', 'Rivers', 'Degema', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_rivers_eleme', 'rivers-eleme', 'Rivers', 'Eleme', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_rivers_emuoha', 'rivers-emuoha', 'Rivers', 'Emuoha', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_rivers_etche', 'rivers-etche', 'Rivers', 'Etche', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_rivers_gokana', 'rivers-gokana', 'Rivers', 'Gokana', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_rivers_ikwerre', 'rivers-ikwerre', 'Rivers', 'Ikwerre', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_rivers_khana', 'rivers-khana', 'Rivers', 'Khana', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_rivers_obio_akpor', 'rivers-obio-akpor', 'Rivers', 'Obio/Akpor', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_rivers_ogba_egbema_andoni', 'rivers-ogba-egbema-andoni', 'Rivers', 'Ogba/Egbema/Andoni', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_rivers_ogu_bolo', 'rivers-ogu-bolo', 'Rivers', 'Ogu/Bolo', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_rivers_okrika', 'rivers-okrika', 'Rivers', 'Okrika', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_rivers_omumma', 'rivers-omumma', 'Rivers', 'Omumma', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_rivers_opobo_nkoro', 'rivers-opobo-nkoro', 'Rivers', 'Opobo/Nkoro', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_rivers_oyigbo', 'rivers-oyigbo', 'Rivers', 'Oyigbo', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  ('area_rivers_port_harcourt', 'rivers-port-harcourt', 'Rivers', 'Port Harcourt', '{}', false, true, 21, 1, 1786600001100, 1786600001100),
  ('area_rivers_tai', 'rivers-tai', 'Rivers', 'Tai', '{}', false, true, 22, 1, 1786600001100, 1786600001100),
  -- Sokoto
  ('area_sokoto_binji', 'sokoto-binji', 'Sokoto', 'Binji', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_sokoto_bodinga', 'sokoto-bodinga', 'Sokoto', 'Bodinga', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_sokoto_dange_shuni', 'sokoto-dange-shuni', 'Sokoto', 'Dange-Shuni', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_sokoto_gada', 'sokoto-gada', 'Sokoto', 'Gada', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_sokoto_goronyo', 'sokoto-goronyo', 'Sokoto', 'Goronyo', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_sokoto_gudu', 'sokoto-gudu', 'Sokoto', 'Gudu', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_sokoto_gwadabaw', 'sokoto-gwadabaw', 'Sokoto', 'Gwadabaw', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_sokoto_illela', 'sokoto-illela', 'Sokoto', 'Illela', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_sokoto_isa', 'sokoto-isa', 'Sokoto', 'Isa', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_sokoto_kebbe', 'sokoto-kebbe', 'Sokoto', 'Kebbe', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_sokoto_kware', 'sokoto-kware', 'Sokoto', 'Kware', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_sokoto_rabah', 'sokoto-rabah', 'Sokoto', 'Rabah', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_sokoto_sabon_birni', 'sokoto-sabon-birni', 'Sokoto', 'Sabon Birni', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_sokoto_shagari', 'sokoto-shagari', 'Sokoto', 'Shagari', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_sokoto_silame', 'sokoto-silame', 'Sokoto', 'Silame', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_sokoto_sokoto_north', 'sokoto-sokoto-north', 'Sokoto', 'Sokoto North', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_sokoto_sokoto_south', 'sokoto-sokoto-south', 'Sokoto', 'Sokoto South', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  ('area_sokoto_tambawal', 'sokoto-tambawal', 'Sokoto', 'Tambawal', '{}', false, true, 17, 1, 1786600001100, 1786600001100),
  ('area_sokoto_tangazar', 'sokoto-tangazar', 'Sokoto', 'Tangazar', '{}', false, true, 18, 1, 1786600001100, 1786600001100),
  ('area_sokoto_tureta', 'sokoto-tureta', 'Sokoto', 'Tureta', '{}', false, true, 19, 1, 1786600001100, 1786600001100),
  ('area_sokoto_wamakko', 'sokoto-wamakko', 'Sokoto', 'Wamakko', '{}', false, true, 20, 1, 1786600001100, 1786600001100),
  ('area_sokoto_wurno', 'sokoto-wurno', 'Sokoto', 'Wurno', '{}', false, true, 21, 1, 1786600001100, 1786600001100),
  ('area_sokoto_yabo', 'sokoto-yabo', 'Sokoto', 'Yabo', '{}', false, true, 22, 1, 1786600001100, 1786600001100),
  -- Taraba
  ('area_taraba_ardo_kola', 'taraba-ardo-kola', 'Taraba', 'Ardo-Kola', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_taraba_bali', 'taraba-bali', 'Taraba', 'Bali', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_taraba_donga', 'taraba-donga', 'Taraba', 'Donga', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_taraba_gashaka', 'taraba-gashaka', 'Taraba', 'Gashaka', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_taraba_gassol', 'taraba-gassol', 'Taraba', 'Gassol', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_taraba_ibi', 'taraba-ibi', 'Taraba', 'Ibi', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_taraba_jalingo', 'taraba-jalingo', 'Taraba', 'Jalingo', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_taraba_karim_lamido', 'taraba-karim-lamido', 'Taraba', 'Karim-Lamido', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_taraba_kurmi', 'taraba-kurmi', 'Taraba', 'Kurmi', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_taraba_lau', 'taraba-lau', 'Taraba', 'Lau', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_taraba_sardauna', 'taraba-sardauna', 'Taraba', 'Sardauna', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_taraba_takum', 'taraba-takum', 'Taraba', 'Takum', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_taraba_ussa', 'taraba-ussa', 'Taraba', 'Ussa', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_taraba_wukari', 'taraba-wukari', 'Taraba', 'Wukari', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_taraba_yorro', 'taraba-yorro', 'Taraba', 'Yorro', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_taraba_zing', 'taraba-zing', 'Taraba', 'Zing', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  -- Yobe
  ('area_yobe_bade', 'yobe-bade', 'Yobe', 'Bade', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_yobe_borsari', 'yobe-borsari', 'Yobe', 'Borsari', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_yobe_damaturu', 'yobe-damaturu', 'Yobe', 'Damaturu', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_yobe_fika', 'yobe-fika', 'Yobe', 'Fika', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_yobe_fune', 'yobe-fune', 'Yobe', 'Fune', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_yobe_geidam', 'yobe-geidam', 'Yobe', 'Geidam', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_yobe_gujba', 'yobe-gujba', 'Yobe', 'Gujba', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_yobe_gulani', 'yobe-gulani', 'Yobe', 'Gulani', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_yobe_jakusko', 'yobe-jakusko', 'Yobe', 'Jakusko', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_yobe_karasuwa', 'yobe-karasuwa', 'Yobe', 'Karasuwa', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_yobe_machina', 'yobe-machina', 'Yobe', 'Machina', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_yobe_nangere', 'yobe-nangere', 'Yobe', 'Nangere', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_yobe_nguru', 'yobe-nguru', 'Yobe', 'Nguru', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_yobe_potiskum', 'yobe-potiskum', 'Yobe', 'Potiskum', '{}', false, true, 13, 1, 1786600001100, 1786600001100),
  ('area_yobe_tarmuwa', 'yobe-tarmuwa', 'Yobe', 'Tarmuwa', '{}', false, true, 14, 1, 1786600001100, 1786600001100),
  ('area_yobe_yunusari', 'yobe-yunusari', 'Yobe', 'Yunusari', '{}', false, true, 15, 1, 1786600001100, 1786600001100),
  ('area_yobe_yusufari', 'yobe-yusufari', 'Yobe', 'Yusufari', '{}', false, true, 16, 1, 1786600001100, 1786600001100),
  -- Zamfara
  ('area_zamfara_anka', 'zamfara-anka', 'Zamfara', 'Anka', '{}', false, true, 0, 1, 1786600001100, 1786600001100),
  ('area_zamfara_bakura', 'zamfara-bakura', 'Zamfara', 'Bakura', '{}', false, true, 1, 1, 1786600001100, 1786600001100),
  ('area_zamfara_birnin_magaji', 'zamfara-birnin-magaji', 'Zamfara', 'Birnin Magaji', '{}', false, true, 2, 1, 1786600001100, 1786600001100),
  ('area_zamfara_bukkuyum', 'zamfara-bukkuyum', 'Zamfara', 'Bukkuyum', '{}', false, true, 3, 1, 1786600001100, 1786600001100),
  ('area_zamfara_bungudu', 'zamfara-bungudu', 'Zamfara', 'Bungudu', '{}', false, true, 4, 1, 1786600001100, 1786600001100),
  ('area_zamfara_gummi', 'zamfara-gummi', 'Zamfara', 'Gummi', '{}', false, true, 5, 1, 1786600001100, 1786600001100),
  ('area_zamfara_gusau', 'zamfara-gusau', 'Zamfara', 'Gusau', '{}', false, true, 6, 1, 1786600001100, 1786600001100),
  ('area_zamfara_kaura_namoda', 'zamfara-kaura-namoda', 'Zamfara', 'Kaura-Namoda', '{}', false, true, 7, 1, 1786600001100, 1786600001100),
  ('area_zamfara_maradun', 'zamfara-maradun', 'Zamfara', 'Maradun', '{}', false, true, 8, 1, 1786600001100, 1786600001100),
  ('area_zamfara_maru', 'zamfara-maru', 'Zamfara', 'Maru', '{}', false, true, 9, 1, 1786600001100, 1786600001100),
  ('area_zamfara_shinkafi', 'zamfara-shinkafi', 'Zamfara', 'Shinkafi', '{}', false, true, 10, 1, 1786600001100, 1786600001100),
  ('area_zamfara_talata_mafara', 'zamfara-talata-mafara', 'Zamfara', 'Talata-Mafara', '{}', false, true, 11, 1, 1786600001100, 1786600001100),
  ('area_zamfara_tsafe', 'zamfara-tsafe', 'Zamfara', 'Tsafe', '{}', false, true, 12, 1, 1786600001100, 1786600001100),
  ('area_zamfara_zurmi', 'zamfara-zurmi', 'Zamfara', 'Zurmi', '{}', false, true, 13, 1, 1786600001100, 1786600001100)
ON CONFLICT DO NOTHING;
-- <<< generated
