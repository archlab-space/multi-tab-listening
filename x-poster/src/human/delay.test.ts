import { describe, expect, it } from 'vitest'
import { humanDelay, mulberry32, sampleDelay } from './delay.js'

function samples(count: number, min: number, max: number): number[] {
  const rng = mulberry32(20260804)
  return Array.from({ length: count }, () => sampleDelay(min, max, rng))
}

describe('sampleDelay', () => {
  it('always stays within the requested range', () => {
    for (const value of samples(2000, 100, 900)) {
      expect(value).toBeGreaterThanOrEqual(100)
      expect(value).toBeLessThanOrEqual(900)
    }
  })

  it('returns integers', () => {
    for (const value of samples(200, 100, 900)) {
      expect(Number.isInteger(value)).toBe(true)
    }
  })

  it('is right-skewed: most samples fall below the arithmetic midpoint', () => {
    // A uniform distribution would put ~50% above the midpoint. Human pauses
    // cluster low with an occasional long one, and that asymmetry is the
    // whole point of not using Math.random() directly.
    const values = samples(2000, 100, 900)
    const aboveMidpoint = values.filter((v) => v > 500).length
    expect(aboveMidpoint / values.length).toBeLessThan(0.3)
  })

  it('still produces a long tail rather than clustering at the floor', () => {
    const values = samples(2000, 100, 900)
    const nearCeiling = values.filter((v) => v > 700).length
    expect(nearCeiling).toBeGreaterThan(0)
  })

  it('is deterministic for a given seed', () => {
    expect(samples(20, 100, 900)).toEqual(samples(20, 100, 900))
  })

  it('handles a degenerate range', () => {
    expect(sampleDelay(500, 500, mulberry32(1))).toBe(500)
  })
})

describe('mulberry32', () => {
  it('produces values in [0, 1)', () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 500; i++) {
      const value = rng()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe('humanDelay', () => {
  it('waits for at least the sampled floor', async () => {
    const started = Date.now()
    await humanDelay(30, 40, mulberry32(3))
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
  })
})
