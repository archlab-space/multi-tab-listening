import {
  minutesIntoDayIn,
  nextDayStartIn,
  startOfDayIn,
} from 'shared/clock'
import type { XPosterConfig } from '../config.js'
import { sampleDelay, type Rng } from '../human/delay.js'

export interface PostingHistory {
  lastPostedAt: Date | null
  postedToday: number
}

export type RateLimitReason =
  | 'ok'
  | 'interval'
  | 'daily-cap'
  | 'outside-active-hours'

export interface RateLimitDecision {
  allowed: boolean
  waitUntil: Date | null
  reason: RateLimitReason
}

const MS_PER_MINUTE = 60_000

function windowOpensOn(day: Date, config: XPosterConfig): Date {
  return new Date(day.getTime() + config.activeHours.startMinute * MS_PER_MINUTE)
}

/**
 * The three gates, in the order that produces the most useful answer.
 *
 * Order matters: at the daily cap the honest answer is "not today", not "in
 * twenty minutes", and outside the window neither of the other two gates is
 * worth evaluating. This ordering is asserted by the tests.
 *
 * The interval is resampled on every call rather than fixed at post time, so
 * the gap between tweets carries no fixed-period signature.
 */
export function decide(
  now: Date,
  history: PostingHistory,
  config: XPosterConfig,
  rng: Rng = Math.random,
): RateLimitDecision {
  const minute = minutesIntoDayIn(config.timezone, now)

  if (minute < config.activeHours.startMinute) {
    return {
      allowed: false,
      waitUntil: windowOpensOn(startOfDayIn(config.timezone, now), config),
      reason: 'outside-active-hours',
    }
  }

  if (minute >= config.activeHours.endMinute) {
    return {
      allowed: false,
      waitUntil: windowOpensOn(nextDayStartIn(config.timezone, now), config),
      reason: 'outside-active-hours',
    }
  }

  if (history.postedToday >= config.dailyCap) {
    return {
      allowed: false,
      waitUntil: windowOpensOn(nextDayStartIn(config.timezone, now), config),
      reason: 'daily-cap',
    }
  }

  if (history.lastPostedAt) {
    const requiredMs =
      sampleDelay(config.minIntervalMinutes, config.maxIntervalMinutes, rng) *
      MS_PER_MINUTE
    const readyAt = new Date(history.lastPostedAt.getTime() + requiredMs)
    if (readyAt > now) {
      return { allowed: false, waitUntil: readyAt, reason: 'interval' }
    }
  }

  return { allowed: true, waitUntil: null, reason: 'ok' }
}
