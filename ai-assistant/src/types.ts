// Messages fetched for processing come from a query that joins `channels`
// (see getUnprocessedMessages), so the default DiscordMessage here is the
// enriched view.
export type { DiscordMessageWithChannel as DiscordMessage } from 'shared'

// Context queries select from `messages` alone, so their rows genuinely have
// no channel or guild name. They use this narrower type — anything that needs
// a name must come from a joined query instead.
export type { DiscordMessage as DiscordMessageRow } from 'shared'

import type { DbConfig } from 'shared/db'

export interface AIConfig {
  database: DbConfig
  fireworksApiKey: string
  discordWebhookUrl: string
  polling: {
    intervalMinutes: number
    batchSize: number
  }
  context: {
    keywordSearchDays: number
    fallbackSearchDays: number
    maxContextMessages: number
  }
}
