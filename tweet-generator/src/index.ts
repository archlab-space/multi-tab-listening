import { createPool } from 'shared/db'
import { formatError } from 'shared/errors'
import { createLogger } from 'shared/logger'
import { notifyFailure } from 'shared/notifier'
import { mulberry32, type Rng } from 'shared/rng'
import { loadConfig } from './config.js'
import { cleanupMedia, mediaPathFor, renderCard } from './image/render.js'
import { pickVariant, renderTemplate } from './image/template.js'
import { ARCHETYPES, pickArchetype } from './llm/archetypes.js'
import { LlmClient, LlmError } from './llm/client.js'
import {
  generateTweet,
  GenerationGaveUp,
  type PipelineResult,
} from './llm/pipeline.js'
import { loadBannedPhrases, type BannedPhrases } from './llm/validate.js'
import { startOfDayIn } from './select/clock.js'
import { selectCandidate, type PoolDeps } from './select/pool.js'
import { orderKinds } from './select/quota.js'
import { AgentLensClient, AgentLensError } from './sources/agentlens.js'
import { GeneratorStore } from './store.js'

const logger = createLogger('tweet-generator.log')
const config = loadConfig()
const pool = createPool(config.db)
const store = new GeneratorStore(pool)
const agentlens = new AgentLensClient(config.agentlensBaseUrl)
const llm = new LlmClient(config.llm)

/** Loaded once, on the first cycle that needs it. */
let banned: BannedPhrases | null = null

/**
 * Unlike the archetype, this is not worth a database column: repeating a
 * card style is far less visible than repeating a post shape, and losing the
 * value on restart costs nothing.
 */
let lastVariant: string | null = null

const deps: PoolDeps = {
  listBlogs: (jobType, limit) => agentlens.listBlogs(jobType, limit),
  getBlog: (id) => agentlens.getBlog(id),
  listProjects: (limit) => agentlens.listProjects(limit),
  getProject: (id) => agentlens.getProject(id),
  knownDedupeKeys: (keys) => store.knownDedupeKeys(keys),
  failureCounts: (ids) => store.failureCounts(ids),
  projectPostedSince: (ref, since) => store.projectPostedSince(ref, since),
}

let stopping = false
let consecutiveSourceFailures = 0
/** Latched, so a quiet week produces one alert rather than eighty. */
let alertedIdle = false

/** Sleeps, but wakes early on shutdown. */
async function sleep(ms: number): Promise<void> {
  const step = 1000
  let elapsed = 0
  while (elapsed < ms && !stopping) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(step, ms - elapsed)),
    )
    elapsed += step
  }
}

/**
 * Exact spacing between cycles is itself a machine signature, so the
 * interval is resampled every time inside ± the configured jitter.
 */
function nextIntervalMs(rng: Rng = Math.random): number {
  const spread = config.cycleJitterMinutes * 2
  const minutes =
    config.cycleMinutes - config.cycleJitterMinutes + rng() * spread
  return Math.round(minutes * 60_000)
}

/**
 * Warns when the queue has gained nothing for a day.
 *
 * Every other alert fires on something going wrong. This one fires on
 * nothing happening at all — a niche gate that rejects everything, or a
 * quota misconfiguration, produces no errors and no posts, and would
 * otherwise be noticed only by the absence of tweets.
 */
async function checkIdleWatchdog(now: Date): Promise<void> {
  const last = await store.lastEnqueuedAt()
  if (!last) return
  const idleHours = (now.getTime() - last.getTime()) / 3_600_000
  if (idleHours < 24 || alertedIdle) return

  alertedIdle = true
  await notifyFailure(
    config.discordWebhookUrl,
    'tweet-generator',
    `Nothing has been enqueued for ${Math.floor(idleHours)} hours. ` +
      'Every pool may be empty, or the quota may be misconfigured.',
  )
}

