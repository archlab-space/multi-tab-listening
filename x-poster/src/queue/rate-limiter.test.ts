import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { mulberry32 } from '../human/delay.js'
import { decide, startOfDay, type PostingHistory } from './rate-limiter.js'

const config = loadConfig({
  X_PROFILE_DIR: '/tmp/x-profile',
  X_ACTIVE_HOURS: '09:00-23:00',
  X_MIN_INTERVAL_MINUTES: '20',
  X_MAX_INTERVAL_MINUTES: '60',
  X_DAILY_CAP: '10',
} as NodeJS.ProcessEnv)

/** Local time, since the active-hours window is expressed in local time. */
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

describe('startOfDay', () => {
  it('returns local midnight', () => {
    expect(startOfDay(at('2026-08-04T17:43:21'))).toEqual(
      at('2026-08-04T00:00:00'),
    )
  })
})
