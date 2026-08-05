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
          channelId: channel.channelId,
          channelName: channel.channelName,
          guildId: channel.guildId,
          guildName: channel.guildName,
        })
        .onConflictDoUpdate({
          target: channels.channelId,
          set: {
            channelName: channel.channelName,
            guildId: channel.guildId,
            guildName: channel.guildName,
          },
        })
    } catch (error) {
      this.logger.error('Error inserting channel:', error)
      throw error
    }
  }

  async insertMessage(
    message: DiscordMessage,
    isFiltered: boolean = false,
  ): Promise<void> {
    try {
      await this.db
        .insert(messages)
        .values({
          messageId: message.messageId,
          channelId: message.channelId,
          guildId: message.guildId,
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
        .onConflictDoNothing({ target: messages.messageId })
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
          threadId: thread.threadId,
          originalMessageId: thread.originalMessageId,
          channelId: thread.channelId,
        })
        .onConflictDoNothing({ target: threads.threadId })
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
          messageId: messages.messageId,
          channelId: messages.channelId,
          guildId: messages.guildId,
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
          messageId: messages.messageId,
          channelId: messages.channelId,
          guildId: messages.guildId,
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
