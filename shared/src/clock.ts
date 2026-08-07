/**
 * Day boundaries in a named timezone.
 *
 * `Date` carries no zone, and the host's local time is not the operator's:
 * using it is the classic silent scheduling bug — correct on the developer's
 * machine, the whole day shifted on a server in another region.
 */

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function wallClockIn(timezone: string, at: Date): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)

  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)!.value)

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // `hour12: false` renders midnight as 24 in some ICU versions.
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  }
}

/** How far the zone is ahead of UTC at this instant, in milliseconds. */
function offsetMsAt(timezone: string, at: Date): number {
  const w = wallClockIn(timezone, at)
  const asIfUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
  )
  // `formatToParts` only resolves to the second, so `at` is truncated to
  // match — otherwise sub-second precision leaks into the offset.
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000
}

export function startOfDayIn(timezone: string, at: Date): Date {
  const w = wallClockIn(timezone, at)
  const localMidnightAsUtc = Date.UTC(w.year, w.month - 1, w.day)

  // Two passes: the offset at `at` may not be the offset at midnight if a
  // DST transition falls between them. The second pass uses the offset that
  // actually applies at the candidate instant.
  const firstPass = localMidnightAsUtc - offsetMsAt(timezone, at)
  return new Date(localMidnightAsUtc - offsetMsAt(timezone, new Date(firstPass)))
}

/**
 * The next midnight in `timezone` strictly after `at`.
 *
 * Advancing the instant by 24 hours and then asking for its day start, rather
 * than adding one to the wall-clock day: the offset at `at` need not be the
 * offset tomorrow, and `startOfDayIn` already resolves that for whatever
 * instant it is handed.
 */
export function nextDayStartIn(timezone: string, at: Date): Date {
  return startOfDayIn(timezone, new Date(at.getTime() + 86_400_000))
}

export function minutesIntoDayIn(timezone: string, at: Date): number {
  const w = wallClockIn(timezone, at)
  return w.hour * 60 + w.minute
}
