import dotenv from 'dotenv'

dotenv.config()

/** Local-time posting window, expressed as minutes from midnight. */
export interface ActiveHours {
  startMinute: number
  endMinute: number
}

export interface XPosterConfig {
  profileDir: string
  debugPort: number
  chromePath: string
  dryRun: boolean
  minIntervalMinutes: number
  maxIntervalMinutes: number
  dailyCap: number
  activeHours: ActiveHours
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

/**
 * A window that wrapped past midnight would need its own set of comparisons
 * throughout the rate limiter. Rejecting it keeps one untested edge case out
 * of the scheduler entirely.
 */
function parseActiveHours(raw: string | undefined): ActiveHours {
  const value = raw ?? '09:00-23:00'
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(value)
  if (!match) {
    throw new Error(`X_ACTIVE_HOURS must look like "09:00-23:00", got: ${value}`)
  }

  const startHour = Number(match[1])
  const startMin = Number(match[2])
  const endHour = Number(match[3])
  const endMin = Number(match[4])

  if (startHour > 23 || endHour > 23 || startMin > 59 || endMin > 59) {
    throw new Error(`X_ACTIVE_HOURS contains an invalid time: ${value}`)
  }

  const startMinute = startHour * 60 + startMin
  const endMinute = endHour * 60 + endMin

  if (endMinute <= startMinute) {
    throw new Error(`X_ACTIVE_HOURS must not wrap past midnight, got: ${value}`)
  }

  return { startMinute, endMinute }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): XPosterConfig {
  const minIntervalMinutes = positiveInt(env, 'X_MIN_INTERVAL_MINUTES', 20)
  const maxIntervalMinutes = positiveInt(env, 'X_MAX_INTERVAL_MINUTES', 60)

  if (minIntervalMinutes > maxIntervalMinutes) {
    throw new Error(
      `X_MIN_INTERVAL_MINUTES (${minIntervalMinutes}) must not exceed ` +
        `X_MAX_INTERVAL_MINUTES (${maxIntervalMinutes})`,
    )
  }

  return {
    profileDir: requiredString(env, 'X_PROFILE_DIR'),
    debugPort: positiveInt(env, 'X_DEBUG_PORT', 9333),
    chromePath: env.X_CHROME_PATH || DEFAULT_CHROME_PATH,
    dryRun: (env.X_DRY_RUN ?? '').toLowerCase() === 'true',
    minIntervalMinutes,
    maxIntervalMinutes,
    dailyCap: positiveInt(env, 'X_DAILY_CAP', 10),
    activeHours: parseActiveHours(env.X_ACTIVE_HOURS),
    maxAttempts: positiveInt(env, 'X_MAX_ATTEMPTS', 3),
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL || null,
  }
}
