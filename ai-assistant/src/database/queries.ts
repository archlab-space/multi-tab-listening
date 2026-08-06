import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import type { Pool } from 'pg'
import type winston from 'winston'
import { createLogger } from 'shared/logger'
import { createDb, createPool } from 'shared/db'
import { channels, messages } from 'shared/schema'
import type { DiscordMessage, DiscordMessageRow } from '../types.js'
import { config } from '../config.js'

/**
 * The columns every context query returns. Selected as a shared shape so the
 * four strategies cannot drift from one another.
 */
const MESSAGE_FIELDS = {
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
} as const

/** The recency windows are numbers from config, not input. Postgres will not
 *  take an interval as a bound parameter, so they are interpolated — as they
 *  already were in the SQL strings this replaces. */
function withinDays(days: number) {
  return gt(messages.timestamp, sql`now() - ${sql.raw(`interval '${days} days'`)}`)
}

export class DatabaseQueries {
  private pool: Pool
  private db: ReturnType<typeof createDb>
  private logger: winston.Logger

  constructor() {
    this.pool = createPool(config.database)
    this.db = createDb(this.pool)

    this.logger = createLogger('ai-assistant.log')
  }

  async getUnprocessedMessages(limit: number = 50): Promise<DiscordMessage[]> {
    try {
      const rows = await this.db
        .select({
          ...MESSAGE_FIELDS,
          channelName: channels.channelName,
          guildName: channels.guildName,
        })
        .from(messages)
        .leftJoin(channels, eq(messages.channelId, channels.channelId))
        .where(
          and(
            eq(messages.processed, false),
            isNotNull(messages.content),
            ne(messages.content, ''),
          ),
        )
        .orderBy(asc(messages.timestamp))
        .limit(limit)

      return rows
    } catch (error) {
      this.logger.error('Error fetching unprocessed messages:', error)
      throw error
    }
  }

  async markMessageAsProcessed(messageId: string): Promise<void> {
    try {
      await this.db
        .update(messages)
        .set({ processed: true })
        .where(eq(messages.messageId, messageId))
    } catch (error) {
      this.logger.error('Error marking message as processed:', {
        messageId,
        error,
      })
      throw error
    }
  }

  async markMultipleMessagesAsProcessed(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return

    try {
      await this.db
        .update(messages)
        .set({ processed: true })
        .where(inArray(messages.messageId, messageIds))
      this.logger.info(`Marked ${messageIds.length} messages as processed`)
    } catch (error) {
      this.logger.error('Error marking messages as processed:', {
        count: messageIds.length,
        error,
      })
      throw error
    }
  }

  async updateMessageQuestionAnalysis(
    messageId: string,
    isQuestion: boolean,
    confidence: number,
    questionType?: string,
  ): Promise<void> {
    try {
      await this.db
        .update(messages)
        .set({
          isQuestion,
          questionConfidence: confidence,
          questionType: questionType ?? null,
        })
        .where(eq(messages.messageId, messageId))
    } catch (error) {
      this.logger.error('Error updating question analysis:', {
        messageId,
        error,
      })
      throw error
    }
  }

  async getQuestionMessages(
    channelId?: string,
    limit: number = 50,
  ): Promise<DiscordMessageRow[]> {
    try {
      // The old code appended ` AND channel_id = $1` to the SQL string and
      // renumbered the placeholders by counting them. and() drops undefined
      // members, so the optional filter is a list entry, not arithmetic.
      const rows = await this.db
        .select(MESSAGE_FIELDS)
        .from(messages)
        .where(
          and(
            eq(messages.isQuestion, true),
            isNotNull(messages.content),
            ne(messages.content, ''),
            channelId ? eq(messages.channelId, channelId) : undefined,
          ),
        )
        .orderBy(desc(messages.timestamp))
        .limit(limit)

      return rows
    } catch (error) {
      this.logger.error('Error fetching question messages:', {
        channelId,
        error,
      })
      throw error
    }
  }

  async getRelatedMessages(
    channelId: string,
    questionContent: string,
    targetMessage?: DiscordMessage,
  ): Promise<DiscordMessageRow[]> {
    // Extract keywords from the question for relevance scoring
    const keywords = this.extractKeywords(questionContent)

    try {
      // Strategy 1: Get thread context if the question is part of a thread
      let threadMessages: DiscordMessageRow[] = []
      if (targetMessage?.threadId || targetMessage?.replyToMessageId) {
        threadMessages = await this.getThreadContextMessages(
          channelId,
          targetMessage,
        )
      }

      // Strategy 2: Get keyword-relevant messages (exclude questions - we want answers!)
      const keywordMessages = await this.getKeywordRelevantMessages(
        channelId,
        keywords,
        config.context.maxContextMessages,
      )

      // Combine and deduplicate messages
      const allMessages = this.combineAndRankMessages(
        threadMessages,
        keywordMessages,
        keywords,
        config.context.maxContextMessages,
      )

      return allMessages
    } catch (error) {
      this.logger.error('Error fetching related messages:', {
        channelId,
        error,
      })

      // Fallback to simple recent messages
      return this.getRecentMessages(
        channelId,
        config.context.maxContextMessages,
      )
    }
  }

