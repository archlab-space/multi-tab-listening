// The scraper writes plain `messages` rows; channel/guild names go to the
// `channels` table via the Channel type below.
export type { DiscordMessage } from 'shared'

export interface Channel {
  channelId: string
  channelName?: string
  guildId?: string
  guildName?: string
}

export interface Thread {
  threadId: string
  originalMessageId: string
  channelId: string
}

export interface ChannelInfo {
  guildId: string
  channelId: string
}

export interface Config {
  channels: ChannelInfo[]
  storageStatePath?: string
  database: {
    user: string
    host: string
    database: string
    password: string
    port: number
  }
  filtering: {
    enabled: boolean
    trivialPhrases: string[]
    minLength: number
  }
}

export interface ChannelHealthStatus {
  channelId: string
  channelName: string | undefined
  guildId: string
  guildName: string | undefined
  lastMessageTime: number
  lastHeartbeat: number
  messageCount: number
  isObserving: boolean
  timeSinceLastMessage: number
  processedMessagesCount: number
  url: string
  lastErrorTime?: number
  errorCount: number
}
