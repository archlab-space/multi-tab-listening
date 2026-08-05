CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" varchar(255) NOT NULL,
	"channel_name" varchar(255),
	"guild_id" varchar(255),
	"guild_name" varchar(255),
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "channels_channel_id_unique" UNIQUE("channel_id")
);
--> statement-breakpoint
CREATE TABLE "generation_attempts" (
	"external_id" varchar(255) PRIMARY KEY NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" varchar(255) NOT NULL,
	"channel_id" varchar(255) NOT NULL,
	"guild_id" varchar(255) NOT NULL,
	"author_id" varchar(255),
	"author_name" varchar(255),
	"content" text,
	"timestamp" timestamp,
	"reply_to_message_id" varchar(255),
	"thread_id" varchar(255),
	"is_filtered" boolean DEFAULT false,
	"raw_data" jsonb,
	"embedding" vector(1536),
	"processed" boolean DEFAULT false,
	"is_question" boolean,
	"question_confidence" integer,
	"question_type" varchar(50),
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "messages_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" varchar(255) NOT NULL,
	"original_message_id" varchar(255) NOT NULL,
	"channel_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "threads_thread_id_unique" UNIQUE("thread_id")
);
--> statement-breakpoint
CREATE TABLE "tweets" (
	"id" serial PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"dedupe_key" varchar(255) NOT NULL,
	"source" varchar(50),
	"source_ref" varchar(255),
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"media_path" text,
	"archetype" varchar(20),
	CONSTRAINT "tweets_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE INDEX "idx_messages_channel_id" ON "messages" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_messages_timestamp" ON "messages" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_messages_processed" ON "messages" USING btree ("processed","timestamp");--> statement-breakpoint
CREATE INDEX "idx_messages_is_question" ON "messages" USING btree ("is_question");--> statement-breakpoint
CREATE INDEX "idx_messages_author_id" ON "messages" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "idx_messages_thread_id" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "idx_messages_reply_to" ON "messages" USING btree ("reply_to_message_id");--> statement-breakpoint
CREATE INDEX "idx_messages_channel_timestamp" ON "messages" USING btree ("channel_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_messages_context_search" ON "messages" USING btree ("channel_id","is_question","timestamp");--> statement-breakpoint
CREATE INDEX "idx_messages_guild_id" ON "messages" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "idx_messages_content_fts" ON "messages" USING gin (to_tsvector('english', "content"));--> statement-breakpoint
CREATE INDEX "idx_tweets_claim" ON "tweets" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_tweets_posted_at" ON "tweets" USING btree ("posted_at");