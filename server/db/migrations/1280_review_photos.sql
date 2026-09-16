-- REVIEW PHOTOS (range 1280-1299; owner's request 2026-09-16).
--
-- HAND-WRITTEN, like every commerce migration. Declared in
-- server/shop/reviews/schema.ts.
--
-- A customer uploads a photo BEFORE the review exists (the storefront shows it
-- in the form while they type), so review_id is NULL until the submit attaches
-- it. uploader_key says who may attach it: 'cus:<customer id>' for a signed-in
-- shopper, 'ord:<order id>' for somebody writing through a review link. A photo
-- that is never attached stays unattached and is never served to anyone.
--
-- A photo is public ONLY while its review is approved. That is decided when it
-- is served, from this table, and not stored on the row, so turning a review
-- down takes its photos down in the same moment.
--
-- The bytes live in R2 under reviews/, a prefix the blog's image collector
-- never looks at: that collector works from the images table, and these are
-- not in it.
CREATE TABLE shop_review_photos (
  id text PRIMARY KEY,
  review_id text REFERENCES shop_reviews(id) ON DELETE CASCADE,
  uploader_key text NOT NULL,
  storage_key text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL,
  width integer,
  height integer,
  position integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  CONSTRAINT shop_review_photos_storage_key_uq UNIQUE (storage_key),
  CONSTRAINT shop_review_photos_type_ck CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT shop_review_photos_size_ck CHECK (byte_size > 0),
  CONSTRAINT shop_review_photos_position_ck CHECK (position BETWEEN 0 AND 3),
  CONSTRAINT shop_review_photos_uploader_ck CHECK (uploader_key ~ '^(cus|ord):.+$')
);--> statement-breakpoint
CREATE INDEX shop_review_photos_review_idx ON shop_review_photos (review_id, position);--> statement-breakpoint
CREATE INDEX shop_review_photos_uploader_idx ON shop_review_photos (uploader_key, created_at);
