# Queue-Depth Pacing — Design

- **Date:** 2026-08-06
- **Status:** Approved, ready for implementation planning

## Goal

Make the pace at which tweets reach X a decision that x-poster owns alone, by
turning tweet-generator from something that produces on a clock into something
that keeps a small buffer stocked.

## Problem

The two services are decoupled through the queue, which is the right seam. But
both of them currently hold an opinion about timing, and the two opinions do
not compose.

**The generator sets the pace, and the poster's pacing is decorative.**
tweet-generator wakes every `CYCLE_MINUTES=120` ± `CYCLE_JITTER_MINUTES=25` and
enqueues at most one tweet, so it offers at most ten to fifteen a day. x-poster
paces itself with `X_MIN_INTERVAL_MINUTES=20` to `X_MAX_INTERVAL_MINUTES=60`
over a fourteen-hour window, an appetite of roughly twenty-one a day. Demand
exceeds supply, so `claimNext` usually returns nothing and the poster falls
through to its sixty-second idle sleep. The interval sampler that exists
specifically to keep the timeline free of a fixed-period signature almost never
governs anything. The signature the timeline actually carries is the
generator's two-hour cycle.

**Production runs for twenty-four hours; consumption runs for fourteen.**
`X_ACTIVE_HOURS=09:00-23:00` stops the poster overnight, but nothing stops the
generator. The ten hours from 23:00 produce four or five tweets that sit in the
queue. When the window opens at 09:00 the poster has a backlog and drains it at
twenty to sixty minute intervals — a burst at the same hour every morning,
which is the least human-looking shape the timeline could have.

**Each service counts its own day, and the days do not line up.** Both caps are
ten, but `DAILY_CAP` counts what the generator enqueued and `X_DAILY_CAP`
counts what the poster published, so they are not the same ten. Worse, they are
not even the same day: `orderKinds` measures the day with
`startOfDayIn(config.timezone, now)` against `TIMEZONE=Asia/Shanghai`, while
the poster's `startOfDay` in `x-poster/src/queue/rate-limiter.ts` is
`new Date(y, m, d)` — the host's local zone. On a host that is not set to
Shanghai the two boundaries drift apart and the caps contradict each other.

## Non-Goals

- Merging the two services. They fail in unrelated ways — one drives Chrome,
  the other calls an LLM — and they already disagree deliberately about what a
  failure means: x-poster stops, tweet-generator carries on. The queue between
  them is load-bearing and stays.
- Teaching tweet-generator about `X_ACTIVE_HOURS`. It was in an earlier draft
  and is now removed: a generator that stops when the buffer is full already
  stops overnight, because an idle poster consumes nothing. Active hours would
  be a second mechanism expressing what the watermark already expresses.
- A watchdog on the poster for the opposite failure — a stocked queue that is
  not draining. Real, but a separate change.
- Changing how candidates are selected, how kinds rotate, or how the LLM
  pipeline works. Only the question of *when* to generate moves.
- Reconciling the two daily caps into one number. They measure different
  things and both are worth keeping; what changes is that one of them stops
  being a pace.

## Decision

### Replenish to a watermark instead of waking on a clock

The generator's outer loop stops sleeping for a sampled interval and starts
asking how much stock is left:

```
while not stopping:
    pending = await store.pendingCount()

    if pending >= config.queueTarget:
        await sleep(config.queuePollMinutes)
        continue

    await runCycle()          # enqueues at most one tweet
    # deliberately no sleep — an empty queue should refill without waiting
```

`runCycle` and the retry policy inside it are untouched.

This is what makes the poster the pacemaker. The generator no longer has a
period; it has a set point. When the poster publishes one, the buffer drops to
one and the generator puts one back. When the poster stops at 23:00 the buffer
stays at two and the generator does nothing until morning, without being told
that a night exists. The morning burst disappears because there is no backlog
to burst through — at most two items are waiting, which is what the buffer is
for.

`QUEUE_TARGET=2` is chosen against the poster's floor: it publishes at most one
per twenty minutes, and the generator takes ten to thirty seconds to produce
one, so two items cover a refill that has to retry. It is a buffer against
latency, not a store of inventory. Raising it trades freshness for slack,
because anything held overnight is written against yesterday's material.

