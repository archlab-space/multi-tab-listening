import { describe, expect, it } from 'vitest'
import { minutesIntoDayIn, nextDayStartIn, startOfDayIn } from './clock.js'

describe('startOfDayIn', () => {
  it('returns the instant of local midnight, not host midnight', () => {
    // 2026-08-05T01:05Z is 09:05 in Shanghai, so the day began at
    // 2026-08-04T16:00Z.
    expect(
      startOfDayIn('Asia/Shanghai', new Date('2026-08-05T01:05:00.000Z')),
    ).toEqual(new Date('2026-08-04T16:00:00.000Z'))
  })

  it('rolls over at local midnight, not at UTC midnight', () => {
    // 2026-08-04T23:00Z is already 07:00 on the 5th in Shanghai.
    expect(
      startOfDayIn('Asia/Shanghai', new Date('2026-08-04T23:00:00.000Z')),
    ).toEqual(new Date('2026-08-04T16:00:00.000Z'))
  })

  it('handles UTC', () => {
    expect(startOfDayIn('UTC', new Date('2026-08-05T13:45:00.000Z'))).toEqual(
      new Date('2026-08-05T00:00:00.000Z'),
    )
  })

  it('handles a zone that observes DST', () => {
    // New York is UTC-4 in August.
    expect(
      startOfDayIn('America/New_York', new Date('2026-08-05T12:00:00.000Z')),
    ).toEqual(new Date('2026-08-05T04:00:00.000Z'))
  })
})

describe('minutesIntoDayIn', () => {
  it('reads the local wall clock', () => {
    expect(
      minutesIntoDayIn('Asia/Shanghai', new Date('2026-08-05T01:05:00.000Z')),
    ).toBe(9 * 60 + 5)
  })

  it('reports midnight as zero', () => {
    expect(
      minutesIntoDayIn('Asia/Shanghai', new Date('2026-08-04T16:00:00.000Z')),
    ).toBe(0)
  })

  it('reports 23:59 as the last minute of the day', () => {
    expect(
      minutesIntoDayIn('Asia/Shanghai', new Date('2026-08-05T15:59:00.000Z')),
    ).toBe(23 * 60 + 59)
  })
})

describe('nextDayStartIn', () => {
  it('returns tomorrow midnight in the named zone', () => {
    // 2026-08-06T15:30Z is 23:30 in Shanghai, so the next day begins half an
    // hour later, at 2026-08-06T16:00Z.
    expect(
      nextDayStartIn('Asia/Shanghai', new Date('2026-08-06T15:30:00.000Z')),
    ).toEqual(new Date('2026-08-06T16:00:00.000Z'))
  })

  it('is unaffected by the host zone', () => {
    // 09:00 in Shanghai on the 6th; the same instant is 02:00 in Berlin and
    // still the 5th in New York. Only the named zone may decide.
    expect(
      nextDayStartIn('Asia/Shanghai', new Date('2026-08-06T01:00:00.000Z')),
    ).toEqual(new Date('2026-08-06T16:00:00.000Z'))
  })
})
