# Tweet Generator — Design

- **Date:** 2026-08-05
- **Status:** Approved, ready for implementation planning

## Goal

Add a fourth service, `tweet-generator`, that fills the `tweets` queue the
`x-poster` already drains. It pulls fresh AI-industry intelligence from the
AgentLens public API, writes it up as a tweet in the voice of a working AI
engineer, renders a matching card image, and enqueues the result.

The account it feeds is a personal brand: an AI developer who posts
high-signal, low-noise material for other developers.

## Non-Goals

- **Replying, quoting, liking, or following.** These are the strongest growth
  levers on X, and they are all human work. Automating them carries a much
  higher risk than automating posts, and it annoys real people. This service
  posts and nothing else.
- **Threads.** One idea, one post.
- **Growth.** Posting alone does not grow an account. The realistic job of this
  service is that when someone arrives at the profile from a reply the human
  wrote, they find a consistent, worthwhile timeline. Success is a good
  timeline, not a follower count.
- **Multi-account or multi-language.** English only, one account.
- **Posting mechanics.** `x-poster` owns everything from `status='pending'`
  onward. This service never touches a browser session for x.com.

## Context

The workspace has three services that never call each other — they meet only in
Postgres. `x-poster` was built as a queue consumer with no producer; this design
supplies it.

```
   Discord tabs ──▶ discord-monitor ──┐
                                      ▼
   AgentLens API ──▶ tweet-generator ─┤    ┌──────────────────┐
                       │              ├──▶ │    PostgreSQL    │
                       ▼              │    │  messages        │
                  local LLM           │    │  tweets          │
                  (OmniRoute)         │    └──────────────────┘
                                      │             │
                    ai-assistant ─────┘             │ claim
                                                    ▼
                                               x-poster ──▶ x.com
```

### AgentLens API

Base URL `https://api.agentlenshq.com`. `/blogs` and `/projects` are free and
need no key. `/query` needs a key and is **not used** — its quota (100 calls /
30 days) cannot sustain a service on a two-hour cycle.

- `GET /blogs?job_type=&limit=&offset=` — dispatches, newest first.
  `job_type` ∈ `lab_article`, `gh_project`, `x_digest`, `hn_story`,
  `youtube_video`. Items carry `id`, `title`, `summary`, `job_type`,
  `generated_at`, `occurred_at`, `signal`.
- `GET /blogs/:id` — adds `body_markdown` and `references[]`.
- `GET /projects?sort=momentum&limit=` — trending GitHub projects with hard
  metrics: `stars`, `forks`, `star_velocity_7d`, `star_velocity_per_day`,
  `momentum_score`, `language`, `license`, `topics`, `tags`.
- `GET /projects/:id` — adds `explainer_md`, `html_url`, `sparkline`.

Measured publication rates (2026-08-05), which drive the per-source windows in
§3:

| source | 24h | 48h | 7d |
| --- | --- | --- | --- |
| `hn_story` | 68 | 93 | 100+ |
| `gh_project` | 88 | 100+ | 100+ |
| `lab_article` | 4 | 7 | 24 |
| `x_digest` | 2 | 4 | 14 |
| `youtube_video` | 0 | 11 | 31 |

`youtube_video` is bursty — zero one day, eleven the next. A 24-hour window
would leave its pool empty most days.

### LLM

A local OpenAI-compatible gateway, OmniRoute, at `http://localhost:20128/v1`.

**The model must be pinned.** OmniRoute's `auto` mode falls back across four
provider tiers, so the same prompt is served by Claude one day and a free
tier-4 model the next. Posts go out unattended under a personal brand; the
quality floor of the router is the quality floor of the brand. Pinning means
occasional generation failures instead — an acceptable trade, because a skipped
cycle costs nothing and the candidate returns next cycle.

**Prompt compression must be disabled for this route.** OmniRoute ships RTK +
Caveman compression (15–95% token savings). The prompts here contain material
whose exact wording matters — a banned-phrase list and a hard character budget.
Compressing prose instructions is exactly the failure this feature invites.

## Architecture

A standalone package, `tweet-generator/`, structured like the existing
services. It is deliberately **not** folded into `x-poster`:

