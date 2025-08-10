export interface DiscordMessage {
  messageId: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: Date;
  replyToMessageId?: string;
  threadId?: string;
  rawData: any;
}

export interface Channel {
  channelId: string;
  channelName?: string;
  guildId?: string;
  guildName?: string;
}

export interface Thread {
  threadId: string;
  originalMessageId: string;
  channelId: string;
}

export interface Config {
  channels: string[];
  storageStatePath?: string;
  database: {
    user: string;
    host: string;
    database: string;
    password: string;
    port: number;
  };
  filtering: {
    enabled: boolean;
    trivialPhrases: string[];
    minLength: number;
  };
}