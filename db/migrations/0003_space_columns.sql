-- Written by hand rather than generated. drizzle-kit cannot tell a rename from
-- a drop-plus-add, so it asks — and its prompt needs a TTY, which the agent
-- running this did not have. Answering wrong emits DROP COLUMN and destroys
-- the data, so the safe move was to write the four statements out and prove
-- the accompanying snapshot correct by running `drizzle-kit generate` again
-- and getting "No schema changes".
ALTER TABLE "messages" RENAME COLUMN "guild_id" TO "space_id";--> statement-breakpoint
ALTER TABLE "channels" RENAME COLUMN "guild_id" TO "space_id";--> statement-breakpoint
ALTER TABLE "channels" RENAME COLUMN "guild_name" TO "space_name";--> statement-breakpoint
ALTER INDEX "idx_messages_guild_id" RENAME TO "idx_messages_space_id";
