# X Auto-Poster — Design

- **Date:** 2026-08-04
- **Status:** Approved, ready for implementation planning

## Goal

Add automated posting to X (Twitter) as a third service in the workspace. It
drains a queue of pending tweets from Postgres and posts each one through a
real Chrome browser, driven so that the interaction is indistinguishable from a
human at the keyboard.

## Non-Goals

- Scraping or monitoring X. This service only writes.
- Replying, quoting, threading, or attaching media. Plain-text tweets only.
- Producing tweet content. Something else fills the queue; this service drains
  it.
- Multi-account support. One X account, one browser profile.

## Context

The workspace already has two services that never call each other — they meet
only in Postgres:

- `scraper` — Playwright opens one tab per Discord channel, injects a
  `MutationObserver`, writes messages to Postgres.
- `ai-assistant` — polls Postgres, classifies questions with Fireworks AI,
  pushes results to a Discord webhook.

The new service, `x-poster`, follows the same contract: it knows the `tweets`
table and nothing else about its siblings.

## Architecture

```
                     ┌──────────────┐
   Discord tabs ───▶ │   scraper    │ ──┐
                     └──────────────┘   │
                                        ▼
                              ┌──────────────────┐
                              │    PostgreSQL    │
                              │  messages        │
                              │  tweets   (new)  │
                              └──────────────────┘
                                  ▲          │
                    ┌─────────────┘          │ claim
                    │ (optional producer)    ▼
             ┌──────────────┐        ┌──────────────┐
             │ ai-assistant │        │   x-poster   │  (new)
             └──────────────┘        └──────────────┘
                                            │ CDP
                                            ▼
                                     real Chrome ──▶ x.com
```

## Data Model

New `tweets` table, created in `scraper/src/setup-database.ts` alongside the
existing schema. Schema ownership stays in one place even though `x-poster` is
the table's only consumer — this matches how `ai-assistant`'s columns
(`is_question`, `question_confidence`, `question_type`) already live in the
`scraper`-owned `messages` DDL.

```sql
CREATE TABLE IF NOT EXISTS tweets (
  id            SERIAL PRIMARY KEY,
  content       TEXT NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  dedupe_key    VARCHAR(255) UNIQUE NOT NULL,
  source        VARCHAR(50),
  source_ref    VARCHAR(255),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  scheduled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  posted_at     TIMESTAMPTZ,
  posted_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tweets_claim ON tweets(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_tweets_posted_at ON tweets(posted_at);
```

**Deliberate deviation from existing convention:** the existing tables use
`TIMESTAMP` (without time zone). This table uses `TIMESTAMPTZ` because every
one of its time fields participates in scheduling decisions — active-hour
windows, minimum intervals, daily caps. A naive timestamp there is a
correctness bug waiting to happen, not a style preference.

`dedupe_key` is `UNIQUE NOT NULL`: producers must supply an idempotency key, so
inserting the same logical tweet twice is rejected by the database rather than
by application logic. For AI-produced tweets the natural key is the source
Discord message id; for manual inserts, any stable string.

### State machine

```
pending ──claim──▶ sending ──verified──▶ posted
                      │
                      ├── retryable error ──▶ pending   (attempts+1, backoff)
                      ├── attempts exhausted ─▶ failed
                      └── clicked, unverifiable ─▶ uncertain
```

`uncertain` exists because "the send button was clicked but the result could
not be confirmed" is a fundamentally different condition from "this failed".
The tweet may well be live. Retrying would double-post. Rows in `uncertain`
are never retried automatically and require a human to resolve them.

**Prefer a missed tweet over a duplicate tweet.** This principle decides every
ambiguous case in the error handling below.

### Claiming a tweet

```sql
UPDATE tweets
SET status = 'sending', attempts = attempts + 1, updated_at = NOW()
WHERE id = (
  SELECT id FROM tweets
  WHERE status = 'pending' AND scheduled_at <= NOW()
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` guarantees that two concurrent `x-poster` processes
cannot claim the same row, without any coordination between them.

## Browser Access Layer

### Constraint that drives the whole design

Chrome holds an exclusive lock on its user-data directory, so automation cannot
take over a profile that is already open for everyday browsing. Since Chrome
136, `--remote-debugging-port` is additionally ignored unless a **non-default**
`--user-data-dir` is passed explicitly. The machine runs Chrome 150, so the
everyday default profile is not reachable over CDP at all.

Conclusion: use a **dedicated Chrome profile directory**, logged into X once,
persisted indefinitely. This satisfies "avoid logging in repeatedly" without
exposing the everyday profile's cookies to an open debugging port.

### Attach-or-spawn