- **Fault isolation.** A wedged generator must not take the poster down.
- **Browser isolation.** Rendering needs a headless Chromium. `x-poster` drives
  a real Chrome holding a live x.com session with an open CDP debugging port;
  any local process that connects to it gains full control of that account.
  Nothing else may share that profile.
- The `tweets` table is already the contract between producer and consumer.

```
tweet-generator/src/
  index.ts            service loop, ~2h cycle with jitter
  config.ts
  sources/
    agentlens.ts      HTTP client for /blogs and /projects
    candidates.ts     five sources -> one Candidate shape
  select/
    niche.ts          topic gate (pure)
    quota.ts          daily quota + fallback (pure)
    dedupe.ts         milestone keys, cooldown, momentum floor (pure)
  llm/
    client.ts         OpenAI-compatible chat client
    prompts.ts        persona / generate / critique / rewrite
    pipeline.ts       generate -> validate -> critique -> rewrite
    validate.ts       deterministic validator (pure, zero tokens)
    assemble.ts       fields -> final tweet string (pure)
  image/
    template.ts       HTML templates per archetype and variant
    render.ts         headless Chromium screenshot
  enqueue.ts
```

## 1. The Candidate

All five sources normalise into one shape. Everything downstream sees only
this.

```ts
interface Candidate {
  kind: 'lab_article' | 'gh_project' | 'x_digest' | 'hn_story' | 'youtube_video'
  externalId: string        // blog id, or project id
  title: string
  summary: string
  body: string              // body_markdown, or explainer_md
  facts: string[]           // pre-formatted hard metrics
  sourceUrl: string | null  // for the image only, never the tweet body
  freshness: Date           // generated_at, or pushed_at for projects
  dedupeKey: string
}
```

`facts` is the anti-hallucination whitelist, and it is **pre-formatted as
strings** the model is told to quote verbatim: `"31.4k stars"`,
`"+116 stars/day"`, `"Apache-2.0"`, `"Python"`. Formatting them in code sidesteps
the ambiguity of checking `31420` against `31.4k` against `31k` — the validator
does verbatim existence checks, never fuzzy numeric matching.

## 2. Topic gate

Runs before anything else, so filtered material never costs an LLM call. The
five sources together are a firehose, not a niche; this narrows them to what an
AI developer can act on.

Matched against `title + summary`.

```
deny  /crypto|web3|blockchain|on-chain|NFT|DePIN|airdrop/i
deny  /\btokenomics\b|\btoken (sale|price|holders)\b/i
deny  /funding|raises \$|valuation|acquires|IPO/i
keep  everything else
```

**`token` is not a deny term on its own.** `tokens`, `tokens/sec`, `tokenizer`,
and `2M tokens of context` are core vocabulary here; a bare `\btoken` rule
rejects most of the material this account exists to post. The crypto sense is
matched by the specific phrases above instead — and the seven terms on the line
before already catch the `AI × Crypto Roundup` digests on their own.

## 3. Candidate pools

A pool is that source's items inside its window whose `dedupeKey` is not
already in `tweets`, and whose `generation_attempts.attempts` is below 3.
Ordered by freshness; the top item wins.

Windows are set by **how fast the content goes stale**, not by how much of it
there is:

| source | window | reasoning |
| --- | --- | --- |
| `x_digest` | see below | a daily digest is worthless the next morning |
| `hn_story` | 24h | front-page news is stale in a day, and supply is ample |
| `lab_article` | 72h | official releases stay discussed for a few days |
| `youtube_video` | 7d | bursty supply, and a deep-dive keeps a week |
| `gh_project` | none | a leaderboard, always populated; gated by §4 instead |

"Pick the freshest unused item" reproduces the desired behaviour that an older
item which lost an earlier cycle resurfaces later — no extra mechanism needed,
because the dedupe exclusion promotes the runner-up automatically.

### x_digest is a special case

AgentLens publishes exactly two digests per day, both around 01:05 UTC
(09:05 Beijing): an `AI & Frontier Tech Roundup` and an `AI × Crypto Roundup`.
Only the former is wanted. No pool, no scoring:

```
take x_digest items with generated_at >= today 09:00 Asia/Shanghai
drop  titles matching /crypto|web3/i
take  the first survivor; if none, skip this cycle
```

