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

/**
 * How long to wait after `lastPostedAt` before the next post in this window.
 *
 * Derived rather than sampled: what is left of the window, over what is left
 * of its quota plus one. The plus one is what leaves the window room to
 * close — without it the final post lands exactly on the boundary. Six over a
 * six-hour evening comes out at a steady hour and finishes an hour early, and
 * four over a two-hour morning comes out at half an hour, from the same
 * expression.
 *
 * It also self-corrects: a slot that could not be filled leaves the quota
 * alone while the window shrinks, so the next gap narrows.
 *
 * The jitter is uniform and symmetric, and deliberately not `sampleDelay`.
 * That one draws from a log-normal whose median sits at a quarter of the
 * range, because it models the pauses a person leaves between actions.
 * Applied here it would bias every gap below target, and a window's worth of
 * low draws would spend the quota early and idle out the rest — the failure
 * this whole change exists to remove.
 */
export function nextGapMinutes(
  windowEnd: Date,
  lastPostedAt: Date,
  remainingQuota: number,
  jitter: number,
  rng: Rng = Math.random,
): number {
  const leftMinutes =
    (windowEnd.getTime() - lastPostedAt.getTime()) / MS_PER_MINUTE
  const target = leftMinutes / (remainingQuota + 1)

  return target * (1 + (rng() * 2 - 1) * jitter)
}

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