On startup the launcher probes `127.0.0.1:<port>`:

- **A Chrome is listening** → attach with `connectOverCDP`. This is the path
  when the operator started the browser themselves and wants to watch it or
  step in to clear a verification challenge.
- **Nothing is listening** → spawn Chrome as a child process with the argument
  set below, wait for the port to accept connections, then attach. This is the
  unattended path.

When `x-poster` spawns the browser it owns the process: it must propagate
`SIGTERM`/`SIGINT` and reap the child on exit so no orphan Chrome is left
behind. When it attaches to an existing browser it must **not** close the
browser on shutdown — only its own page.

The service opens its own tab and never calls `page.bringToFront()`, so it
cannot steal the operator's focus. CDP input events are delivered directly to
the target's renderer, never through the OS input queue, so the real cursor and
keyboard focus are untouched.

### Launch arguments

```
--user-data-dir=<dedicated dir>            # required by Chrome 136+
--remote-debugging-port=<port>
--remote-debugging-address=127.0.0.1       # loopback only
--disable-backgrounding-occluded-windows
--disable-renderer-backgrounding
--disable-background-timer-throttling
```

The last three defeat background-tab throttling, which would otherwise stall
X's lazy-loaded, animation-heavy frontend whenever the automated tab is not
frontmost. They are pure scheduling switches; they alter no `navigator`
property and contribute nothing to a fingerprint.

Nothing else is passed. In particular, none of the flags currently used by
`scraper` appear here — see Refactors.

## Anti-Detection Posture

The dominant design decision is to **do less, not more**. Because this is a
genuine Chrome binary, started by us rather than by Playwright, most detection
surfaces are correct by construction:

| Surface | Why it passes without intervention |
| --- | --- |
| `navigator.webdriver` | `true` only under `--enable-automation` or a Playwright-launched browser. Cold-started Chrome + CDP attach leaves it `false`. |
| Canvas / WebGL / AudioContext | Real GPU, real drivers, real values. |
| Font enumeration, screen metrics, timezone | Real machine values. |
| Event `isTrusted` | CDP `Input.dispatch*Event` produces `isTrusted === true`. |
| Launch-argument leakage | Arguments are fully under our control; Playwright injects none. |

**No fingerprint-spoofing library is used.** `puppeteer-extra-plugin-stealth`
and its relatives exist to paper over a bare Playwright-launched Chromium. On a
real Chrome they are actively harmful: a spoofed value that disagrees with the
genuine environment is a stronger signal than no spoofing at all.

### Accepted residual risk: the `Runtime.enable` surface

Playwright's `page.evaluate()` requires CDP `Runtime.enable`, which is
detectable in principle (e.g. via an `Error.stack` getter). Dedicated patch
sets such as `rebrowser-patches` address it. We deliberately do not adopt one —
it is disproportionate for low-volume personal posting.

Mitigation is a **binding coding constraint**, not an aspiration:

> `x-poster` must not call `page.evaluate()`, `page.evaluateHandle()`, or
> `page.addInitScript()`. All page interaction goes through Playwright locator
> APIs and CDP input events.

Any future need to break this rule must be recorded here first.

## Human Behaviour

### The posting script

`x/composer.ts` is the only module that knows the shape of the whole flow:

1. Navigate to `x.com/home`; wait for the timeline to render.
2. **Browse** — 3–6 scrolls of randomised distance, pausing 0.8–3.5 s after
   each to simulate reading; occasionally scroll back up a little.
3. **Travel** — move the mouse along a Bézier curve to the compose button,
   hover, then click.
4. **Input** — focus the editor and paste the tweet body (see below).
5. **Review** — pause 1.5–4 s, as a person re-reading before posting.
6. **Travel** — move to the submit button and click.
7. **Verify** — confirm the tweet went out, then write the result back to the
   database.

### Text input: clipboard paste

The tweet body is placed on the system clipboard with `pbcopy` from the Node
side, then pasted in the browser with `Cmd+V`.

This was chosen over character-by-character typing after examining what each
approach actually looks like to the page:

| | Human typing CJK | Synthetic per-character insert | Paste (human or synthetic) |
| --- | --- | --- | --- |
| Events | `compositionstart/update/end` + `input` | `input` only, no composition | `paste` + `input(insertFromPaste)` |
| Matches a real user? | — | **No — resembles neither typing nor pasting** | **Yes, byte-for-byte identical** |

Playwright falls back to `Input.insertText` for non-ASCII characters, so
simulated CJK typing produces a third event shape that matches no real user
behaviour. Synthesising composition events is not an option: they would have to
be dispatched from page context, making them `isTrusted === false` — strictly
worse. Pasting bypasses the IME entirely, which is exactly why a synthetic
paste and a human paste are indistinguishable. Pasting tweet text is also
thoroughly ordinary user behaviour and carries no anomaly signal of its own.

