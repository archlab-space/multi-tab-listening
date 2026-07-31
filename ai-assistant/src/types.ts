// Every message this service handles comes from a query that joins `channels`
// (see database/queries.ts), so its DiscordMessage is the enriched view.
export type { DiscordMessageWithChannel as DiscordMessage } from 'shared'

export interface AIConfig {
  database: {
    user: string
    host: string
    database: string
    password: string
    port: number
  }
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
