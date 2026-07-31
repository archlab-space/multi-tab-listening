/**
 * Types shared between the scraper (writes) and the ai-assistant (reads).
 * These mirror the database schema created in scraper/src/setup-database.ts,
 * which is the actual contract between the two services — they never call
 * each other, they only meet in Postgres.
 */

/** One row of the `messages` table. */
export interface DiscordMessage {
  messageId: string
  channelId: string
  guildId: string
  authorId: string
  authorName: string
  content: string
  timestamp: Date
  replyToMessageId?: string
  threadId?: string
  rawData: any
}

/**
 * A message joined with its channel.
 *
 * `channel_name` and `guild_name` live on the `channels` table, not on
 * `messages`, so they are only available when the two are joined — and the
 * join is a LEFT JOIN, hence `undefined` rather than optional: a caller that
 * asked for the enriched shape must acknowledge the name may be missing.
 */
export interface DiscordMessageWithChannel extends DiscordMessage {
  channelName: string | undefined
  guildName: string | undefined
}
