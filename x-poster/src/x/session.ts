import type { Page } from 'playwright'
import { FatalError } from '../errors.js'
import { HOME_URL, selectors } from './selectors.js'

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
 * Every failure here is fatal rather than retryable: neither a dead session
 * nor a vanished app shell gets better by trying again, and repeatedly
 * hitting X with a challenged session only deepens the problem.
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
    throw new FatalError(
      `X redirected to ${url} instead of staying on ${HOME_URL}, which means ` +
        'the session has expired. Log in manually in the dedicated Chrome ' +
        'profile, then restart the service.',
    )
  }

  if (outcome === 'logged-out') {
    throw new FatalError(
      'X served the logged-out landing page. Log in manually in the ' +
        'dedicated Chrome profile, then restart the service.',
    )
  }

  throw new FatalError(
    `Still on ${url} but the account switcher never appeared. X may be ` +
      'showing a verification challenge, or the selectors in ' +
      'src/x/selectors.ts are out of date.',
  )
}
