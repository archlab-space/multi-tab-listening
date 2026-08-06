-- Backfill before constraining. drizzle-kit generates the ALTER COLUMN lines
-- alone, which abort the whole migration if a single legacy row holds a null.
-- The values below are the ones the observer already substitutes when it
-- cannot read a field, so a backfilled row is indistinguishable from one
-- written today.
UPDATE "messages" SET "author_id" = 'unknown' WHERE "author_id" IS NULL;--> statement-breakpoint
UPDATE "messages" SET "author_name" = 'unknown' WHERE "author_name" IS NULL;--> statement-breakpoint
UPDATE "messages" SET "content" = '' WHERE "content" IS NULL;--> statement-breakpoint
-- No substitute for a missing timestamp is truthful, so prefer created_at:
-- when the row was written is the closest thing to when it was observed.
UPDATE "messages" SET "timestamp" = COALESCE("created_at", now()) WHERE "timestamp" IS NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "author_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "author_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "content" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "timestamp" SET NOT NULL;
