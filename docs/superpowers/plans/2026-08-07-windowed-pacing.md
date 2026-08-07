# Windowed Pacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace x-poster's single posting window and fixed interval range with several windows that each carry their own quota, spacing posts by what is left of the window rather than by a sampled constant.

**Architecture:** A new pure module owns time-of-day windows (parsing, which one contains an instant, when the next opens). `rate-limiter.ts` keeps `decide` a pure function of its arguments and gains one gate — a window that has spent its quota — plus a derived gap in place of the sampled one. `index.ts` supplies the one new input `decide` needs, a count of posts published inside the current window, which `TweetQueue` reads from the database.

**Tech Stack:** TypeScript (nodenext, strict), Vitest, drizzle-orm over Postgres, winston. Package manager is pnpm in a workspace; run commands from `x-poster/`.

## Global Constraints

- Design source of truth: `docs/superpowers/specs/2026-08-07-windowed-pacing-design.md`.
- Only `x-poster` changes. `tweet-generator` is not touched by this work.
- `decide` in `rate-limiter.ts` stays a pure function of `(now, history, config, rng)` — no clock reads, no I/O.
- Every timezone-dependent calculation goes through `shared/clock` helpers (`startOfDayIn`, `nextDayStartIn`, `minutesIntoDayIn`). Never `new Date(y, m, d)` or `getHours()`.
- Window syntax is exactly `HH:MM-HH:MMx<quota>`, comma-separated, e.g. `06:00-08:00x4,17:00-23:00x6`.
- Defaults: `X_INTERVAL_JITTER` = `0.25`, `X_MIN_INTERVAL_MINUTES` = `20`, `X_DAILY_CAP` = `10`.
- `X_WINDOWS` is required — no default. `X_ACTIVE_HOURS` and `X_MAX_INTERVAL_MINUTES` are removed.
- Run tests with `pnpm vitest run` from `x-poster/`. Do **not** use `pnpm -r test`: tweet-generator's `store.test.ts` and x-poster's `tweet-queue.test.ts` share one `tweets` table and fail when run together. That is a pre-existing issue, not something this plan introduces or fixes.
- Typecheck with `pnpm build` from `x-poster/`, then `rm -rf dist` — `dist/` is gitignored but leaving it around is noise.

## File Structure

| File | Responsibility |
| --- | --- |
| `x-poster/src/queue/windows.ts` | **New.** Posting windows: parse and validate, which window contains an instant, when a window opens and closes, when the next one opens. Pure. |
| `x-poster/src/queue/windows.test.ts` | **New.** Tests for the above. |
| `x-poster/src/queue/rate-limiter.ts` | Gains `nextGapMinutes`; `decide` gains the `window-quota` gate and the derived gap. |
| `x-poster/src/queue/rate-limiter.test.ts` | Existing 13 cases updated to the new config shape; new cases for the gate and the gap. |
| `x-poster/src/config.ts` | `windows` and `intervalJitter` replace `activeHours` and `maxIntervalMinutes`. |
| `x-poster/src/config.test.ts` | Existing active-hours cases replaced by window cases. |
| `x-poster/src/queue/tweet-queue.ts` | Gains `postedSince`. |
| `x-poster/src/queue/tweet-queue.test.ts` | Test for `postedSince`. |
| `x-poster/src/index.ts` | Computes the current window and passes `postedInWindow` into `decide`; startup log names the windows. |
| `x-poster/.env.example`, `README.md` | Document the new keys and drop the removed ones. |

---

### Task 1: The windows module

**Files:**
- Create: `x-poster/src/queue/windows.ts`
- Test: `x-poster/src/queue/windows.test.ts`

**Interfaces:**
- Consumes: `minutesIntoDayIn`, `startOfDayIn`, `nextDayStartIn` from `shared/clock`.
- Produces:
  - `interface PostingWindow { startMinute: number; endMinute: number; quota: number }`
  - `parseWindows(raw: string): PostingWindow[]` — sorted by `startMinute`
  - `activeWindowAt(timezone: string, windows: PostingWindow[], now: Date): PostingWindow | null`
  - `windowStartAt(timezone: string, window: PostingWindow, now: Date): Date`
  - `windowEndAt(timezone: string, window: PostingWindow, now: Date): Date`
  - `nextWindowStartAfter(timezone: string, windows: PostingWindow[], now: Date): Date`
  - `nextDayFirstWindowStart(timezone: string, windows: PostingWindow[], now: Date): Date`

- [ ] **Step 1: Write the failing test**

