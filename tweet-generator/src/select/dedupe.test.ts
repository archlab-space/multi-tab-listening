import { describe, expect, it } from 'vitest'
import { starBucket } from './dedupe.js'

describe('starBucket', () => {
  it('names the largest bucket at or below the count', () => {
    expect(starBucket(1500)).toBe('stars-1k')
    expect(starBucket(18420)).toBe('stars-10k')
    expect(starBucket(31420)).toBe('stars-30k')
  })

  it('treats a boundary as being in the bucket it names', () => {
    expect(starBucket(1000)).toBe('stars-1k')
    expect(starBucket(2000)).toBe('stars-2k')
    expect(starBucket(100_000)).toBe('stars-100k')
  })

  it('buckets everything below the first boundary together', () => {
    // Nothing under 1k should ever reach here — the momentum floor and the
    // leaderboard both exclude it — but a shared bucket is the safe answer,
    // because an undefined bucket would produce a dedupe key of "undefined"
    // and collapse every such project onto one row.
    expect(starBucket(0)).toBe('stars-0')
    expect(starBucket(999)).toBe('stars-0')
  })

  it('keeps growing past the last named boundary', () => {
    expect(starBucket(250_000)).toBe('stars-200k')
  })
})