Both failure modes are safe: if the naming convention ever changes, either zero
items survive (the cycle skips) or two do (one is taken).

## 4. Deduplication

**Blogs** (`lab_article`, `x_digest`, `hn_story`, `youtube_video`) are events
with stable ids: `dedupeKey = agentlens:blog:{id}`, permanent. The existing
`UNIQUE (dedupe_key)` and `ON CONFLICT DO NOTHING` already enforce this; no new
code.

**Projects** are long-lived entities — a repo sits on the leaderboard for
weeks — so a permanent key would allow one post per repo, ever. Instead the key
carries a milestone:

```
agentlens:project:{id}:{starBucket}
e.g. agentlens:project:ghp:vllm-project/vllm:stars-30k
```

`starBucket` is the largest of `1k, 2k, 5k, 10k, 20k, 50k, 100k` at or below
the current star count. A project reappears only after crossing into a new
bucket, so **a repost requires something new to say** rather than an arbitrary
timer expiring. Two further gates:

- **Cooldown.** Skip if the same `source_ref` has a `posted_at` within 7 days.
  Stops a repo that straddles a bucket boundary from posting repeatedly.
- **Momentum floor.** Skip if `star_velocity_per_day` is below
  `PROJECT_MIN_VELOCITY_PER_DAY` (default 20), so a dormant project never
  surfaces just because its cumulative count crossed a line.

`enqueue()` sets `source = kind` and `source_ref = externalId`; the cooldown
query reads `source_ref`, so this mapping is load-bearing rather than
decorative.

## 5. Quota and scheduling

The cycle runs every 2 hours ± 25 minutes of jitter. Exact two-hour spacing is
itself a machine signature.

Daily quota, configurable, totalling 10:

| kind | quota |
| --- | --- |
| `lab_article` | 4 |
| `gh_project` | 3 |
| `x_digest` | 1 |
| `hn_story` | 1 |
| `youtube_video` | 1 |

Each cycle picks **one** kind: among kinds with quota remaining, the one with
the highest remaining ratio (`remaining / quota`), ties broken by the priority
order above. This is five lines of pure function and it interleaves naturally:

| cycle | lab | proj | digest | hn | yt | picked |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | lab (tie → priority) |
| 2 | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | proj |
| 3 | 0.75 | 0.67 | 1.00 | 1.00 | 1.00 | digest |
| 4 | 0.75 | 0.67 | 0 | 1.00 | 1.00 | hn |

Strict priority ordering would instead produce four Labs posts, then three
Projects, then the rest — a monotone, visibly automated timeline.

**Fallback** is free: if the picked kind's pool is empty, continue down the same
ordering to the next kind with quota left. If every pool is empty, skip.

**The 09:00 anchor** is the only time-based exception: in the first cycle at or
after 09:00 Asia/Shanghai, `x_digest` gets first refusal, because that is when
it lands and it is stale by tomorrow.

**The generator enforces the daily cap itself** by counting today's enqueued
rows, rather than leaving it to `x-poster`. Twelve cycles against a cap of ten
would otherwise leave two rows sitting at the back of the queue overnight, to
surface the next morning carrying yesterday's news.

## 6. Post archetypes

Structural monotony, not volume, is what makes an account read as a content
farm — every post being a hook, three arrows, and an identically watermarked
card is a trivially learnable fingerprint, and ten identical posts a day give a
classifier more to work with than three do. Archetypes are chosen by weighted
random with a hard constraint: **never the same archetype twice in a row.**

| archetype | shape | image | weight |
| --- | --- | --- | --- |
| `digest` | hook + 3 highlights | full card | 45% |
| `metric` | hard number, then one line | minimal card | 20% |
| `take` | one opinionated sentence | none | 20% |
| `question` | a pointed question for peers | none | 15% |

Half the posts carrying no image at all cuts the fingerprint, cuts render cost,
and makes the timeline read like a person rather than a feed.

Character budgets, assembled in code:

| archetype | budget |
| --- | --- |
| `digest` | hook ≤ 90, each highlight ≤ 55, separators ~6 → ≈ 261 |
| `metric` | number line ≤ 40, body ≤ 200 |
| `take` | ≤ 240 |
| `question` | ≤ 200 |