Create `x-poster/src/queue/windows.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  activeWindowAt,
  nextDayFirstWindowStart,
  nextWindowStartAfter,
  parseWindows,
  windowEndAt,
  windowStartAt,
} from './windows.js'

const TZ = 'Asia/Shanghai'
const two = parseWindows('06:00-08:00x4,17:00-23:00x6')

/**
 * A zoneless literal, which `Date` reads as host time. These cases hold when
 * the host runs the zone the tests name; the case at the bottom states its
 * instants in UTC and pins the behaviour down regardless.
 */
function at(iso: string): Date {
  return new Date(iso)
}

describe('parseWindows', () => {
  it('parses windows into minutes from midnight with their quotas', () => {
    expect(parseWindows('06:00-08:00x4')).toEqual([
      { startMinute: 360, endMinute: 480, quota: 4 },
    ])
  })

  it('sorts windows by start, whatever order they were written in', () => {
    expect(parseWindows('17:00-23:00x6,06:00-08:00x4')).toEqual([
      { startMinute: 360, endMinute: 480, quota: 4 },
      { startMinute: 1020, endMinute: 1380, quota: 6 },
    ])
  })

  it('tolerates spaces around the separator', () => {
    expect(parseWindows('06:00-08:00x4, 17:00-23:00x6')).toHaveLength(2)
  })

  it('rejects an empty list', () => {
    expect(() => parseWindows('')).toThrow(/at least one window/)
  })

  it('rejects a malformed entry', () => {
    expect(() => parseWindows('06:00-08:00')).toThrow(/06:00-08:00/)
    expect(() => parseWindows('6-8x4')).toThrow(/6-8x4/)
  })

  it('rejects an invalid time', () => {
    expect(() => parseWindows('06:00-25:00x4')).toThrow(/invalid time/)
    expect(() => parseWindows('06:70-08:00x4')).toThrow(/invalid time/)
  })

  it('rejects a window that wraps past midnight', () => {
    expect(() => parseWindows('22:00-02:00x4')).toThrow(/wrap past midnight/)
    expect(() => parseWindows('08:00-08:00x4')).toThrow(/wrap past midnight/)
  })

  it('rejects a window with no quota to spend', () => {
    expect(() => parseWindows('06:00-08:00x0')).toThrow(/quota/)
  })

  it('rejects overlapping windows', () => {
    expect(() => parseWindows('06:00-10:00x4,09:00-12:00x6')).toThrow(
      /must not overlap/,
    )
  })

  it('allows windows that touch without overlapping', () => {
    expect(parseWindows('06:00-08:00x4,08:00-10:00x6')).toHaveLength(2)
  })
})

describe('activeWindowAt', () => {
  it('finds the window containing the instant', () => {
    expect(activeWindowAt(TZ, two, at('2026-08-07T18:00:00'))?.quota).toBe(6)
    expect(activeWindowAt(TZ, two, at('2026-08-07T07:00:00'))?.quota).toBe(4)
  })

  it('treats the start as inside and the end as outside', () => {
    expect(activeWindowAt(TZ, two, at('2026-08-07T06:00:00'))).not.toBeNull()
    expect(activeWindowAt(TZ, two, at('2026-08-07T08:00:00'))).toBeNull()
  })

  it('returns null between windows', () => {
    expect(activeWindowAt(TZ, two, at('2026-08-07T12:00:00'))).toBeNull()
  })
})

describe('window boundaries', () => {
  it('gives the opening and closing instants on the day of `now`', () => {
    const evening = two[1]!
    const now = at('2026-08-07T19:30:00')
    expect(windowStartAt(TZ, evening, now)).toEqual(at('2026-08-07T17:00:00'))
    expect(windowEndAt(TZ, evening, now)).toEqual(at('2026-08-07T23:00:00'))
  })
})

describe('nextWindowStartAfter', () => {
  it('finds a later window on the same day', () => {
    expect(nextWindowStartAfter(TZ, two, at('2026-08-07T09:00:00'))).toEqual(
      at('2026-08-07T17:00:00'),
    )
  })

  it('rolls to the first window tomorrow once the last one has opened', () => {
    expect(nextWindowStartAfter(TZ, two, at('2026-08-07T23:30:00'))).toEqual(
      at('2026-08-08T06:00:00'),
    )
  })

  it('rolls over from inside the last window too', () => {
    expect(nextWindowStartAfter(TZ, two, at('2026-08-07T20:00:00'))).toEqual(
      at('2026-08-08T06:00:00'),
    )
  })

  it('never proposes an instant in the past', () => {
    for (const hour of [0, 5, 6, 7, 9, 16, 17, 22, 23]) {
      const now = at(`2026-08-07T${String(hour).padStart(2, '0')}:00:00`)
      expect(
        nextWindowStartAfter(TZ, two, now).getTime(),
      ).toBeGreaterThan(now.getTime())
    }
  })
})

describe('nextDayFirstWindowStart', () => {
  it('is tomorrow’s first opening whatever time it is asked', () => {
    expect(nextDayFirstWindowStart(TZ, two, at('2026-08-07T07:00:00'))).toEqual(
      at('2026-08-08T06:00:00'),
    )
    expect(nextDayFirstWindowStart(TZ, two, at('2026-08-07T22:00:00'))).toEqual(
      at('2026-08-08T06:00:00'),
    )
  })
})

describe('the configured zone', () => {
  it('reads windows in the named zone, not the host clock', () => {
    // 2026-08-07T01:00:00Z is 09:00 in Shanghai — between the two windows.
    const now = new Date('2026-08-07T01:00:00Z')
    expect(activeWindowAt(TZ, two, now)).toBeNull()
    // 2026-08-07T10:00:00Z is 18:00 in Shanghai — inside the evening window.
    expect(activeWindowAt(TZ, two, new Date('2026-08-07T10:00:00Z'))?.quota).toBe(6)
    expect(nextWindowStartAfter(TZ, two, now)).toEqual(
      new Date('2026-08-07T09:00:00Z'),
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `x-poster/`: `pnpm vitest run src/queue/windows.test.ts`

Expected: FAIL — `Failed to load url ./windows.js`.

- [ ] **Step 3: Write the implementation**

Create `x-poster/src/queue/windows.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `x-poster/`: `pnpm vitest run src/queue/windows.test.ts`

