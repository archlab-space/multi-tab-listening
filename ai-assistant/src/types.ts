export interface DiscordMessage {
  messageId: string
  channelId: string
  channelName: string | undefined
  guildId: string
  guildName: string | undefined
  authorId: string
  authorName: string
  content: string
  timestamp: Date
  replyToMessageId?: string
  threadId?: string
  rawData: any
}

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
