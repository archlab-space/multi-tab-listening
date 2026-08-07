import { minutesIntoDayIn, nextDayStartIn, startOfDayIn } from 'shared/clock'

export interface PostingWindow {
  /** Minutes from local midnight. */
  startMinute: number
  endMinute: number
  /** How many posts this window may publish in a day. */
  quota: number
}

const MS_PER_MINUTE = 60_000
const ENTRY = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})x(\d+)$/

/**
 * Parses `06:00-08:00x4,17:00-23:00x6` into sorted windows.
 *
 * Every rule here is fatal at startup rather than tolerated, because each one
 * describes a schedule that cannot be honoured: a window that wraps has no
 * single comparison that places an instant inside it, overlapping windows
 * make "which quota does this post spend" ambiguous, and a window with no
 * quota is a window that silently never fires.
 */
export function parseWindows(raw: string): PostingWindow[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')

  if (entries.length === 0) {
    throw new Error(
      'X_WINDOWS must name at least one window, like "06:00-08:00x4"',
    )
  }

  const windows = entries.map((entry) => {
    const match = ENTRY.exec(entry)
    if (!match) {
      throw new Error(
        `X_WINDOWS entries must look like "06:00-08:00x4", got: ${entry}`,
      )
    }

    const startHour = Number(match[1])
    const startMin = Number(match[2])
    const endHour = Number(match[3])
    const endMin = Number(match[4])
    const quota = Number(match[5])

    if (startHour > 23 || endHour > 23 || startMin > 59 || endMin > 59) {
      throw new Error(`X_WINDOWS contains an invalid time: ${entry}`)
    }
    if (quota < 1) {
      throw new Error(`X_WINDOWS gives ${entry} no quota to spend`)
    }

    const startMinute = startHour * 60 + startMin
    const endMinute = endHour * 60 + endMin

    // The same rule the single window it replaced enforced, for the same
    // reason: a window that wraps past midnight needs its own set of
    // comparisons in every gate that reads it.
    if (endMinute <= startMinute) {
      throw new Error(`X_WINDOWS must not wrap past midnight, got: ${entry}`)
    }

    return { startMinute, endMinute, quota }
  })

  windows.sort((left, right) => left.startMinute - right.startMinute)

  for (let i = 1; i < windows.length; i++) {
    if (windows[i]!.startMinute < windows[i - 1]!.endMinute) {
      throw new Error(`X_WINDOWS must not overlap, got: ${raw}`)
    }
  }

  return windows
}

/**
 * Minutes from a local midnight, as an instant.
 *
 * Adding minutes to a midnight assumes the zone's offset does not move during
 * the day. This is the same assumption `windowOpensOn` made before it, and it
 * holds for `Asia/Shanghai`, which has no DST.
 */
function instantAt(midnight: Date, minute: number): Date {
  return new Date(midnight.getTime() + minute * MS_PER_MINUTE)
}

/** The window containing `now`, or null between them. */
export function activeWindowAt(
  timezone: string,
  windows: PostingWindow[],
  now: Date,
): PostingWindow | null {
  const minute = minutesIntoDayIn(timezone, now)
  return (
    windows.find(
      (window) => minute >= window.startMinute && minute < window.endMinute,
    ) ?? null
  )
}

export function windowStartAt(
  timezone: string,
  window: PostingWindow,
  now: Date,
): Date {
  return instantAt(startOfDayIn(timezone, now), window.startMinute)
}

export function windowEndAt(
  timezone: string,
  window: PostingWindow,
  now: Date,
): Date {
  return instantAt(startOfDayIn(timezone, now), window.endMinute)
}

/** The next opening strictly after `now`, rolling into tomorrow if needed. */
export function nextWindowStartAfter(
  timezone: string,
  windows: PostingWindow[],
  now: Date,
): Date {
  const minute = minutesIntoDayIn(timezone, now)
  const later = windows.find((window) => window.startMinute > minute)

  return later
    ? instantAt(startOfDayIn(timezone, now), later.startMinute)
    : nextDayFirstWindowStart(timezone, windows, now)
}

/**
 * Tomorrow's first opening. Separate from `nextWindowStartAfter` because the
 * daily cap has to skip the rest of today's windows, not merely the current
 * one.
 */
export function nextDayFirstWindowStart(
  timezone: string,
  windows: PostingWindow[],
  now: Date,
): Date {
  return instantAt(nextDayStartIn(timezone, now), windows[0]!.startMinute)
}
