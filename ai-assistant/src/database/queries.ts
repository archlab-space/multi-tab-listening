import { Pool } from 'pg';
import winston from 'winston';
import type { DiscordMessage } from '../types.js';
import { config } from '../config.js';

export class DatabaseQueries {
  private pool: Pool;
  private logger: winston.Logger;

  constructor() {
    this.pool = new Pool({
      ...config.database,
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
        new winston.transports.File({ filename: 'ai-assistant.log' }),
        new winston.transports.Console()
      ],
    });
  }

  async getUnprocessedMessages(limit: number = 50): Promise<DiscordMessage[]> {
    const query = `
      SELECT 
        message_id, channel_id, author_id, author_name, content, 
        timestamp, reply_to_message_id, thread_id, raw_data
      FROM messages 
      WHERE processed = FALSE 
        AND content IS NOT NULL 
        AND content != ''
      ORDER BY timestamp ASC 
      LIMIT $1
    `;

    try {
      const result = await this.pool.query(query, [limit]);
      return result.rows.map(row => ({
        messageId: row.message_id,
        channelId: row.channel_id,
        authorId: row.author_id,
        authorName: row.author_name,
        content: row.content,
        timestamp: row.timestamp,
        replyToMessageId: row.reply_to_message_id,
        threadId: row.thread_id,
        rawData: row.raw_data
      }));
    } catch (error) {
      this.logger.error('Error fetching unprocessed messages:', error);
      throw error;
    }
  }

  async markMessageAsProcessed(messageId: string): Promise<void> {
    const query = 'UPDATE messages SET processed = TRUE WHERE message_id = $1';
    
    try {
      await this.pool.query(query, [messageId]);
    } catch (error) {
      this.logger.error('Error marking message as processed:', { messageId, error });
      throw error;
    }
  }

  async markMultipleMessagesAsProcessed(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;

    const query = 'UPDATE messages SET processed = TRUE WHERE message_id = ANY($1)';
    
    try {
      await this.pool.query(query, [messageIds]);
      this.logger.info(`Marked ${messageIds.length} messages as processed`);
    } catch (error) {
      this.logger.error('Error marking messages as processed:', { count: messageIds.length, error });
      throw error;
    }
  }

  async getRelatedMessages(channelId: string, limit: number = 20): Promise<DiscordMessage[]> {
    const query = `
      SELECT 
        message_id, channel_id, author_id, author_name, content, 
        timestamp, reply_to_message_id, thread_id, raw_data
      FROM messages 
      WHERE channel_id = $1 
        AND content IS NOT NULL 
        AND content != ''
        AND processed = TRUE
      ORDER BY timestamp DESC 
      LIMIT $2
    `;

    try {
      const result = await this.pool.query(query, [channelId, limit]);
      return result.rows.map(row => ({
        messageId: row.message_id,
        channelId: row.channel_id,
        authorId: row.author_id,
        authorName: row.author_name,
        content: row.content,
        timestamp: row.timestamp,
        replyToMessageId: row.reply_to_message_id,
        threadId: row.thread_id,
        rawData: row.raw_data
      }));
    } catch (error) {
      this.logger.error('Error fetching related messages:', { channelId, error });
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}