async function tick(): Promise<void> {
  const now = new Date()
  await checkIdleWatchdog(now)

  const retentionCutoff = new Date(
    now.getTime() - config.mediaRetentionDays * 86_400_000,
  )
  const removed = await cleanupMedia(await store.expiredMedia(retentionCutoff))
  if (removed > 0) logger.info('Cleaned up old media', { removed })

  const dayStart = startOfDayIn(config.timezone, now)
  const usage = await store.usageSince(dayStart)
  const order = orderKinds(now, usage, config)

  if (order.length === 0) {
    logger.info('Nothing left to spend today', { total: usage.total })
    return
  }

  for (const kind of order) {
    const candidate = await selectCandidate(kind, now, config, deps)
    if (!candidate) {
      logger.debug('Pool empty, falling through', { kind })
      continue
    }

    banned ??= await loadBannedPhrases(config.bannedPhrasesFile)
    const archetype = pickArchetype(await store.lastArchetype())

    // Declared outside the try so the card renderer can reach the draft.
    let generated: PipelineResult
    try {
      generated = await generateTweet(candidate, archetype, {
        chat: (messages) => llm.chat(messages),
        banned,
        maxRounds: config.maxRounds,
      })
      logger.info('Generated', {
        externalId: candidate.externalId,
        archetype,
        rounds: generated.rounds,
      })
    } catch (error) {
      if (error instanceof GenerationGaveUp) {
        // The candidate stays out of the pool for good after three of these,
        // so one item the model cannot handle cannot starve its source.
        await store.recordFailure(
          candidate.externalId,
          error.violations.join('; '),
        )
        logger.warn('Gave up on a candidate', {
          externalId: candidate.externalId,
          violations: error.violations,
        })
        return
      }
      throw error
    }

    let mediaPath: string | undefined
    if (ARCHETYPES[archetype].hasImage) {
      const cardArchetype = archetype as 'digest' | 'metric'
      const variant = pickVariant(cardArchetype, lastVariant)
      const path = mediaPathFor(config.mediaDir, candidate.dedupeKey)
      // A render failure abandons the whole item. Enqueueing the text alone
      // would ship a degraded post that can never be repaired, because the
      // dedupe key is spent the moment the row exists.
      await renderCard(
        renderTemplate({ draft: generated.draft, candidate, variant }),
        path,
      )
      lastVariant = variant
      mediaPath = path
      logger.debug('Rendered a card', { path, variant })
    }

    const id = await store.enqueue({
      content: generated.text,
      dedupeKey: candidate.dedupeKey,
      source: candidate.kind,
      sourceRef: candidate.externalId,
      archetype,
      mediaPath,
    })

    if (id === null) {
      // Another process won the race, or the key was already spent.
      logger.info('Already queued, skipping', { key: candidate.dedupeKey })
      return
    }

    alertedIdle = false
    logger.info('Enqueued', {
      id,
      kind: candidate.kind,
      externalId: candidate.externalId,
    })
    return
  }

  logger.info('Every pool was empty this cycle')
}

async function shutdown(reason: string, code: number): Promise<void> {
  if (stopping) return
  stopping = true
  logger.info('Shutting down', { reason })
  await pool.end().catch(() => {})
  process.exit(code)
}

async function main(): Promise<void> {
  logger.info('Starting tweet-generator', {
    model: config.llm.model,
    dailyCap: config.dailyCap,
    cycleMinutes: config.cycleMinutes,
    timezone: config.timezone,
  })

  process.on('SIGINT', () => void shutdown('SIGINT', 0))
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0))

  const rng = mulberry32(Date.now() & 0xffffffff)

  while (!stopping) {
    try {
      await tick()
      consecutiveSourceFailures = 0
    } catch (error) {
      const message = formatError(error)

      if (error instanceof AgentLensError || error instanceof LlmError) {
        consecutiveSourceFailures += 1
        logger.warn('An upstream dependency is unreachable', {
          error: message,
          consecutive: consecutiveSourceFailures,
        })
        // Three cycles is roughly six hours of silence — long enough to be
        // a real outage rather than a blip, short enough to still matter.
        if (consecutiveSourceFailures === 3) {
          await notifyFailure(
            config.discordWebhookUrl,
            'tweet-generator',
            `Upstream unreachable for ${consecutiveSourceFailures} cycles: ${message}`,
          )
        }
      } else {
        // Unlike x-poster, an unexpected failure here is not a reason to
        // stop: nothing has been posted, and the next cycle starts fresh.
        logger.error('Cycle failed', { error: message })
      }
    }

    await sleep(nextIntervalMs(rng))
  }
}

main().catch(async (error) => {
  const message = formatError(error)
  logger.error('Unrecoverable startup failure', { error: message })
  await notifyFailure(config.discordWebhookUrl, 'tweet-generator', message)
  await shutdown('startup failure', 1)
})
