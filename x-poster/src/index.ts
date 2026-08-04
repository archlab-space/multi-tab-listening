import { createPool } from 'shared/db'
import { createLogger } from 'shared/logger'
import {
  connectOrLaunch,
  type BrowserHandle,
} from './browser/chrome-launcher.js'
import { loadConfig } from './config.js'
import {
  FatalError,
  RetryableError,
  UncertainError,
  classifyError,
} from './errors.js'
import { notifyCircuitBreak } from './notifier.js'
import { decide } from './queue/rate-limiter.js'
import { TweetQueue } from './queue/tweet-queue.js'
import { postTweet } from './x/composer.js'

const logger = createLogger('x-poster.log')
const config = loadConfig()
const pool = createPool()
const queue = new TweetQueue(pool)

let handle: BrowserHandle | null = null
let stopping = false

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

function backoffMs(attempts: number): number {
  return Math.min(30 * 60_000, 60_000 * 2 ** (attempts - 1))
}

async function tick(): Promise<void> {
  const now = new Date()
  const verdict = decide(now, await queue.history(now), config)

  if (!verdict.allowed) {
    const waitMs = Math.max(1000, verdict.waitUntil!.getTime() - now.getTime())
    logger.info('Holding off', {
      reason: verdict.reason,
      until: verdict.waitUntil!.toISOString(),
    })
    await sleep(waitMs)
    return
  }

  const tweet = await queue.claimNext(now)
  if (!tweet) {
    await sleep(60_000)
    return
  }

  logger.info('Claimed a tweet', { id: tweet.id, attempt: tweet.attempts })

  if (!handle) {
    handle = await connectOrLaunch(config, logger)
  }

  try {
    const result = await postTweet(handle.page, tweet.content, config, logger)

    if (result.dryRun) {
      // A dry run proves nothing about delivery, so the row stays claimable.
      await queue.releaseForRetry(tweet.id, 'dry run: not submitted', new Date())
      logger.info('Dry run complete, tweet returned to the queue', {
        id: tweet.id,
      })
      await sleep(30_000)
      return
    }

    await queue.markPosted(tweet.id, result.url)
    logger.info('Posted', { id: tweet.id })
  } catch (raw) {
    const error = classifyError(raw)

    if (error instanceof UncertainError) {
      await queue.markUncertain(tweet.id, error.message)
      logger.error('Outcome unknown — not retrying', {
        id: tweet.id,
        error: error.message,
      })
      throw new FatalError(
        `Tweet ${tweet.id} may or may not have been posted: ${error.message}`,
      )
    }

    if (error instanceof RetryableError) {
      if (tweet.attempts >= config.maxAttempts) {
        await queue.markFailed(tweet.id, error.message)
        logger.error('Giving up', { id: tweet.id, attempts: tweet.attempts })
        return
      }
      const retryAt = new Date(Date.now() + backoffMs(tweet.attempts))
      await queue.releaseForRetry(tweet.id, error.message, retryAt)
      logger.warn('Retrying later', {
        id: tweet.id,
        retryAt: retryAt.toISOString(),
      })
      return
    }

    await queue.releaseForRetry(tweet.id, error.message, new Date())
    throw error
  }
}

async function shutdown(reason: string, code: number): Promise<void> {
  if (stopping) return
  stopping = true
  logger.info('Shutting down', { reason })
  await handle?.close().catch(() => {})
  await pool.end().catch(() => {})
  process.exit(code)
}

async function main(): Promise<void> {
  logger.info('Starting x-poster', {
    dryRun: config.dryRun,
    dailyCap: config.dailyCap,
    activeHours: config.activeHours,
  })

  process.on('SIGINT', () => void shutdown('SIGINT', 0))
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0))

  while (!stopping) {
    try {
      await tick()
    } catch (raw) {
      const error = classifyError(raw)
      if (error instanceof RetryableError) {
        logger.warn('Transient failure in the loop, backing off', {
          error: error.message,
        })
        await sleep(120_000)
        continue
      }

      // Circuit break. A dead session makes every subsequent attempt fail
      // too, and hammering a challenged account only deepens the problem.
      logger.error('Circuit break', { error: error.message })
      await notifyCircuitBreak(config.discordWebhookUrl, error.message)
      await shutdown('circuit break', 1)
    }
  }
}

main().catch(async (error) => {
  logger.error('Unrecoverable startup failure', { error: String(error) })
  await notifyCircuitBreak(config.discordWebhookUrl, String(error))
  await shutdown('startup failure', 1)
})
