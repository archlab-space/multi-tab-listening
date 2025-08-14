import type { AIConfig } from './types.js';

export const config: AIConfig = {
  database: {
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'discord_monitor',
    password: process.env.DB_PASSWORD || '',
    port: parseInt(process.env.DB_PORT || '5432'),
  },
  fireworksApiKey: process.env.FIREWORKS_API_KEY || '',
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  polling: {
    intervalMinutes: parseInt(process.env.POLLING_INTERVAL_MINUTES || '1'),
    batchSize: parseInt(process.env.POLLING_BATCH_SIZE || '50'),
  },
  context: {
    keywordSearchDays: parseInt(process.env.CONTEXT_KEYWORD_SEARCH_DAYS || '30'),
    fallbackSearchDays: parseInt(process.env.CONTEXT_FALLBACK_SEARCH_DAYS || '7'),
    maxContextMessages: parseInt(process.env.CONTEXT_MAX_MESSAGES || '20'),
  },
};