No tweet carries a URL, so the full 280 is available — X charges a flat 23
characters for any link regardless of length, and down-ranks posts with
external links. Attribution rides on the image watermark instead.

## 7. Generation pipeline

```
Stage 0  PREPARE    pure code. Candidate -> facts[], truncated body, archetype
Stage 1  GENERATE   one call -> JSON fields. Archetype is fixed by code and
                    written into the prompt; the model only fills it in.
Stage 2  VALIDATE   pure code, zero tokens. On failure, the specific violations
                    go back to Stage 1.
Stage 3  CRITIQUE   pinned model -> { verdict: 'pass' | 'revise', issues: [] }
Stage 4  REWRITE    rewrite against issues -> back to Stage 2
```

A **round** is one generate-or-rewrite call plus the validation and critique
that follow it. Three rounds maximum, then the candidate is abandoned for this
cycle and its `generation_attempts` row increments.

Stage 2 runs **before** Stage 3 because it is free: a critique call should never
be spent on a draft that is already mechanically broken.

The model returns **separate fields** (`hook`, `highlights[]`, …), never a
finished tweet string. Code assembles and counts. This makes the 280-character
limit a property of construction rather than something the model is asked to
achieve — and models cannot count characters reliably, because tokenisation
hides character boundaries from them.

`response_format: { type: 'json_schema' }` **cannot be relied on**: OmniRoute's
lower tiers will ignore it. Parsing is lenient — strip code fences, find the
first balanced JSON object — and validation is what actually enforces structure.

## 8. Validator

Pure functions, no I/O, no tokens. The bulk of the test suite lives here.

| check | detail |
| --- | --- |
| total length | X weighted length; emoji count as 2 |
| per-field budget | see §6 |
| structural fit | `digest` must have exactly 3 highlights |
| **number whitelist** | every numeric token in the output must appear verbatim somewhere in the source material |
| banned phrases | two tiers, below |
| no hashtags | `#` is the most marketing-coded thing in a geek register |
| no URLs | by design |
| em dashes ≤ 1 | the single strongest LLM tell in short-form English |
| no leading emoji, `1/`, `🧵` | thread bait |

### The number whitelist checks the whole source, not just `facts[]`

Scoping it to `facts[]` would reject `LFM2.5-2.6B`, `GPT-5.6`, and `v2` — model
names and version strings that are not metrics. The check exists to catch
**invented** numbers, not quoted ones, so its reference set is
`title + summary + body + facts`.

### Banned phrases: two tiers

A flat substring blacklist has a design flaw that matters here. It cannot tell
"the model wrote a cliché" from "the source says this and the model is quoting
it accurately" — and `facts[]` explicitly instructs the model to quote verbatim.
The two rules then fight: accuracy forces a blacklist hit, and avoiding the hit
forces a distortion. Three rounds burn and the post is dropped.

**Tier 1 — hard fail.** Multi-word phrases only, with essentially no legitimate
technical use:

```
in the ever-evolving | in today's fast-paced | delve into | paradigm shift
harness the power | unlock the (power|potential) | it's worth noting
buckle up | let that sink in | the AI landscape | game.?changer
```

**Rule: single words are never hard-failed, only phrases.** A single word's
meaning is entirely contextual, and a regex cannot see context.

**Tier 2 — soft flag.** `seamless`, `elevate`, `unleash`, `robust`, `leverage`,
`supercharge`, `revolutionize`, `cutting-edge`. These have real technical uses —
`seamless failover` and `elevated privileges` are standard terms, and rejecting
a post about privilege escalation for containing "elevated" is absurd. Hits are
not failures; they are handed to the Stage 3 critic as pointed questions:

> The draft uses "seamless". Is it doing real semantic work in this sentence, or
> is it filler? If filler, rewrite that line.

**This is the job an LLM critic is uniquely suited for, and the reason the
pipeline includes one.** The regex does recall; the model does judgement.

### Two safeguards

- **Quotation exemption.** Before running the phrase checks, mask any span that
  appears verbatim in the source material. A project actually named `Unleash`
  must not convict the model of saying its name.
- **Loop guard.** If the same rule fires two rounds running, downgrade it to a
  warning and let the draft through. A rule the model cannot satisfy is a broken
  rule, and a tweet containing "seamless" beats a tweet that never shipped.

