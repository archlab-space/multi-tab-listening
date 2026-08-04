import { loadDbConfig } from 'shared/db';
import type { AIConfig } from './types.js';

export const config: AIConfig = {
  database: loadDbConfig(),
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