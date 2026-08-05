import {
  SOURCE_PRIORITY,
  type GeneratorConfig,
  type SourceKind,
} from '../config.js'
import { minutesIntoDayIn } from './clock.js'

export interface QuotaUsage {
  used: Record<SourceKind, number>
  total: number
}

/** 09:00 local. AgentLens publishes the day's digests just after this. */
export const DIGEST_ANCHOR_MINUTE = 9 * 60

/**
 * The kinds worth trying this cycle, best first.
 *
 * Returning an ordered list rather than one kind is what makes fallback
 * free: the caller walks it and takes the first kind whose pool is not
 * empty, with no separate fallback path to keep in step.
 *
 * The ordering is by remaining quota ratio, ties broken by priority. Strict
 * priority ordering would instead post four Labs items, then three Projects,
 * then the rest — a monotone, visibly automated timeline.
 */
export function orderKinds(
  now: Date,
  usage: QuotaUsage,
  config: GeneratorConfig,
): SourceKind[] {
  if (usage.total >= config.dailyCap) return []

  const minute = minutesIntoDayIn(config.timezone, now)

  const eligible = SOURCE_PRIORITY.filter((kind) => {
    const quota = config.quota[kind]
    if (quota <= 0) return false
    if (usage.used[kind] >= quota) return false
    // Today's digest does not exist before the anchor, so offering it would
    // only produce an empty pool and a wasted fallback hop.
    if (kind === 'x_digest' && minute < DIGEST_ANCHOR_MINUTE) return false
    return true
  })

  const ratio = (kind: SourceKind): number =>
    (config.quota[kind] - usage.used[kind]) / config.quota[kind]

  const ordered = [...eligible].sort((a, b) => {
    const difference = ratio(b) - ratio(a)
    if (difference !== 0) return difference
    return SOURCE_PRIORITY.indexOf(a) - SOURCE_PRIORITY.indexOf(b)
  })

  // The one time-based exception. The digest lands at 09:05 local and is
  // worthless by tomorrow, so it cannot wait for the ratio picker to reach
  // it in the afternoon.
  if (minute >= DIGEST_ANCHOR_MINUTE && ordered.includes('x_digest')) {
    return ['x_digest', ...ordered.filter((kind) => kind !== 'x_digest')]
  }

  return ordered
}
