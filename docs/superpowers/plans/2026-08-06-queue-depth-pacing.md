# Queue-Depth Pacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tweet-generator restock a two-item buffer instead of producing on
a two-hour clock, so x-poster alone decides the pace at which tweets reach X.

**Architecture:** The generator's outer loop asks `store.pendingCount()` how
much stock is left. Below the watermark it runs a cycle; at or above it, it
sleeps a short poll interval. `tick` returns which of three things happened so
the loop knows how long to wait. Both services take their day boundary from one
shared timezone-aware `startOfDayIn`.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Drizzle ORM
over `pg`, Vitest, pnpm workspaces.

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-08-06-queue-depth-pacing-design.md`.
- `QUEUE_TARGET` defaults to `2`; `QUEUE_POLL_MINUTES` defaults to `5`.
- `CYCLE_MINUTES` and `CYCLE_JITTER_MINUTES` are removed outright, along with
  `nextIntervalMs` and the generator's `mulberry32` seeding. This is a breaking
  `.env` change.
- Only `status = 'pending'` counts as stock. `sending` is already claimed;
  `posted`, `failed` and `uncertain` are terminal.
- Imports inside a package use `./x.js` specifiers even for `.ts` sources.
  Cross-package imports use the bare name (`shared/clock`).
- Store tests run against the real Postgres on `localhost:5432`, database
  `multi_tab_listening`, and clean up rows keyed `test:%`.
- Run the full suite with `pnpm --filter <pkg> test`; typecheck with
  `pnpm --filter <pkg> build`. Delete any `dist/` produced by a typecheck before
  committing — it is not in `.gitignore`.

## Deviations From The Spec

Two gaps surfaced while planning. Both are decided here; the spec's pseudocode
does not cover them.

**`tick` returning is not the same as `tick` enqueueing.** A cycle can return
having enqueued nothing — every pool empty, every candidate given up on, or the
daily cap reached. The spec's loop would then re-run immediately and spin,
hammering the AgentLens API. `tick` therefore returns a `CycleOutcome` and the
loop waits accordingly.

**An empty pool needs its own backoff.** `selectCandidate` calls the AgentLens
API, so polling it every `QUEUE_POLL_MINUTES` during a drought would turn 12
calls a day into 288. A third knob, `EMPTY_POOL_MINUTES` (default `30`), paces
the outcome where the generator tried and found nothing. `QUEUE_POLL_MINUTES`
stays short because that path is a bare `COUNT` against an indexed column.

---

### Task 1: Move the clock into `shared`

**Files:**
- Create: `shared/src/clock.ts`
- Create: `shared/src/clock.test.ts`
- Delete: `tweet-generator/src/select/clock.ts`, `tweet-generator/src/select/clock.test.ts`
- Modify: `shared/package.json` (exports map), `tweet-generator/src/index.ts:17`,
  `tweet-generator/src/select/pool.ts:13`, `tweet-generator/src/select/quota.ts:6`

**Interfaces:**
- Produces: `startOfDayIn(timezone: string, at: Date): Date`,
  `minutesIntoDayIn(timezone: string, at: Date): number`,
  `nextDayStartIn(timezone: string, at: Date): Date`

- [ ] **Step 1: Move the file verbatim**

`git mv tweet-generator/src/select/clock.ts shared/src/clock.ts` and
`git mv tweet-generator/src/select/clock.test.ts shared/src/clock.test.ts`.
Change nothing inside either file yet. The existing implementation already
handles the DST two-pass correctly and must not be rewritten.

- [ ] **Step 2: Add the export**

In `shared/package.json`, add to `exports`, after `"./rng"`:

```json
    "./clock": "./src/clock.ts"
