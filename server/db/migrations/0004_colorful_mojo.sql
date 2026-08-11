ALTER TABLE "images" ALTER COLUMN "width" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "images" ALTER COLUMN "height" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "unreferenced_since" bigint;--> statement-breakpoint
CREATE INDEX "images_unreferenced_idx" ON "images" USING btree ("unreferenced_since");