  private async getThreadContextMessages(
    channelId: string,
    targetMessage: DiscordMessage,
  ): Promise<DiscordMessageRow[]> {
    const anchor = targetMessage.replyToMessageId || targetMessage.messageId

    const rows = await this.db
      .select(MESSAGE_FIELDS)
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          or(
            targetMessage.threadId
              ? eq(messages.threadId, targetMessage.threadId)
              : undefined,
            eq(messages.messageId, anchor),
            eq(messages.replyToMessageId, anchor),
          ),
          isNotNull(messages.content),
          ne(messages.content, ''),
          eq(messages.processed, true),
        ),
      )
      .orderBy(asc(messages.timestamp))

    return rows
  }

  private async getKeywordRelevantMessages(
    channelId: string,
    keywords: string[],
    limit: number,
  ): Promise<DiscordMessageRow[]> {
    if (keywords.length === 0) {
      return this.getRecentMessages(channelId, limit)
    }

    // Use PostgreSQL full-text search with keyword weighting.
    //
    // One plainto_tsquery per keyword, ORed with the tsquery `||` operator.
    // Joining the keywords into a single ' | ' string instead would not OR
    // anything: plainto_tsquery reads its argument as plain text, drops the
    // separators as noise and ANDs the rest, which required a message to
    // contain every keyword. Building the string for to_tsquery would OR
    // correctly but puts unescaped user text where operators are parsed;
    // composing per keyword keeps each term inside plainto_tsquery, so
    // operators stay text. A keyword that stems to nothing yields an empty
    // tsquery, and `||` drops it rather than poisoning the rest.
    const keywordQuery = sql.join(
      keywords.map((keyword) => sql`plainto_tsquery('english', ${keyword})`),
      sql` || `,
    )
    // Bound once and reused in the ORDER BY. The old code wrote the
    // expression as a string and re-referenced it by alias, so the two could
    // disagree. ts_rank still scores a message matching more keywords higher,
    // so the best matches lead even though one keyword is now enough.
    const relevance = sql<number>`ts_rank(to_tsvector('english', ${messages.content}), ${keywordQuery})`

    try {
      const rows = await this.db
        .select({ ...MESSAGE_FIELDS, relevanceScore: relevance })
        .from(messages)
        .where(
          and(
            eq(messages.channelId, channelId),
            isNotNull(messages.content),
            ne(messages.content, ''),
            eq(messages.processed, true),
            or(isNull(messages.isQuestion), eq(messages.isQuestion, false)),
            withinDays(config.context.keywordSearchDays),
            sql`to_tsvector('english', ${messages.content}) @@ (${keywordQuery})`,
          ),
        )
        .orderBy(desc(relevance), desc(messages.timestamp))
        .limit(limit)

      return rows
    } catch (error) {
      // Fallback to simple keyword matching if full-text search fails
      this.logger.warn('Full-text search failed, using simple keyword matching')
      return this.getSimpleKeywordMessages(channelId, keywords, limit)
    }
  }

  private async getSimpleKeywordMessages(
    channelId: string,
    keywords: string[],
    limit: number,
  ): Promise<DiscordMessageRow[]> {
    if (keywords.length === 0) {
      return this.getRecentMessages(channelId, limit)
    }

    const rows = await this.db
      .select(MESSAGE_FIELDS)
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          or(...keywords.map((k) => ilike(messages.content, `%${k}%`))),
          isNotNull(messages.content),
          ne(messages.content, ''),
          eq(messages.processed, true),
          or(isNull(messages.isQuestion), eq(messages.isQuestion, false)),
          withinDays(config.context.keywordSearchDays),
        ),
      )
      .orderBy(desc(messages.timestamp))
      .limit(limit)

    return rows
  }

  private async getRecentMessages(
    channelId: string,
    limit: number,
  ): Promise<DiscordMessageRow[]> {
    const rows = await this.db
      .select(MESSAGE_FIELDS)
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          isNotNull(messages.content),
          ne(messages.content, ''),
          eq(messages.processed, true),
          withinDays(config.context.fallbackSearchDays),
        ),
      )
      .orderBy(desc(messages.timestamp))
      .limit(limit)

    return rows
  }

  private combineAndRankMessages(
    threadMessages: DiscordMessageRow[],
    keywordMessages: DiscordMessageRow[],
    keywords: string[],
    limit: number,
  ): DiscordMessageRow[] {
    const messageMap = new Map<string, DiscordMessageRow & { score: number }>()

    // Add thread messages with highest priority (score: 100)
    threadMessages.forEach((msg) => {
      messageMap.set(msg.messageId, { ...msg, score: 100 })
    })

    // Add keyword-relevant messages with high priority (score: 50-100)
    keywordMessages.forEach((msg) => {
      if (!messageMap.has(msg.messageId)) {
        const keywordScore = this.calculateKeywordScore(msg.content, keywords)
        messageMap.set(msg.messageId, { ...msg, score: 50 + keywordScore })
      }
    })

    // Sort by score and recency, then limit
    return Array.from(messageMap.values())
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score
        return b.timestamp.getTime() - a.timestamp.getTime()
      })
      .slice(0, limit)
      .map(({ score, ...msg }) => msg)
  }

  private extractKeywords(text: string): string[] {
    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 3)

    const stopWords = new Set([
      'this',
      'that',
      'with',
      'have',
      'will',
      'from',
      'they',
      'know',
      'want',
      'been',
      'good',
      'much',
      'some',
      'time',
      'very',
      'when',
      'come',
      'here',
      'just',
      'like',
      'long',
      'make',
      'many',
      'over',
      'such',
      'take',
      'than',
      'them',
      'well',
      'were',
      'what',
    ])

    return words.filter((word) => !stopWords.has(word)).slice(0, 8) // Limit to 8 most relevant keywords
  }

  private calculateKeywordScore(content: string, keywords: string[]): number {
    const contentLower = content.toLowerCase()
    let score = 0

    keywords.forEach((keyword) => {
      const matches = (contentLower.match(new RegExp(keyword, 'g')) || [])
        .length
      score += matches * 10 // 10 points per keyword match
    })

    return Math.min(score, 50) // Cap at 50 points
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