### `DAILY_CAP` narrows from a pace to an upper bound

It stays, because it is not really a pacing knob. `orderKinds` returns nothing
once `usage.total >= config.dailyCap`, and the kind rotation is driven by each
kind's remaining-quota ratio, so `DAILY_CAP` is the denominator that holds the
source mix together. Removing it would take the rotation with it.

What changes is that it stops competing with the poster to define a rhythm.
Under a watermark the cap is reached only if the poster actually consumed that
many: six published means four still pending, which is above the watermark, so
the generator does not produce and the cap is never approached. The number
becomes a ceiling that is rarely touched rather than a target that is always
met.

When the cap is reached, the loop sleeps until the next day boundary in
`config.timezone` — the same boundary `usageSince` measures against — rather
than for one poll interval. Polling every five minutes to re-derive an
answer that cannot change until midnight is waste.

### The idle watchdog has to learn the difference

`checkIdleWatchdog` alerts when nothing has been enqueued for twenty-four
hours, and says the pools may be empty or the quota misconfigured. Under a
clock that inference is sound. Under a watermark it is backwards: if x-poster
dies, the queue stops draining, the generator correctly produces nothing, and
the watchdog pages about the generator while the broken service is the poster.

An alert that names the wrong service is worse than no alert. The idle
condition gains a second clause:

```ts
if (idleHours < 24 || alertedIdle) return
if (pending >= config.queueTarget) return   // full buffer: idle is correct
```

Silence with a full buffer is health. Silence with an empty buffer is the
failure the watchdog was written for, and that is the only case that still
alerts.

### One definition of a day

`startOfDayIn` and `minutesIntoDayIn` move from
`tweet-generator/src/select/clock.ts` to `shared/clock.ts`. The local-zone
`startOfDay` in `x-poster/src/queue/rate-limiter.ts` is deleted and the poster
takes a `TIMEZONE` config like the generator's.

This is the whole of the shared-code change. The scheduling loops themselves
stay where they are: "when should I restock" and "when should I publish" are
different decisions, and a shared scheduler expressing both would take a
parameter for every way they differ.

### Configuration

| Key | Service | Change | Default |
| --- | --- | --- | --- |
| `QUEUE_TARGET` | tweet-generator | new | `2` |
| `QUEUE_POLL_MINUTES` | tweet-generator | new | `5` |
| `CYCLE_MINUTES` | tweet-generator | **removed** | — |
| `CYCLE_JITTER_MINUTES` | tweet-generator | **removed** | — |
| `TIMEZONE` | x-poster | new | required |

Removing the two cycle keys is a breaking change to `.env`, and takes
`nextIntervalMs` and the generator's `mulberry32` seeding with it. The jitter
existed to hide a fixed period; there is no longer a period to hide, and the
poster samples its own interval anyway.

## Testing

The decision that used to live in `nextIntervalMs` becomes a pure function, so
unlike the current `tick`, this change is testable without refactoring the
entrypoint:

- `shouldReplenish(pending, target)` — a unit test per boundary, including
  equality, which is the case that decides whether the buffer is a floor or a
  ceiling.
- `store.pendingCount()` — follows the existing `store.test.ts` pattern against
  a real schema. Only `pending` counts as stock. A `sending` row is already
  claimed by the poster and about to leave, and `posted`, `failed` and
  `uncertain` are all terminal, so counting any of them would let a stuck row
  masquerade as inventory and starve the buffer.
- `shared/clock.ts` — the moved tests come with it, plus one asserting that a
  host in a different zone still gets Shanghai's midnight, which is the bug
  this move fixes.
- The watchdog's new clause — extract the predicate so the full-buffer case can
  be asserted without a running service.

`tick` and the outer loop stay untested, as they are today. Making the
entrypoint testable is a larger change and is not in scope.

## Risks

**Overnight items are stale by morning.** At most two, by construction, and the
alternative — an empty queue at 09:00 — costs a publishing slot outright.

**A five-minute poll adds a `COUNT` every five minutes.** Negligible against
one query per two hours, and the query is indexed on status.

**A wedged poster now silently stops the generator too.** This is the intended
coupling, and it is the reason the watchdog change ships in the same commit
rather than after it.
