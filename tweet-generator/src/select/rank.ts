import { heatOf, type BlogSignal } from '../sources/agentlens.js'
import { scoreEntities } from './entities.js'

/** The three fields ranking needs. Anything wider is the caller's business. */
export interface Rankable {
  title: string
  summary: string
  signal: BlogSignal | null
}

export interface Ranked<T> {
  item: T
  /** 0..1. Only comparable against other items from the same call. */
  rank: number
  entities: string[]
}

/**
 * Normalised against the batch, never against a constant.
 *
 * An identical batch is the point: HN scores run 179-803, project momentum
 * runs 1-1200, and half the sources send no signal at all. Any fixed scale
 * would encode one source's range as the truth for all of them. Callers
 * therefore hand this one tier's items at a time.
 */
function normalise(values: (number | null)[]): number[] {
  const present = values.filter((value): value is number => value !== null)
  if (present.length === 0) return values.map(() => 0)

  const min = Math.min(...present)
  const max = Math.max(...present)
  // Every item scored the same, so none of them is ahead on this axis.
  // Dividing here would be a zero divide; returning 1 says "no separation".
  if (max === min) return values.map((value) => (value === null ? 0 : 1))

  return values.map((value) =>
    value === null ? 0 : (value - min) / (max - min),
  )
}

export function rankWithinTier<T extends Rankable>(
  items: T[],
  entityWeight: number,
): Ranked<T>[] {
  if (items.length === 0) return []

  const scored = items.map((item) =>
    scoreEntities(`${item.title} ${item.summary}`),
  )
  const entityRanks = normalise(scored.map((score) => score.score))
  const heatRanks = normalise(items.map((item) => heatOf(item.signal)))

  return items
    .map((item, index) => ({
      item,
      rank:
        entityWeight * entityRanks[index]! +
        (1 - entityWeight) * heatRanks[index]!,
      entities: scored[index]!.entities,
    }))
    .sort((a, b) => b.rank - a.rank)
}
