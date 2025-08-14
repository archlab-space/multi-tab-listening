import { Client, Pool } from 'pg';
import winston from 'winston';
import { DiscordMessage, Channel, Thread } from './types.js';

export class Database {
  private pool: Pool;
  private logger: winston.Logger;

  constructor() {
    this.pool = new Pool({
      user: process.env.DB_USER || 'postgres',
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'discord_monitor',
      password: process.env.DB_PASSWORD,
      port: parseInt(process.env.DB_PORT || '5432'),
      max: 10,
      idleTimeoutMillis: 30000,
    });

    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({ filename: 'database.log' }),
        new winston.transports.Console()
      ],
    });
  }

  async insertChannel(channel: Channel): Promise<void> {
    const query = `
      INSERT INTO channels (channel_id, channel_name, guild_id, guild_name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (channel_id) DO UPDATE SET
        channel_name = EXCLUDED.channel_name,
        guild_id = EXCLUDED.guild_id,
        guild_name = EXCLUDED.guild_name
    `;
    
    try {
      await this.pool.query(query, [
        channel.channelId,
        channel.channelName,
        channel.guildId,
        channel.guildName
      ]);
    } catch (error) {
      this.logger.error('Error inserting channel:', error);
      throw error;
    }
  }

  async insertMessage(message: DiscordMessage, isFiltered: boolean = false): Promise<void> {
    const query = `
      INSERT INTO messages (
        message_id, channel_id, guild_id, author_id, author_name, content, 
        timestamp, reply_to_message_id, thread_id, is_filtered, raw_data
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (message_id) DO NOTHING
    `;

    try {
      await this.pool.query(query, [
        message.messageId,
        message.channelId,
        message.guildId,
        message.authorId,
        message.authorName,
        message.content,
        message.timestamp,
        message.replyToMessageId,
        message.threadId,
        isFiltered,
        JSON.stringify(message.rawData)
      ]);
    } catch (error) {
      this.logger.error('Error inserting message:', error);
      throw error;
    }
  }

  async insertThread(thread: Thread): Promise<void> {
    const query = `
      INSERT INTO threads (thread_id, original_message_id, channel_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (thread_id) DO NOTHING
    `;

    try {
      await this.pool.query(query, [
        thread.threadId,
        thread.originalMessageId,
        thread.channelId
      ]);
    } catch (error) {
      this.logger.error('Error inserting thread:', error);
      throw error;
    }
  }

  async getMessagesByChannel(channelId: string, limit: number = 100): Promise<DiscordMessage[]> {
    const query = `
      SELECT * FROM messages 
      WHERE channel_id = $1 
      ORDER BY timestamp DESC 
      LIMIT $2
    `;

    try {
      const result = await this.pool.query(query, [channelId, limit]);
      return result.rows.map(row => ({
        messageId: row.message_id,
        channelId: row.channel_id,
        guildId: row.guild_id,
        authorId: row.author_id,
        authorName: row.author_name,
        content: row.content,
        timestamp: row.timestamp,
        replyToMessageId: row.reply_to_message_id,
        threadId: row.thread_id,
        rawData: row.raw_data
      }));
    } catch (error) {
      this.logger.error('Error fetching messages:', error);
      throw error;
    }
  }

  async getThreadMessages(threadId: string): Promise<DiscordMessage[]> {
    const query = `
      SELECT * FROM messages 
      WHERE thread_id = $1 OR reply_to_message_id IN (
        SELECT original_message_id FROM threads WHERE thread_id = $1
      )
      ORDER BY timestamp ASC
    `;

    try {
      const result = await this.pool.query(query, [threadId]);
      return result.rows.map(row => ({
        messageId: row.message_id,
        channelId: row.channel_id,
        guildId: row.guild_id,
        authorId: row.author_id,
        authorName: row.author_name,
        content: row.content,
        timestamp: row.timestamp,
        replyToMessageId: row.reply_to_message_id,
        threadId: row.thread_id,
        rawData: row.raw_data
      }));
    } catch (error) {
      this.logger.error('Error fetching thread messages:', error);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}