Expected: PASS, 20 tests.

- [ ] **Step 5: Typecheck**

Run from `x-poster/`: `pnpm build && rm -rf dist`

Expected: no output from `tsc`.

- [ ] **Step 6: Commit**

```bash
git add x-poster/src/queue/windows.ts x-poster/src/queue/windows.test.ts
git commit -m "feat(x-poster): posting windows with their own quotas"
```

---

### Task 2: The derived gap

**Files:**
- Modify: `x-poster/src/queue/rate-limiter.ts` (add an exported function; `decide` is untouched in this task)
- Test: `x-poster/src/queue/rate-limiter.test.ts` (add a new `describe`; existing cases untouched)

**Interfaces:**
- Consumes: `Rng` from `../human/delay.js`.
- Produces: `nextGapMinutes(windowEnd: Date, lastPostedAt: Date, remainingQuota: number, jitter: number, rng?: Rng): number` — minutes, unclamped. Task 4 applies the `X_MIN_INTERVAL_MINUTES` floor.

- [ ] **Step 1: Write the failing test**

Append to `x-poster/src/queue/rate-limiter.test.ts`:

```ts
describe('nextGapMinutes', () => {
  const end = new Date('2026-08-07T23:00:00')
  const steady = () => 0.5 // the midpoint of the jitter range: no adjustment

  it('spreads the remaining quota over the remaining window', () => {
    // Six over 17:00-23:00: after the first post there are five left and six
    // hours, and the +1 puts the last one an hour before the close.
    const gap = nextGapMinutes(end, new Date('2026-08-07T17:00:00'), 5, 0, steady)
    expect(gap).toBe(60)
  })

  it('holds that pace as the window drains', () => {
    expect(
      nextGapMinutes(end, new Date('2026-08-07T18:00:00'), 4, 0, steady),
    ).toBe(60)
    expect(
      nextGapMinutes(end, new Date('2026-08-07T21:00:00'), 1, 0, steady),
    ).toBe(60)
  })

  it('derives a tighter pace for a short window', () => {
    // Four over 06:00-08:00, after the first post: three left, two hours.
    const morningEnd = new Date('2026-08-07T08:00:00')
    expect(
      nextGapMinutes(morningEnd, new Date('2026-08-07T06:00:00'), 3, 0, steady),
    ).toBe(30)
  })

  it('catches up after a slot that could not be filled', () => {
    // The 18:00 post did not go out until 18:30. The quota is unchanged and
    // the window is shorter, so the gap narrows rather than pushing work past
    // the close.
    const gap = nextGapMinutes(end, new Date('2026-08-07T18:30:00'), 4, 0, steady)
    expect(gap).toBe(54)
  })

  it('applies jitter symmetrically about the target', () => {
    const last = new Date('2026-08-07T17:00:00')
    expect(nextGapMinutes(end, last, 5, 0.25, () => 1)).toBeCloseTo(75)
    expect(nextGapMinutes(end, last, 5, 0.25, () => 0)).toBeCloseTo(45)
    expect(nextGapMinutes(end, last, 5, 0.25, steady)).toBeCloseTo(60)
  })

  it('averages the target rather than drifting below it', () => {
    // The property `sampleDelay` would break: a log-normal with its median at
    // a quarter of the range biases every gap low, and a window's worth of
    // low draws spends the quota early and idles out the rest.
    //
    // Named `sequence`, not `rng`: the file-level `rng` rebuilds the
    // generator on every call and so returns one fixed number, which would
    // average to itself and prove nothing.
    const last = new Date('2026-08-07T17:00:00')
    const sequence = mulberry32(2026)
    let total = 0
    for (let i = 0; i < 2000; i++) {
      total += nextGapMinutes(end, last, 5, 0.25, sequence)
    }
    expect(total / 2000).toBeGreaterThan(58)
    expect(total / 2000).toBeLessThan(62)
  })
})
```

