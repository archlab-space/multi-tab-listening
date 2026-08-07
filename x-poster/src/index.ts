import { createPool } from 'shared/db'
import { createLogger } from 'shared/logger'
import {
  connectOrLaunch,
  type BrowserHandle,
} from './browser/chrome-launcher.js'
import { loadConfig } from './config.js'
import {
  FatalError,
  LoginRequiredError,
  RetryableError,
  UncertainError,
  classifyError,
} from './errors.js'
import { notifyAttention, notifyFailure } from 'shared/notifier'
import { decide } from './queue/rate-limiter.js'
import { TweetQueue } from './queue/tweet-queue.js'
import { postTweet } from './x/composer.js'
import { waitForLogin } from './x/session.js'

const logger = createLogger('x-poster.log')
const config = loadConfig()
const pool = createPool()
const queue = new TweetQueue(pool)

/**
 * The browser is held as the in-flight promise, not the resolved handle.
 *
 * Shutting down mid-launch used to see a null handle and skip the cleanup
 * entirely, leaving behind a Chrome nobody owned. Holding the promise means
 * shutdown can await the launch it interrupted and then close it.
 */
let browserPromise: Promise<BrowserHandle> | null = null
let stopping = false

/** How long cleanup gets before the process leaves anyway. */
const CLEANUP_TIMEOUT_MS = 10_000

async function getBrowser(): Promise<BrowserHandle> {
  if (!browserPromise) {
    browserPromise = connectOrLaunch(config, logger).catch((error) => {
      // Never cache a failed launch, or every later tick inherits it.
      browserPromise = null
      throw error
    })
  }
  return browserPromise
}

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
  const verdict = decide(now, await queue.history(config.timezone, now), config)

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

  const handle = await getBrowser()

  try {
    const result = await postTweet(
      handle.page,
      tweet.content,
      tweet.mediaPath,
      config,
      logger,
    )

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

    if (error instanceof LoginRequiredError) {
      // Hand the tweet back before settling in to wait. The wait has no upper
      // bound, and a row left in `sending` for hours is invisible to every
      // other process — including the next run of this one.
      await queue.releaseForRetry(tweet.id, error.message, new Date(), {
        refundAttempt: true,
      })

      logger.warn('Session expired — waiting for a manual login', {
        id: tweet.id,
        profileDir: config.profileDir,
      })
      await notifyAttention(
        config.discordWebhookUrl,
        'x-poster',
        `${error.message}\n\nChrome is still open. Log in to the profile at ` +
          `${config.profileDir} and posting resumes on its own — no restart ` +
          'needed.',
      )

      // Chrome deliberately stays up: it is the window being logged into.
      await waitForLogin(handle.page, logger, { isCancelled: () => stopping })
      return
    }

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
        logger.error('Giving up', {
          id: tweet.id,
          attempts: tweet.attempts,
          error: error.message,
        })
        return
      }
      const retryAt = new Date(Date.now() + backoffMs(tweet.attempts))
      await queue.releaseForRetry(tweet.id, error.message, retryAt)
      logger.warn('Retrying later', {
        id: tweet.id,
        retryAt: retryAt.toISOString(),
        error: error.message,
      })
      return
    }

    await queue.releaseForRetry(tweet.id, error.message, new Date())
    throw error
  }
}

/** Resolves when `work` settles, or when `ms` is up — whichever is first. */
function atMost(work: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    work.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ])
}

/**
 * Winston's file transport writes asynchronously and `process.exit` does not
 * wait for it, so the last lines — the ones saying why we stopped — were the
 * ones most likely to be missing from x-poster.log.
 */
function flushLogs(): Promise<unknown> {
  return atMost(
    new Promise((resolve) => {
      logger.once('finish', resolve)
      logger.end()
    }),
    2_000,
  )
}

async function shutdown(reason: string, code: number): Promise<void> {
  if (stopping) {
    // Already cleaning up, and here comes a second signal: the operator is
    // telling us the tidy exit is taking too long. Go now.
    process.exit(code)
  }
  stopping = true
  logger.info('Shutting down', { reason })

  // Bounded, and both at once. A wedged browser or a pool with a query still
  // in flight must not leave the process half-dead in the terminal, which
  // from the outside is indistinguishable from a hang.
  await atMost(
    Promise.allSettled([
      browserPromise?.then((handle) => handle.close()) ?? Promise.resolve(),
      pool.end(),
    ]),
    CLEANUP_TIMEOUT_MS,
  )

  await flushLogs()
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

      if (error instanceof LoginRequiredError) {
        // Reached only if one escapes `tick`, which handles its own. Never a
        // circuit break: breaking the circuit closes the browser, and this is
        // precisely the error that needs the browser left open.
        logger.warn('Session expired outside a post — waiting for a login', {
          error: error.message,
        })
        const handle = await getBrowser()
        await waitForLogin(handle.page, logger, { isCancelled: () => stopping })
        continue
      }

      // Circuit break. A challenge or a changed page makes every subsequent
      // attempt fail too, and hammering a challenged account only deepens
      // the problem.
      logger.error('Circuit break', { error: error.message })
      await notifyFailure(config.discordWebhookUrl, 'x-poster', error.message)
      await shutdown('circuit break', 1)
    }
  }
}

main().catch(async (error) => {
  logger.error('Unrecoverable startup failure', { error: String(error) })
  await notifyFailure(config.discordWebhookUrl, 'x-poster', String(error))
  await shutdown('startup failure', 1)
})
