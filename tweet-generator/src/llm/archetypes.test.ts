import { describe, expect, it } from 'vitest'
import { mulberry32 } from 'shared/rng'
import { ARCHETYPES, pickArchetype } from './archetypes.js'

describe('ARCHETYPES', () => {
  it('weights sum to 100', () => {
    const total = Object.values(ARCHETYPES).reduce(
      (sum, spec) => sum + spec.weight,
      0,
    )
    expect(total).toBe(100)
  })

  it('leaves take and question image-less', () => {
    // Half the posts carrying no image cuts the content-farm fingerprint,
    // cuts render cost, and makes the timeline read like a person.
    expect(ARCHETYPES.take.hasImage).toBe(false)
    expect(ARCHETYPES.question.hasImage).toBe(false)
    expect(ARCHETYPES.digest.hasImage).toBe(true)
    expect(ARCHETYPES.metric.hasImage).toBe(true)
  })
})

describe('pickArchetype', () => {
  it('never repeats the previous archetype', () => {
    const rng = mulberry32(11)
    for (let i = 0; i < 500; i++) {
      expect(pickArchetype('digest', rng)).not.toBe('digest')
    }
  })

  it('can return any archetype when there is no history', () => {
    const rng = mulberry32(3)
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(pickArchetype(null, rng))
    expect(seen.size).toBe(4)
  })

  it('is deterministic for a given seed', () => {
    expect(pickArchetype(null, mulberry32(42))).toBe(
      pickArchetype(null, mulberry32(42)),
    )
  })

  it('still reflects the weights after excluding the previous', () => {
    const rng = mulberry32(9)
    const counts: Record<string, number> = {}
    for (let i = 0; i < 4000; i++) {
      const pick = pickArchetype('question', rng)
      counts[pick] = (counts[pick] ?? 0) + 1
    }
    // digest carries 45 of the remaining 85 weight, so it should dominate.
    expect(counts.digest!).toBeGreaterThan(counts.metric!)
    expect(counts.digest!).toBeGreaterThan(counts.take!)
    expect(counts.question).toBeUndefined()
  })
})