Also add `nextGapMinutes` to the existing import at the top of the file, so the first line becomes:

```ts
import { decide, nextGapMinutes, type PostingHistory } from './rate-limiter.js'
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `x-poster/`: `pnpm vitest run src/queue/rate-limiter.test.ts`

Expected: FAIL — `nextGapMinutes is not a function`.

- [ ] **Step 3: Write the implementation**

In `x-poster/src/queue/rate-limiter.ts`, add below the existing `MS_PER_MINUTE` constant:

```ts
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
```

The file already imports `sampleDelay` and `type Rng` from `../human/delay.js`; leave that import as it is for now — `decide` still uses `sampleDelay` until Task 3.

- [ ] **Step 4: Run the test to verify it passes**

Run from `x-poster/`: `pnpm vitest run src/queue/rate-limiter.test.ts`

Expected: PASS — the 13 existing cases plus 6 new ones.

- [ ] **Step 5: Typecheck**

Run from `x-poster/`: `pnpm build && rm -rf dist`

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add x-poster/src/queue/rate-limiter.ts x-poster/src/queue/rate-limiter.test.ts
git commit -m "feat(x-poster): derive the gap from what is left of the window"
```

---

### Task 3: The window's own count

Lands before the switch, so that Task 4 has the count it needs and every task ends on a tree that compiles.

**Files:**
- Modify: `x-poster/src/queue/tweet-queue.ts` (imports, add `postedSince`)
- Test: `x-poster/src/queue/tweet-queue.test.ts` (one new case in `describe('history')`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `TweetQueue.postedSince(since: Date): Promise<number>`.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('history')` block in `x-poster/src/queue/tweet-queue.test.ts`:

```ts
  it('counts only what was posted since the given instant', async () => {
    // What a window needs: a morning window's four must not be charged
    // against the evening's six, so the boundary matters and the day's total
    // does not.
    //
    // The boundaries are an hour out either side because `markPosted` writes
    // the database's `now()` and the assertions run on the host's clock; an
    // hour of slack means the case does not depend on the two agreeing.
    const anHourAgo = new Date(Date.now() - 60 * 60_000)
    const inAnHour = new Date(Date.now() + 60 * 60_000)
    const before = await queue.postedSince(anHourAgo)

    await queue.enqueue({ content: 'one', dedupeKey: 'test:w1' })
    await queue.enqueue({ content: 'two', dedupeKey: 'test:w2' })
    const first = await queue.claimNext()
    await queue.markPosted(first!.id, null)
    const second = await queue.claimNext()
    await queue.markPosted(second!.id, null)

    expect(await queue.postedSince(anHourAgo)).toBe(before + 2)
    expect(await queue.postedSince(inAnHour)).toBe(0)
  })
```

Note the `test:` prefix on both dedupe keys. `beforeEach` and `afterAll` in this file only delete rows matching `dedupe_key LIKE 'test:%'`, so any other prefix leaks rows into the database and into later runs. The relative assertion (`before + 2`) follows the same file's existing cases, which tolerate rows this suite did not create.

- [ ] **Step 2: Run the test to verify it fails**

Run from `x-poster/`: `pnpm vitest run src/queue/tweet-queue.test.ts`

Expected: FAIL — `queue.postedSince is not a function`.

- [ ] **Step 3: Implement `postedSince`**

In `x-poster/src/queue/tweet-queue.ts`, add `gte` to the drizzle import:

```ts
import { and, eq, gte, lte, max, sql } from 'drizzle-orm'
```

Add below `history`:

```ts
  /**
   * How many posts have gone out since `since`.
   *
   * Kept separate from `history` rather than folded into it: this one is
   * asked about a window boundary the caller computes, and the queue has no
   * business knowing what a posting window is.
   */
  async postedSince(since: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<string>`count(*)` })
      .from(tweets)
      .where(and(eq(tweets.status, 'posted'), gte(tweets.postedAt, since)))

    return Number(row?.count ?? 0)
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `x-poster/`: `pnpm vitest run src/queue/tweet-queue.test.ts`

Expected: PASS, 18 tests.

- [ ] **Step 5: Typecheck**