```

- [ ] **Step 3: Repoint the three importers**

```ts
// tweet-generator/src/index.ts:17
import { startOfDayIn } from 'shared/clock'
// tweet-generator/src/select/pool.ts:13
import { startOfDayIn } from 'shared/clock'
// tweet-generator/src/select/quota.ts:6
import { minutesIntoDayIn } from 'shared/clock'
```

- [ ] **Step 4: Write the failing test for the new helper**

Append to `shared/src/clock.test.ts`:

```ts
describe('nextDayStartIn', () => {
  it('returns tomorrow midnight in the named zone', () => {
    const at = new Date('2026-08-06T15:30:00Z') // 23:30 in Shanghai
    expect(nextDayStartIn('Asia/Shanghai', at).toISOString()).toBe(
      '2026-08-06T16:00:00.000Z', // 2026-08-07 00:00 +08:00
    )
  })

  it('is unaffected by the host zone', () => {
    const at = new Date('2026-08-06T01:00:00Z') // 09:00 Shanghai, 02:00 Berlin
    expect(nextDayStartIn('Asia/Shanghai', at).toISOString()).toBe(
      '2026-08-06T16:00:00.000Z',
    )
  })
})
```

Add `nextDayStartIn` to the import at the top of the test file.

- [ ] **Step 5: Run it and watch it fail**

Run: `pnpm --filter shared test -- clock`
Expected: FAIL — `nextDayStartIn is not a function`.

- [ ] **Step 6: Implement it**

Append to `shared/src/clock.ts`:

```ts
/**
 * The next midnight in `timezone` strictly after `at`.
 *
 * Adding 24 hours before taking the day start rather than adding a day to the
 * wall clock: the offset can change between the two instants, and
 * `startOfDayIn` already resolves that correctly for whatever instant it is
 * handed.
 */
export function nextDayStartIn(timezone: string, at: Date): Date {
  return startOfDayIn(timezone, new Date(at.getTime() + 86_400_000))
}
```

- [ ] **Step 7: Run the full suites**

Run: `pnpm --filter shared test && pnpm --filter tweet-generator test`
Expected: PASS. The generator suite proves the three repointed imports resolve.

- [ ] **Step 8: Commit**

```bash
git add shared/src/clock.ts shared/src/clock.test.ts shared/package.json \
        tweet-generator/src/index.ts tweet-generator/src/select/pool.ts \
        tweet-generator/src/select/quota.ts
