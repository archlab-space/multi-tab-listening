import { asc, desc, eq, inArray, or } from 'drizzle-orm'
import type { Pool } from 'pg'
import type winston from 'winston'
import { createDb, createPool } from 'shared/db'
import { createLogger } from 'shared/logger'
import { channels, messages, threads } from 'shared/schema'
import type { Channel, DiscordMessage, Thread } from './types.js'

export class Database {
  private pool: Pool
  private db: ReturnType<typeof createDb>
  private logger: winston.Logger

  constructor() {
    this.pool = createPool()
    this.db = createDb(this.pool)
    this.logger = createLogger('database.log')
  }

  async insertChannel(channel: Channel): Promise<void> {
    try {
      await this.db
        .insert(channels)
        .values({
          source: 'discord',
          channelId: channel.channelId,
          channelName: channel.channelName,
          spaceId: channel.guildId,
          spaceName: channel.guildName,
        })
        .onConflictDoUpdate({
          target: [channels.source, channels.channelId],
          set: {
            channelName: channel.channelName,
            spaceId: channel.guildId,
            spaceName: channel.guildName,
          },
        })
    } catch (error) {
      this.logger.error('Error inserting channel:', error)
      throw error
    }
  }

  /**
   * The adapter stamps its own source rather than accepting one, so a caller
   * cannot mislabel a row and the scraper never has to know the column exists.
   */
  async insertMessage(
    message: Omit<DiscordMessage, 'source'>,
    isFiltered: boolean = false,
  ): Promise<void> {
    try {
      await this.db
        .insert(messages)
        .values({
          source: 'discord',
          messageId: message.messageId,
          channelId: message.channelId,
          spaceId: message.spaceId,
          authorId: message.authorId,
          authorName: message.authorName,
          content: message.content,
          timestamp: message.timestamp,
          replyToMessageId: message.replyToMessageId,
          threadId: message.threadId,
          isFiltered,
          // jsonb takes the value, not a string: Drizzle serialises it. The
          // old code called JSON.stringify itself, which `pg` then handed to
          // Postgres to parse — the same result by a different route, but
          // keeping the stringify here would encode it twice.
          rawData: message.rawData,
        })
        .onConflictDoNothing({ target: [messages.source, messages.messageId] })
    } catch (error) {
      this.logger.error('Error inserting message:', error)
      throw error
    }
  }

  async insertThread(thread: Thread): Promise<void> {
    try {
      await this.db
        .insert(threads)
        .values({
          source: 'discord',
          threadId: thread.threadId,
          originalMessageId: thread.originalMessageId,
          channelId: thread.channelId,
        })
        .onConflictDoNothing({ target: [threads.source, threads.threadId] })
    } catch (error) {
      this.logger.error('Error inserting thread:', error)
      throw error
    }
  }

  async getMessagesByChannel(
    channelId: string,
    limit: number = 100,
  ): Promise<DiscordMessage[]> {
    try {
      const rows = await this.db
        .select({
          source: messages.source,
          messageId: messages.messageId,
          channelId: messages.channelId,
          spaceId: messages.spaceId,
          authorId: messages.authorId,
          authorName: messages.authorName,
          content: messages.content,
          timestamp: messages.timestamp,
          replyToMessageId: messages.replyToMessageId,
          threadId: messages.threadId,
          rawData: messages.rawData,
        })
        .from(messages)
        .where(eq(messages.channelId, channelId))
        .orderBy(desc(messages.timestamp))
        .limit(limit)

      return rows
    } catch (error) {
      this.logger.error('Error fetching messages:', error)
      throw error
    }
  }

  async getThreadMessages(threadId: string): Promise<DiscordMessage[]> {
    try {
      // A message belongs to the thread if it carries the thread id, or if it
      // replies to the message the thread grew out of.
      const threadOrigins = this.db
        .select({ originalMessageId: threads.originalMessageId })
        .from(threads)
        .where(eq(threads.threadId, threadId))

      const rows = await this.db
        .select({
          source: messages.source,
          messageId: messages.messageId,
          channelId: messages.channelId,
          spaceId: messages.spaceId,
          authorId: messages.authorId,
          authorName: messages.authorName,
          content: messages.content,
          timestamp: messages.timestamp,
          replyToMessageId: messages.replyToMessageId,
          threadId: messages.threadId,
          rawData: messages.rawData,
        })
        .from(messages)
        .where(
          or(
            eq(messages.threadId, threadId),
            inArray(messages.replyToMessageId, threadOrigins),
          ),
        )
        .orderBy(asc(messages.timestamp))

      return rows
    } catch (error) {
      this.logger.error('Error fetching thread messages:', error)
      throw error
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
