import dotenv from 'dotenv'
import { loadDbConfig, type DbConfig } from 'shared/db'

dotenv.config()

/** The five AgentLens dispatch kinds this service draws from. */
export type SourceKind =
  | 'lab_article'
  | 'gh_project'
  | 'x_digest'
  | 'hn_story'
  | 'youtube_video'

/**
 * Priority order, highest first. Breaks ties in the quota picker and decides
 * the order the caller falls through when a pool is empty.
 */
export const SOURCE_PRIORITY: readonly SourceKind[] = [
  'lab_article',
  'gh_project',
  'x_digest',
  'hn_story',
  'youtube_video',
]

export type Quota = Record<SourceKind, number>

export interface LlmConfig {
  baseUrl: string
  apiKey: string | null
  model: string
  timeoutMs: number
}

export interface GeneratorConfig {
  db: DbConfig
  agentlensBaseUrl: string
  llm: LlmConfig
  queueTarget: number
  queuePollMinutes: number
  emptyPoolMinutes: number
  dailyCap: number
  quota: Quota
  projectCooldownDays: number
  projectMinVelocityPerDay: number
  timezone: string
  maxRounds: number
  bannedPhrasesFile: string
  mediaDir: string
  mediaRetentionDays: number
  discordWebhookUrl: string | null
}

function nonNegativeInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer, got: ${raw}`)
  }
  return value
}

function positiveInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const value = nonNegativeInt(env, key, fallback)
  if (value < 1) throw new Error(`${key} must be a positive integer`)
  return value
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): GeneratorConfig {
  const model = env.LLM_MODEL
  if (!model) {
    throw new Error(
      'LLM_MODEL is required. OmniRoute falls back across provider tiers, ' +
        'so an unpinned model means a different writer every day.',
    )
  }
  if (model.toLowerCase() === 'auto') {
    throw new Error(
      'LLM_MODEL must be pinned to a specific model, not "auto". Unattended ' +
        "posts inherit the router's quality floor as the account's.",
    )
  }

  const quota: Quota = {
    lab_article: nonNegativeInt(env, 'QUOTA_LAB', 4),
    gh_project: nonNegativeInt(env, 'QUOTA_PROJECT', 3),
    x_digest: nonNegativeInt(env, 'QUOTA_DIGEST', 1),
    hn_story: nonNegativeInt(env, 'QUOTA_HN', 1),
    youtube_video: nonNegativeInt(env, 'QUOTA_YOUTUBE', 1),
  }

  const dailyCap = positiveInt(env, 'DAILY_CAP', 10)
  const quotaTotal = Object.values(quota).reduce((sum, n) => sum + n, 0)
  if (quotaTotal > dailyCap) {
    // Quota that cannot be spent is quota that silently never fires, which
    // reads as "the lowest-priority source is broken" rather than as a
    // configuration mistake.
    throw new Error(
      `The quota total (${quotaTotal}) exceeds DAILY_CAP (${dailyCap})`,
    )
  }


  return {
    db: loadDbConfig(env),
    agentlensBaseUrl: env.AGENTLENS_BASE_URL || 'https://api.agentlenshq.com',
    llm: {
      baseUrl: env.LLM_BASE_URL || 'http://localhost:20128/v1',
      apiKey: env.LLM_API_KEY || null,
      model,
      timeoutMs: positiveInt(env, 'LLM_TIMEOUT_MS', 120_000),
    },
    // How much stock to hold, not how often to produce. x-poster sets the
    // pace; this only has to cover the gap between one being taken and the
    // next being written.
    queueTarget: positiveInt(env, 'QUEUE_TARGET', 2),
    // The full-buffer check is a bare COUNT, so it can afford to be frequent.
    queuePollMinutes: positiveInt(env, 'QUEUE_POLL_MINUTES', 5),
    // A cycle that produced nothing spent an AgentLens call to find out, so
    // this one cannot be.
    emptyPoolMinutes: positiveInt(env, 'EMPTY_POOL_MINUTES', 30),
    dailyCap,
    quota,
    projectCooldownDays: nonNegativeInt(env, 'PROJECT_COOLDOWN_DAYS', 7),
    projectMinVelocityPerDay: nonNegativeInt(
      env,
      'PROJECT_MIN_VELOCITY_PER_DAY',
      20,
    ),
    timezone: env.TIMEZONE || 'Asia/Shanghai',
    maxRounds: positiveInt(env, 'MAX_ROUNDS', 3),
    bannedPhrasesFile: env.BANNED_PHRASES_FILE || './banned-phrases.json',
    mediaDir: env.MEDIA_DIR || './media',
    mediaRetentionDays: nonNegativeInt(env, 'MEDIA_RETENTION_DAYS', 7),
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL || null,
  }
}
