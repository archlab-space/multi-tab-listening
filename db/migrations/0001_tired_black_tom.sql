ALTER TABLE "tweets" ADD COLUMN "tier" varchar(10);--> statement-breakpoint
ALTER TABLE "tweets" ADD COLUMN "entities" text[];