`navigator.clipboard.writeText()` is **not** used — it would require
`page.evaluate()` and a clipboard permission grant. Driving the OS clipboard
keeps the browser's view of events a pure keyboard paste.

The service backs up the existing clipboard with `pbpaste` before overwriting
it and restores it afterwards, including on the error path.

### Supporting modules

**`human/delay.ts`** — randomised delays sampled from a **log-normal**
distribution clamped to a range, not a uniform one. Human inter-action
intervals are mostly short with an occasional long tail; uniformly distributed
delays are themselves an anomaly.

**`human/mouse.ts`** — cursor travel:

- Cubic Bézier curve with randomly offset control points, giving a natural arc
  rather than a straight line.
- 20–40 intermediate points, each dispatched via `page.mouse.move` with a small
  delay.
- Non-constant speed: ease-in-out, fast in the middle and slow at both ends,
  matching human acceleration and deceleration.
- **Overshoot correction** on roughly 30% of travels — briefly pass the target
  and come back. This is the single most characteristic trait of a real hand on
  a mouse.
- ±2 px jitter at the endpoint; never a pixel-perfect hit on the element
  centre.

**`human/clipboard.ts`** — `pbcopy`/`pbpaste` wrapper with backup and restore.

### Selectors

`x/selectors.ts` holds every X DOM selector in one place, so a redesign of X
costs one file. X exposes stable `data-testid` attributes, which are far more
durable than the obfuscated class names `scraper` has to chase in
`discord-monitor.ts:203-219`.

The exact `data-testid` values are **not** written from memory. Confirming them
against the live site is the first task of the implementation plan.

## Rate Limiting

`queue/rate-limiter.ts`. Three gates, all configurable. This matters more than
input fidelity: X weighs account behaviour patterns — posting frequency, time
distribution, content similarity — far more heavily than input mechanics.

| Gate | Default | Purpose |
| --- | --- | --- |
| Minimum interval + jitter | 20 min floor, sampled 20–60 min | Removes fixed-period signature |
| Daily cap | 10 tweets | Prevents a burst when the queue backs up |
| Active-hours window | 09:00–23:00 local | Avoids the fatal "posting at 3 a.m." pattern |

Outside the active window the service waits silently rather than erroring. A
row's `scheduled_at` composes with these gates by taking the later of the two.

## Error Handling

`errors.ts` defines three categories. Every failure path must map to exactly
one of them.

| Category | Triggers | Handling |
| --- | --- | --- |
| `RetryableError` | Network failure, navigation timeout, transient load failure | Exponential backoff, max 3 attempts; on exhaustion → `failed` |
| `FatalError` | Session expired, verification challenge presented, all selectors missing | **Circuit-break**: stop claiming, send one notification, exit non-zero |
| `UncertainError` | Submit was clicked but the outcome could not be confirmed | Mark `uncertain`, **never retry**, await human resolution |

`FatalError` breaks the circuit rather than advancing to the next row because a
dead session makes every subsequent attempt fail too — and hammering a
challenged account only deepens the problem.

Circuit-break notifications reuse the existing `DISCORD_WEBHOOK_URL`. There is
already notification infrastructure in this workspace; a second one is not
warranted.

## Package Structure

```
x-poster/
├── src/
│   ├── index.ts                  # entry point, graceful shutdown
│   ├── config.ts                 # environment variables
│   ├── errors.ts                 # the three error categories
│   ├── browser/
│   │   ├── chrome-launcher.ts    # probe port → attach or spawn
│   │   └── launch-args.ts        # the argument set, isolated for review
│   ├── human/
│   │   ├── delay.ts              # log-normal delays
│   │   ├── mouse.ts              # Bézier travel + overshoot
│   │   └── clipboard.ts          # pbcopy/pbpaste + Cmd+V
│   ├── x/
│   │   ├── selectors.ts          # all X DOM selectors
│   │   ├── session.ts            # login-state check
│   │   └── composer.ts           # the 7-step script
│   └── queue/
│       ├── tweet-queue.ts        # SKIP LOCKED claim + status write-back
│       └── rate-limiter.ts       # the three gates
└── .env.example
```

`composer.ts` is the only module that knows the whole flow; everything else is a
tool it calls. Changing X's DOM touches `selectors.ts`; changing the pacing
touches `human/*`; neither touches the other.

Registered in `pnpm-workspace.yaml` alongside the existing three members.

## Refactors

Scoped to what this work touches. Each lands as its own commit.

