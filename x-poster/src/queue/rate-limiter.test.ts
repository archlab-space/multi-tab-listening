import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { mulberry32 } from '../human/delay.js'
import { decide, nextGapMinutes, type PostingHistory } from './rate-limiter.js'

const config = loadConfig({
  X_PROFILE_DIR: '/tmp/x-profile',
  X_WINDOWS: '09:00-23:00x10',
  X_MIN_INTERVAL_MINUTES: '20',
  X_INTERVAL_JITTER: '0.25',
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

const fresh: PostingHistory = {
  lastPostedAt: null,
  postedToday: 0,
  postedInWindow: 0,
}
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

  it('holds off until the derived gap has elapsed', () => {
    const result = decide(
      at('2026-08-04T12:05:00'),
      {
        lastPostedAt: at('2026-08-04T12:00:00'),
        postedToday: 1,
        postedInWindow: 1,
      },
      config,
      rng,
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('interval')

    const waitMinutes =
      (result.waitUntil!.getTime() - at('2026-08-04T12:00:00').getTime()) / 60000
    // Nine of the ten remain and the window closes at 23:00, so the target
    // is 660/10 = 66 minutes and the jitter puts it in 49.5-82.5.
    expect(waitMinutes).toBeGreaterThanOrEqual(49.5)
    expect(waitMinutes).toBeLessThanOrEqual(82.5)
  })

  it('allows the next post once the derived gap has passed', () => {
    const result = decide(
      at('2026-08-04T13:30:00'),
      {
        lastPostedAt: at('2026-08-04T12:00:00'),
        postedToday: 1,
        postedInWindow: 1,
      },
      config,
      rng,
    )
    expect(result).toEqual({ allowed: true, waitUntil: null, reason: 'ok' })
  })

  it('stops at the daily cap and waits for tomorrow', () => {
    const result = decide(
      at('2026-08-04T14:00:00'),
      {
        lastPostedAt: at('2026-08-04T13:00:00'),
        postedToday: 10,
        postedInWindow: 10,
      },
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
      {
        lastPostedAt: at('2026-08-04T22:58:00'),
        postedToday: 10,
        postedInWindow: 10,
      },
      config,
      rng,
    )
    expect(result.reason).toBe('daily-cap')
  })

  it('checks the active-hours window before anything else', () => {
    const result = decide(
      at('2026-08-04T03:00:00'),
      {
        lastPostedAt: at('2026-08-03T22:00:00'),
        postedToday: 10,
        postedInWindow: 10,
      },
      config,
      rng,
    )
    expect(result.reason).toBe('outside-active-hours')
  })

  it('never proposes a wait in the past', () => {
    for (const hour of [0, 6, 9, 15, 22, 23]) {
      const now = at(`2026-08-04T${String(hour).padStart(2, '0')}:00:00`)
      const result = decide(
        now,
        { lastPostedAt: now, postedToday: 3, postedInWindow: 3 },
        config,
        rng,
      )
      if (result.waitUntil) {
        expect(result.waitUntil.getTime()).toBeGreaterThanOrEqual(now.getTime())
      }
    }
  })
})

describe('the day boundary', () => {
  const fresh: PostingHistory = {
  lastPostedAt: null,
  postedToday: 0,
  postedInWindow: 0,
}

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
    const spent: PostingHistory = {
      lastPostedAt: null,
      postedToday: 10,
      postedInWindow: 0,
    }

    expect(
      decide(justAfterMidnight, spent, {
        ...config,
        timezone: 'Asia/Shanghai',
      }).reason,
    ).not.toBe('daily-cap')
  })
})

