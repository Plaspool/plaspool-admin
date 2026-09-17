-- The owner's margin on the daily rate, STORED (1140 follow-up).
--
-- Rates now refresh on their own (the sweep), so a margin that lived only in
-- a script flag would be silently dropped by the next automatic refresh. It is
-- baked into each multiplier as it is written, so the published number is
-- still the charged number and nothing downstream adds anything. 0 = no margin.
-- Changing it moves no number by itself; the refresh it triggers does, and
-- that write moves the revision.
ALTER TABLE shop_currency_settings
  ADD COLUMN feed_margin_bps integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT shop_currency_settings_margin_ck CHECK (feed_margin_bps BETWEEN 0 AND 5000);
