import { describe, expect, it } from 'vitest'
import { shouldReplenish, waitAfterMs, type PaceConfig } from './pace.js'

const config: PaceConfig = {
  timezone: 'Asia/Shanghai',
  queuePollMinutes: 5,
  emptyPoolMinutes: 30,
}

describe('shouldReplenish', () => {
  it('restocks an empty buffer', () => {
    expect(shouldReplenish(0, 2)).toBe(true)
  })

  it('restocks a buffer below target', () => {
    expect(shouldReplenish(1, 2)).toBe(true)
  })

  it('leaves a buffer that is exactly at target alone', () => {
    // The boundary that decides whether the target is a floor to stand on or
    // a ceiling to grow past.
    expect(shouldReplenish(2, 2)).toBe(false)
  })

  it('leaves an over-full buffer alone', () => {
    // Reachable after the target is lowered while rows are already queued.
    expect(shouldReplenish(5, 2)).toBe(false)
  })
})

describe('waitAfterMs', () => {
  const nineAmShanghai = new Date('2026-08-06T01:00:00.000Z')

  it('does not wait after a successful enqueue', () => {
    // The buffer may still be short, and the next check is a bare COUNT.
    expect(waitAfterMs('enqueued', nineAmShanghai, config)).toBe(0)
  })

  it('waits the empty-pool backoff when nothing could be produced', () => {
    expect(waitAfterMs('idle', nineAmShanghai, config)).toBe(30 * 60_000)
  })

  it('waits out the day when the daily cap is spent', () => {
    // 09:00 in Shanghai to the next midnight is fifteen hours.
    expect(waitAfterMs('capped', nineAmShanghai, config)).toBe(15 * 3_600_000)
  })

  it('measures the cap wait in the configured zone, not the host zone', () => {
    // The same instant is 03:00 in Berlin, twenty-one hours short of midnight.
    // Reading the host's clock here is the bug this whole change removes.
    const berlin: PaceConfig = { ...config, timezone: 'Europe/Berlin' }

    expect(waitAfterMs('capped', nineAmShanghai, berlin)).toBe(21 * 3_600_000)
  })
})
