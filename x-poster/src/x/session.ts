import type { Page } from 'playwright'
import type winston from 'winston'
import { FatalError, LoginRequiredError } from '../errors.js'
import { HOME_URL, selectors } from './selectors.js'

const ORIGIN = new URL(HOME_URL).origin

/**
 * The cookie X sets when a login succeeds.
 *
 * Only a gate, never the answer — see `isSessionLive`. If X ever renames it,
 * the gate stops opening and the wait heartbeat is what makes that visible
 * rather than silent.
 */
const SESSION_COOKIE = 'auth_token'

const DEFAULT_POLL_MS = 5_000
const DEFAULT_HEARTBEAT_MS = 60_000

/**
 * Confirms we are logged in, not merely that the page rendered.
 *
 * The positive signal is the account switcher rather than the timeline
 * column: the column can appear on a logged-out view too, so waiting on it
 * would let a dead session through and fail later, deeper in the script.
 *
 * The negative signal is the URL. A logged-out request for /home redirects
 * to x.com/ — verified against the live site — and that redirect is far more
 * durable than any testid on the landing page, which is why it decides the
 * message rather than the markup does.
 *
 * The two ways of being logged out raise `LoginRequiredError`, which parks
 * the poster until someone logs in. The third case — still on /home, but no
 * account switcher — stays fatal: nothing about it says "logged out", so it
 * is as likely to be a stale selector as a challenge, and waiting forever on
 * a selector that no longer exists is worse than stopping loudly.
 */
export async function assertLoggedIn(
  page: Page,
  timeoutMs = 25_000,
): Promise<void> {
  const outcome = await Promise.race([
    page
      .locator(selectors.accountSwitcher)
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => 'logged-in' as const)
      .catch(() => null),
    page
      .locator(selectors.loggedOutLanding)
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => 'logged-out' as const)
      .catch(() => null),
  ])

  if (outcome === 'logged-in') return

  const url = page.url()
  if (!url.startsWith(HOME_URL)) {
    throw new LoginRequiredError(
      `X redirected to ${url} instead of staying on ${HOME_URL}, which means ` +
        'the session has expired.',
    )
  }

  if (outcome === 'logged-out') {
    throw new LoginRequiredError('X served the logged-out landing page.')
  }

  throw new FatalError(
    `Still on ${url} but the account switcher never appeared. X may be ` +
      'showing a verification challenge, or the selectors in ' +
      'src/x/selectors.ts are out of date.',
  )
}

/**
 * True once the profile holds a live session again.
 *
 * The cookie is a gate, not the answer. Reading the jar costs nothing, sends
 * no request to X, and — this is the point — touches no tab. The operator is
 * most likely typing their password into the very tab we opened, and
 * reloading it under them every few seconds would destroy the login we are
 * waiting for. Only once the cookie appears, which is to say only once the
 * login has already succeeded, do we spend a navigation letting
 * `assertLoggedIn` give the authoritative answer.
 */
export async function isSessionLive(
  page: Page,
  confirmTimeoutMs = 25_000,
): Promise<boolean> {
  const cookies = await page.context().cookies(ORIGIN)
  const live = cookies.some((c) => c.name === SESSION_COOKIE && c.value !== '')
  if (!live) return false

  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' })
    await assertLoggedIn(page, confirmTimeoutMs)
    return true
  } catch (error) {
    // A stale cookie is just "not yet". Anything else — a challenge, rotted
    // selectors — is a real fault and must not be swallowed by the wait.
    if (error instanceof LoginRequiredError) return false
    throw error
  }
}

export interface WaitForLoginOptions {
  pollMs?: number
  heartbeatMs?: number
  /** Lets a shutdown interrupt what is otherwise an unbounded wait. */
  isCancelled?: () => boolean
  /** Injected in tests. */
  probe?: () => Promise<boolean>
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Blocks until someone logs in, or until the caller cancels.
 *
 * Unbounded on purpose. The alternative — give up after N minutes — turns a
 * recoverable pause into the circuit break this was written to avoid, and the
 * operator is the only one who can end the wait anyway.
 *
 * @returns true if the session came back, false if the wait was cancelled.
 */
export async function waitForLogin(
  page: Page,
  logger: winston.Logger,
  options: WaitForLoginOptions = {},
): Promise<boolean> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const isCancelled = options.isCancelled ?? (() => false)
  const probe = options.probe ?? (() => isSessionLive(page))
  const sleep =
    options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  const startedAt = Date.now()
  let lastHeartbeat = startedAt

  while (!isCancelled()) {
    if (await probe()) {
      logger.info('Session is live again, resuming', {
        waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
      })
      return true
    }

    const now = Date.now()
    if (now - lastHeartbeat >= heartbeatMs) {
      lastHeartbeat = now
      logger.warn('Still waiting for a manual login', {
        waitedSeconds: Math.round((now - startedAt) / 1000),
        watching: `the ${SESSION_COOKIE} cookie on ${ORIGIN}`,
      })
    }

    await sleep(pollMs)
  }

  return false
}
