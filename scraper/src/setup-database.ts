import { Client } from 'pg'
import dotenv from 'dotenv'

dotenv.config()

export const setupDatabase = async () => {
  const client = new Client({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'discord_monitor',
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432'),
  })

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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
    `)

    // Create full-text search index for content
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_content_fts 
      ON messages USING GIN(to_tsvector('english', content));
    `)

    console.log('Database schema created successfully')
  } catch (err) {
    console.error('Error setting up database:', err)
  } finally {
    await client.end()
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  setupDatabase()
}