git rm --cached -r tweet-generator/src/select/clock.ts tweet-generator/src/select/clock.test.ts 2>/dev/null || true
git commit -m "refactor(shared): make the day boundary one implementation"
```

---

### Task 2: Count the stock

**Files:**
- Modify: `tweet-generator/src/store.ts` (new method after `usageSince`, ~line 105)
- Test: `tweet-generator/src/store.test.ts`

**Interfaces:**
- Consumes: `tweets` from `shared/schema`, `count`/`eq` from `drizzle-orm`
  (both already imported in `store.ts`)
- Produces: `GeneratorStore.pendingCount(): Promise<number>`

- [ ] **Step 1: Write the failing test**

Append to `tweet-generator/src/store.test.ts`:

```ts
describe('pendingCount', () => {
  it('counts only rows still waiting to be posted', async () => {
    await store.enqueue({ content: 'a', dedupeKey: 'test:p1' })
    await store.enqueue({ content: 'b', dedupeKey: 'test:p2' })
    expect(await store.pendingCount()).toBe(2)
  })

  it('stops counting a row once x-poster has posted it', async () => {
    await store.enqueue({ content: 'a', dedupeKey: 'test:p3' })
    await markPosted('test:p3')
    expect(await store.pendingCount()).toBe(0)
  })

  it('does not count a row x-poster has already claimed', async () => {
    // 'sending' is stock that has left the shelf: counting it would let the
    // buffer read as full while the poster is mid-flight.
    await store.enqueue({ content: 'a', dedupeKey: 'test:p4' })
    await pool.query(
      "UPDATE tweets SET status = 'sending' WHERE dedupe_key = $1",
      ['test:p4'],
    )
    expect(await store.pendingCount()).toBe(0)
  })

  it('does not count terminal failures', async () => {
    await store.enqueue({ content: 'a', dedupeKey: 'test:p5' })
    await pool.query(
      "UPDATE tweets SET status = 'failed' WHERE dedupe_key = $1",
      ['test:p5'],
    )
    expect(await store.pendingCount()).toBe(0)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter tweet-generator test -- store`
Expected: FAIL — `store.pendingCount is not a function`.

- [ ] **Step 3: Implement it**

Insert into `GeneratorStore` immediately after `usageSince`:

```ts
  /**
   * How many tweets are still waiting for x-poster to take them.
   *
   * This is the generator's set point, so only 'pending' is stock. A 'sending'
   * row has already been claimed and is about to leave; 'posted', 'failed' and
   * 'uncertain' are terminal. Counting any of them would let a stuck row
   * masquerade as inventory and starve the buffer.
   */
  async pendingCount(): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(tweets)
      .where(eq(tweets.status, 'pending'))

    return row?.count ?? 0
  }
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter tweet-generator test -- store`
Expected: PASS, 19 tests in the file.

- [ ] **Step 5: Commit**

```bash
git add tweet-generator/src/store.ts tweet-generator/src/store.test.ts
git commit -m "feat(tweet-generator): count the tweets still waiting to be posted"
```

---

### Task 3: The pacing decisions, as pure functions

**Files:**
- Create: `tweet-generator/src/pace.ts`
- Create: `tweet-generator/src/pace.test.ts`

**Interfaces:**
- Consumes: `nextDayStartIn` from `shared/clock` (Task 1)
- Produces: `type CycleOutcome = 'enqueued' | 'capped' | 'idle'`,
  `shouldReplenish(pending: number, target: number): boolean`,
  `waitAfterMs(outcome: CycleOutcome, at: Date, config: PaceConfig): number`,
  `interface PaceConfig { timezone: string; queuePollMinutes: number; emptyPoolMinutes: number }`

This is where the logic that used to live in `nextIntervalMs` goes. It is a
separate module so it is testable without a running service — unlike `tick`,
which stays untested.

- [ ] **Step 1: Write the failing tests**

Create `tweet-generator/src/pace.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { shouldReplenish, waitAfterMs, type PaceConfig } from './pace.js'

const config: PaceConfig = {
  timezone: 'Asia/Shanghai',
  queuePollMinutes: 5,
  emptyPoolMinutes: 30,
}

describe('shouldReplenish', () => {
  it('restocks an empty buffer', () => {
    expect(shouldReplenish(0, 2)).toBe(true)
  })

  it('restocks a buffer below target', () => {
    expect(shouldReplenish(1, 2)).toBe(true)
  })

  it('leaves a buffer that is exactly at target alone', () => {
    // The boundary that decides whether the target is a floor or a ceiling.
    expect(shouldReplenish(2, 2)).toBe(false)
  })

  it('leaves an over-full buffer alone', () => {
    expect(shouldReplenish(5, 2)).toBe(false)
  })
})

describe('waitAfterMs', () => {
  const at = new Date('2026-08-06T01:00:00Z') // 09:00 Shanghai

  it('does not wait after a successful enqueue', () => {
    // The buffer may still be below target, so the next check is immediate.
    expect(waitAfterMs('enqueued', at, config)).toBe(0)
  })

  it('waits the empty-pool backoff when nothing could be produced', () => {
    expect(waitAfterMs('idle', at, config)).toBe(30 * 60_000)
  })

  it('waits until tomorrow when the daily cap is spent', () => {
    // 09:00 Shanghai to the next midnight is 15 hours.
    expect(waitAfterMs('capped', at, config)).toBe(15 * 3_600_000)
  })

  it('measures the cap wait in the configured zone, not the host zone', () => {
    const berlin: PaceConfig = { ...config, timezone: 'Europe/Berlin' }
    // 03:00 Berlin (CEST) to the next midnight is 21 hours.
    expect(waitAfterMs('capped', at, berlin)).toBe(21 * 3_600_000)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter tweet-generator test -- pace`
Expected: FAIL — cannot resolve `./pace.js`.

- [ ] **Step 3: Implement it**

Create `tweet-generator/src/pace.ts`:

```ts
import { nextDayStartIn } from 'shared/clock'

/**
 * What a cycle actually accomplished.
 *
 * Returning rather than enqueueing is the common case — every pool empty, or
 * every candidate given up on — and the loop has to tell it apart from a
 * successful restock, or it would spin against the AgentLens API.
 */
export type CycleOutcome = 'enqueued' | 'capped' | 'idle'

export interface PaceConfig {
  timezone: string
  queuePollMinutes: number
  emptyPoolMinutes: number
}

/**
 * Whether the buffer is short.
 *
 * `>=` rather than `>`: the target is the amount to hold, so reaching it is
 * the reason to stop, not the reason to add one more.
 */
export function shouldReplenish(pending: number, target: number): boolean {
  return pending < target
}

/** How long to wait before looking at the buffer again. */
export function waitAfterMs(
  outcome: CycleOutcome,
  at: Date,
  config: PaceConfig,
): number {
  switch (outcome) {
    // The buffer may still be short, and a restock is cheap to re-check.
    case 'enqueued':
      return 0
    // Nothing to spend until the quota resets, and that cannot change before
    // the day does. Polling in between only re-derives the same answer.
    case 'capped':
      return nextDayStartIn(config.timezone, at).getTime() - at.getTime()
    // The pools were empty or every candidate was refused. Both are sourcing
    // problems that do not clear in minutes, and retrying costs an AgentLens
    // call each time.
    case 'idle':
      return config.emptyPoolMinutes * 60_000
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter tweet-generator test -- pace`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add tweet-generator/src/pace.ts tweet-generator/src/pace.test.ts
git commit -m "feat(tweet-generator): decide the pace from the buffer, not a clock"
```

---

### Task 4: Retire the cycle knobs from config

**Files:**
- Modify: `tweet-generator/src/config.ts:39-40` (interface), `:113-120` (parsing),
  `:131-132` (return)
- Modify: `tweet-generator/src/config.test.ts:13-14`, `:53-54`, `:60-64`

**Interfaces:**
- Produces: `GeneratorConfig.queueTarget: number`,
  `GeneratorConfig.queuePollMinutes: number`,
  `GeneratorConfig.emptyPoolMinutes: number`; `cycleMinutes` and
  `cycleJitterMinutes` no longer exist.

- [ ] **Step 1: Rewrite the config tests first**

In `tweet-generator/src/config.test.ts`, replace lines 13-14 with:

```ts
    expect(config.queueTarget).toBe(2)
    expect(config.queuePollMinutes).toBe(5)
    expect(config.emptyPoolMinutes).toBe(30)
```

Replace the `CYCLE_MINUTES: 'soon'` case (lines 53-54) with:

```ts
      loadConfig({ ...minimal, QUEUE_TARGET: 'lots' } as NodeJS.ProcessEnv),
    ).toThrow(/QUEUE_TARGET/)
```

Delete the `CYCLE_JITTER_MINUTES` case entirely (lines ~58-65) — the invariant
it guarded is gone with the knobs. Replace it with the one invariant that
matters now:

```ts
  it('rejects a queue target of zero', () => {
    // A target of zero means the generator never restocks and the queue only
    // ever drains, which reads as "the generator is broken" at 09:00.
    expect(() =>
      loadConfig({ ...minimal, QUEUE_TARGET: '0' } as NodeJS.ProcessEnv),
    ).toThrow(/QUEUE_TARGET/)
  })
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter tweet-generator test -- config`
Expected: FAIL — `config.queueTarget` is `undefined`.

- [ ] **Step 3: Change the interface**

In `tweet-generator/src/config.ts`, replace lines 39-40:

```ts
  queueTarget: number
  queuePollMinutes: number
  emptyPoolMinutes: number
```

- [ ] **Step 4: Change the parsing**

Replace lines 113-120 (the whole `cycleMinutes` / `cycleJitterMinutes` block,
including the jitter validation) with:

```ts
  // How much stock to hold, not how often to produce. x-poster sets the pace;
  // this only has to cover the gap between one being taken and one being made.
  const queueTarget = positiveInt(env, 'QUEUE_TARGET', 2)
```

Replace lines 131-132 in the returned object with:

```ts
    queueTarget,
    queuePollMinutes: positiveInt(env, 'QUEUE_POLL_MINUTES', 5),
    emptyPoolMinutes: positiveInt(env, 'EMPTY_POOL_MINUTES', 30),
```

- [ ] **Step 5: Run it and watch it pass**

Run: `pnpm --filter tweet-generator test -- config`
Expected: PASS. `pnpm --filter tweet-generator build` still fails — `index.ts`
references `config.cycleMinutes`. That is Task 5.

- [ ] **Step 6: Commit**

```bash
git add tweet-generator/src/config.ts tweet-generator/src/config.test.ts
git commit -m "refactor(tweet-generator): replace the cycle knobs with a watermark"
```

---

### Task 5: Rewire the loop

**Files:**
- Modify: `tweet-generator/src/index.ts` — imports (~line 1-25), `nextIntervalMs`
  (:73-82), `checkIdleWatchdog` (:84-105), `tick` (:107-220), `runCycle`,
  `main` (:262-328)

**Interfaces:**
- Consumes: `shouldReplenish`, `waitAfterMs`, `type CycleOutcome` from
  `./pace.js` (Task 3); `store.pendingCount()` (Task 2);
  `config.queueTarget` / `queuePollMinutes` / `emptyPoolMinutes` (Task 4)

`tick` and `main` stay untested, as they are today. Everything they now decide
with was tested in Tasks 2 and 3.

- [ ] **Step 1: Delete `nextIntervalMs` and its imports**

Remove lines 73-82 entirely. Remove `mulberry32, type Rng` from the
`shared/rng` import at the top — nothing else in this file uses it. Remove
`const rng = mulberry32(...)` from `main` (line 273).

- [ ] **Step 2: Give the watchdog the buffer, and move it to the loop**

Replace `checkIdleWatchdog` (lines 84-105) with:

```ts
/**
 * Warns when the queue has gained nothing for a day *and* is short.
 *
 * The second clause is what keeps this honest under a watermark. A full buffer
 * with no new rows is the healthy shape: x-poster has stopped taking them, so
 * the generator correctly stops making them. Alerting on that would page about
 * this service while the broken one is the poster.
 */
async function checkIdleWatchdog(now: Date, pending: number): Promise<void> {
  const last = await store.lastEnqueuedAt()
  if (!last) return
  const idleHours = (now.getTime() - last.getTime()) / 3_600_000
  if (idleHours < 24 || alertedIdle) return
  if (pending >= config.queueTarget) return

  alertedIdle = true
  await notifyFailure(
    config.discordWebhookUrl,
    'tweet-generator',
    `Nothing has been enqueued for ${Math.floor(idleHours)} hours ` +
      `with only ${pending} queued. Every pool may be empty, or the quota ` +
      'may be misconfigured.',
  )
}
```

Delete the `await checkIdleWatchdog(now)` call from the top of `tick` (line
109); the loop calls it now, where `pending` is already known.

- [ ] **Step 3: Make `tick` report what it did**

Change the signature to `async function tick(): Promise<CycleOutcome>` and
return a verdict at each exit:

- the `order.length === 0` early return (line ~121) returns `'capped'`
- the `GenerationGaveUp` branch keeps `continue`, unchanged
- the `id === null` branch returns `'idle'` — nothing new was queued
- the successful `Enqueued` path returns `'enqueued'`
- the fall-through past the loop returns `'idle'`

Change `runCycle` to `Promise<CycleOutcome>` and `return await tick()` in place
of `await tick(); return`.

- [ ] **Step 4: Rewrite the loop**

Replace `main`'s `while` body (lines 275-327) with:

```ts
  while (!stopping) {
    const now = new Date()
    const pending = await store.pendingCount()
    await checkIdleWatchdog(now, pending)

    if (!shouldReplenish(pending, config.queueTarget)) {
      await sleep(config.queuePollMinutes * 60_000)
      continue
    }

    let waitMs: number

    try {
      const outcome = await runCycle()
      consecutiveSourceFailures = 0
      waitMs = waitAfterMs(outcome, now, config)
    } catch (error) {
      const message = formatError(error)
      const policy = retryPolicyOf(error)

      // A failed cycle must never fall through to a zero wait: runCycle has
      // already exhausted its fast retries by the time it throws, and coming
      // straight back would spin against an upstream that is still down.
      waitMs = config.emptyPoolMinutes * 60_000

      if (policy !== null) {
        consecutiveSourceFailures += 1
        logger.warn('An upstream dependency failed', {
          error: message,
          retry: policy,
          consecutive: consecutiveSourceFailures,
        })

        if (shouldAlert(policy, consecutiveSourceFailures)) {
          await notifyFailure(
            config.discordWebhookUrl,
            'tweet-generator',
            policy === 'never'
              ? `Upstream failure that cannot clear itself: ${message}`
              : `Upstream unreachable for ${consecutiveSourceFailures} cycles: ${message}`,
          )
        }

        // Only ever extends the wait. Coming back before the window the
        // server named is how a quota gets pushed out rather than reset.
        const retryAfterMs = retryAfterMsOfError(error)
        if (policy === 'quota' && retryAfterMs !== null) {
          waitMs = Math.max(waitMs, retryAfterMs)
        }
      } else {
        // Unlike x-poster, an unexpected failure here is not a reason to
        // stop: nothing has been posted, and the next cycle starts fresh.
        logger.error('Cycle failed', { error: message })
      }
    }

    if (waitMs > 0) {
      // Logged rather than left implicit: a process that has gone quiet is
      // otherwise indistinguishable from one that has hung, and the answer is
      // only ever in this number.
      logger.info('Waiting before the next look at the queue', {
        minutes: Math.round(waitMs / 60_000),
        wakesAt: new Date(Date.now() + waitMs).toISOString(),
        pending,
      })
      await sleep(waitMs)
    }
  }
```

- [ ] **Step 5: Fix the startup banner**

In `main`'s opening `logger.info`, replace `cycleMinutes: config.cycleMinutes`
with `queueTarget: config.queueTarget`.

- [ ] **Step 6: Typecheck and run everything**

Run: `pnpm --filter tweet-generator build && pnpm --filter tweet-generator test`
Expected: `tsc` clean, all tests pass. Then `rm -rf tweet-generator/dist`.

- [ ] **Step 7: Commit**

```bash
git add tweet-generator/src/index.ts
git commit -m "feat(tweet-generator): restock the queue instead of running a clock"
```

---

### Task 6: One day boundary in x-poster

**Files:**
- Modify: `x-poster/src/config.ts` (interface + `loadConfig`),
  `x-poster/src/queue/rate-limiter.ts:24,37,62`,
  `x-poster/src/queue/tweet-queue.ts:135`
- Test: `x-poster/src/queue/rate-limiter.test.ts:4,124-...`,
  `x-poster/src/config.test.ts`

**Interfaces:**
- Consumes: `startOfDayIn`, `nextDayStartIn` from `shared/clock` (Task 1)
- Produces: `XPosterConfig.timezone: string`

There are **three** local-zone day boundaries in x-poster, not one: `startOfDay`
and `tomorrow` in `rate-limiter.ts`, and a fourth inline copy in
`tweet-queue.ts:135` that scopes the `postedToday` count. All of them move.

- [ ] **Step 1: Write the failing config test**

Append to `x-poster/src/config.test.ts`:

```ts
  it('requires a timezone', () => {
    // Without it the daily cap resets on the host's midnight, which is not
    // the same midnight tweet-generator counts against.
    expect(() =>
      loadConfig({ X_PROFILE_DIR: '/tmp/x-profile' } as NodeJS.ProcessEnv),
    ).toThrow(/TIMEZONE/)
  })
```

Then add `TIMEZONE: 'Asia/Shanghai'` to the `required` fixture on line 4 of
that file:

```ts
const required = {
  X_PROFILE_DIR: '/tmp/x-profile',
  TIMEZONE: 'Asia/Shanghai',
} as NodeJS.ProcessEnv
```

Every other test in the file spreads `required`, so this keeps them passing.
Note the new test above must therefore build its env literally rather than
spreading the fixture — spreading it would include the key it is asserting is
missing.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter x-poster test -- config`
Expected: FAIL — no error thrown.

- [ ] **Step 3: Add the config field**

In `x-poster/src/config.ts`, add `timezone: string` to `XPosterConfig` beside
`activeHours`, and in the returned object:

```ts
    timezone: requiredString(env, 'TIMEZONE'),
```

- [ ] **Step 4: Rewrite the rate limiter's day tests**

In `x-poster/src/queue/rate-limiter.test.ts`: change the import on line 4 to
drop `startOfDay` (it is no longer exported), and add `TIMEZONE: 'Asia/Shanghai'`
to the `loadConfig({...})` literal on lines 6-12 — `TIMEZONE` is required now,
so without it every test in this file throws at module load.

The comment on line 14 (*"Local time, since the active-hours window is
expressed in local time"*) becomes false with this change and must be rewritten:
the window is now expressed in `config.timezone`. Leaving it would send the next
reader looking for host-zone behaviour that no longer exists.

Replace the `describe('startOfDay')` block (line 124 onward) with a test that
goes through `decide`:

```ts
describe('the day boundary', () => {
  it('resets the daily cap on the configured zone’s midnight', () => {
    // 16:30 UTC is 00:30 the next day in Shanghai: a new day, so a full cap
    // is available even though the host may still be on the previous date.
    const at = new Date('2026-08-06T16:30:00Z')
    const verdict = decide(
      at,
      { lastPostedAt: null, postedToday: 0 },
      { ...config, timezone: 'Asia/Shanghai' },
    )
    expect(verdict.reason).not.toBe('daily-cap')
  })
})
```

- [ ] **Step 5: Replace the three local-zone boundaries**

In `rate-limiter.ts`: delete the exported `startOfDay` (line 24) and `tomorrow`
(line 37). Import `startOfDayIn, nextDayStartIn` from `shared/clock` and thread
`config.timezone` through — `startOfDay(now)` becomes
`startOfDayIn(config.timezone, now)`, `tomorrow(now)` becomes
`nextDayStartIn(config.timezone, now)`.

`minutesIntoDay` (line 28) also reads the host zone. Replace its body with
`minutesIntoDayIn(config.timezone, now)` and give it the config parameter;
otherwise the active-hours window still opens on host time.

In `tweet-queue.ts:135`, replace the inline
`new Date(now.getFullYear(), now.getMonth(), now.getDate())` with
`startOfDayIn(timezone, now)`. `history()` takes the timezone as a parameter;
update its caller in `x-poster/src/index.ts:45` to pass `config.timezone`.

- [ ] **Step 6: Run everything**

Run: `pnpm --filter x-poster build && pnpm --filter x-poster test`
Expected: `tsc` clean, all tests pass. Then `rm -rf x-poster/dist`.

- [ ] **Step 7: Commit**

```bash
git add x-poster/src
git commit -m "fix(x-poster): count the day in the configured zone, not the host's"
```

---

### Task 7: The env files

**Files:**
- Modify: `tweet-generator/.env`, `tweet-generator/.env.example`,
  `x-poster/.env`, `x-poster/.env.example`

- [ ] **Step 1: Swap the generator's keys**

In both `tweet-generator/.env` and `.env.example`, delete lines 28-29
(`CYCLE_MINUTES`, `CYCLE_JITTER_MINUTES`) and put in their place:

```bash
# How many tweets to keep queued. x-poster sets the pace; this only covers the
# gap between one being taken and the next being written.
QUEUE_TARGET=2
# How often to look at the queue when it is already full. A bare COUNT.
QUEUE_POLL_MINUTES=5
# How long to wait after a cycle that produced nothing. Longer, because each
# attempt costs an AgentLens call.
EMPTY_POOL_MINUTES=30
```

- [ ] **Step 2: Give x-poster the timezone**

Add to both `x-poster/.env` and `.env.example`, next to `X_ACTIVE_HOURS`:

```bash
# Must match tweet-generator's TIMEZONE, or the two daily caps count
# different days.
TIMEZONE=Asia/Shanghai
```

- [ ] **Step 3: Start it and read the banner**

Run: `pnpm --filter tweet-generator dev`
Expected: `Starting tweet-generator` logs `queueTarget: 2` and no
`cycleMinutes`. Within a minute the log shows either a restock or
`Waiting before the next look at the queue` with a `pending` count. Stop it
with Ctrl-C.

- [ ] **Step 4: Commit**

```bash
git add tweet-generator/.env.example x-poster/.env.example
git commit -m "chore: document the watermark and timezone settings"
```

`.env` itself is not tracked; only the examples are committed.

---

## Self-Review

**Spec coverage.** Watermark loop → Task 5, backed by Tasks 2 and 3. `DAILY_CAP`
narrowing to a ceiling → Task 5 (`'capped'` sleeps to the day boundary rather
than to a poll). Watchdog second clause → Task 5 Step 2. Shared day boundary →
Tasks 1 and 6. Config table → Tasks 4, 6 and 7. Testing section → Tasks 1, 2, 3
and 6; the spec's note that `tick` stays untested is carried into Task 5.

**Known deltas from the spec**, both stated at the top: `CycleOutcome` and the
`EMPTY_POOL_MINUTES` knob. Task 6 is also wider than the spec described — the
spec named one local-zone `startOfDay` in x-poster and there are three, plus
`minutesIntoDay`.

**Type consistency.** `pendingCount(): Promise<number>` is produced in Task 2
and consumed in Task 5. `shouldReplenish` / `waitAfterMs` / `CycleOutcome` are
produced in Task 3 and consumed in Task 5. `PaceConfig` is structurally
satisfied by `GeneratorConfig` once Task 4 adds all three fields, so Task 5
passes `config` directly. `nextDayStartIn` is produced in Task 1 and consumed
in Tasks 3 and 6.

**Ordering.** Tasks 1-4 are independent of each other and can be done in any
order; Task 5 needs 2, 3 and 4; Task 6 needs 1; Task 7 needs 4 and 6.