Run from `x-poster/`: `pnpm build && rm -rf dist`

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add x-poster/src/queue/tweet-queue.ts x-poster/src/queue/tweet-queue.test.ts
git commit -m "feat(x-poster): count what a window has published"
```

---

### Task 4: Switch the config and the decision over

The task that changes behaviour. Config, `decide`, and `index.ts` move together because `XPosterConfig` is the interface between them: splitting them leaves the package uncompilable in between.

**Files:**
- Modify: `x-poster/src/config.ts`
- Modify: `x-poster/src/config.test.ts:23-61` (the defaults case and the four active-hours/interval cases)
- Modify: `x-poster/src/queue/rate-limiter.ts` (`decide`, `PostingHistory`, `RateLimitReason`)
- Modify: `x-poster/src/queue/rate-limiter.test.ts:6-28` (the shared config and `fresh`), plus the interval cases
- Modify: `x-poster/src/queue/tweet-queue.ts` (the `history` return type only)
- Modify: `x-poster/src/index.ts:66-88` (`tick`) and `:217-222` (the startup log)
- Modify: `x-poster/.env.example:24-30`
- Modify: `README.md:159-162`

**Interfaces:**
- Consumes: everything Tasks 1, 2 and 3 produced.
- Produces:
  - `XPosterConfig.windows: PostingWindow[]`, `XPosterConfig.intervalJitter: number` — replacing `activeHours` and `maxIntervalMinutes`
  - `PostingHistory` gains `postedInWindow: number`
  - `export type PostingCounts = Omit<PostingHistory, 'postedInWindow'>` — what `TweetQueue.history` returns
  - `RateLimitReason` gains `'window-quota'`

- [ ] **Step 1: Update the config tests to the new shape**

In `x-poster/src/config.test.ts`, replace the defaults assertion for active hours and the four cases at lines 35–61 with:

```ts
  it('parses windows with their quotas', () => {
    const config = loadConfig({
      ...required,
      X_WINDOWS: '06:00-08:00x4,17:00-23:00x6',
    })
    expect(config.windows).toEqual([
      { startMinute: 360, endMinute: 480, quota: 4 },
      { startMinute: 1020, endMinute: 1380, quota: 6 },
    ])
  })

  it('rejects window quotas that exceed the daily cap', () => {
    // Quota that cannot be spent is a window that silently never fires.
    expect(() =>
      loadConfig({
        ...required,
        X_WINDOWS: '06:00-08:00x6,17:00-23:00x6',
        X_DAILY_CAP: '10',
      }),
    ).toThrow(/exceed X_DAILY_CAP/)
  })

  it('requires X_WINDOWS', () => {
    const { X_WINDOWS: _omitted, ...withoutWindows } = required
    expect(() => loadConfig(withoutWindows)).toThrow(/X_WINDOWS is required/)
  })

  it('names the replacement when only the old X_ACTIVE_HOURS is set', () => {
    // A silent fall back to the old single window is the one outcome worse
    // than refusing to start.
    const { X_WINDOWS: _omitted, ...withoutWindows } = required
    expect(() =>
      loadConfig({ ...withoutWindows, X_ACTIVE_HOURS: '09:00-23:00' }),
    ).toThrow(/X_ACTIVE_HOURS has been replaced by X_WINDOWS/)
  })

  it('defaults the interval jitter and rejects one outside [0, 1)', () => {
    expect(loadConfig(required).intervalJitter).toBe(0.25)
    expect(loadConfig({ ...required, X_INTERVAL_JITTER: '0' }).intervalJitter).toBe(0)
    expect(() =>
      loadConfig({ ...required, X_INTERVAL_JITTER: '1' }),
    ).toThrow(/X_INTERVAL_JITTER/)
    expect(() =>
      loadConfig({ ...required, X_INTERVAL_JITTER: '-0.1' }),
    ).toThrow(/X_INTERVAL_JITTER/)
  })
```

Update the `required` fixture at the top of that file to include `X_WINDOWS: '09:00-23:00x10'`, and in the `applies documented defaults` case replace the `config.activeHours` assertion with:

```ts
    expect(config.windows).toEqual([
      { startMinute: 540, endMinute: 1380, quota: 10 },
    ])
    expect(config.intervalJitter).toBe(0.25)
    expect(config.minIntervalMinutes).toBe(20)
```

- [ ] **Step 2: Run the config tests to verify they fail**

Run from `x-poster/`: `pnpm vitest run src/config.test.ts`

Expected: FAIL — `config.windows` is undefined and `X_WINDOWS` is ignored.

- [ ] **Step 3: Rewrite the config**

In `x-poster/src/config.ts`: add the import, replace `parseActiveHours` and the `ActiveHours` interface, and rewrite the returned object.

```ts
import dotenv from 'dotenv'
import { parseWindows, type PostingWindow } from './queue/windows.js'

