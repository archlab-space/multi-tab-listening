import { describe, expect, it } from 'vitest'
import { mulberry32 } from './rng.js'

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(2026)
    const b = mulberry32(2026)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('produces different streams for different seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)())
  })

  it('stays inside [0, 1)', () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 1000; i++) {
      const value = rng()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})
