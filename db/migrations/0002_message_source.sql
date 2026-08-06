-- Add the column nullable, fill it, then constrain. drizzle-kit generates a
-- single NOT NULL ADD COLUMN, which Postgres rejects on a non-empty table
-- when there is no default — and a default is exactly what this column must
-- not have, so that omitting it is a compile error rather than a silent
-- mislabelling.
ALTER TABLE "messages" ADD COLUMN "source" varchar(20);--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "source" varchar(20);--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "source" varchar(20);--> statement-breakpoint
-- Every row that predates this column came from the only source there was.
UPDATE "messages" SET "source" = 'discord' WHERE "source" IS NULL;--> statement-breakpoint
UPDATE "channels" SET "source" = 'discord' WHERE "source" IS NULL;--> statement-breakpoint
UPDATE "threads" SET "source" = 'discord' WHERE "source" IS NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "source" SET NOT NULL;--> statement-breakpoint
-- The old constraints span all sources at once, which is the bug.
ALTER TABLE "messages" DROP CONSTRAINT "messages_message_id_unique";--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_channel_id_unique";--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT "threads_thread_id_unique";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_source_message_id_unique" UNIQUE("source","message_id");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_source_channel_id_unique" UNIQUE("source","channel_id");--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_source_thread_id_unique" UNIQUE("source","thread_id");
