import type { Pool } from 'pg'
import type winston from 'winston'
import { createLogger } from 'shared/logger'
import { createPool } from 'shared/db'
import type { DiscordMessage, DiscordMessageRow } from '../types.js'
import { config } from '../config.js'

export class DatabaseQueries {
  private pool: Pool
  private logger: winston.Logger

  constructor() {
    this.pool = createPool(config.database)

    this.logger = createLogger('ai-assistant.log')
  }

  async getUnprocessedMessages(limit: number = 50): Promise<DiscordMessage[]> {
    const query = `
      SELECT 
        m.message_id, m.channel_id, m.guild_id, m.author_id, m.author_name, m.content, 
        m.timestamp, m.reply_to_message_id, m.thread_id, m.raw_data,
        c.channel_name, c.guild_name
      FROM messages m
      LEFT JOIN channels c ON m.channel_id = c.channel_id
      WHERE m.processed = FALSE 
        AND m.content IS NOT NULL 
        AND m.content != ''
      ORDER BY m.timestamp ASC 
      LIMIT $1
    `

    try {
      const result = await this.pool.query(query, [limit])
      return result.rows.map(
        (row) =>
          ({
            messageId: row.message_id,
            channelId: row.channel_id,
            channelName: row.channel_name,
            guildId: row.guild_id,
            guildName: row.guild_name,
            authorId: row.author_id,
            authorName: row.author_name,
            content: row.content,
            timestamp: row.timestamp,
            replyToMessageId: row.reply_to_message_id,
            threadId: row.thread_id,
            rawData: row.raw_data,
          } as DiscordMessage),
      )
    } catch (error) {
      this.logger.error('Error fetching unprocessed messages:', error)
      throw error
    }
  }

  async markMessageAsProcessed(messageId: string): Promise<void> {
    const query = 'UPDATE messages SET processed = TRUE WHERE message_id = $1'

    try {
      await this.pool.query(query, [messageId])
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

    const query =
      'UPDATE messages SET processed = TRUE WHERE message_id = ANY($1)'

    try {
      await this.pool.query(query, [messageIds])
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
    const query = `
      UPDATE messages 
      SET is_question = $2, question_confidence = $3, question_type = $4
      WHERE message_id = $1
    `

    try {
      await this.pool.query(query, [
        messageId,
        isQuestion,
        confidence,
        questionType,
      ])
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
    let query = `
      SELECT 
        message_id, channel_id, guild_id, author_id, author_name, content, 
        timestamp, reply_to_message_id, thread_id, raw_data
      FROM messages 
      WHERE is_question = TRUE 
        AND content IS NOT NULL 
        AND content != ''
    `

    const params: any[] = []

    if (channelId) {
      query += ' AND channel_id = $1'
      params.push(channelId)
    }

    query += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`
    params.push(limit)

    try {
      const result = await this.pool.query(query, params)
      return result.rows.map(this.mapRowToMessage)
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
    const query = `
      SELECT 
        message_id, channel_id, guild_id, author_id, author_name, content, 
        timestamp, reply_to_message_id, thread_id, raw_data
      FROM messages 
      WHERE channel_id = $1 
        AND (
          thread_id = $2 OR 
          message_id = $3 OR
          reply_to_message_id = $3
        )
        AND content IS NOT NULL 
        AND content != ''
        AND processed = TRUE
      ORDER BY timestamp ASC
    `

    const result = await this.pool.query(query, [
      channelId,
      targetMessage.threadId,
      targetMessage.replyToMessageId || targetMessage.messageId,
    ])

    return result.rows.map(this.mapRowToMessage)
  }

  private async getKeywordRelevantMessages(
    channelId: string,
    keywords: string[],
    limit: number,
  ): Promise<DiscordMessageRow[]> {
    if (keywords.length === 0) {
      return this.getRecentMessages(channelId, limit)
    }

    // Use PostgreSQL full-text search with keyword weighting
    const keywordPattern = keywords.join(' | ')

    const query = `
      SELECT 
        message_id, channel_id, guild_id, author_id, author_name, content, 
        timestamp, reply_to_message_id, thread_id, raw_data,
        ts_rank(to_tsvector('english', content), plainto_tsquery('english', $2)) as relevance_score
      FROM messages 
      WHERE channel_id = $1 
        AND content IS NOT NULL 
        AND content != ''
        AND processed = TRUE
        AND (is_question IS NULL OR is_question = FALSE)
        AND timestamp > NOW() - INTERVAL '${config.context.keywordSearchDays} days'
        AND to_tsvector('english', content) @@ plainto_tsquery('english', $2)
      ORDER BY relevance_score DESC, timestamp DESC
      LIMIT $3
    `

    try {
      const result = await this.pool.query(query, [
        channelId,
        keywordPattern,
        limit,
      ])
      return result.rows.map(this.mapRowToMessage)
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

    const keywordConditions = keywords
      .map((_, index) => `content ILIKE $${index + 3}`)
      .join(' OR ')
    const keywordParams = keywords.map((k) => `%${k}%`)

    const query = `
      SELECT 
        message_id, channel_id, guild_id, author_id, author_name, content, 
        timestamp, reply_to_message_id, thread_id, raw_data
      FROM messages 
      WHERE channel_id = $1 
        AND (${keywordConditions})
        AND content IS NOT NULL 
        AND content != ''
        AND processed = TRUE
        AND (is_question IS NULL OR is_question = FALSE)
        AND timestamp > NOW() - INTERVAL '${config.context.keywordSearchDays} days'
      ORDER BY timestamp DESC
      LIMIT $2
    `

    const result = await this.pool.query(query, [
      channelId,
      limit,
      ...keywordParams,
    ])
    return result.rows.map(this.mapRowToMessage)
  }

  private async getRecentMessages(
    channelId: string,
    limit: number,
  ): Promise<DiscordMessageRow[]> {
    const query = `
      SELECT 
        message_id, channel_id, guild_id, author_id, author_name, content, 
        timestamp, reply_to_message_id, thread_id, raw_data
      FROM messages 
      WHERE channel_id = $1 
        AND content IS NOT NULL 
        AND content != ''
        AND processed = TRUE
        AND timestamp > NOW() - INTERVAL '${config.context.fallbackSearchDays} days'
      ORDER BY timestamp DESC 
      LIMIT $2
    `

    const result = await this.pool.query(query, [channelId, limit])
    return result.rows.map(this.mapRowToMessage)
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

  private mapRowToMessage = (row: any): DiscordMessageRow => ({
    messageId: row.message_id,
    channelId: row.channel_id,
    guildId: row.guild_id,
    authorId: row.author_id,
    authorName: row.author_name,
    content: row.content,
    timestamp: row.timestamp,
    replyToMessageId: row.reply_to_message_id,
    threadId: row.thread_id,
    rawData: row.raw_data,
  })

  async close(): Promise<void> {
    await this.pool.end()
  }
}
