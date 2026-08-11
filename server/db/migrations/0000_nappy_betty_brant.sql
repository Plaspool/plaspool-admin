CREATE TABLE "auth_attempts" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" bigint NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "images" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"byte_size" integer NOT NULL,
	"checksum" text,
	"created_at" bigint NOT NULL,
	"committed_at" bigint,
	CONSTRAINT "images_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" uuid NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"accepted_at" bigint,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invites_role_ck" CHECK ("invites"."role" IN ('owner', 'writer'))
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"subtitle" text NOT NULL,
	"slug" text,
	"excerpt" text NOT NULL,
	"excerpt_source" text NOT NULL,
	"content" jsonb NOT NULL,
	"content_text" text NOT NULL,
	"cover_image" jsonb,
	"category" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"published_at" bigint,
	"deleted_at" bigint,
	"word_count" integer NOT NULL,
	"reading_time" integer NOT NULL,
	"author_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "posts_slug_unique" UNIQUE("slug"),
	CONSTRAINT "posts_status_ck" CHECK ("posts"."status" IN ('draft', 'published', 'archived')),
	CONSTRAINT "posts_excerpt_source_ck" CHECK ("posts"."excerpt_source" IN ('derived', 'author')),
	CONSTRAINT "posts_revision_ck" CHECK ("posts"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"revision" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"author_id" uuid NOT NULL,
	"title" text NOT NULL,
	"subtitle" text NOT NULL,
	"content" jsonb NOT NULL,
	"word_count" integer NOT NULL,
	"kind" text NOT NULL,
	"note" text,
	CONSTRAINT "revisions_revision_ck" CHECK ("revisions"."revision" > 0),
	CONSTRAINT "revisions_kind_ck" CHECK ("revisions"."kind" IN ('autosave', 'manual', 'publish', 'status'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text NOT NULL,
	"created_at" bigint NOT NULL,
	"disabled_at" bigint,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_role_ck" CHECK ("users"."role" IN ('owner', 'writer'))
);
--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "images_owner_idx" ON "images" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "images_committed_idx" ON "images" USING btree ("committed_at");--> statement-breakpoint
CREATE INDEX "posts_status_updated_idx" ON "posts" USING btree ("status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_deleted_idx" ON "posts" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "posts_author_idx" ON "posts" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "posts_category_idx" ON "posts" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "revisions_post_revision_uq" ON "revisions" USING btree ("post_id","revision");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE FUNCTION tags_text(text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT array_to_string($1, ' ') $$;
--> statement-breakpoint
ALTER TABLE posts ADD COLUMN search tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(subtitle,'')), 'B') ||
    setweight(to_tsvector('english', coalesce(excerpt,'')), 'B') ||
    setweight(to_tsvector('english', coalesce(category,'')), 'C') ||
    setweight(to_tsvector('english', tags_text(coalesce(tags,'{}'::text[]))), 'C') ||
    setweight(to_tsvector('english', coalesce(content_text,'')), 'D')
  ) STORED;
--> statement-breakpoint
CREATE INDEX posts_search_idx ON posts USING GIN (search);
--> statement-breakpoint
CREATE INDEX posts_tags_idx ON posts USING GIN (tags);