dotenv.config()

export interface XPosterConfig {
  profileDir: string
  debugPort: number
  chromePath: string
  dryRun: boolean
  minIntervalMinutes: number
  /** How far the derived gap may stray from its target, as a fraction. */
  intervalJitter: number
  dailyCap: number
  windows: PostingWindow[]
  timezone: string
  maxAttempts: number
  discordWebhookUrl: string | null
}
```

Delete the `ActiveHours` interface and the whole `parseActiveHours` function. Add a validator beside `positiveInt`:

```ts
/** A fraction in [0, 1). One is not allowed: a gap may not reach zero. */
function fraction(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`${key} must be at least 0 and below 1, got: ${raw}`)
  }
  return value
}
```

Replace the body of `loadConfig` — the min/max comparison goes, the window checks arrive:

```ts
export function loadConfig(env: NodeJS.ProcessEnv = process.env): XPosterConfig {
  if (!env.X_WINDOWS) {
    throw new Error(
      env.X_ACTIVE_HOURS
        ? 'X_ACTIVE_HOURS has been replaced by X_WINDOWS, which gives each ' +
          'window its own quota. Set X_WINDOWS=06:00-08:00x4,17:00-23:00x6 ' +
          'and remove X_ACTIVE_HOURS and X_MAX_INTERVAL_MINUTES.'
        : 'X_WINDOWS is required, like "06:00-08:00x4,17:00-23:00x6"',
    )
  }

  const windows = parseWindows(env.X_WINDOWS)
  const dailyCap = positiveInt(env, 'X_DAILY_CAP', 10)
  const quotaTotal = windows.reduce((sum, window) => sum + window.quota, 0)

  if (quotaTotal > dailyCap) {
    // Quota that cannot be spent is a window that silently never fires,
    // which reads as "the evening is broken" rather than as a mistake here.
    throw new Error(
      `The window quotas (${quotaTotal}) exceed X_DAILY_CAP (${dailyCap})`,
    )
  }

  return {
    profileDir: requiredString(env, 'X_PROFILE_DIR'),
    debugPort: positiveInt(env, 'X_DEBUG_PORT', 9333),
    chromePath: env.X_CHROME_PATH || DEFAULT_CHROME_PATH,
    dryRun: (env.X_DRY_RUN ?? '').toLowerCase() === 'true',
    minIntervalMinutes: positiveInt(env, 'X_MIN_INTERVAL_MINUTES', 20),
    intervalJitter: fraction(env, 'X_INTERVAL_JITTER', 0.25),
    dailyCap,
    windows,
    // Required rather than defaulted. The windows and the daily cap are both
    // expressed in it, and a default would silently be the host's zone on one
    // machine and the operator's on another — which is the bug this replaced,
    // not a convenience.
    timezone: requiredString(env, 'TIMEZONE'),
    maxAttempts: positiveInt(env, 'X_MAX_ATTEMPTS', 3),
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL || null,
  }
}
```

- [ ] **Step 4: Run the config tests to verify they pass**

Run from `x-poster/`: `pnpm vitest run src/config.test.ts`

Expected: PASS. `pnpm vitest run` as a whole still FAILS — `rate-limiter.ts` reads `config.activeHours`, which no longer exists. That is the next step.

- [ ] **Step 5: Update the rate-limiter tests**

In `x-poster/src/queue/rate-limiter.test.ts`, replace the shared config and `fresh` at lines 6–28:

```ts
const config = loadConfig({
  X_PROFILE_DIR: '/tmp/x-profile',
  X_WINDOWS: '09:00-23:00x10',
  X_MIN_INTERVAL_MINUTES: '20',
  X_INTERVAL_JITTER: '0.25',
  X_DAILY_CAP: '10',
  TIMEZONE: 'Asia/Shanghai',
} as NodeJS.ProcessEnv)

