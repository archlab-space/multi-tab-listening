import { minutesIntoDayIn } from 'shared/clock'
import { TIER_PRIORITY, type GeneratorConfig, type Tier } from '../config.js'

export interface QuotaUsage {
  used: Record<Tier, number>
  total: number
}

/** 09:00 local. AgentLens publishes the day's digests just after this. */
export const DIGEST_ANCHOR_MINUTE = 9 * 60

/**
 * The tiers worth trying this cycle, best first.
 *
 * Returning an ordered list rather than one tier is what makes fallback
 * free: the caller walks it and takes the first tier whose pool is not
 * empty, with no separate fallback path to keep in step.
 *
 * The ordering is by remaining quota ratio, ties broken by priority. Strict
 * priority ordering would instead post the whole hot allowance, then the
 * whole project allowance — a monotone, visibly automated timeline.
 */
export function orderTiers(
  now: Date,
  usage: QuotaUsage,
  config: GeneratorConfig,
): Tier[] {
  if (usage.total >= config.dailyCap) return []

  const eligible = TIER_PRIORITY.filter((tier) => {
    const quota = config.quota[tier]
    return quota > 0 && usage.used[tier] < quota
  })

  const ratio = (tier: Tier): number =>
    (config.quota[tier] - usage.used[tier]) / config.quota[tier]

  const ordered = [...eligible].sort((a, b) => {
    const difference = ratio(b) - ratio(a)
    if (difference !== 0) return difference
    return TIER_PRIORITY.indexOf(a) - TIER_PRIORITY.indexOf(b)
  })

  // The one time-based exception. The digest lands at 09:05 local and is
  // worthless by tomorrow, so the tier that carries it cannot wait for the
  // ratio picker to reach it in the afternoon.
  const minute = minutesIntoDayIn(config.timezone, now)
  if (minute >= DIGEST_ANCHOR_MINUTE && ordered.includes('hot')) {
    return ['hot', ...ordered.filter((tier) => tier !== 'hot')]
  }

  return ordered
}
