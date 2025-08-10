import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const setupDatabase = async () => {
  const client = new Client({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'discord_monitor',
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432'),
  });

  try {
    await client.connect();
    console.log('Connected to PostgreSQL');

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
    `);

    // Create messages table
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        message_id VARCHAR(255) UNIQUE NOT NULL,
        channel_id VARCHAR(255) NOT NULL,
        author_id VARCHAR(255),
        author_name VARCHAR(255),
        content TEXT,
        timestamp TIMESTAMP,
        reply_to_message_id VARCHAR(255),
        thread_id VARCHAR(255),
        is_filtered BOOLEAN DEFAULT FALSE,
        raw_data JSONB,
        embedding VECTOR(1536),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES channels(channel_id),
        FOREIGN KEY (reply_to_message_id) REFERENCES messages(message_id)
      )
    `);

    // Create threads table for better thread management
    await client.query(`
      CREATE TABLE IF NOT EXISTS threads (
        id SERIAL PRIMARY KEY,
        thread_id VARCHAR(255) UNIQUE NOT NULL,
        original_message_id VARCHAR(255) NOT NULL,
        channel_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (original_message_id) REFERENCES messages(message_id),
        FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
      )
    `);

    // Create indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_author_id ON messages(author_id);
      CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_message_id);
      CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
    `);

    console.log('Database schema created successfully');
  } catch (err) {
    console.error('Error setting up database:', err);
  } finally {
    await client.end();
  }
};

if (process.argv[1] === new URL(import.meta.url).pathname) {
  setupDatabase();
}