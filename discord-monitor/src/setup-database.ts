import { Client } from 'pg'
import dotenv from 'dotenv'
import { loadDbConfig } from 'shared/db'

dotenv.config()

export const setupDatabase = async () => {
  const client = new Client(loadDbConfig())

  try {
    await client.connect()
    console.log('Connected to PostgreSQL')

    // Enable pgvector extension
    await client.query('CREATE EXTENSION IF NOT EXISTS vector')

    // Create channels table
    await client.query(`
      CREATE TABLE IF NOT EXISTS channels (
        id SERIAL PRIMARY KEY,
        channel_id VARCHAR(255) UNIQUE NOT NULL,
        channel_name VARCHAR(255),
        guild_id VARCHAR(255),
        guild_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Create messages table
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        message_id VARCHAR(255) UNIQUE NOT NULL,
        channel_id VARCHAR(255) NOT NULL,
        guild_id VARCHAR(255) NOT NULL,
        author_id VARCHAR(255),
        author_name VARCHAR(255),
        content TEXT,
        timestamp TIMESTAMP,
        reply_to_message_id VARCHAR(255),
        thread_id VARCHAR(255),
        is_filtered BOOLEAN DEFAULT FALSE,
        raw_data JSONB,
        embedding VECTOR(1536),
        processed BOOLEAN DEFAULT FALSE,
        is_question BOOLEAN DEFAULT NULL,
        question_confidence INTEGER DEFAULT NULL,
        question_type VARCHAR(50) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Create threads table for better thread management
    await client.query(`
      CREATE TABLE IF NOT EXISTS threads (
        id SERIAL PRIMARY KEY,
        thread_id VARCHAR(255) UNIQUE NOT NULL,
        original_message_id VARCHAR(255) NOT NULL,
        channel_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Create tweets table — the queue drained by the x-poster service.
    // Time columns are TIMESTAMPTZ, unlike the tables above, because every
    // one of them feeds a scheduling decision (active-hours window, minimum
    // interval, daily cap) where a naive timestamp is a correctness bug.
    await client.query(`
      CREATE TABLE IF NOT EXISTS tweets (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        dedupe_key VARCHAR(255) UNIQUE NOT NULL,
        source VARCHAR(50),
        source_ref VARCHAR(255),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        posted_at TIMESTAMPTZ,
        posted_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // Added after the tweets table shipped, so these run as ALTERs rather
    // than being folded into the CREATE above — an existing database would
    // never see a changed CREATE TABLE IF NOT EXISTS.
    await client.query(`
      ALTER TABLE tweets ADD COLUMN IF NOT EXISTS media_path TEXT;
      ALTER TABLE tweets ADD COLUMN IF NOT EXISTS archetype VARCHAR(20);
    `)

    // One row per candidate the tweet-generator has tried and failed to write
    // up. Without it a candidate the model cannot handle sits at the top of
    // its pool and consumes every slot that source has, every cycle, until it
    // ages out of the freshness window.
    await client.query(`
      CREATE TABLE IF NOT EXISTS generation_attempts (
        external_id VARCHAR(255) PRIMARY KEY,
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // Create indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_processed ON messages(processed, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_is_question ON messages(is_question);
      CREATE INDEX IF NOT EXISTS idx_messages_author_id ON messages(author_id);
      CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_message_id);
      CREATE INDEX IF NOT EXISTS idx_messages_channel_timestamp ON messages(channel_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_context_search ON messages(channel_id, is_question, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_guild_id ON messages(guild_id);
      CREATE INDEX IF NOT EXISTS idx_tweets_claim ON tweets(status, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_tweets_posted_at ON tweets(posted_at);
    `)

    // Create full-text search index for content
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_content_fts 
      ON messages USING GIN(to_tsvector('english', content));
    `)

    console.log('Database schema created successfully')
  } catch (err) {
    // Rethrow: a schema failure that only logs means every statement after it
    // is skipped silently, which is exactly how the trailing comma above went
    // unnoticed while none of the indexes below it were ever created.
    console.error('Error setting up database:', err)
    throw err
  } finally {
    await client.end()
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  setupDatabase()
}
