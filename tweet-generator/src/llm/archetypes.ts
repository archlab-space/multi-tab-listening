import type { TweetArchetype } from 'shared'
import type { Rng } from 'shared/rng'

export interface ArchetypeSpec {
  name: TweetArchetype
  /** Relative frequency. The four weights sum to 100. */
  weight: number
  hasImage: boolean
  /** Field name → weighted-character budget, enforced by the validator. */
  fields: Record<string, number>
}

/**
 * The four shapes a post can take.
 *
 * Structural monotony, not volume, is what makes an account read as a
 * content farm: every post being a hook, three arrows, and an identically
 * watermarked card is a trivially learnable fingerprint, and ten identical
 * posts a day give a classifier more to work with than three do.
 *
 * The mix also covers the three kinds of account that grow — useful value
 * (digest), results and progress (metric), and something with a human voice
 * (take, question) — rather than only the first.
 */
export const ARCHETYPES: Record<TweetArchetype, ArchetypeSpec> = {
  digest: {
    name: 'digest',
    weight: 45,
    hasImage: true,
    fields: { hook: 90, highlight: 55 },
  },
  metric: {
    name: 'metric',
    weight: 20,
    hasImage: true,
    fields: { metric: 40, line: 200 },
  },
  take: {
    name: 'take',
    weight: 20,
    hasImage: false,
    fields: { text: 240 }
  },
  question: {
    name: 'question',
    weight: 15,
    hasImage: false,
    fields: { text: 200 },
  },
}

/**
 * Weighted pick, excluding whatever went out last.
 *
 * The exclusion is a hard rule rather than a nudge: two identical shapes in
 * a row is the most visible thing a reader scrolling a profile notices.
 */
export function pickArchetype(
  last: TweetArchetype | null,
  rng: Rng = Math.random,
): TweetArchetype {
  const eligible = Object.values(ARCHETYPES).filter((spec) => spec.name !== last)
  const total = eligible.reduce((sum, spec) => sum + spec.weight, 0)

  let roll = rng() * total
  for (const spec of eligible) {
    roll -= spec.weight
    if (roll < 0) return spec.name
  }
  return eligible[eligible.length - 1]!.name
}
