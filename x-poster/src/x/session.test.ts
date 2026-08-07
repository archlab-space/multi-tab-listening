import type { Page } from 'playwright'
import type winston from 'winston'
import { describe, expect, it, vi } from 'vitest'
import { FatalError, LoginRequiredError } from '../errors.js'
import { HOME_URL, selectors } from './selectors.js'
import { assertLoggedIn, isSessionLive, waitForLogin } from './session.js'

interface FakePageOptions {
  visible?: string[]
  url?: string
  /** Where a navigation actually lands. This is how being logged out looks. */
  redirectTo?: string
  cookies?: { name: string; value: string }[]
}

/**
 * The slice of Playwright's `Page` that `session.ts` actually touches.
 *
 * `goto` is recorded rather than ignored: not navigating while the operator
 * may be halfway through a login form is a property worth asserting.
 */
function fakePage(options: FakePageOptions = {}) {
  const visible = new Set(options.visible ?? [])
  const goto = vi.fn()
  let url = options.url ?? HOME_URL

  const page = {
    url: () => url,
    goto: async (target: string) => {
      goto(target)
      url = options.redirectTo ?? target
    },
    locator: (selector: string) => ({
      first: () => ({
        waitFor: async ({ timeout }: { timeout: number }) => {
          if (visible.has(selector)) return
          await new Promise((resolve) => setTimeout(resolve, timeout))
          throw new Error(`Timeout ${timeout}ms exceeded.`)
        },
      }),
    }),
    context: () => ({ cookies: async () => options.cookies ?? [] }),
  }

  return { page: page as unknown as Page, goto }
}

function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as winston.Logger
}

describe('assertLoggedIn', () => {
  it('returns once the account switcher is visible', async () => {
    const { page } = fakePage({ visible: [selectors.accountSwitcher] })
    await expect(assertLoggedIn(page, 20)).resolves.toBeUndefined()
  })

  /**
   * The distinction this whole change rests on. A dead session is a request
   * for a person, not a fault: classifying it fatal breaks the circuit and
   * tears down the browser the operator is being told to log into.
   */
  it('asks for a login, not a circuit break, when X redirects away from /home', async () => {
    const { page } = fakePage({ url: 'https://x.com/' })
    await expect(assertLoggedIn(page, 20)).rejects.toBeInstanceOf(
      LoginRequiredError,
    )
    await expect(assertLoggedIn(page, 20)).rejects.not.toBeInstanceOf(
      FatalError,
    )
  })

  it('asks for a login when the logged-out landing page is served', async () => {
    const { page } = fakePage({ visible: [selectors.loggedOutLanding] })
    await expect(assertLoggedIn(page, 20)).rejects.toBeInstanceOf(
      LoginRequiredError,
    )
  })

  /**
   * Stays fatal. Nothing here says "logged out", so it is as likely to be a
   * stale selector as a challenge, and waiting forever on a selector that no
   * longer exists is worse than stopping loudly.
   */
  it('stays fatal when the page is on /home but shows neither signal', async () => {
    const { page } = fakePage()
    await expect(assertLoggedIn(page, 20)).rejects.toBeInstanceOf(FatalError)
  })
})

describe('isSessionLive', () => {
  it('does not navigate while no session cookie exists', async () => {
    const { page, goto } = fakePage({ cookies: [] })
    await expect(isSessionLive(page, 20)).resolves.toBe(false)
    expect(goto).not.toHaveBeenCalled()
  })

  it('ignores a session cookie that has been blanked out', async () => {
    const { page, goto } = fakePage({
      cookies: [{ name: 'auth_token', value: '' }],
    })
    await expect(isSessionLive(page, 20)).resolves.toBe(false)
    expect(goto).not.toHaveBeenCalled()
  })

  it('confirms with a real navigation once the cookie appears', async () => {
    const { page, goto } = fakePage({
      cookies: [{ name: 'auth_token', value: 'abc' }],
      visible: [selectors.accountSwitcher],
    })
    await expect(isSessionLive(page, 20)).resolves.toBe(true)
    expect(goto).toHaveBeenCalledWith(HOME_URL)
  })

  it('keeps waiting when the cookie is there but the session still is not', async () => {
    const { page } = fakePage({
      cookies: [{ name: 'auth_token', value: 'stale' }],
      redirectTo: 'https://x.com/',
    })
    await expect(isSessionLive(page, 20)).resolves.toBe(false)
  })

  it('propagates a genuinely fatal page instead of swallowing it', async () => {
    const { page } = fakePage({
      cookies: [{ name: 'auth_token', value: 'abc' }],
    })
    await expect(isSessionLive(page, 20)).rejects.toBeInstanceOf(FatalError)
  })
})

describe('waitForLogin', () => {
  const sleep = () => Promise.resolve()

  it('returns immediately when the session is already live', async () => {
    const probe = vi.fn().mockResolvedValue(true)
    await expect(
      waitForLogin(fakePage().page, fakeLogger(), { probe, sleep }),
    ).resolves.toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('keeps polling until the operator finishes logging in', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)

    await expect(
      waitForLogin(fakePage().page, fakeLogger(), { probe, sleep }),
    ).resolves.toBe(true)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  /** Ctrl-C during an unbounded wait has to be answered. */
  it('gives up when the caller cancels', async () => {
    const probe = vi.fn().mockResolvedValue(false)
    let calls = 0
    const isCancelled = () => ++calls > 3

    await expect(
      waitForLogin(fakePage().page, fakeLogger(), { probe, sleep, isCancelled }),
    ).resolves.toBe(false)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('says out loud that it is still waiting, so a silent wait is visible', async () => {
    const logger = fakeLogger()
    const probe = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)

    await waitForLogin(fakePage().page, logger, {
      probe,
      sleep,
      heartbeatMs: 0,
    })

    expect(logger.warn).toHaveBeenCalled()
  })
})
