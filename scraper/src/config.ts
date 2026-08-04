import dotenv from 'dotenv'
import { loadDbConfig } from 'shared/db'
import { Config, ChannelInfo } from './types.js'

dotenv.config()

function parseChannelsList(channelsStr: string = ''): ChannelInfo[] {
  return channelsStr
    .split(',')
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const [guildId, channelId] = pair.split('/')
      if (!guildId || !channelId) {
        throw new Error(
          `Invalid channel format: ${pair}. Expected format: guild_id/channel_id`,
        )
      }
      return { guildId: guildId.trim(), channelId: channelId.trim() }
    })
}

function parseTrivialPhrases(phrasesStr: string = ''): string[] {
  return phrasesStr
    .split(',')
    .map((phrase) => phrase.trim().toLowerCase())
    .filter((phrase) => phrase.length > 0)
}

export function loadConfig(): Config {
  const channels = parseChannelsList(process.env.DISCORD_CHANNELS)

  if (channels.length === 0) {
    throw new Error(
      'No Discord channels specified. Please set DISCORD_CHANNELS environment variable.',
    )
  }

  const config: Config = {
    channels,
    storageStatePath: process.env.STORAGE_STATE_PATH,
    database: loadDbConfig(),
    filtering: {
      enabled: process.env.ENABLE_FILTERING?.toLowerCase() === 'true' || true,
      trivialPhrases: parseTrivialPhrases(process.env.CUSTOM_TRIVIAL_PHRASES),
      minLength: parseInt(process.env.MIN_MESSAGE_LENGTH || '30'),
    },
  }

  // Validate configuration
  if (!config.database.password) {
    console.warn(
      'Warning: No database password specified. This may cause connection issues.',
    )
  }

  return config
}

export function validateConfig(config: Config): void {
  if (config.channels.length === 0) {
    throw new Error('At least one Discord channel must be specified')
  }

  if (config.channels.length > 10) {
    throw new Error(
      'Too many channels specified. Maximum is 10 to avoid rate limiting.',
    )
  }

  // Validate channel format
  for (const channel of config.channels) {
    if (!/^\d+$/.test(channel.guildId)) {
      throw new Error(
        `Invalid guild ID: ${channel.guildId}. Guild IDs should be numeric strings.`,
      )
    }
    if (!/^\d+$/.test(channel.channelId)) {
      throw new Error(
        `Invalid channel ID: ${channel.channelId}. Channel IDs should be numeric strings.`,
      )
    }
  }

  if (config.database.port < 1 || config.database.port > 65535) {
    throw new Error('Invalid database port. Must be between 1 and 65535.')
  }

  if (config.filtering.minLength < 0) {
    throw new Error('Minimum message length cannot be negative.')
  }
}
