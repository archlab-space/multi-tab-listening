# Windowed Pacing — Design

- **Date:** 2026-08-07
- **Status:** Approved, ready for implementation planning

## Goal

Spend the daily cap where the audience is, by replacing one long posting window
and a fixed interval range with several windows that each carry their own
quota, and a gap derived from how much of the window is left.

## Problem

**The cap is spent by mid-afternoon.** `X_ACTIVE_HOURS=09:00-23:00` is a
fourteen-hour window and `X_MIN_INTERVAL_MINUTES=20` to
`X_MAX_INTERVAL_MINUTES=60` averages forty minutes, so ten tweets fit in under
seven hours. Observed on 2026-08-07: four to five posts published by 15:42,
with the whole evening still ahead and nothing left to publish in it.

**The window is one flat region, and the hours inside it are not
interchangeable.** The account posts English-language AI material, so its
audience is mostly European and American. Against `Asia/Shanghai`, 06:00–08:00
is 18:00–20:00 US Eastern the previous day, and 17:00–23:00 is 11:00–17:00 in
Central Europe and 05:00–11:00 US Eastern. Those are the hours worth spending
the cap in; 09:00–15:00 Shanghai, which is where the cap currently goes, is the
middle of the night for most of the audience.

**The interval range cannot express "spread these over that window."** It is a
pace, not a plan. Six posts at twenty to sixty minutes finish in roughly four
hours whatever the window is, so a six-hour evening ends with two idle hours,
and a two-hour morning would overrun. Raising the minimum to fix the evening
breaks the morning, because one range has to serve both.

## Non-Goals

- Giving `take` a card. It was considered alongside this change and dropped:
  the tweet-generator design names "half the posts image-less" as one of two
  mitigations for the content-farm signature, and moving `take` to a card would
  retire it. The image share stays at 65% and `tweet-generator` is not touched
  by this work at all.
- Varying the watermark. It is the only attribution the posts carry — no tweet
  contains a URL, because X charges a flat 23 characters for one and down-ranks
  posts that have them — so a watermark that changes dilutes the single channel
  carrying the brand. Consistency is the point of it.
- Interaction (replies, likes, follows). "Zero interaction" is the other half
  of the signature the tweet-generator design names, and it remains unaddressed.
  It is a separate change and a much larger one.
- Teaching tweet-generator about windows. It replenishes to a queue watermark
  and therefore already follows whatever the poster consumes. A second opinion
  about timing is what the queue-depth-pacing change removed; this must not put
  one back.
- Reconciling `X_DAILY_CAP` with the generator's `DAILY_CAP`. They measure
  different things — published versus enqueued — and both stay.

## Decision

### Several windows, each with a quota

`X_ACTIVE_HOURS` becomes `X_WINDOWS`, a comma-separated list of
`HH:MM-HH:MMx<quota>`:

```
X_WINDOWS=06:00-08:00x4,17:00-23:00x6
```

Validated at startup, all of it fatal:

- at least one window, each matching `HH:MM-HH:MMx<n>` with a valid time
- no window wraps past midnight, which is the rule `parseActiveHours` already
  enforces and for the same reason: a wrapping window needs its own set of
  comparisons in every gate
- windows do not overlap, once sorted by start
- quotas sum to no more than `X_DAILY_CAP`

The last check follows the precedent in `tweet-generator/src/config.ts`, where
a quota total above `DAILY_CAP` throws rather than silently starving the
lowest-priority source. Here the failure would be a window that can never spend
what it was given.

`X_WINDOWS` is required rather than defaulted, like `TIMEZONE` above it: a
default would be a different posting schedule on a machine whose `.env` was not
updated, which is the failure this file exists to prevent. If `X_ACTIVE_HOURS`
is still set and `X_WINDOWS` is absent, the error names the replacement and
shows the new syntax — a silent fall back to the old single window is the one
outcome worse than refusing to start.

`X_DAILY_CAP` stays. With the sum check above it can no longer bind, which is
the point: it stops being a pace and becomes a backstop against a hand-edited
row or a future config that drifts.

### The gap comes from the window, not from a range

Inside a window, the wait after a post is

```
gap = (window end - last posted at) / (remaining quota + 1)
```

where `remaining quota` is the window's quota minus what this window has
already published today, and `last posted at` is the most recent post overall —
which, once the window has published anything, is necessarily inside it. The
first post of a window has no gap to satisfy and goes as soon as the queue has
something.

The `+ 1` is what leaves the window room to close. Without it the last post
lands exactly at the boundary; with it, an evening of six over 17:00–23:00 runs
at a steady hour and finishes at 22:00:

| after | remaining | window left | gap |
| --- | --- | --- | --- |
| 17:00 | 5 | 360 min | 60 |
| 18:00 | 4 | 300 min | 60 |
| 19:00 | 3 | 240 min | 60 |
| 20:00 | 2 | 180 min | 60 |
| 21:00 | 1 | 120 min | 60 |
| 22:00 | 0 | — | window done |

