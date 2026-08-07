import dotenv from 'dotenv'
import { parseWindows, type PostingWindow } from './queue/windows.js'

dotenv.config()

export interface XPosterConfig {
  profileDir: string
  debugPort: number
  chromePath: string
  dryRun: boolean
  minIntervalMinutes: number
  /** How far the derived gap may stray from its target, as a fraction. */
  intervalJitter: number
  dailyCap: number
  windows: PostingWindow[]
  timezone: string
  maxAttempts: number
  discordWebhookUrl: string | null
}

const DEFAULT_CHROME_PATH =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function requiredString(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`${key} is required`)
  return value
}

function positiveInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer, got: ${raw}`)
  }
  return value
}

/** A fraction in [0, 1). One is not allowed: a gap may not reach zero. */
function fraction(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`${key} must be at least 0 and below 1, got: ${raw}`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): XPosterConfig {
  // The two that have no defensible default, read first so that an empty
  // .env is answered with the most basic thing missing rather than with
  // whichever check happens to come first in the file.
  const profileDir = requiredString(env, 'X_PROFILE_DIR')
  // A default here would silently be the host's zone on one machine and the
  // operator's on another — which is the bug this replaced, not a
  // convenience. Both the windows and the daily cap are expressed in it.
  const timezone = requiredString(env, 'TIMEZONE')

  if (!env.X_WINDOWS) {
    throw new Error(
      env.X_ACTIVE_HOURS
        ? 'X_ACTIVE_HOURS has been replaced by X_WINDOWS, which gives each ' +
          'window its own quota. Set X_WINDOWS=06:00-08:00x4,17:00-23:00x6 ' +
          'and remove X_ACTIVE_HOURS and X_MAX_INTERVAL_MINUTES.'
        : 'X_WINDOWS is required, like "06:00-08:00x4,17:00-23:00x6"',
    )
  }

  const windows = parseWindows(env.X_WINDOWS)
  const dailyCap = positiveInt(env, 'X_DAILY_CAP', 10)
  const quotaTotal = windows.reduce((sum, window) => sum + window.quota, 0)

  if (quotaTotal > dailyCap) {
    // Quota that cannot be spent is a window that silently never fires,
    // which reads as "the evening is broken" rather than as a mistake here.
    throw new Error(
      `The window quotas (${quotaTotal}) exceed X_DAILY_CAP (${dailyCap})`,
    )
  }

  return {
    profileDir,
    debugPort: positiveInt(env, 'X_DEBUG_PORT', 9333),
    chromePath: env.X_CHROME_PATH || DEFAULT_CHROME_PATH,
    dryRun: (env.X_DRY_RUN ?? '').toLowerCase() === 'true',
    minIntervalMinutes: positiveInt(env, 'X_MIN_INTERVAL_MINUTES', 20),
    intervalJitter: fraction(env, 'X_INTERVAL_JITTER', 0.25),
    dailyCap,
    windows,
    timezone,
    maxAttempts: positiveInt(env, 'X_MAX_ATTEMPTS', 3),
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL || null,
  }
}