Both tiers load from a config file, not from source: new clichés will need
adding, and editing config is faster than editing code.

## 9. Persona

The system prompt establishes a working AI engineer, not a marketing account.
The user prompt supplies the material, the fixed archetype, `facts[]`, and
explicit character budgets. Core constraints:

- Use only numbers from `facts[]`, quoted verbatim. Invent nothing.
- Write for peers, not for recruiters or investors.
- One idea per post.
- No preamble. The first word is already the point.
- Do not explain the obvious.
- Flat and dry beats enthusiastic.

## 10. Image rendering

A headless Chromium from the existing Playwright dependency, launched per
render and closed immediately. At one image every two hours there is no
throughput requirement, and a long-lived browser is a leak, a wedge risk, and a
health check to maintain.

| | |
| --- | --- |
| size | 1600×900 at `deviceScaleFactor: 2` → 3200×1800 PNG |
| templates | two `digest` variants, one `metric`; `take`/`question` render nothing |
| watermark | `agentlenshq.com`, bottom right, low contrast |
| output | `MEDIA_DIR/{sha256(dedupeKey).slice(0, 16)}.png` |

**Fonts are embedded as base64 in the template.** A `font-family: Inter,
sans-serif` declaration renders differently on macOS and in a container —
different metrics, different wrapping, broken cards. Embedding also means the
template makes zero network requests.

Variant selection carries the same "never twice in a row" constraint as
archetypes, but only where an archetype has more than one variant — `metric`
has a single card, so the rule does not apply to it.

A cleanup pass deletes media for tweets whose `posted_at` is older than 7 days.
Deterministic filenames mean a retry overwrites its own file rather than
orphaning one.

## 11. Database changes

```sql
ALTER TABLE tweets ADD COLUMN IF NOT EXISTS media_path TEXT;
ALTER TABLE tweets ADD COLUMN IF NOT EXISTS archetype VARCHAR(20);

CREATE TABLE IF NOT EXISTS generation_attempts (
  external_id VARCHAR(255) PRIMARY KEY,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`archetype` is required for **correctness**, not analytics: the "never twice in
a row" rule needs the last posted archetype, and the process restarts.

`generation_attempts` stops a poison candidate from starving a source. Without
it, one lab article the model cannot write well sits at the top of the pool and
consumes every Labs slot for three days — it is selected each cycle and fails
each cycle.

Also updated: the `Tweet` interface in `shared/src/types.ts`, and `COLUMNS`,
`toTweet`, and `EnqueueInput` in `x-poster/src/queue/tweet-queue.ts`.

## 12. Media upload in the composer

A new step between step 4 (paste) and step 5 (re-read) of the existing
seven-step script, skipped when `media_path` is null.

**Use `setInputFiles` on the hidden `input[type=file]`. Do not click the media
button.** Clicking it in a real, non-headless Chrome opens a **native OS file
dialog**. Playwright's `filechooser` interception is less reliable against a
CDP-attached browser, and one missed interception leaves a modal system dialog
blocking the session — on an unattended process, until someone notices.
`setInputFiles` writes the DOM input directly and never opens that path.

**Wait for the upload to land before submitting.** X disables the submit button
during upload; wait for `[data-testid="removeMedia"]` (the preview-ready
signal) plus a settle delay. Submitting early either posts without the image or
throws.

**A media timeout is `RetryableError`, not `UncertainError`.** Submit has not
been clicked, so the tweet definitively did not post and retrying is safe.
Misclassifying it as uncertain would strand a healthy tweet awaiting manual
review.

## 13. Failure handling

| condition | handling |
| --- | --- |
| AgentLens request fails | skip the cycle, write nothing, retry in ~2h |
| pool empty | fall through to the next kind with quota; skip if all empty |
| LLM unreachable | skip the cycle; 3 consecutive (~6h) → Discord alert |
| 3 rounds without passing validation | abandon candidate, increment `generation_attempts` |
| image render fails | abandon the whole item — no degraded image-less fallback |
| dedupe conflict on enqueue | `enqueue()` returns null; treat as already posted, skip silently |

The rule throughout: **skip a post rather than enqueue one that has not
passed validation.** The queue is irreversible — once a row is `pending`,
`x-poster` puts it on the timeline with no second review.

Alerts (Discord webhook): LLM unreachable 3 cycles running; nothing enqueued in
24 hours; AgentLens 5xx 3 cycles running.

`notifier.ts` moves from `x-poster/` into `shared/`, since both services now
need it. This follows the direction already set by `2d5c644` (*stop naming
shared infrastructure after one service*).

## 14. Testing

Almost all of the value is in pure functions with no I/O:

| module | cases that matter |
| --- | --- |
| `validate.ts` | length boundaries, both blacklist tiers, number whitelist, **quotation exemption**, **loop-guard downgrade** |
| `quota.ts` | remaining-ratio selection, fallback, the 09:00 anchor, the daily cap |
| `dedupe.ts` | star-bucket boundaries, 7-day cooldown, momentum floor |
| `assemble.ts` | weighted length with emoji, each archetype's assembly |
| `niche.ts` | **`tokenizer` and `tokens/sec` survive the `token` rule** |
| `candidates.ts` | all five sources normalise correctly, fixture-driven |

I/O paths: `agentlens.ts` replays stored real responses; `pipeline.ts` runs
against a mock client to test round control, issue feedback, and the abandon
path; `template.ts` snapshots the **HTML string** (far more stable than
comparing screenshots); `render.ts` gets one smoke test that a plausible PNG
comes out.

The composer's media upload is not unit-testable and is marked for manual
verification: run with `X_DRY_RUN=true` and confirm the image is attached in
`screenshots/`.

## Configuration

New `tweet-generator/.env.example`:

```
# Database
DB_USER, DB_HOST, DB_NAME, DB_PASSWORD, DB_PORT