The same formula gives the morning window of four over 06:00–08:00 a gap of
thirty minutes and finishes it at 07:30. Neither number is configured; both
fall out of the window and its quota, which is the property that makes one
mechanism serve two windows of different shapes.

It also self-corrects. A post that cannot go out — an empty queue, a retry —
leaves the remaining quota unchanged while the window shrinks, so the next gap
narrows and the schedule catches up rather than pushing work past the close.

### Jitter, and why not `sampleDelay`

The gap is multiplied by `1 ± X_INTERVAL_JITTER` (default `0.25`, so 45–75
minutes on an hourly evening), drawn uniformly, then floored at
`X_MIN_INTERVAL_MINUTES`.

Jitter is not decoration. A post exactly every sixty minutes is a stronger
fixed-period signature than the current sampled interval, so replacing a random
gap with an even one would make the timeline more machine-like, not less — the
opposite of what the interval sampler was introduced for.

`sampleDelay` is deliberately not reused. It draws from a log-normal with its
median at 25% of the range, because it models human pauses between actions,
which are mostly short with an occasional long tail. Applied here that shape
biases every gap below target, and six consecutive low draws spend the window's
quota early and idle out the rest — the failure this design exists to remove.
The jitter here has to be symmetric so that the average pace is the target
pace, which is also what keeps the self-correction above honest.

`X_MAX_INTERVAL_MINUTES` is deleted. As a ceiling on a derived gap it is
actively harmful: two posts left in four hours wants a two-hour gap, and a
sixty-minute cap would spend them in two and idle for the rest.

### Where the code goes

A new `x-poster/src/queue/windows.ts` owns time-of-day windows and nothing
else: parsing and validating them, finding the one containing an instant, and
finding when the next one opens. It is pure, takes a timezone, and is tested
directly.

`decide` in `rate-limiter.ts` stays pure — thirteen tests rest on its being a
function of its arguments, and that is worth preserving. It gains one gate and
one input:

- `PostingHistory` grows `postedInWindow`, counted by the caller
- a new `RateLimitReason`, `window-quota`, for a window that has spent its
  allowance while the day still has cap left

Gate order becomes: outside every window, then daily cap, then window quota,
then interval. The existing ordering rationale carries over — at the cap the
useful answer is "not today" rather than "in twenty minutes" — with the window
quota sitting between them because its honest answer is "not this window."

`TweetQueue` gains a count of posts published since a given instant, which
`index.ts` calls with the current window's start before calling `decide`. The
window lookup is exported from `windows.ts` and used by both, so there is one
definition of which window an instant falls in.

### Configuration summary

| key | change |
| --- | --- |
| `X_WINDOWS` | new, required, `HH:MM-HH:MMx<quota>` comma-separated |
| `X_ACTIVE_HOURS` | removed; its presence without `X_WINDOWS` is a startup error |
| `X_INTERVAL_JITTER` | new, default `0.25`, must be in `[0, 1)` |
| `X_MAX_INTERVAL_MINUTES` | removed |
| `X_MIN_INTERVAL_MINUTES` | kept, now a floor under the derived gap |
| `X_DAILY_CAP` | kept, now a backstop rather than a pace |

## Testing

`windows.ts` is pure and gets the bulk of it: parsing valid and malformed
strings, rejecting wrapping and overlapping windows, quota totals over the cap,
the window containing an instant, the next opening both later today and
tomorrow, and a day boundary that crosses one.

`rate-limiter.ts` keeps its thirteen tests and adds: the new gate's position in
the order, a window whose quota is spent while the day's cap is not, the
derived gap at each step of a window (the table above, with jitter pinned by a
seeded `Rng`), the floor applying when a narrow window would ask for less than
`X_MIN_INTERVAL_MINUTES`, the first post of a window going without a gap, and
the catch-up after a missed slot.

`config.ts` adds the parse and validation cases, including the migration error
when `X_ACTIVE_HOURS` is set alone.

`TweetQueue`'s new count is covered alongside the existing `history` tests,
against the real database those tests already use.

## Risks

**Nine silent hours.** Nothing publishes between 08:00 and 17:00 Shanghai. That
is the intent, but it is a visible change to an account that currently posts
through that period, and a reader who checks at noon sees a quiet timeline.

**Generation has to keep up with the morning.** Four posts thirty minutes apart
draw on the queue faster than any interval the poster has used before. The
generator replenishes to `QUEUE_TARGET=2` and a cycle costs an LLM round trip
plus a Chromium launch for the card, so the buffer should hold; if the idle
alert fires during a morning window, the fix is `QUEUE_TARGET=3` rather than
anything in this design.

**Even pacing is its own signature.** Jitter is the mitigation and it is
configurable, but a window that runs at a steady hour is still more regular
than the current uniform sampling across fourteen hours. This trades one
regularity for another and is worth revisiting once there is a timeline to look
at.

**A stale `.env` stops the service.** Deliberately: the alternative is a
machine quietly running yesterday's schedule. The migration error names the
replacement, so the fix is one line.
