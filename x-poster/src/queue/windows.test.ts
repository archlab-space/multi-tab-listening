import { describe, expect, it } from 'vitest'
import {
  activeWindowAt,
  nextDayFirstWindowStart,
  nextWindowStartAfter,
  parseWindows,
  windowEndAt,
  windowStartAt,
} from './windows.js'

const TZ = 'Asia/Shanghai'
const two = parseWindows('06:00-08:00x4,17:00-23:00x6')

/**
 * A zoneless literal, which `Date` reads as host time. These cases hold when
 * the host runs the zone the tests name; the case at the bottom states its
 * instants in UTC and pins the behaviour down regardless.
 */
function at(iso: string): Date {
  return new Date(iso)
}

describe('parseWindows', () => {
  it('parses windows into minutes from midnight with their quotas', () => {
    expect(parseWindows('06:00-08:00x4')).toEqual([
      { startMinute: 360, endMinute: 480, quota: 4 },
    ])
  })

  it('sorts windows by start, whatever order they were written in', () => {
    expect(parseWindows('17:00-23:00x6,06:00-08:00x4')).toEqual([
      { startMinute: 360, endMinute: 480, quota: 4 },
      { startMinute: 1020, endMinute: 1380, quota: 6 },
    ])
  })

  it('tolerates spaces around the separator', () => {
    expect(parseWindows('06:00-08:00x4, 17:00-23:00x6')).toHaveLength(2)
  })

  it('rejects an empty list', () => {
    expect(() => parseWindows('')).toThrow(/at least one window/)
  })

  it('rejects a malformed entry', () => {
    expect(() => parseWindows('06:00-08:00')).toThrow(/06:00-08:00/)
    expect(() => parseWindows('6-8x4')).toThrow(/6-8x4/)
  })

  it('rejects an invalid time', () => {
    expect(() => parseWindows('06:00-25:00x4')).toThrow(/invalid time/)
    expect(() => parseWindows('06:70-08:00x4')).toThrow(/invalid time/)
  })

  it('rejects a window that wraps past midnight', () => {
    expect(() => parseWindows('22:00-02:00x4')).toThrow(/wrap past midnight/)
    expect(() => parseWindows('08:00-08:00x4')).toThrow(/wrap past midnight/)
  })

  it('rejects a window with no quota to spend', () => {
    expect(() => parseWindows('06:00-08:00x0')).toThrow(/quota/)
  })

  it('rejects overlapping windows', () => {
    expect(() => parseWindows('06:00-10:00x4,09:00-12:00x6')).toThrow(
      /must not overlap/,
    )
  })

  it('allows windows that touch without overlapping', () => {
    expect(parseWindows('06:00-08:00x4,08:00-10:00x6')).toHaveLength(2)
  })
})

describe('activeWindowAt', () => {
  it('finds the window containing the instant', () => {
    expect(activeWindowAt(TZ, two, at('2026-08-07T18:00:00'))?.quota).toBe(6)
    expect(activeWindowAt(TZ, two, at('2026-08-07T07:00:00'))?.quota).toBe(4)
  })

  it('treats the start as inside and the end as outside', () => {
    expect(activeWindowAt(TZ, two, at('2026-08-07T06:00:00'))).not.toBeNull()
    expect(activeWindowAt(TZ, two, at('2026-08-07T08:00:00'))).toBeNull()
  })

  it('returns null between windows', () => {
    expect(activeWindowAt(TZ, two, at('2026-08-07T12:00:00'))).toBeNull()
  })
})

describe('window boundaries', () => {
  it('gives the opening and closing instants on the day of `now`', () => {
    const evening = two[1]!
    const now = at('2026-08-07T19:30:00')
    expect(windowStartAt(TZ, evening, now)).toEqual(at('2026-08-07T17:00:00'))
    expect(windowEndAt(TZ, evening, now)).toEqual(at('2026-08-07T23:00:00'))
  })
})

describe('nextWindowStartAfter', () => {
  it('finds a later window on the same day', () => {
    expect(nextWindowStartAfter(TZ, two, at('2026-08-07T09:00:00'))).toEqual(
      at('2026-08-07T17:00:00'),
    )
  })

  it('rolls to the first window tomorrow once the last one has opened', () => {
    expect(nextWindowStartAfter(TZ, two, at('2026-08-07T23:30:00'))).toEqual(
      at('2026-08-08T06:00:00'),
    )
  })

  it('rolls over from inside the last window too', () => {
    expect(nextWindowStartAfter(TZ, two, at('2026-08-07T20:00:00'))).toEqual(
      at('2026-08-08T06:00:00'),
    )
  })

  it('never proposes an instant in the past', () => {
    for (const hour of [0, 5, 6, 7, 9, 16, 17, 22, 23]) {
      const now = at(`2026-08-07T${String(hour).padStart(2, '0')}:00:00`)
      expect(nextWindowStartAfter(TZ, two, now).getTime()).toBeGreaterThan(
        now.getTime(),
      )
    }
  })
})

describe('nextDayFirstWindowStart', () => {
  it('is tomorrow’s first opening whatever time it is asked', () => {
    expect(nextDayFirstWindowStart(TZ, two, at('2026-08-07T07:00:00'))).toEqual(
      at('2026-08-08T06:00:00'),
    )
    expect(nextDayFirstWindowStart(TZ, two, at('2026-08-07T22:00:00'))).toEqual(
      at('2026-08-08T06:00:00'),
    )
  })
})

describe('the configured zone', () => {
  it('reads windows in the named zone, not the host clock', () => {
    // 2026-08-07T01:00:00Z is 09:00 in Shanghai — between the two windows.
    const now = new Date('2026-08-07T01:00:00Z')
    expect(activeWindowAt(TZ, two, now)).toBeNull()
    // 2026-08-07T10:00:00Z is 18:00 in Shanghai — inside the evening window.
    expect(activeWindowAt(TZ, two, new Date('2026-08-07T10:00:00Z'))?.quota).toBe(
      6,
    )
    expect(nextWindowStartAfter(TZ, two, now)).toEqual(
      new Date('2026-08-07T09:00:00Z'),
    )
  })
})