# AgentLens
AGENTLENS_BASE_URL=https://api.agentlenshq.com

# LLM — pin the model, do not use "auto"
LLM_BASE_URL=http://localhost:20128/v1
LLM_API_KEY=
LLM_MODEL=
LLM_TIMEOUT_MS=120000

# Cycle
CYCLE_MINUTES=120
CYCLE_JITTER_MINUTES=25
DAILY_CAP=10
QUOTA_LAB=4
QUOTA_PROJECT=3
QUOTA_DIGEST=1
QUOTA_HN=1
QUOTA_YOUTUBE=1

# Selection
PROJECT_COOLDOWN_DAYS=7
PROJECT_MIN_VELOCITY_PER_DAY=20
TIMEZONE=Asia/Shanghai

# Pipeline
MAX_ROUNDS=3
BANNED_PHRASES_FILE=./banned-phrases.json

# Images
MEDIA_DIR=./media
MEDIA_RETENTION_DAYS=7

# Alerts
DISCORD_WEBHOOK_URL=
LOG_LEVEL=info
```

## Suggested phasing

The system is one coherent design, but it has three natural checkpoints where
something observable exists:

1. **Sources, selection, enqueue.** §1–§5 and §11, with a placeholder formatter
   that emits the title. End state: correct items, correctly paced, landing in
   `tweets`, verifiable against `X_DRY_RUN=true`.
2. **The generation pipeline.** §6–§9. End state: real copy, validated.
3. **Images and media upload.** §10 and §12. End state: cards attached.

Phase 1 is the only one that touches scheduling and deduplication — the parts
whose bugs are silent and slow to notice — so it deserves the heaviest test
pass.

## Risks

**Browser automation of x.com.** X provides an official API; driving the web UI
around it is a terms-of-service matter independent of volume. This risk is
pre-existing — `x-poster` already carries it — but it remains the largest single
risk in the system and is worth stating plainly.

**Ten posts a day on a cold account.** Ten is nowhere near any X rate limit;
those sit in the thousands. The real exposure is behavioural: uniform structure,
zero interaction, and an identical watermark on every card is the standard
content-farm signature, and volume amplifies it. §6 (archetype mix, half the
posts image-less) and the cycle jitter in §5 are the mitigations. The operator
has decided against a volume ramp; the quota values are configuration and can be
lowered at any time.

**Unattended generation.** Nothing reviews a post between the validator and the
timeline. The two-tier blacklist, the number whitelist, and the pinned model are
what stand in for a human reviewer. `X_DRY_RUN=true` on `x-poster` is the safe
way to observe a full day's output before going live.