### 1. Fix the silently broken schema setup — blocking

`scraper/src/setup-database.ts:57` has a trailing comma in the `threads` table
DDL, which is a syntax error. The surrounding `try/catch` logs the failure
without rethrowing, so the breakage is silent — and because the query throws,
**every statement after it is skipped, including all index creation**. None of
the declared indexes currently exist.

This blocks the feature: a `tweets` table added after that statement would never
be created. Fix the comma, and make the `catch` rethrow so a schema failure
cannot pass unnoticed again.

### 2. Remove dangerous launch flags from `scraper`

`scraper/src/discord-monitor.ts:72-77` passes `--no-sandbox`,
`--disable-web-security`, and `--disable-features=VizDisplayCompositor`. These
are prime automation tells, and `--disable-web-security` disables same-origin
protection in a browser holding a live Discord session.

Removing them requires a live run confirming Discord capture still works. This
lands as its own commit with its own acceptance step, never mixed with other
changes.

### 3. `shared/src/logger.ts`

A winston factory taking a log filename. `scraper` currently uses a `printf`
format and `ai-assistant` uses `json`; the shared factory keeps `printf` for the
console transport and `json` for the file transport. Replaces four duplicated
logger constructions and gives `x-poster` one for free.

### 4. `shared/src/db.ts`

A `pg` Pool factory with unified environment-variable reading. `scraper` and
`ai-assistant` each build their own today. All three packages consume it.

### 5. Types consolidated into `shared`

Add `Tweet` and `TweetStatus`. Remove the definitions in
`scraper/src/types.ts` and `ai-assistant/src/types.ts` that `shared` already
covers.

## Testing Strategy

Split by what is actually testable.

### Unit-tested, written test-first

- `human/delay.ts` — samples fall within bounds; tail proportion matches the
  intended distribution.
- `human/mouse.ts` — point count, correct start and end, curve monotonicity,
  overshoot frequency.
- `human/clipboard.ts` — backup and restore semantics, including restoration on
  the error path.
- `queue/rate-limiter.ts` — window boundaries, daily cap, interval arithmetic,
  edge cases around midnight.
- `queue/tweet-queue.ts` — state machine transitions, against the real Postgres
  from the existing `docker-compose.yml`.
- `errors.ts` — classification of each failure mode.

### Manually accepted

`chrome-launcher.ts` and `x/*` depend on the live X site; automated tests there
are expensive and brittle in equal measure. They are covered by a **dry-run
mode** instead: the full seven-step script executes, but step 6 does not click
submit — it screenshots and logs. This makes the behaviour script repeatably
verifiable without emitting real tweets.

## Configuration

New `x-poster/.env`:

| Variable | Description | Default |
| --- | --- | --- |
| `X_PROFILE_DIR` | Dedicated Chrome user-data directory | required |
| `X_DEBUG_PORT` | CDP port on `127.0.0.1` | `9333` |
| `X_CHROME_PATH` | Chrome binary path | platform default |
| `X_DRY_RUN` | Run the script without clicking submit | `false` |
| `X_MIN_INTERVAL_MINUTES` | Interval floor between tweets | `20` |
| `X_MAX_INTERVAL_MINUTES` | Interval ceiling | `60` |
| `X_DAILY_CAP` | Maximum tweets per day | `10` |
| `X_ACTIVE_HOURS` | Active window, local time | `09:00-23:00` |
| `X_MAX_ATTEMPTS` | Retries for retryable errors | `3` |
| `DISCORD_WEBHOOK_URL` | Circuit-break notifications | optional |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Postgres connection | required |

## Risks and Accepted Limitations

1. **Platform terms.** Automating posting may conflict with X's terms of
   service. This is a single personal account posting at human volume, not bulk
   or coordinated activity. Accepted knowingly by the operator.
2. **Verification challenges.** X can present a challenge at any time. The
   circuit breaker handles it by stopping and notifying; clearing it is manual.
3. **DOM churn.** X ships frontend changes without notice. Contained by
   `selectors.ts`, but breakage will happen and surfaces as `FatalError`.
4. **`Runtime.enable` detectability.** Accepted; mitigated by the no-`evaluate`
   constraint above.
5. **macOS only.** `pbcopy`/`pbpaste` are macOS commands. Porting means
   swapping one module.
6. **Clipboard is global state.** Backed up and restored, but a paste performed
   by the operator during the ~200 ms window would get the tweet text.

## Open Items for Implementation

1. Confirm X's `data-testid` values against the live site before writing
   `selectors.ts`. **First task of the plan.**
2. Confirm the compose-button and submit-button flow on the current X layout —
   whether the home-timeline inline composer or the modal composer is the more
   stable path.
