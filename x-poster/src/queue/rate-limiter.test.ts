import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { mulberry32 } from '../human/delay.js'
import { decide, type PostingHistory } from './rate-limiter.js'

const config = loadConfig({
  X_PROFILE_DIR: '/tmp/x-profile',
  X_ACTIVE_HOURS: '09:00-23:00',
  X_MIN_INTERVAL_MINUTES: '20',
  X_MAX_INTERVAL_MINUTES: '60',
  X_DAILY_CAP: '10',
  TIMEZONE: 'Asia/Shanghai',
} as NodeJS.ProcessEnv)

/**
 * A zoneless literal, which `Date` reads as host time.
 *
 * These cases only hold when the host runs the same zone the config names.
 * The window and the cap are expressed in `config.timezone` now, not in the
 * host's clock — the case that pins that down is at the bottom of the file
 * and states its instants in UTC.
 */
function at(iso: string): Date {
  return new Date(iso)
}

const fresh: PostingHistory = { lastPostedAt: null, postedToday: 0 }
const rng = () => mulberry32(2026)()

describe('decide', () => {
  it('allows a first post inside the window', () => {
    const result = decide(at('2026-08-04T12:00:00'), fresh, config, rng)
    expect(result).toEqual({ allowed: true, waitUntil: null, reason: 'ok' })
  })

  it('waits until the window opens when the day has not started', () => {
    const result = decide(at('2026-08-04T07:30:00'), fresh, config, rng)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('outside-active-hours')
    expect(result.waitUntil).toEqual(at('2026-08-04T09:00:00'))
  })

  it('waits until tomorrow when the window has already closed', () => {
    const result = decide(at('2026-08-04T23:30:00'), fresh, config, rng)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('outside-active-hours')
    expect(result.waitUntil).toEqual(at('2026-08-05T09:00:00'))
  })

  it('treats the window start as inside the window', () => {
    expect(decide(at('2026-08-04T09:00:00'), fresh, config, rng).allowed).toBe(
      true,
    )
  })

  it('treats the window end as outside the window', () => {
    expect(decide(at('2026-08-04T23:00:00'), fresh, config, rng).allowed).toBe(
      false,
    )
  })

  it('holds off until the sampled interval has elapsed', () => {
    const result = decide(
      at('2026-08-04T12:05:00'),
      { lastPostedAt: at('2026-08-04T12:00:00'), postedToday: 1 },
      config,
      rng,
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('interval')

    const waitMinutes =
      (result.waitUntil!.getTime() - at('2026-08-04T12:00:00').getTime()) / 60000
    expect(waitMinutes).toBeGreaterThanOrEqual(20)
    expect(waitMinutes).toBeLessThanOrEqual(60)
  })

  it('allows the next post once the ceiling interval has passed', () => {
    const result = decide(
      at('2026-08-04T13:30:00'),
      { lastPostedAt: at('2026-08-04T12:00:00'), postedToday: 1 },
      config,
      rng,
    )
    expect(result).toEqual({ allowed: true, waitUntil: null, reason: 'ok' })
  })

  it('stops at the daily cap and waits for tomorrow', () => {
    const result = decide(
      at('2026-08-04T14:00:00'),
      { lastPostedAt: at('2026-08-04T13:00:00'), postedToday: 10 },
      config,
      rng,
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('daily-cap')
    expect(result.waitUntil).toEqual(at('2026-08-05T09:00:00'))
  })

  it('checks the daily cap before the interval', () => {
    // At the cap, the answer is "not today", not "in 20 minutes".
    const result = decide(
      at('2026-08-04T22:59:00'),
      { lastPostedAt: at('2026-08-04T22:58:00'), postedToday: 10 },
      config,
      rng,
    )
    expect(result.reason).toBe('daily-cap')
  })

  it('checks the active-hours window before anything else', () => {
    const result = decide(
      at('2026-08-04T03:00:00'),
      { lastPostedAt: at('2026-08-03T22:00:00'), postedToday: 10 },
      config,
      rng,
    )
    expect(result.reason).toBe('outside-active-hours')
  })

  it('never proposes a wait in the past', () => {
    for (const hour of [0, 6, 9, 15, 22, 23]) {
      const now = at(`2026-08-04T${String(hour).padStart(2, '0')}:00:00`)
      const result = decide(now, { lastPostedAt: now, postedToday: 3 }, config, rng)
      if (result.waitUntil) {
        expect(result.waitUntil.getTime()).toBeGreaterThanOrEqual(now.getTime())
      }
    }
  })
})

describe('the day boundary', () => {
  const fresh: PostingHistory = { lastPostedAt: null, postedToday: 0 }

  it('reads the window in the configured zone, not the host clock', () => {
    // 2026-08-06T02:00Z is 10:00 in Shanghai — inside 09:00-23:00 — and
    // 04:00 in Berlin, well outside it. Only the config may decide, so a
    // host anywhere in the world has to get the same verdict here.
    const at = new Date('2026-08-06T02:00:00.000Z')

    expect(decide(at, fresh, { ...config, timezone: 'Asia/Shanghai' }).reason)
      .not.toBe('outside-active-hours')
    expect(
      decide(at, fresh, { ...config, timezone: 'Europe/Berlin' }).reason,
    ).toBe('outside-active-hours')
  })

  it('resets the cap on the configured zone’s midnight', () => {
    // 2026-08-06T16:30Z is 00:30 on the 7th in Shanghai: a new day, so a cap
    // spent yesterday is no longer the reason to hold off.
    const justAfterMidnight = new Date('2026-08-06T16:30:00.000Z')
    const spent: PostingHistory = { lastPostedAt: null, postedToday: 10 }

    expect(
      decide(justAfterMidnight, spent, {
        ...config,
        timezone: 'Asia/Shanghai',
      }).reason,
    ).not.toBe('daily-cap')
  })
})