describe('the window quota', () => {
  const two = loadConfig({
    X_PROFILE_DIR: '/tmp/x-profile',
    X_WINDOWS: '06:00-08:00x4,17:00-23:00x6',
    X_MIN_INTERVAL_MINUTES: '20',
    X_INTERVAL_JITTER: '0',
    X_DAILY_CAP: '10',
    TIMEZONE: 'Asia/Shanghai',
  } as NodeJS.ProcessEnv)

  it('lets the first post of a window go without a gap', () => {
    const result = decide(
      at('2026-08-07T17:00:00'),
      {
        lastPostedAt: at('2026-08-07T07:30:00'),
        postedToday: 4,
        postedInWindow: 0,
      },
      two,
      rng,
    )
    expect(result).toEqual({ allowed: true, waitUntil: null, reason: 'ok' })
  })

  it('waits for the next window once this one has spent its quota', () => {
    const result = decide(
      at('2026-08-07T07:45:00'),
      {
        lastPostedAt: at('2026-08-07T07:30:00'),
        postedToday: 4,
        postedInWindow: 4,
      },
      two,
      rng,
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('window-quota')
    expect(result.waitUntil).toEqual(at('2026-08-07T17:00:00'))
  })

  it('checks the daily cap before the window quota', () => {
    // At the cap the honest answer is "not today", and tomorrow's first
    // window is not the next window on the clock.
    const result = decide(
      at('2026-08-07T18:00:00'),
      {
        lastPostedAt: at('2026-08-07T17:00:00'),
        postedToday: 10,
        postedInWindow: 1,
      },
      two,
      rng,
    )
    expect(result.reason).toBe('daily-cap')
    expect(result.waitUntil).toEqual(at('2026-08-08T06:00:00'))
  })

  it('paces the evening at an hour and finishes before the close', () => {
    // Jitter is zero in this config, so the schedule is exact.
    const expected = [
      ['2026-08-07T17:00:00', 1, '2026-08-07T18:00:00'],
      ['2026-08-07T18:00:00', 2, '2026-08-07T19:00:00'],
      ['2026-08-07T21:00:00', 5, '2026-08-07T22:00:00'],
    ] as const

    for (const [last, posted, readyAt] of expected) {
      const result = decide(
        at(last),
        { lastPostedAt: at(last), postedToday: posted, postedInWindow: posted },
        two,
        rng,
      )
      expect(result.reason).toBe('interval')
      expect(result.waitUntil).toEqual(at(readyAt))
    }
  })

  it('floors the gap at the configured minimum', () => {
    // A window with one minute left and quota to spare would otherwise ask
    // for a gap of seconds.
    const result = decide(
      at('2026-08-07T22:59:00'),
      {
        lastPostedAt: at('2026-08-07T22:59:00'),
        postedToday: 5,
        postedInWindow: 5,
      },
      two,
      rng,
    )
    expect(result.reason).toBe('interval')
    expect(result.waitUntil).toEqual(at('2026-08-07T23:19:00'))
  })
})

describe('nextGapMinutes', () => {
  const end = new Date('2026-08-07T23:00:00')
  const steady = () => 0.5 // the midpoint of the jitter range: no adjustment

  it('spreads the remaining quota over the remaining window', () => {
    // Six over 17:00-23:00: after the first post there are five left and six
    // hours, and the +1 puts the last one an hour before the close.
    const gap = nextGapMinutes(end, new Date('2026-08-07T17:00:00'), 5, 0, steady)
    expect(gap).toBe(60)
  })

  it('holds that pace as the window drains', () => {
    expect(
      nextGapMinutes(end, new Date('2026-08-07T18:00:00'), 4, 0, steady),
    ).toBe(60)
    expect(
      nextGapMinutes(end, new Date('2026-08-07T21:00:00'), 1, 0, steady),
    ).toBe(60)
  })

  it('derives a tighter pace for a short window', () => {
    // Four over 06:00-08:00, after the first post: three left, two hours.
    const morningEnd = new Date('2026-08-07T08:00:00')
    expect(
      nextGapMinutes(morningEnd, new Date('2026-08-07T06:00:00'), 3, 0, steady),
    ).toBe(30)
  })

  it('catches up after a slot that could not be filled', () => {
    // The 18:00 post did not go out until 18:30. The quota is unchanged and
    // the window is shorter, so the gap narrows rather than pushing work past
    // the close.
    const gap = nextGapMinutes(end, new Date('2026-08-07T18:30:00'), 4, 0, steady)
    expect(gap).toBe(54)
  })

  it('applies jitter symmetrically about the target', () => {
    const last = new Date('2026-08-07T17:00:00')
    expect(nextGapMinutes(end, last, 5, 0.25, () => 1)).toBeCloseTo(75)
    expect(nextGapMinutes(end, last, 5, 0.25, () => 0)).toBeCloseTo(45)
    expect(nextGapMinutes(end, last, 5, 0.25, steady)).toBeCloseTo(60)
  })

  it('averages the target rather than drifting below it', () => {
    // The property `sampleDelay` would break: a log-normal with its median at
    // a quarter of the range biases every gap low, and a window's worth of
    // low draws spends the quota early and idles out the rest.
    //
    // Named `sequence`, not `rng`: the file-level `rng` rebuilds the
    // generator on every call and so returns one fixed number, which would
    // average to itself and prove nothing.
    const last = new Date('2026-08-07T17:00:00')
    const sequence = mulberry32(2026)
    let total = 0
    for (let i = 0; i < 2000; i++) {
      total += nextGapMinutes(end, last, 5, 0.25, sequence)
    }
    expect(total / 2000).toBeGreaterThan(58)
    expect(total / 2000).toBeLessThan(62)
  })
})