const fresh: PostingHistory = {
  lastPostedAt: null,
  postedToday: 0,
  postedInWindow: 0,
}
```

Every remaining case that builds a history literal needs `postedInWindow`. Set it equal to `postedToday` in each — the single window makes them the same number:

- `holds off until the sampled interval has elapsed` → `{ lastPostedAt: at('2026-08-04T12:00:00'), postedToday: 1, postedInWindow: 1 }`
- `allows the next post once the ceiling interval has passed` → `postedToday: 1, postedInWindow: 1`
- `stops at the daily cap and waits for tomorrow` → `postedToday: 10, postedInWindow: 10`
- `checks the daily cap before the interval` → `postedToday: 10, postedInWindow: 10`
- `checks the active-hours window before anything else` → `postedToday: 10, postedInWindow: 10`
- `never proposes a wait in the past` → `{ lastPostedAt: now, postedToday: 3, postedInWindow: 3 }`
- both cases in `describe('the day boundary')` use the file-level `fresh`; give the local `fresh` on that line the third field too.

Rewrite the interval case, because the gap is now derived rather than sampled from 20–60. At 12:05 with the last post at 12:00, the window closes at 23:00 and nine of the ten remain, so the target is 660/10 = 66 minutes and jitter puts it in 49.5–82.5:

```ts
  it('holds off until the derived gap has elapsed', () => {
    const result = decide(
      at('2026-08-04T12:05:00'),
      {
        lastPostedAt: at('2026-08-04T12:00:00'),
        postedToday: 1,
        postedInWindow: 1,
      },
      config,
      rng,
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('interval')

    const waitMinutes =
      (result.waitUntil!.getTime() - at('2026-08-04T12:00:00').getTime()) / 60000
    expect(waitMinutes).toBeGreaterThanOrEqual(49.5)
    expect(waitMinutes).toBeLessThanOrEqual(82.5)
  })
```

Then add the new cases:

```ts
describe('the window quota', () => {
  const two = loadConfig({
    X_PROFILE_DIR: '/tmp/x-profile',
    X_WINDOWS: '06:00-08:00x4,17:00-23:00x6',
    X_MIN_INTERVAL_MINUTES: '20',
    X_INTERVAL_JITTER: '0',
    X_DAILY_CAP: '10',
    TIMEZONE: 'Asia/Shanghai',
  } as NodeJS.ProcessEnv)

  it('lets the first post of a window go without a gap', () => {
    const result = decide(
      at('2026-08-07T17:00:00'),
      {
        lastPostedAt: at('2026-08-07T07:30:00'),
        postedToday: 4,
        postedInWindow: 0,
      },
      two,
      rng,
    )
    expect(result).toEqual({ allowed: true, waitUntil: null, reason: 'ok' })
  })

  it('waits for the next window once this one has spent its quota', () => {
    const result = decide(
      at('2026-08-07T07:45:00'),
      {
        lastPostedAt: at('2026-08-07T07:30:00'),
        postedToday: 4,
        postedInWindow: 4,
      },
      two,
      rng,
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('window-quota')
    expect(result.waitUntil).toEqual(at('2026-08-07T17:00:00'))
  })

  it('checks the daily cap before the window quota', () => {
    // At the cap the honest answer is "not today", and tomorrow's first
    // window is not the next window on the clock.
    const result = decide(
      at('2026-08-07T18:00:00'),
      {
        lastPostedAt: at('2026-08-07T17:00:00'),
        postedToday: 10,
        postedInWindow: 1,
      },
      two,
      rng,
    )
    expect(result.reason).toBe('daily-cap')
    expect(result.waitUntil).toEqual(at('2026-08-08T06:00:00'))
  })

  it('paces the evening at an hour and finishes before the close', () => {
    // Jitter is zero in this config, so the schedule is exact.
    const expected = [
      ['2026-08-07T17:00:00', 1, '2026-08-07T18:00:00'],
      ['2026-08-07T18:00:00', 2, '2026-08-07T19:00:00'],
      ['2026-08-07T21:00:00', 5, '2026-08-07T22:00:00'],
    ] as const

    for (const [last, posted, readyAt] of expected) {
      const result = decide(
        at(last),
        { lastPostedAt: at(last), postedToday: posted, postedInWindow: posted },
        two,
        rng,
      )
      expect(result.reason).toBe('interval')
      expect(result.waitUntil).toEqual(at(readyAt))
    }
  })

  it('floors the gap at the configured minimum', () => {
    // A window with one minute left and quota to spare would otherwise ask
    // for a gap of seconds.
    const result = decide(
      at('2026-08-07T22:59:00'),
      {
        lastPostedAt: at('2026-08-07T22:59:00'),
        postedToday: 5,
        postedInWindow: 5,
      },
      two,
      rng,
    )
    expect(result.reason).toBe('interval')
    expect(result.waitUntil).toEqual(at('2026-08-07T23:19:00'))
  })
})
```

- [ ] **Step 6: Run the rate-limiter tests to verify they fail**

Run from `x-poster/`: `pnpm vitest run src/queue/rate-limiter.test.ts`

Expected: FAIL — `config.activeHours` is undefined, and `'window-quota'` is not a reason `decide` can return.

- [ ] **Step 7: Rewrite `decide`**

In `x-poster/src/queue/rate-limiter.ts`, replace the imports, the `PostingHistory` and `RateLimitReason` declarations, the `windowOpensOn` helper, and `decide`. `nextGapMinutes` from Task 2 stays as it is.

```ts
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
```

Delete `windowOpensOn` and the `sampleDelay` import — nothing uses either now. Then:

```ts
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
```

- [ ] **Step 8: Wire `tick` and the startup log**

In `x-poster/src/queue/tweet-queue.ts`, change the rate-limiter type import
and the `history` return type — it counts the day, and it has no opinion about
windows:

```ts
import type { PostingCounts } from './rate-limiter.js'
```

```ts
  async history(
    timezone: string,
    now: Date = new Date(),
  ): Promise<PostingCounts> {
```

In `x-poster/src/index.ts`, add to the imports:

```ts
import { activeWindowAt, windowStartAt } from './queue/windows.js'
```

Replace the opening of `tick` — currently `const now` followed by `const verdict`:

```ts
async function tick(): Promise<void> {
  const now = new Date()
  const counts = await queue.history(config.timezone, now)

  // The window is looked up here rather than inside `decide` because the
  // count it implies has to come from the database, and `decide` is pure.
  const window = activeWindowAt(config.timezone, config.windows, now)
  const postedInWindow = window
    ? await queue.postedSince(windowStartAt(config.timezone, window, now))
    : 0

  const verdict = decide(now, { ...counts, postedInWindow }, config)
```

The rest of `tick` is unchanged. In `main`, replace the `activeHours` field of
the startup log:

```ts
  logger.info('Starting x-poster', {
    dryRun: config.dryRun,
    dailyCap: config.dailyCap,
    windows: config.windows.map(
      (window) => `${window.startMinute}-${window.endMinute}x${window.quota}`,
    ),
  })
```

- [ ] **Step 9: Run the whole suite and typecheck**

Run from `x-poster/`: `pnpm build && rm -rf dist && pnpm vitest run`

Expected: `tsc` silent, all tests PASS. If `tweet-queue.test.ts` fails, re-run
it alone — see the note in Global Constraints.

- [ ] **Step 10: Update `.env.example`**

In `x-poster/.env.example`, replace lines 24-30 (the pacing block and the
active-hours block) with:

```bash
# Pacing. Each window carries its own quota, written as HH:MM-HH:MMx<quota>.
# The gap between posts is derived from what is left of the window divided by
# what is left of its quota, so neither window needs an interval configured:
# four over two morning hours comes out at half an hour, six over six evening
# hours at an hour. Windows must not wrap past midnight or overlap, and their
# quotas must not exceed X_DAILY_CAP.
X_WINDOWS=06:00-08:00x4,17:00-23:00x6

# How far a derived gap may stray from its target, as a fraction. Not
# decoration: a post exactly on the hour is a stronger fixed-period signature
# than a sampled one.
X_INTERVAL_JITTER=0.25

# A floor under the derived gap, for the end of a window.
X_MIN_INTERVAL_MINUTES=20

# A backstop, not a pace - the window quotas already sum to at most this.
X_DAILY_CAP=10
```

- [ ] **Step 11: Update the README table**

In `README.md`, replace lines 159-162 with:

```markdown
| `X_MIN_INTERVAL_MINUTES` | Floor under the derived gap between tweets | `20` |
| `X_INTERVAL_JITTER` | How far a gap may stray from its target, as a fraction in `[0, 1)` | `0.25` |
| `X_DAILY_CAP` | Backstop on tweets per day; the window quotas already sum to at most this | `10` |
| `X_WINDOWS` | Posting windows with per-window quotas, `HH:MM-HH:MMx<quota>` comma-separated. Must not wrap past midnight or overlap. Required. | - |
```

- [ ] **Step 12: Commit**

```bash
git add x-poster/src/config.ts x-poster/src/config.test.ts \
  x-poster/src/queue/rate-limiter.ts x-poster/src/queue/rate-limiter.test.ts \
  x-poster/src/queue/tweet-queue.ts x-poster/src/index.ts \
  x-poster/.env.example README.md
git commit -m "feat(x-poster): pace inside windows that carry their own quota"
```

---

## Manual acceptance

Not automatable — the schedule only shows itself over a day.

1. On the machine that runs the service, set `X_WINDOWS=06:00-08:00x4,17:00-23:00x6` in `x-poster/.env` and delete `X_ACTIVE_HOURS` and `X_MAX_INTERVAL_MINUTES`.
2. Start with `X_DRY_RUN=true` and confirm the startup log names both windows.
3. Outside both windows, confirm the log says `Holding off` with `reason: "outside-active-hours"` and an `until` at the next opening — 17:00 if it is the afternoon, 06:00 tomorrow if it is the evening.
4. Inside a window with the queue stocked, confirm `Holding off` with `reason: "interval"` and an `until` roughly an hour out in the evening, half an hour in the morning.
5. Leave it a full day with `X_DRY_RUN=false` and check the timeline: four posts before 08:00, six between 17:00 and 22:00, none in between.
