import type { XPosterConfig } from '../config.js'
import type { Rng } from '../human/delay.js'
import {
  activeWindowAt,
  nextDayFirstWindowStart,
  nextWindowStartAfter,
  windowEndAt,
} from './windows.js'

export interface PostingHistory {
  lastPostedAt: Date | null
  postedToday: number
  /** Published inside the window containing `now`. */
  postedInWindow: number
}

/** What the queue can count without knowing about windows. */
export type PostingCounts = Omit<PostingHistory, 'postedInWindow'>

export type RateLimitReason =
  | 'ok'
  | 'interval'
  | 'daily-cap'
  | 'window-quota'
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

/**
 * The four gates, in the order that produces the most useful answer.
 *
 * Order matters, and each step down is a narrower "not yet": outside every
 * window nothing else is worth evaluating, at the daily cap the honest answer
 * is "not today" rather than "at the next opening", and a window that has
 * spent its allowance is "not this window" rather than "in an hour". This
 * ordering is asserted by the tests.
 */
export function decide(
  now: Date,
  history: PostingHistory,
  config: XPosterConfig,
  rng: Rng = Math.random,
): RateLimitDecision {
  const window = activeWindowAt(config.timezone, config.windows, now)

  if (!window) {
    return {
      allowed: false,
      waitUntil: nextWindowStartAfter(config.timezone, config.windows, now),
      reason: 'outside-active-hours',
    }
  }

  if (history.postedToday >= config.dailyCap) {
    return {
      allowed: false,
      waitUntil: nextDayFirstWindowStart(config.timezone, config.windows, now),
      reason: 'daily-cap',
    }
  }

  const remaining = window.quota - history.postedInWindow
  if (remaining <= 0) {
    return {
      allowed: false,
      waitUntil: nextWindowStartAfter(config.timezone, config.windows, now),
      reason: 'window-quota',
    }
  }

  // The first post of a window has no gap to satisfy: the window opening is
  // itself the wait, and pacing from a post made in an earlier window would
  // charge this one for the last one's timing.
  if (history.postedInWindow > 0 && history.lastPostedAt) {
    const gap = Math.max(
      config.minIntervalMinutes,
      nextGapMinutes(
        windowEndAt(config.timezone, window, now),
        history.lastPostedAt,
        remaining,
        config.intervalJitter,
        rng,
      ),
    )
    const readyAt = new Date(
      history.lastPostedAt.getTime() + gap * MS_PER_MINUTE,
    )
    if (readyAt > now) {
      return { allowed: false, waitUntil: readyAt, reason: 'interval' }
    }
  }

  return { allowed: true, waitUntil: null, reason: 'ok' }
}
