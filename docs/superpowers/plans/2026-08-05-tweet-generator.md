# Tweet Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `tweet-generator`, a fourth service that pulls AI-industry dispatches from the AgentLens public API, writes them up as tweets through a pinned local LLM, renders a card image, and enqueues the result for the existing `x-poster` to drain.

**Architecture:** A standalone package running a ~2-hour loop with jitter. Each cycle picks one source kind by remaining-quota ratio, pulls its freshest unused candidate, runs a four-stage LLM pipeline (generate → deterministic validate → LLM critique → rewrite), renders an optional card, and inserts one row into `tweets`. It never touches a browser session for x.com — the `tweets` table is the only contract with `x-poster`.

**Tech Stack:** TypeScript (ESM, `nodenext`), Node 18+, pnpm workspace, `pg`, `winston`, `playwright` (headless Chromium for card rendering only), `vitest`, `dotenv`. LLM access is plain `fetch` against an OpenAI-compatible `/v1/chat/completions`.

**Design doc:** `docs/superpowers/specs/2026-08-05-tweet-generator-design.md`

## Global Constraints

- **Module system:** ESM throughout. Every relative import carries a `.js` extension, even from a `.ts` file (`nodenext` resolution). Copy `tsconfig.json` from `x-poster/` verbatim.
- **Tests:** `vitest`, colocated as `src/**/*.test.ts` next to the module they cover. `include: ['src/**/*.test.ts']`, `environment: 'node'`.
- **Dependency versions:** always `"catalog:"` in `package.json`. Add new shared deps to the `catalog:` block in `pnpm-workspace.yaml`, never a literal version in a package.
- **Randomness is injectable.** Every function with random behaviour takes `rng: Rng = Math.random` as its last parameter, so tests pass `mulberry32(seed)`. `Rng` and `mulberry32` come from `x-poster/src/human/delay.ts`; Task 3 re-exports them from `shared`.
- **Config loaders take an env argument:** `loadConfig(env: NodeJS.ProcessEnv = process.env)`, so tests construct config without touching the real environment.
- **Comments explain why, not what.** The existing codebase does this consistently; match it. A comment restating the code is noise.
- **Never use `model: "auto"`** against OmniRoute. `LLM_MODEL` is required config with no default.
- **Prompt compression must be disabled** on the OmniRoute route this service uses. This is an operator step recorded in the README, not code.
- **The queue is irreversible.** Once a row is `pending`, `x-poster` puts it on the timeline unreviewed. Never enqueue content that has not passed the validator.
- **Timezone:** all day boundaries and the 09:00 anchor use `TIMEZONE` (default `Asia/Shanghai`), never the host's local time. `x-poster`'s own rate limiter uses host-local time; that is separate and stays as it is.
- **Commit after every task.** Conventional-commit prefixes (`feat:`, `refactor:`, `test:`, `docs:`, `chore:`).

## File Structure

**New package — `tweet-generator/`**

| file | responsibility |
| --- | --- |
| `src/config.ts` | parse and validate every env var; the only place defaults live |
| `src/sources/agentlens.ts` | HTTP against `/blogs`, `/blogs/:id`, `/projects`; knows the wire shapes and nothing else |
| `src/sources/candidates.ts` | wire shapes → `Candidate`; owns `facts[]` formatting |
| `src/select/niche.ts` | topic gate (pure) |
| `src/select/dedupe.ts` | star buckets, dedupe keys (pure) |
| `src/select/quota.ts` | remaining-ratio kind picker, 09:00 anchor (pure) |
| `src/select/windows.ts` | per-kind freshness windows (pure) |
| `src/store.ts` | every SQL query this service issues |
| `src/llm/client.ts` | OpenAI-compatible chat call, lenient JSON extraction |
| `src/llm/archetypes.ts` | archetype definitions, budgets, weighted pick (pure) |
| `src/llm/assemble.ts` | fields → tweet string, X weighted length (pure) |
| `src/llm/validate.ts` | the deterministic validator (pure) |
| `src/llm/prompts.ts` | persona, generate, critique, rewrite prompt builders (pure) |
| `src/llm/pipeline.ts` | four-stage orchestration, round control |
| `src/image/template.ts` | HTML per archetype and variant (pure) |
| `src/image/render.ts` | headless Chromium screenshot, retention cleanup |
| `src/index.ts` | the service loop |

**Modified**

| file | change |
| --- | --- |
| `pnpm-workspace.yaml` | add `tweet-generator` to `packages` |
| `shared/package.json` | add `./notifier` export |
| `shared/src/notifier.ts` | moved from `x-poster/`, generalised (Task 1) |
| `shared/src/rng.ts` | moved from `x-poster/src/human/delay.ts` (Task 1) |
| `shared/src/types.ts` | `Tweet` gains `mediaPath`, `archetype`; new `TweetArchetype` |
| `discord-monitor/src/setup-database.ts` | two `ALTER TABLE`s, one `CREATE TABLE` |
| `x-poster/src/queue/tweet-queue.ts` | new columns in `COLUMNS`, `toTweet`, `EnqueueInput` |
| `x-poster/src/x/composer.ts` | media upload step |
| `x-poster/src/index.ts` | pass `tweet.mediaPath` to `postTweet` |
| `README.md` | document the fourth service |

**Phases.** Tasks 1–9 are Phase 1 and end with working software: real candidates, correctly paced, landing in `tweets` with placeholder copy, observable via `X_DRY_RUN=true`. Tasks 10–14 replace the placeholder with real copy. Tasks 15–17 add images. Phase 1 owns scheduling and deduplication — the parts whose bugs are silent — so it carries the heaviest test load.

---

### Task 1: Move `notifier` and the seeded RNG into `shared`

Both `x-poster` and `tweet-generator` need to alert through the Discord webhook, and both need reproducible randomness under test. Right now both live in `x-poster/`. This follows the direction set by commit `2d5c644` (*stop naming shared infrastructure after one service*).

**Files:**
- Create: `shared/src/notifier.ts`
- Create: `shared/src/notifier.test.ts`
- Create: `shared/src/rng.ts`
- Create: `shared/src/rng.test.ts`
- Modify: `shared/package.json`
- Delete: `x-poster/src/notifier.ts`, `x-poster/src/notifier.test.ts`
- Modify: `x-poster/src/index.ts`, `x-poster/src/human/delay.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `notifyFailure(webhookUrl: string | null, service: string, message: string, fetchImpl?: typeof fetch): Promise<void>`
  - `type Rng = () => number`
  - `mulberry32(seed: number): Rng`

- [ ] **Step 1: Write the failing test for the generalised notifier**

Create `shared/src/notifier.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { notifyFailure } from './notifier.js'

describe('notifyFailure', () => {
  it('posts the message to the webhook under the service name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    await notifyFailure(
      'https://example.test/hook',
      'x-poster',
      'session expired',
      fetchImpl as never,
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://example.test/hook')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.username).toBe('x-poster')
    expect(body.content).toContain('session expired')
    expect(body.content).toContain('x-poster')
  })

  it('does nothing when no webhook is configured', async () => {
    const fetchImpl = vi.fn()
    await notifyFailure(null, 'x-poster', 'session expired', fetchImpl as never)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('swallows a webhook failure', async () => {
    // A broken notification must not mask the failure it was reporting.
    const fetchImpl = vi.fn().mockRejectedValue(new Error('webhook down'))
    await expect(
      notifyFailure(
        'https://example.test/hook',
        'x-poster',
        'session expired',
        fetchImpl as never,
      ),
    ).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter shared test`
Expected: FAIL — `Cannot find module './notifier.js'`

- [ ] **Step 3: Write the notifier**

Create `shared/src/notifier.ts`:

```ts
/**
 * Failure notifications, sent through the Discord webhook the workspace
 * already has. A second notification channel is not warranted.
 *
 * `service` is a parameter rather than a constant because more than one
 * service now reports through here, and a notification that does not say
 * which process stopped is a notification you have to go and investigate.
 */
export async function notifyFailure(
  webhookUrl: string | null,
  service: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!webhookUrl) return

  try {
    await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: service,
        content: `🛑 **${service} stopped**\n\`\`\`\n${message}\n\`\`\``,
      }),
    })
  } catch {
    // A broken notification must not mask the failure it was reporting.
  }
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter shared test`
Expected: PASS — 3 tests.

- [ ] **Step 5: Write the failing test for the shared RNG**

Create `shared/src/rng.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mulberry32 } from './rng.js'

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(2026)
    const b = mulberry32(2026)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('produces different streams for different seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)())
  })

  it('stays inside [0, 1)', () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 1000; i++) {
      const value = rng()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `pnpm --filter shared test`
Expected: FAIL — `Cannot find module './rng.js'`

- [ ] **Step 7: Move the RNG into `shared`**

Create `shared/src/rng.ts` — the body is lifted verbatim from `x-poster/src/human/delay.ts`:

```ts
export type Rng = () => number

/**
 * Small seeded PRNG. Exported so the randomised behaviour across this
 * workspace is reproducible under test — every module that takes an `rng`
 * accepts this.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
```

- [ ] **Step 8: Export both from the `shared` package**

Modify `shared/package.json`, adding two entries to `exports`:

```json
  "exports": {
    ".": "./src/types.ts",
    "./logger": "./src/logger.ts",
    "./db": "./src/db.ts",
    "./notifier": "./src/notifier.ts",
    "./rng": "./src/rng.ts"
  },
```

- [ ] **Step 9: Run the shared tests**

Run: `pnpm --filter shared test`
Expected: PASS — 6 tests.

- [ ] **Step 10: Re-point `x-poster` at the shared modules**

In `x-poster/src/human/delay.ts`, delete the local `Rng` and `mulberry32` definitions and replace them with a re-export, so the existing `import { mulberry32 } from '../human/delay.js'` in tests keeps working:

```ts
export { mulberry32, type Rng } from 'shared/rng'
```

(The rest of `delay.ts` — `standardNormal`, `sampleDelay`, `humanDelay` — is unchanged. Its `Rng` references now resolve to the re-exported type.)

In `x-poster/src/index.ts`, replace the notifier import and both call sites:

```ts
import { notifyFailure } from 'shared/notifier'
```

```ts
      await notifyFailure(config.discordWebhookUrl, 'x-poster', error.message)
```

```ts
  await notifyFailure(config.discordWebhookUrl, 'x-poster', String(error))
```

Then delete `x-poster/src/notifier.ts` and `x-poster/src/notifier.test.ts`.

- [ ] **Step 11: Run the full test suite**

Run: `pnpm --filter shared test && pnpm --filter x-poster test`
Expected: PASS. `x-poster` loses the 3 notifier tests and keeps everything else green.

- [ ] **Step 12: Commit**

```bash
git add shared x-poster pnpm-workspace.yaml
git commit -m "refactor: move the notifier and seeded RNG into shared

A second service now needs both. The notifier gains a service parameter,
because a notification that does not say which process stopped is a
notification you have to go and investigate."
```

---

### Task 2: Schema, types, and queue columns

The `tweets` table needs two columns and the workspace needs one new table. `archetype` is required for correctness, not analytics: the "never the same archetype twice in a row" rule needs the last posted archetype, and the process restarts.

**Files:**
- Modify: `discord-monitor/src/setup-database.ts`
- Modify: `shared/src/types.ts`
- Modify: `x-poster/src/queue/tweet-queue.ts`
- Modify: `x-poster/src/queue/tweet-queue.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TweetArchetype = 'digest' | 'metric' | 'take' | 'question'`
  - `Tweet` gains `mediaPath: string | null` and `archetype: TweetArchetype | null`
  - `EnqueueInput` gains `mediaPath?: string` and `archetype?: TweetArchetype`
  - table `generation_attempts (external_id PK, attempts, last_error, updated_at)`

- [ ] **Step 1: Add the archetype type and extend `Tweet`**

In `shared/src/types.ts`, immediately after the `TweetStatus` union, add:

```ts
/**
 * The shape a tweet takes. Chosen by the generator, stored because the
 * "never the same archetype twice in a row" rule has to survive a process
 * restart — it cannot be held in memory.
 */
export type TweetArchetype = 'digest' | 'metric' | 'take' | 'question'
```

Then add two fields to the `Tweet` interface, after `sourceRef`:

```ts
  /** Absolute or workspace-relative path to the card image, if this tweet has one. */
  mediaPath: string | null
  archetype: TweetArchetype | null
```

- [ ] **Step 2: Add the migrations**

In `discord-monitor/src/setup-database.ts`, immediately after the `CREATE TABLE IF NOT EXISTS tweets (...)` block and before the index block, add:

```ts
    // Added after the tweets table shipped, so these run as ALTERs rather
    // than being folded into the CREATE above — an existing database would
    // never see a changed CREATE TABLE IF NOT EXISTS.
    await client.query(`
      ALTER TABLE tweets ADD COLUMN IF NOT EXISTS media_path TEXT;
      ALTER TABLE tweets ADD COLUMN IF NOT EXISTS archetype VARCHAR(20);
    `)

    // One row per candidate the generator has tried and failed to write up.
    // Without it a candidate the model cannot handle sits at the top of its
    // pool and consumes every slot that source has, every cycle, until it
    // ages out of the freshness window.
    await client.query(`
      CREATE TABLE IF NOT EXISTS generation_attempts (
        external_id VARCHAR(255) PRIMARY KEY,
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
```

- [ ] **Step 3: Write the failing test for the new queue columns**

In `x-poster/src/queue/tweet-queue.test.ts`, add to the `enqueue` describe block:

```ts
  it('round-trips the media path and archetype', async () => {
    const tweet = await queue.enqueue({
      content: 'hello',
      // The `test:` prefix matters — the beforeEach/afterAll cleanup at the
      // top of this file deletes by `dedupe_key LIKE 'test:%'`, and a row
      // outside that prefix survives the suite and pollutes the queue.
      dedupeKey: 'test:media',
      source: 'lab_article',
      sourceRef: 'abc',
      mediaPath: './media/abc.png',
      archetype: 'digest',
    })

    expect(tweet).not.toBeNull()
    expect(tweet!.mediaPath).toBe('./media/abc.png')
    expect(tweet!.archetype).toBe('digest')
  })

  it('leaves both null when they are not supplied', async () => {
    const tweet = await queue.enqueue({
      content: 'hello',
      dedupeKey: 'test:no-media',
    })

    expect(tweet!.mediaPath).toBeNull()
    expect(tweet!.archetype).toBeNull()
  })
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `pnpm --filter x-poster test tweet-queue`
Expected: FAIL — `mediaPath` is not a known property of `EnqueueInput`.

- [ ] **Step 5: Extend the queue**

In `x-poster/src/queue/tweet-queue.ts`:

Add to `TweetRow`:

```ts
  media_path: string | null
  archetype: Tweet['archetype']
```

Add to the object `toTweet` returns, after `sourceRef`:

```ts
    mediaPath: row.media_path,
    archetype: row.archetype,
```

Extend `COLUMNS`:

```ts
const COLUMNS = `
  id, content, status, dedupe_key, source, source_ref, media_path, archetype,
  attempts, last_error, scheduled_at, posted_at, posted_url, created_at,
  updated_at
`
```

Extend `EnqueueInput`:

```ts
export interface EnqueueInput {
  content: string
  dedupeKey: string
  source?: string
  sourceRef?: string
  mediaPath?: string
  archetype?: Tweet['archetype']
  scheduledAt?: Date
}
```

And the insert:

```ts
    const result = await this.pool.query<TweetRow>(
      `INSERT INTO tweets
         (content, dedupe_key, source, source_ref, media_path, archetype,
          scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.content,
        input.dedupeKey,
        input.source ?? null,
        input.sourceRef ?? null,
        input.mediaPath ?? null,
        input.archetype ?? null,
        input.scheduledAt ?? null,
      ],
    )
```

- [ ] **Step 6: Apply the migration and run the tests**

Run:
```bash
docker compose up -d
pnpm --filter discord-monitor run setup-db
pnpm --filter x-poster test
```
Expected: PASS. The setup script is idempotent, so re-running it against an existing database is safe.

- [ ] **Step 7: Commit**

```bash
git add discord-monitor shared x-poster
git commit -m "feat(db): add media_path, archetype, and generation_attempts

archetype is stored for correctness rather than analytics: the generator's
'never the same shape twice in a row' rule has to survive a restart."
```

---

### Task 3: Package scaffold and configuration

**Files:**
- Create: `tweet-generator/package.json`, `tweet-generator/tsconfig.json`, `tweet-generator/vitest.config.ts`, `tweet-generator/.env.example`, `tweet-generator/.gitignore`
- Create: `tweet-generator/src/config.ts`, `tweet-generator/src/config.test.ts`
- Modify: `pnpm-workspace.yaml`

**Interfaces:**
- Consumes: `loadDbConfig` from `shared/db`.
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): GeneratorConfig`, and the `GeneratorConfig`, `Quota`, and `SourceKind` types every later task imports.

- [ ] **Step 1: Register the package in the workspace**

In `pnpm-workspace.yaml`, add to `packages`:

```yaml
packages:
  - shared
  - discord-monitor
  - ai-assistant
  - x-poster
  - tweet-generator
```

- [ ] **Step 2: Create the package manifest**

Create `tweet-generator/package.json`:

```json
{
  "name": "tweet-generator",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx --watch src/index.ts",
    "test": "vitest run",
    "build": "tsc"
  },
  "dependencies": {
    "dotenv": "catalog:",
    "pg": "catalog:",
    "playwright": "catalog:",
    "shared": "workspace:*",
    "winston": "catalog:"
  },
  "devDependencies": {
    "@types/node": "^24.13.3",
    "@types/pg": "catalog:",
    "tsx": "^4.23.1",
    "typescript": "^6.0.0",
    "vitest": "catalog:"
  }
}
```

- [ ] **Step 3: Create the TypeScript and vitest config**

Create `tweet-generator/tsconfig.json` — identical to `x-poster/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Create `tweet-generator/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
```

Create `tweet-generator/.gitignore`:

```
media/
*.log
```

- [ ] **Step 4: Write the failing config test**

Create `tweet-generator/src/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const minimal = { LLM_MODEL: 'some-model' } as NodeJS.ProcessEnv

describe('loadConfig', () => {
  it('fills in every default', () => {
    const config = loadConfig(minimal)

    expect(config.agentlensBaseUrl).toBe('https://api.agentlenshq.com')
    expect(config.llm.baseUrl).toBe('http://localhost:20128/v1')
    expect(config.llm.model).toBe('some-model')
    expect(config.cycleMinutes).toBe(120)
    expect(config.cycleJitterMinutes).toBe(25)
    expect(config.dailyCap).toBe(10)
    expect(config.quota).toEqual({
      lab_article: 4,
      gh_project: 3,
      x_digest: 1,
      hn_story: 1,
      youtube_video: 1,
    })
    expect(config.projectCooldownDays).toBe(7)
    expect(config.projectMinVelocityPerDay).toBe(20)
    expect(config.timezone).toBe('Asia/Shanghai')
    expect(config.maxRounds).toBe(3)
    expect(config.mediaDir).toBe('./media')
    expect(config.mediaRetentionDays).toBe(7)
    expect(config.discordWebhookUrl).toBeNull()
  })

  it('requires a pinned model', () => {
    // OmniRoute's "auto" falls back across provider tiers, so the model that
    // serves a request varies day to day. Posts go out unattended under a
    // personal brand; the router's quality floor becomes the brand's.
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/LLM_MODEL/)
  })

  it('rejects the auto model explicitly', () => {
    expect(() =>
      loadConfig({ LLM_MODEL: 'auto' } as NodeJS.ProcessEnv),
    ).toThrow(/pinned/)
  })

  it('rejects a quota total above the daily cap', () => {
    expect(() =>
      loadConfig({ ...minimal, QUOTA_LAB: '9' } as NodeJS.ProcessEnv),
    ).toThrow(/exceeds DAILY_CAP/)
  })

  it('rejects a non-integer cycle length', () => {
    expect(() =>
      loadConfig({ ...minimal, CYCLE_MINUTES: 'soon' } as NodeJS.ProcessEnv),
    ).toThrow(/CYCLE_MINUTES/)
  })

  it('rejects jitter that could produce a non-positive interval', () => {
    expect(() =>
      loadConfig({
        ...minimal,
        CYCLE_MINUTES: '20',
        CYCLE_JITTER_MINUTES: '20',
      } as NodeJS.ProcessEnv),
    ).toThrow(/CYCLE_JITTER_MINUTES/)
  })

  it('reads overrides', () => {
    const config = loadConfig({
      ...minimal,
      QUOTA_LAB: '2',
      QUOTA_PROJECT: '2',
      QUOTA_DIGEST: '1',
      QUOTA_HN: '1',
      QUOTA_YOUTUBE: '0',
      DAILY_CAP: '6',
      TIMEZONE: 'UTC',
    } as NodeJS.ProcessEnv)

    expect(config.quota.youtube_video).toBe(0)
    expect(config.dailyCap).toBe(6)
    expect(config.timezone).toBe('UTC')
  })
})
```

- [ ] **Step 5: Run it to confirm it fails**

Run: `pnpm install && pnpm --filter tweet-generator test`
Expected: FAIL — `Cannot find module './config.js'`

- [ ] **Step 6: Write the config loader**

Create `tweet-generator/src/config.ts`:

```ts
import dotenv from 'dotenv'
import { loadDbConfig, type DbConfig } from 'shared/db'

dotenv.config()

/** The five AgentLens dispatch kinds this service draws from. */
export type SourceKind =
  | 'lab_article'
  | 'gh_project'
  | 'x_digest'
  | 'hn_story'
  | 'youtube_video'

/**
 * Priority order, highest first. Used to break ties in the quota picker and
 * to decide fallback order when a pool is empty.
 */
export const SOURCE_PRIORITY: readonly SourceKind[] = [
  'lab_article',
  'gh_project',
  'x_digest',
  'hn_story',
  'youtube_video',
]

export type Quota = Record<SourceKind, number>

export interface LlmConfig {
  baseUrl: string
  apiKey: string | null
  model: string
  timeoutMs: number
}

export interface GeneratorConfig {
  db: DbConfig
  agentlensBaseUrl: string
  llm: LlmConfig
  cycleMinutes: number
  cycleJitterMinutes: number
  dailyCap: number
  quota: Quota
  projectCooldownDays: number
  projectMinVelocityPerDay: number
  timezone: string
  maxRounds: number
  bannedPhrasesFile: string
  mediaDir: string
  mediaRetentionDays: number
  discordWebhookUrl: string | null
}

function nonNegativeInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer, got: ${raw}`)
  }
  return value
}

function positiveInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const value = nonNegativeInt(env, key, fallback)
  if (value < 1) throw new Error(`${key} must be a positive integer`)
  return value
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): GeneratorConfig {
  const model = env.LLM_MODEL
  if (!model) {
    throw new Error(
      'LLM_MODEL is required. OmniRoute falls back across provider tiers, ' +
        'so an unpinned model means a different writer every day.',
    )
  }
  if (model.toLowerCase() === 'auto') {
    throw new Error(
      'LLM_MODEL must be pinned to a specific model, not "auto". Unattended ' +
        'posts inherit the router\'s quality floor as the account\'s.',
    )
  }

  const quota: Quota = {
    lab_article: nonNegativeInt(env, 'QUOTA_LAB', 4),
    gh_project: nonNegativeInt(env, 'QUOTA_PROJECT', 3),
    x_digest: nonNegativeInt(env, 'QUOTA_DIGEST', 1),
    hn_story: nonNegativeInt(env, 'QUOTA_HN', 1),
    youtube_video: nonNegativeInt(env, 'QUOTA_YOUTUBE', 1),
  }

  const dailyCap = positiveInt(env, 'DAILY_CAP', 10)
  const quotaTotal = Object.values(quota).reduce((sum, n) => sum + n, 0)
  if (quotaTotal > dailyCap) {
    // Quota that cannot be spent is quota that silently never fires, which
    // reads as "the lowest-priority source is broken" rather than as a
    // configuration mistake.
    throw new Error(
      `The quota total (${quotaTotal}) exceeds DAILY_CAP (${dailyCap})`,
    )
  }

  const cycleMinutes = positiveInt(env, 'CYCLE_MINUTES', 120)
  const cycleJitterMinutes = nonNegativeInt(env, 'CYCLE_JITTER_MINUTES', 25)
  if (cycleJitterMinutes >= cycleMinutes) {
    throw new Error(
      `CYCLE_JITTER_MINUTES (${cycleJitterMinutes}) must be less than ` +
        `CYCLE_MINUTES (${cycleMinutes}), or a cycle can be instant`,
    )
  }

  return {
    db: loadDbConfig(env),
    agentlensBaseUrl: env.AGENTLENS_BASE_URL || 'https://api.agentlenshq.com',
    llm: {
      baseUrl: env.LLM_BASE_URL || 'http://localhost:20128/v1',
      apiKey: env.LLM_API_KEY || null,
      model,
      timeoutMs: positiveInt(env, 'LLM_TIMEOUT_MS', 120_000),
    },
    cycleMinutes,
    cycleJitterMinutes,
    dailyCap,
    quota,
    projectCooldownDays: nonNegativeInt(env, 'PROJECT_COOLDOWN_DAYS', 7),
    projectMinVelocityPerDay: nonNegativeInt(
      env,
      'PROJECT_MIN_VELOCITY_PER_DAY',
      20,
    ),
    timezone: env.TIMEZONE || 'Asia/Shanghai',
    maxRounds: positiveInt(env, 'MAX_ROUNDS', 3),
    bannedPhrasesFile: env.BANNED_PHRASES_FILE || './banned-phrases.json',
    mediaDir: env.MEDIA_DIR || './media',
    mediaRetentionDays: nonNegativeInt(env, 'MEDIA_RETENTION_DAYS', 7),
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL || null,
  }
}
```

- [ ] **Step 7: Run it to confirm it passes**

Run: `pnpm --filter tweet-generator test`
Expected: PASS — 7 tests.

- [ ] **Step 8: Write the env example**

Create `tweet-generator/.env.example`:

```
# Database Configuration
DB_USER=app_user
DB_HOST=localhost
DB_NAME=multi_tab_listening
DB_PASSWORD=defaultpassword123
DB_PORT=5432

# AgentLens. /blogs and /projects are public and need no key.
AGENTLENS_BASE_URL=https://api.agentlenshq.com

# LLM. OpenAI-compatible; OmniRoute by default.
#
# LLM_MODEL is REQUIRED and must name one model. "auto" is rejected: it falls
# back across four provider tiers, so the same prompt is served by a frontier
# model one day and a free tier-4 model the next. These posts go out
# unattended under a personal brand.
#
# Prompt compression (RTK / Caveman) must be DISABLED on this route. The
# prompts carry a banned-phrase list and a hard character budget — material
# whose exact wording is the point.
LLM_BASE_URL=http://localhost:20128/v1
LLM_API_KEY=
LLM_MODEL=
LLM_TIMEOUT_MS=120000

# Cycle. Jitter must be smaller than the cycle length. Exact spacing is
# itself a machine signature.
CYCLE_MINUTES=120
CYCLE_JITTER_MINUTES=25

# Daily quota per source. The total must not exceed DAILY_CAP.
DAILY_CAP=10
QUOTA_LAB=4
QUOTA_PROJECT=3
QUOTA_DIGEST=1
QUOTA_HN=1
QUOTA_YOUTUBE=1

# Selection. A project reposts only after crossing a star bucket, and never
# within the cooldown, and never while its momentum is below the floor.
PROJECT_COOLDOWN_DAYS=7
PROJECT_MIN_VELOCITY_PER_DAY=20

# Every day boundary and the 09:00 x_digest anchor use this zone.
TIMEZONE=Asia/Shanghai

# Generation pipeline
MAX_ROUNDS=3
BANNED_PHRASES_FILE=./banned-phrases.json

# Card images
MEDIA_DIR=./media
MEDIA_RETENTION_DAYS=7

# Alerts reuse the workspace Discord webhook
DISCORD_WEBHOOK_URL=

# Logging Level (error, warn, info, debug)
LOG_LEVEL=info
```

- [ ] **Step 9: Commit**

```bash
git add pnpm-workspace.yaml tweet-generator pnpm-lock.yaml
git commit -m "feat(tweet-generator): scaffold the package and its configuration

LLM_MODEL is required and rejects 'auto': OmniRoute falls back across
provider tiers, and unattended posts inherit the router's quality floor."
```

---

### Task 4: The AgentLens HTTP client

This module knows the wire shapes and nothing else. Normalisation is Task 5's job, so that a change to the API surface touches exactly one file.

`/query` is deliberately not implemented: its quota is 100 calls per 30 days, which cannot sustain a service on a two-hour cycle.

**Files:**
- Create: `tweet-generator/src/sources/agentlens.ts`
- Create: `tweet-generator/src/sources/agentlens.fixtures.ts`
- Create: `tweet-generator/src/sources/agentlens.test.ts`

**Interfaces:**
- Consumes: `SourceKind` from `../config.js`.
- Produces:
  - `class AgentLensClient { constructor(baseUrl: string, fetchImpl?: typeof fetch); listBlogs(jobType: SourceKind, limit?: number): Promise<BlogListItem[]>; getBlog(id: string): Promise<BlogDetail>; listProjects(limit?: number): Promise<ProjectListItem[]>; getProject(id: string): Promise<ProjectDetail> }`
  - `interface BlogListItem { id, title, summary, job_type, source_id, occurred_at, generated_at }`
  - `interface BlogDetail extends BlogListItem { body_markdown, references }`
  - `interface ProjectListItem { id, full_name, description, summary, language, topics, tags, license, stars, forks, star_velocity_7d, star_velocity_per_day, momentum_score, pushed_at }`
  - `interface ProjectDetail extends ProjectListItem { explainer_md, html_url }`
  - `class AgentLensError extends Error`

- [ ] **Step 1: Write the fixtures**

Create `tweet-generator/src/sources/agentlens.fixtures.ts`. These are trimmed captures of real responses taken on 2026-08-05:

```ts
/**
 * Captured responses, trimmed. Replaying real payloads is the only way to
 * catch a field this service reads that the API stopped sending.
 */
export const blogListResponse = {
  items: [
    {
      id: '33fd0db1-0a72-49c7-ad0a-0dd751658872',
      title: 'OpenAI Third-Party Cyber Evaluations Security Incidents',
      summary:
        'OpenAI has reported two security incidents where models accessed ' +
        'the public internet during third-party cyber evaluations.',
      period_label: null,
      job_type: 'lab_article',
      source_id: 'lab:openai',
      model: 'gemma-4-31b-it',
      occurred_at: '2026-08-04T19:00:00.000Z',
      generated_at: '2026-08-04T23:07:26.230Z',
      signal: null,
    },
    {
      id: '96753d8e-aea0-4977-b677-6ba4098850bc',
      title: "LFM2.5-2.6B release notes / what's new",
      summary:
        'Liquid AI has released LFM2.5-2.6B, a small model for on-device ' +
        'agents with best-in-class tool use.',
      period_label: null,
      job_type: 'lab_article',
      source_id: 'lab:huggingface',
      model: 'gemma-4-31b-it',
      occurred_at: '2026-08-04T13:58:29.000Z',
      generated_at: '2026-08-04T15:08:19.286Z',
      signal: null,
    },
  ],
  total: 2187,
  offset: 0,
  limit: 20,
}

export const blogDetailResponse = {
  ...blogListResponse.items[1],
  body_markdown:
    '## What happened\n\nLiquid AI released LFM2.5-2.6B, a 2.6B-parameter ' +
    'model targeting on-device agents.\n',
  references: [
    {
      type: 'repo',
      identifier: 'LiquidAI/LFM2.5',
      title: 'LiquidAI/LFM2.5',
      url: 'https://github.com/LiquidAI/LFM2.5',
    },
  ],
  translation_status: 'ready',
}

export const digestListResponse = {
  items: [
    {
      id: 'f3f0f8e8-f847-4ce9-bc08-9e4070f15b9d',
      title:
        'AI & Frontier Tech Roundup – Model Scaling, Agent Routers, and ' +
        'Real-World Robotics',
      summary:
        'Recent posts highlight a surge in open-source LLM scaling and ' +
        'intelligent model routing for coding agents.',
      period_label: null,
      job_type: 'x_digest',
      source_id: 'x:search',
      model: 'openai/gpt-oss-120b',
      occurred_at: null,
      generated_at: '2026-08-05T01:05:46.079Z',
      signal: null,
    },
    {
      id: '19130822-9aca-46b7-b394-17c82e3eb4c6',
      title:
        'AI × Crypto Roundup: Agent Payments, Decentralized Compute, and ' +
        'Verifiable AI',
      summary:
        'AI agents are now paying for services and accessing decentralized ' +
        'GPU compute.',
      period_label: null,
      job_type: 'x_digest',
      source_id: 'x:search',
      model: 'openai/gpt-oss-120b',
      occurred_at: null,
      generated_at: '2026-08-05T01:05:15.606Z',
      signal: null,
    },
  ],
  total: 62,
  offset: 0,
  limit: 20,
}

export const projectListResponse = {
  items: [
    {
      id: 'ghp:diegosouzapw/OmniRoute',
      full_name: 'diegosouzapw/OmniRoute',
      description:
        'Free MIT AI gateway: one endpoint, 290+ providers, 500+ models.',
      summary:
        'An AI gateway that aggregates hundreds of providers into a single ' +
        'OpenAI-compatible endpoint with automatic fallback.',
      language: 'TypeScript',
      topics: ['ai-gateway', 'llm-gateway', 'openai-proxy'],
      domain: 'infra_tooling',
      tags: ['inference_engine', 'llm_app'],
      license: 'MIT',
      stars: 18420,
      forks: 1204,
      star_velocity_7d: 3100,
      star_velocity_per_day: 442.9,
      momentum_score: 3100,
      featured: true,
      pushed_at: '2026-08-05T02:45:03.000Z',
    },
  ],
  total: 340,
  offset: 0,
  limit: 24,
}

export const projectDetailResponse = {
  ...projectListResponse.items[0],
  explainer_md:
    '## What it is\n\nOne local endpoint that fans out to 290 providers.\n',
  html_url: 'https://github.com/diegosouzapw/OmniRoute',
  dispatch_blog_id: null,
  sparkline: [
    { captured_at: '2026-07-01T00:00:00.000Z', stars: 9800 },
    { captured_at: '2026-08-05T00:00:00.000Z', stars: 18420 },
  ],
}
```

- [ ] **Step 2: Write the failing test**

Create `tweet-generator/src/sources/agentlens.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { AgentLensClient, AgentLensError } from './agentlens.js'
import {
  blogDetailResponse,
  blogListResponse,
  projectDetailResponse,
  projectListResponse,
} from './agentlens.fixtures.js'

function stubFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
}

const BASE = 'https://api.example.test'

describe('AgentLensClient', () => {
  it('requests blogs filtered by job type', async () => {
    const fetchImpl = stubFetch(blogListResponse)
    const client = new AgentLensClient(BASE, fetchImpl as never)

    const items = await client.listBlogs('lab_article', 50)

    const url = new URL(fetchImpl.mock.calls[0]![0] as string)
    expect(url.pathname).toBe('/blogs')
    expect(url.searchParams.get('job_type')).toBe('lab_article')
    expect(url.searchParams.get('limit')).toBe('50')
    expect(items).toHaveLength(2)
    expect(items[0]!.id).toBe('33fd0db1-0a72-49c7-ad0a-0dd751658872')
  })

  it('clamps the limit to the API maximum of 100', async () => {
    const fetchImpl = stubFetch(blogListResponse)
    const client = new AgentLensClient(BASE, fetchImpl as never)

    await client.listBlogs('hn_story', 500)

    const url = new URL(fetchImpl.mock.calls[0]![0] as string)
    expect(url.searchParams.get('limit')).toBe('100')
  })

  it('fetches a blog body', async () => {
    const fetchImpl = stubFetch(blogDetailResponse)
    const client = new AgentLensClient(BASE, fetchImpl as never)

    const blog = await client.getBlog('96753d8e-aea0-4977-b677-6ba4098850bc')

    const url = new URL(fetchImpl.mock.calls[0]![0] as string)
    expect(url.pathname).toBe('/blogs/96753d8e-aea0-4977-b677-6ba4098850bc')
    expect(blog.body_markdown).toContain('2.6B-parameter')
    expect(blog.references[0]!.url).toBe('https://github.com/LiquidAI/LFM2.5')
  })

  it('requests projects sorted by momentum', async () => {
    const fetchImpl = stubFetch(projectListResponse)
    const client = new AgentLensClient(BASE, fetchImpl as never)

    const items = await client.listProjects(24)

    const url = new URL(fetchImpl.mock.calls[0]![0] as string)
    expect(url.pathname).toBe('/projects')
    expect(url.searchParams.get('sort')).toBe('momentum')
    expect(items[0]!.star_velocity_per_day).toBe(442.9)
  })

  it('fetches a project explainer', async () => {
    const fetchImpl = stubFetch(projectDetailResponse)
    const client = new AgentLensClient(BASE, fetchImpl as never)

    const project = await client.getProject('ghp:diegosouzapw/OmniRoute')

    expect(project.explainer_md).toContain('290 providers')
    expect(project.html_url).toBe('https://github.com/diegosouzapw/OmniRoute')
  })

  it('escapes an id containing a slash', async () => {
    // Project ids look like `ghp:owner/repo`. An unescaped slash would make
    // the request hit /projects/ghp:owner/repo — a different route.
    const fetchImpl = stubFetch(projectDetailResponse)
    const client = new AgentLensClient(BASE, fetchImpl as never)

    await client.getProject('ghp:diegosouzapw/OmniRoute')

    expect(fetchImpl.mock.calls[0]![0]).toContain(
      'ghp%3Adiegosouzapw%2FOmniRoute',
    )
  })

  it('throws AgentLensError on a non-200', async () => {
    const fetchImpl = stubFetch({ error: 'not_found' }, 404)
    const client = new AgentLensClient(BASE, fetchImpl as never)

    await expect(client.getBlog('nope')).rejects.toThrow(AgentLensError)
  })

  it('throws AgentLensError when the transport fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const client = new AgentLensClient(BASE, fetchImpl as never)

    await expect(client.listBlogs('lab_article')).rejects.toThrow(
      AgentLensError,
    )
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm --filter tweet-generator test agentlens`
Expected: FAIL — `Cannot find module './agentlens.js'`

- [ ] **Step 4: Write the client**

Create `tweet-generator/src/sources/agentlens.ts`:

```ts
import type { SourceKind } from '../config.js'

/**
 * Any failure reaching AgentLens. The service loop treats all of them the
 * same way — skip the cycle, write nothing, try again in two hours — so one
 * class is enough.
 */
export class AgentLensError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AgentLensError'
  }
}

export interface BlogListItem {
  id: string
  title: string
  summary: string
  job_type: SourceKind
  source_id: string
  occurred_at: string | null
  generated_at: string
}

export interface BlogReference {
  type: string
  title: string
  url?: string
  html_url?: string
}

export interface BlogDetail extends BlogListItem {
  body_markdown: string
  references: BlogReference[]
}

export interface ProjectListItem {
  id: string
  full_name: string
  description: string | null
  summary: string
  language: string | null
  topics: string[]
  tags: string[]
  license: string | null
  stars: number
  forks: number
  star_velocity_7d: number
  star_velocity_per_day: number
  momentum_score: number
  pushed_at: string
}

export interface ProjectDetail extends ProjectListItem {
  explainer_md: string
  html_url: string
}

interface Listing<T> {
  items: T[]
  total: number
}

/** The API clamps `limit` here itself; sending more just wastes the round trip. */
const MAX_LIMIT = 100

export class AgentLensClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, this.baseUrl)
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }

    let response: Response
    try {
      response = await this.fetchImpl(url.toString(), {
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new AgentLensError(`GET ${url.pathname} failed`, { cause })
    }

    if (!response.ok) {
      throw new AgentLensError(
        `GET ${url.pathname} returned ${response.status}`,
      )
    }

    return (await response.json()) as T
  }

  async listBlogs(jobType: SourceKind, limit = 100): Promise<BlogListItem[]> {
    const listing = await this.get<Listing<BlogListItem>>('/blogs', {
      job_type: jobType,
      limit: String(Math.min(limit, MAX_LIMIT)),
    })
    return listing.items
  }

  async getBlog(id: string): Promise<BlogDetail> {
    return this.get<BlogDetail>(`/blogs/${encodeURIComponent(id)}`)
  }

  async listProjects(limit = 100): Promise<ProjectListItem[]> {
    const listing = await this.get<Listing<ProjectListItem>>('/projects', {
      sort: 'momentum',
      limit: String(Math.min(limit, MAX_LIMIT)),
    })
    return listing.items
  }

  async getProject(id: string): Promise<ProjectDetail> {
    return this.get<ProjectDetail>(`/projects/${encodeURIComponent(id)}`)
  }
}
```

- [ ] **Step 5: Run it to confirm it passes**

Run: `pnpm --filter tweet-generator test agentlens`
Expected: PASS — 8 tests.

- [ ] **Step 6: Verify against the live API once**

Run:
```bash
curl -s "https://api.agentlenshq.com/blogs?limit=2&job_type=lab_article" | head -c 400
curl -s "https://api.agentlenshq.com/projects?limit=1&sort=momentum" | head -c 400
```
Expected: JSON containing the fields the interfaces above declare. If a field is missing, the fixture is stale — update both the fixture and the interface before continuing.

- [ ] **Step 7: Commit**

```bash
git add tweet-generator/src/sources
git commit -m "feat(tweet-generator): add the AgentLens API client

Wire shapes live here and nowhere else, so an API change touches one file.
/query is not implemented: 100 calls per 30 days cannot sustain a service
running every two hours."
```

---

### Task 5: Normalise five sources into one `Candidate`

Everything downstream sees only `Candidate`. `facts[]` is the anti-hallucination whitelist and is **pre-formatted here as strings the model is told to quote verbatim** — formatting in code sidesteps having to check `31420` against `31.4k` against `31k` later.

**Files:**
- Create: `tweet-generator/src/sources/candidates.ts`
- Create: `tweet-generator/src/sources/candidates.test.ts`

**Interfaces:**
- Consumes: `BlogDetail`, `ProjectDetail`, `ProjectListItem` from `./agentlens.js`; `SourceKind` from `../config.js`.
- Produces:
  - `interface Candidate { kind: SourceKind; externalId: string; title: string; summary: string; body: string; facts: string[]; sourceUrl: string | null; freshness: Date; dedupeKey: string }`
  - `blogToCandidate(blog: BlogDetail): Candidate`
  - `projectToCandidate(project: ProjectDetail): Candidate`
  - `formatCount(n: number): string`

- [ ] **Step 1: Write the failing test**

Create `tweet-generator/src/sources/candidates.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  blogToCandidate,
  formatCount,
  projectToCandidate,
} from './candidates.js'
import {
  blogDetailResponse,
  projectDetailResponse,
} from './agentlens.fixtures.js'
import type { BlogDetail, ProjectDetail } from './agentlens.js'

const blog = blogDetailResponse as unknown as BlogDetail
const project = projectDetailResponse as unknown as ProjectDetail

describe('formatCount', () => {
  it('leaves small numbers alone', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
  })

  it('abbreviates thousands to one decimal', () => {
    expect(formatCount(1000)).toBe('1.0k')
    expect(formatCount(18420)).toBe('18.4k')
  })

  it('drops the decimal past 100k, where it is noise', () => {
    expect(formatCount(142000)).toBe('142k')
  })
})

describe('blogToCandidate', () => {
  it('carries the identity and the body across', () => {
    const candidate = blogToCandidate(blog)

    expect(candidate.kind).toBe('lab_article')
    expect(candidate.externalId).toBe('96753d8e-aea0-4977-b677-6ba4098850bc')
    expect(candidate.title).toBe("LFM2.5-2.6B release notes / what's new")
    expect(candidate.body).toContain('2.6B-parameter')
    expect(candidate.freshness).toEqual(new Date('2026-08-04T15:08:19.286Z'))
  })

  it('builds a permanent dedupe key from the blog id', () => {
    expect(blogToCandidate(blog).dedupeKey).toBe(
      'agentlens:blog:96753d8e-aea0-4977-b677-6ba4098850bc',
    )
  })

  it('prefers html_url over url for the source link', () => {
    const withBoth: BlogDetail = {
      ...blog,
      references: [
        {
          type: 'hn_story',
          title: 'x',
          url: 'https://example.test/plain',
          html_url: 'https://example.test/discussion',
        },
      ],
    }
    expect(blogToCandidate(withBoth).sourceUrl).toBe(
      'https://example.test/discussion',
    )
  })

  it('leaves the source link null when there are no references', () => {
    expect(blogToCandidate({ ...blog, references: [] }).sourceUrl).toBeNull()
  })
})

describe('projectToCandidate', () => {
  it('formats every hard metric as a quotable string', () => {
    const candidate = projectToCandidate(project)

    expect(candidate.facts).toContain('18.4k stars')
    expect(candidate.facts).toContain('+443 stars/day')
    expect(candidate.facts).toContain('TypeScript')
    expect(candidate.facts).toContain('MIT')
    expect(candidate.facts).toContain('diegosouzapw/OmniRoute')
  })

  it('keys on the star bucket, not on the project alone', () => {
    // A project sits on the leaderboard for weeks. A permanent key would
    // allow one post per repo, ever.
    expect(projectToCandidate(project).dedupeKey).toBe(
      'agentlens:project:ghp:diegosouzapw/OmniRoute:stars-10k',
    )
  })

  it('uses the explainer as the body and the repo as the source link', () => {
    const candidate = projectToCandidate(project)
    expect(candidate.body).toContain('290 providers')
    expect(candidate.sourceUrl).toBe(
      'https://github.com/diegosouzapw/OmniRoute',
    )
  })

  it('omits a missing language and licence rather than emitting "null"', () => {
    const bare: ProjectDetail = { ...project, language: null, license: null }
    const facts = projectToCandidate(bare).facts
    expect(facts.some((f) => f.includes('null'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter tweet-generator test candidates`
Expected: FAIL — `Cannot find module './candidates.js'`

- [ ] **Step 3: Write the normaliser**

Create `tweet-generator/src/sources/candidates.ts`:

```ts
import type { SourceKind } from '../config.js'
import type { BlogDetail, ProjectDetail } from './agentlens.js'
import { starBucket } from '../select/dedupe.js'

/**
 * The one shape everything downstream sees. Five sources with five different
 * payloads converge here, so selection, generation, and rendering each know
 * about exactly one type.
 */
export interface Candidate {
  kind: SourceKind
  externalId: string
  title: string
  summary: string
  /** `body_markdown` for blogs, `explainer_md` for projects. */
  body: string
  /**
   * Hard metrics, pre-formatted as strings the model is told to quote
   * verbatim. Formatting here rather than in the prompt is what lets the
   * validator do an exact substring check instead of trying to decide
   * whether "31k" is a faithful rendering of 31420.
   */
  facts: string[]
  /** Goes on the card image only. No tweet body ever carries a URL. */
  sourceUrl: string | null
  freshness: Date
  dedupeKey: string
}

/** `18420` → `18.4k`. Past 100k the decimal is noise, so it is dropped. */
export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

export function blogToCandidate(blog: BlogDetail): Candidate {
  const reference = blog.references[0]
  return {
    kind: blog.job_type,
    externalId: blog.id,
    title: blog.title,
    summary: blog.summary,
    body: blog.body_markdown,
    // Dispatches carry no structured metrics, so the whitelist is empty and
    // the validator falls back to the title, summary, and body — which is
    // the correct scope anyway: the check exists to catch invented numbers,
    // not quoted ones.
    facts: [],
    sourceUrl: reference?.html_url ?? reference?.url ?? null,
    freshness: new Date(blog.generated_at),
    dedupeKey: `agentlens:blog:${blog.id}`,
  }
}

export function projectToCandidate(project: ProjectDetail): Candidate {
  const facts = [
    project.full_name,
    `${formatCount(project.stars)} stars`,
    `+${Math.round(project.star_velocity_per_day)} stars/day`,
    `${formatCount(project.forks)} forks`,
  ]
  if (project.language) facts.push(project.language)
  if (project.license) facts.push(project.license)

  return {
    kind: 'gh_project',
    externalId: project.id,
    title: project.full_name,
    summary: project.summary,
    body: project.explainer_md,
    facts,
    sourceUrl: project.html_url,
    freshness: new Date(project.pushed_at),
    dedupeKey: `agentlens:project:${project.id}:${starBucket(project.stars)}`,
  }
}
```

- [ ] **Step 4: Run it and watch it fail on the missing import**

Run: `pnpm --filter tweet-generator test candidates`
Expected: FAIL — `Cannot find module '../select/dedupe.js'`. That module is Task 6; the failure is expected and resolved there.

- [ ] **Step 5: Commit the module without running its tests green yet**

Deferring is deliberate: `starBucket` belongs with the rest of the dedupe rules, and duplicating it here to make one task self-contained would leave two definitions of a bucket boundary.

```bash
git add tweet-generator/src/sources/candidates.ts tweet-generator/src/sources/candidates.test.ts
git commit -m "feat(tweet-generator): normalise five sources into one Candidate

facts[] is pre-formatted here so the validator can do exact substring
checks rather than deciding whether '31k' faithfully renders 31420."
```

---

### Task 6: Dedupe rules, freshness windows, and the topic gate

Three small pure modules that decide what is even eligible. This is where the silent bugs live, so the tests are the point of the task.

**Files:**
- Create: `tweet-generator/src/select/dedupe.ts`, `tweet-generator/src/select/dedupe.test.ts`
- Create: `tweet-generator/src/select/windows.ts`, `tweet-generator/src/select/windows.test.ts`
- Create: `tweet-generator/src/select/niche.ts`, `tweet-generator/src/select/niche.test.ts`

**Interfaces:**
- Consumes: `SourceKind` from `../config.js`.
- Produces:
  - `starBucket(stars: number): string`
  - `windowStart(kind: SourceKind, now: Date): Date`
  - `WINDOW_HOURS: Record<SourceKind, number>`
  - `passesNicheGate(text: string): boolean`
  - `nicheRejectionReason(text: string): string | null`

- [ ] **Step 1: Write the failing dedupe test**

Create `tweet-generator/src/select/dedupe.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { starBucket } from './dedupe.js'

describe('starBucket', () => {
  it('names the largest bucket at or below the count', () => {
    expect(starBucket(1500)).toBe('stars-1k')
    expect(starBucket(18420)).toBe('stars-10k')
    expect(starBucket(31420)).toBe('stars-30k')
  })

  it('treats a boundary as being in the bucket it names', () => {
    expect(starBucket(1000)).toBe('stars-1k')
    expect(starBucket(2000)).toBe('stars-2k')
    expect(starBucket(100_000)).toBe('stars-100k')
  })

  it('buckets everything below the first boundary together', () => {
    // Nothing under 1k should ever reach here — the momentum floor and the
    // leaderboard both exclude it — but a shared bucket is the safe answer,
    // because an undefined bucket would produce a dedupe key of "undefined"
    // and collapse every such project onto one row.
    expect(starBucket(0)).toBe('stars-0')
    expect(starBucket(999)).toBe('stars-0')
  })

  it('keeps growing past the last named boundary', () => {
    expect(starBucket(250_000)).toBe('stars-200k')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter tweet-generator test dedupe`
Expected: FAIL — `Cannot find module './dedupe.js'`

- [ ] **Step 3: Write the dedupe rules**

Create `tweet-generator/src/select/dedupe.ts`:

```ts
/**
 * Star-count boundaries a project must cross before it may be posted again.
 *
 * A project is a long-lived entity — a repo sits on the leaderboard for
 * weeks — so a permanent dedupe key would allow one post per repo, ever.
 * Bucketing makes a repost require something new to say, rather than an
 * arbitrary timer expiring.
 */
const BUCKETS = [
  1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 50_000, 100_000, 200_000,
  500_000,
] as const

/** `18420` → `stars-10k`. Used as the last segment of a project dedupe key. */
export function starBucket(stars: number): string {
  let bucket = 0
  for (const boundary of BUCKETS) {
    if (stars >= boundary) bucket = boundary
  }
  if (bucket === 0) return 'stars-0'
  return `stars-${bucket / 1000}k`
}
```

- [ ] **Step 4: Run both dedupe and candidates tests**

Run: `pnpm --filter tweet-generator test`
Expected: PASS — the `candidates` suite from Task 5 now resolves its import and goes green alongside `dedupe`.

- [ ] **Step 5: Write the failing windows test**

Create `tweet-generator/src/select/windows.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { WINDOW_HOURS, windowStart } from './windows.js'

const now = new Date('2026-08-05T12:00:00.000Z')

describe('windowStart', () => {
  it('gives HN a day, because front-page news is stale by then', () => {
    expect(windowStart('hn_story', now)).toEqual(
      new Date('2026-08-04T12:00:00.000Z'),
    )
  })

  it('gives lab articles three days', () => {
    expect(windowStart('lab_article', now)).toEqual(
      new Date('2026-08-02T12:00:00.000Z'),
    )
  })

  it('gives YouTube a week', () => {
    // Supply is bursty — zero one day, eleven the next — and a deep-dive
    // keeps for a week. A 24h window would leave the pool empty most days.
    expect(windowStart('youtube_video', now)).toEqual(
      new Date('2026-07-29T12:00:00.000Z'),
    )
  })

  it('has a window for every source kind', () => {
    expect(Object.keys(WINDOW_HOURS).sort()).toEqual([
      'gh_project',
      'hn_story',
      'lab_article',
      'x_digest',
      'youtube_video',
    ])
  })
})
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `pnpm --filter tweet-generator test windows`
Expected: FAIL — `Cannot find module './windows.js'`

- [ ] **Step 7: Write the windows**

Create `tweet-generator/src/select/windows.ts`:

```ts
import type { SourceKind } from '../config.js'

/**
 * How far back each source's pool reaches.
 *
 * Set by how fast the content goes stale, not by how much of it there is.
 * Front-page news is worthless the next day; a video explaining inference
 * optimisation is fine a week later. Measured supply on 2026-08-05, per 24h:
 * hn_story 68, gh_project 88, lab_article 4, x_digest 2, youtube_video 0.
 *
 * gh_project's window is generous but unused in practice: the leaderboard is
 * always populated, and eligibility there is decided by the star bucket, the
 * cooldown, and the momentum floor instead.
 */
export const WINDOW_HOURS: Record<SourceKind, number> = {
  x_digest: 24,
  hn_story: 24,
  lab_article: 72,
  youtube_video: 168,
  gh_project: 168,
}

const MS_PER_HOUR = 3_600_000

export function windowStart(kind: SourceKind, now: Date): Date {
  return new Date(now.getTime() - WINDOW_HOURS[kind] * MS_PER_HOUR)
}
```

- [ ] **Step 8: Write the failing niche-gate test**

Create `tweet-generator/src/select/niche.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { nicheRejectionReason, passesNicheGate } from './niche.js'

describe('passesNicheGate', () => {
  it('rejects the crypto digest', () => {
    expect(
      passesNicheGate(
        'AI × Crypto Roundup: Agent Payments, Decentralized Compute',
      ),
    ).toBe(false)
  })

  it('keeps the frontier tech digest', () => {
    expect(
      passesNicheGate(
        'AI & Frontier Tech Roundup – Model Scaling, Agent Routers',
      ),
    ).toBe(true)
  })

  it('rejects web3 and blockchain material', () => {
    expect(passesNicheGate('A web3 identity layer for agents')).toBe(false)
    expect(passesNicheGate('Blockchain-verified inference')).toBe(false)
  })

  it('rejects funding news', () => {
    expect(passesNicheGate('Anthropic raises $5B at a new valuation')).toBe(
      false,
    )
    expect(passesNicheGate('Nvidia acquires an inference startup')).toBe(false)
  })

  it('keeps token vocabulary, which is core to this niche', () => {
    // A bare \btoken rule rejects most of the material this account exists
    // to post. The crypto sense is matched by specific phrases instead.
    expect(passesNicheGate('2M tokens of context on a single GPU')).toBe(true)
    expect(passesNicheGate('A faster tokenizer for Llama models')).toBe(true)
    expect(passesNicheGate('Throughput hits 4200 tokens/sec')).toBe(true)
    expect(passesNicheGate('Cutting the token budget by 40%')).toBe(true)
  })

  it('still rejects the crypto sense of token', () => {
    expect(passesNicheGate('Tokenomics for autonomous agents')).toBe(false)
    expect(passesNicheGate('The token sale opens Monday')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(passesNicheGate('CRYPTO agents')).toBe(false)
  })
})

describe('nicheRejectionReason', () => {
  it('names the rule that fired, for the log', () => {
    expect(nicheRejectionReason('AI × Crypto Roundup')).toBe('crypto')
    expect(nicheRejectionReason('Anthropic raises $5B')).toBe('business')
    expect(nicheRejectionReason('2M tokens of context')).toBeNull()
  })
}) 
```

- [ ] **Step 9: Run it to confirm it fails**

Run: `pnpm --filter tweet-generator test niche`
Expected: FAIL — `Cannot find module './niche.js'`

- [ ] **Step 10: Write the niche gate**

Create `tweet-generator/src/select/niche.ts`:

```ts
/**
 * The five sources together are a firehose, not a niche. This narrows them
 * to what an AI developer can act on, and it runs before anything else so
 * that filtered material never costs an LLM call.
 *
 * Matched against `title + summary`.
 */
const RULES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    name: 'crypto',
    pattern: /crypto|web3|blockchain|on-chain|\bNFT\b|DePIN|airdrop/i,
  },
  {
    // `token` is deliberately NOT a deny term on its own. `tokens/sec`,
    // `tokenizer`, and `2M tokens of context` are core vocabulary here, and
    // a bare \btoken rule rejects most of the material this account exists
    // to post. The crypto sense needs these specific phrases — and the
    // crypto rule above already catches the AI × Crypto digests unaided.
    name: 'crypto',
    pattern: /\btokenomics\b|\btoken (sale|price|holders)\b/i,
  },
  {
    name: 'business',
    pattern: /\bfunding\b|raises \$|\bvaluation\b|\bacquires\b|\bIPO\b/i,
  },
]

/** The rule that rejected this text, or null if it passed. */
export function nicheRejectionReason(text: string): string | null {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.name
  }
  return null
}

export function passesNicheGate(text: string): boolean {
  return nicheRejectionReason(text) === null
}
```

- [ ] **Step 11: Run the whole package suite**

Run: `pnpm --filter tweet-generator test`
Expected: PASS — config, agentlens, candidates, dedupe, windows, and niche all green.

- [ ] **Step 12: Commit**

```bash
git add tweet-generator/src/select
git commit -m "feat(tweet-generator): add dedupe buckets, windows, and the niche gate

Windows are set by how fast content goes stale, not by how much there is:
youtube_video published zero items in 24h and eleven in 48h, so a day-long
window would leave its pool empty most days.

'token' is not a deny term. tokens/sec, tokenizer, and '2M tokens of
context' are the vocabulary this account exists to use."
```

---

### Task 7: Timezone clock and the quota picker

Every day boundary in this service is a `TIMEZONE` boundary, not the host's. Getting that wrong is the classic silent scheduling bug: it works on the developer's machine and quietly shifts the whole day on a server in another zone.

The picker returns an **ordered list** rather than a single kind. Fallback then costs nothing — the caller walks the list and takes the first kind with a non-empty pool.

**Files:**
- Create: `tweet-generator/src/select/clock.ts`, `tweet-generator/src/select/clock.test.ts`
- Create: `tweet-generator/src/select/quota.ts`, `tweet-generator/src/select/quota.test.ts`

**Interfaces:**
- Consumes: `SourceKind`, `SOURCE_PRIORITY`, `Quota`, `GeneratorConfig` from `../config.js`.
- Produces:
  - `startOfDayIn(timezone: string, at: Date): Date`
  - `minutesIntoDayIn(timezone: string, at: Date): number`
  - `interface QuotaUsage { used: Record<SourceKind, number>; total: number }`
  - `orderKinds(now: Date, usage: QuotaUsage, config: GeneratorConfig): SourceKind[]`
  - `DIGEST_ANCHOR_MINUTE: number`

- [ ] **Step 1: Write the failing clock test**

Create `tweet-generator/src/select/clock.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { minutesIntoDayIn, startOfDayIn } from './clock.js'

describe('startOfDayIn', () => {
  it('returns the instant of local midnight, not host midnight', () => {
    // 2026-08-05T01:05Z is 09:05 in Shanghai, so the day began at
    // 2026-08-04T16:00Z.
    expect(
      startOfDayIn('Asia/Shanghai', new Date('2026-08-05T01:05:00.000Z')),
    ).toEqual(new Date('2026-08-04T16:00:00.000Z'))
  })

  it('rolls over at local midnight, not at UTC midnight', () => {
    // 2026-08-04T23:00Z is already 07:00 on the 5th in Shanghai.
    expect(
      startOfDayIn('Asia/Shanghai', new Date('2026-08-04T23:00:00.000Z')),
    ).toEqual(new Date('2026-08-04T16:00:00.000Z'))
  })

  it('handles UTC', () => {
    expect(startOfDayIn('UTC', new Date('2026-08-05T13:45:00.000Z'))).toEqual(
      new Date('2026-08-05T00:00:00.000Z'),
    )
  })

  it('handles a zone that observes DST', () => {
    // New York is UTC-4 in August.
    expect(
      startOfDayIn('America/New_York', new Date('2026-08-05T12:00:00.000Z')),
    ).toEqual(new Date('2026-08-05T04:00:00.000Z'))
  })
})

describe('minutesIntoDayIn', () => {
  it('reads the local wall clock', () => {
    expect(
      minutesIntoDayIn('Asia/Shanghai', new Date('2026-08-05T01:05:00.000Z')),
    ).toBe(9 * 60 + 5)
  })

  it('reports midnight as zero', () => {
    expect(
      minutesIntoDayIn('Asia/Shanghai', new Date('2026-08-04T16:00:00.000Z')),
    ).toBe(0)
  })

  it('reports 23:59 as the last minute of the day', () => {
    expect(
      minutesIntoDayIn('Asia/Shanghai', new Date('2026-08-05T15:59:00.000Z')),
    ).toBe(23 * 60 + 59)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter tweet-generator test clock`
Expected: FAIL — `Cannot find module './clock.js'`

- [ ] **Step 3: Write the clock**

Create `tweet-generator/src/select/clock.ts`:

```ts
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

  // `hour12: false` renders midnight as 24 in some ICU versions.
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  }
}

/** How far the zone is ahead of UTC at this instant, in milliseconds. */
function offsetMsAt(timezone: string, at: Date): number {
  const w = wallClockIn(timezone, at)
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  // Second precision is all `formatToParts` gives, so round `at` to match.
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000
}

export function startOfDayIn(timezone: string, at: Date): Date {
  const w = wallClockIn(timezone, at)
  const localMidnightAsUtc = Date.UTC(w.year, w.month - 1, w.day)

  // Two passes: the offset at `at` may not be the offset at midnight if a
  // DST transition falls between them. The second pass uses the offset that
  // actually applies at the candidate instant.
  const firstPass = localMidnightAsUtc - offsetMsAt(timezone, at)
  return new Date(
    localMidnightAsUtc - offsetMsAt(timezone, new Date(firstPass)),
  )
}

export function minutesIntoDayIn(timezone: string, at: Date): number {
  const w = wallClockIn(timezone, at)
  return w.hour * 60 + w.minute
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter tweet-generator test clock`
Expected: PASS — 7 tests.

- [ ] **Step 5: Write the failing quota test**

Create `tweet-generator/src/select/quota.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { orderKinds, type QuotaUsage } from './quota.js'

const config = loadConfig({
  LLM_MODEL: 'pinned',
  TIMEZONE: 'Asia/Shanghai',
} as NodeJS.ProcessEnv)

/** Nothing posted yet today. */
const fresh: QuotaUsage = {
  used: {
    lab_article: 0,
    gh_project: 0,
    x_digest: 0,
    hn_story: 0,
    youtube_video: 0,
  },
  total: 0,
}

function usage(partial: Partial<QuotaUsage['used']>): QuotaUsage {
  const used = { ...fresh.used, ...partial }
  return {
    used,
    total: Object.values(used).reduce((sum, n) => sum + n, 0),
  }
}

/** 14:00 Shanghai — well past the digest anchor, mid-afternoon. */
const afternoon = new Date('2026-08-05T06:00:00.000Z')
/** 07:00 Shanghai — before today's digest exists. */
const earlyMorning = new Date('2026-08-04T23:00:00.000Z')

describe('orderKinds', () => {
  it('breaks an all-equal tie by priority', () => {
    expect(orderKinds(afternoon, fresh, config)[0]).toBe('lab_article')
  })

  it('interleaves rather than draining one source at a time', () => {
    // Strict priority would produce four Labs posts, then three Projects,
    // then the rest — a monotone, visibly automated timeline.
    expect(orderKinds(afternoon, usage({ lab_article: 1 }), config)[0]).toBe(
      'gh_project',
    )
    expect(
      orderKinds(afternoon, usage({ lab_article: 1, gh_project: 1 }), config)[0],
    ).toBe('x_digest')
    expect(
      orderKinds(
        afternoon,
        usage({ lab_article: 1, gh_project: 1, x_digest: 1 }),
        config,
      )[0],
    ).toBe('hn_story')
  })

  it('lists every kind with quota left, so the caller can fall through', () => {
    const order = orderKinds(afternoon, fresh, config)
    expect(order).toHaveLength(5)
    expect([...order].sort()).toEqual([
      'gh_project',
      'hn_story',
      'lab_article',
      'x_digest',
      'youtube_video',
    ])
  })

  it('drops a kind whose quota is spent', () => {
    const order = orderKinds(afternoon, usage({ x_digest: 1 }), config)
    expect(order).not.toContain('x_digest')
  })

  it('returns nothing once the daily cap is reached', () => {
    const capped = usage({ lab_article: 4, gh_project: 3, hn_story: 1 })
    // Cap is 10; quota total is also 10, so spending 8 still leaves room.
    expect(orderKinds(afternoon, capped, config).length).toBeGreaterThan(0)

    const full = usage({
      lab_article: 4,
      gh_project: 3,
      x_digest: 1,
      hn_story: 1,
      youtube_video: 1,
    })
    expect(orderKinds(afternoon, full, config)).toEqual([])
  })

  it('respects a daily cap lower than the quota total', () => {
    const tight = loadConfig({
      LLM_MODEL: 'pinned',
      DAILY_CAP: '3',
      QUOTA_LAB: '1',
      QUOTA_PROJECT: '1',
      QUOTA_DIGEST: '1',
      QUOTA_HN: '0',
      QUOTA_YOUTUBE: '0',
    } as NodeJS.ProcessEnv)

    expect(
      orderKinds(afternoon, usage({ lab_article: 1, gh_project: 1, x_digest: 1 }), tight),
    ).toEqual([])
  })

  it('gives the digest first refusal at or after 09:00 local', () => {
    // The digest lands at 09:05 Shanghai and is worthless tomorrow, so it
    // must not wait for the ratio picker to reach it in the afternoon.
    const nineOClock = new Date('2026-08-05T01:00:00.000Z')
    expect(orderKinds(nineOClock, fresh, config)[0]).toBe('x_digest')
  })

  it('keeps the anchor until the digest is actually used', () => {
    const noon = new Date('2026-08-05T04:00:00.000Z')
    expect(orderKinds(noon, usage({ lab_article: 2 }), config)[0]).toBe(
      'x_digest',
    )
    expect(
      orderKinds(noon, usage({ lab_article: 2, x_digest: 1 }), config)[0],
    ).not.toBe('x_digest')
  })

  it('excludes the digest before 09:00, when today\'s does not exist yet', () => {
    expect(orderKinds(earlyMorning, fresh, config)).not.toContain('x_digest')
  })

  it('leaves the rest of the order intact behind an anchored digest', () => {
    const nine = new Date('2026-08-05T01:00:00.000Z')
    expect(orderKinds(nine, fresh, config)).toEqual([
      'x_digest',
      'lab_article',
      'gh_project',
      'hn_story',
      'youtube_video',
    ])
  })
})
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `pnpm --filter tweet-generator test quota`
Expected: FAIL — `Cannot find module './quota.js'`

- [ ] **Step 7: Write the quota picker**

Create `tweet-generator/src/select/quota.ts`:

```ts
import {
  SOURCE_PRIORITY,
  type GeneratorConfig,
  type SourceKind,
} from '../config.js'
import { minutesIntoDayIn } from './clock.js'

export interface QuotaUsage {
  used: Record<SourceKind, number>
  total: number
}

/** 09:00 local. AgentLens publishes the day's digests just after this. */
export const DIGEST_ANCHOR_MINUTE = 9 * 60

/**
 * The kinds worth trying this cycle, best first.
 *
 * Returning an ordered list rather than one kind is what makes fallback
 * free: the caller walks it and takes the first kind whose pool is not
 * empty, with no separate fallback path to keep in step.
 *
 * The ordering is by remaining quota ratio, ties broken by priority. Strict
 * priority ordering would instead post four Labs items, then three Projects,
 * then the rest — a monotone, visibly automated timeline.
 */
export function orderKinds(
  now: Date,
  usage: QuotaUsage,
  config: GeneratorConfig,
): SourceKind[] {
  if (usage.total >= config.dailyCap) return []

  const minute = minutesIntoDayIn(config.timezone, now)

  const eligible = SOURCE_PRIORITY.filter((kind) => {
    const quota = config.quota[kind]
    if (quota <= 0) return false
    if (usage.used[kind] >= quota) return false
    // Today's digest does not exist before the anchor, so offering it would
    // only produce an empty pool and a wasted fallback hop.
    if (kind === 'x_digest' && minute < DIGEST_ANCHOR_MINUTE) return false
    return true
  })

  const ratio = (kind: SourceKind): number =>
    (config.quota[kind] - usage.used[kind]) / config.quota[kind]

  const ordered = [...eligible].sort((a, b) => {
    const difference = ratio(b) - ratio(a)
    if (difference !== 0) return difference
    return SOURCE_PRIORITY.indexOf(a) - SOURCE_PRIORITY.indexOf(b)
  })

  // The one time-based exception. The digest lands at 09:05 local and is
  // worthless by tomorrow, so it cannot wait for the ratio picker to reach
  // it in the afternoon.
  if (minute >= DIGEST_ANCHOR_MINUTE && ordered.includes('x_digest')) {
    return ['x_digest', ...ordered.filter((kind) => kind !== 'x_digest')]
  }

  return ordered
}
```

- [ ] **Step 8: Run it to confirm it passes**

Run: `pnpm --filter tweet-generator test`
Expected: PASS — clock and quota green alongside everything before them.

- [ ] **Step 9: Commit**

```bash
git add tweet-generator/src/select
git commit -m "feat(tweet-generator): add the timezone clock and quota picker

Day boundaries follow TIMEZONE, not the host: host-local time is correct on
a developer machine and silently shifts the whole day on a server elsewhere.

orderKinds returns a list rather than one kind, which makes fallback free —
the caller takes the first kind with a non-empty pool."
```

---

### Task 8: The store

Every SQL statement this service issues, in one file. Keeping them together is what makes it possible to see at a glance which columns the generator depends on.

**Files:**
- Create: `tweet-generator/src/store.ts`
- Create: `tweet-generator/src/store.test.ts`

**Interfaces:**
- Consumes: `Pool` from `pg`; `SourceKind` from `./config.js`; `QuotaUsage` from `./select/quota.js`; `TweetArchetype` from `shared`.
- Produces: `class GeneratorStore` with
  - `enqueue(input: EnqueueInput): Promise<number | null>`
  - `usageSince(dayStart: Date): Promise<QuotaUsage>`
  - `knownDedupeKeys(keys: string[]): Promise<Set<string>>`
  - `lastArchetype(): Promise<TweetArchetype | null>`
  - `lastEnqueuedAt(): Promise<Date | null>`
  - `projectPostedSince(sourceRef: string, since: Date): Promise<boolean>`
  - `failureCounts(externalIds: string[]): Promise<Map<string, number>>`
  - `recordFailure(externalId: string, error: string): Promise<void>`
  - `expiredMedia(before: Date): Promise<string[]>`

**Why this service owns its own INSERT.** `x-poster`'s `TweetQueue` already
has an `enqueue`, but `tweet-generator` cannot import it: the two are separate
workspace packages and `x-poster` publishes no `exports` map, so a relative
`../../x-poster/src/...` path would not resolve under `nodenext`. Adding
`x-poster` as a dependency to reach one INSERT would also make a producer
depend on its consumer. The generator writes the row; it never claims, marks,
or retries one, so it needs a single statement rather than the whole queue.

- [ ] **Step 1: Write the failing test**

Create `tweet-generator/src/store.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool } from 'shared/db'
import { GeneratorStore } from './store.js'

const pool = createPool({
  user: 'app_user',
  host: 'localhost',
  database: 'multi_tab_listening',
  password: 'defaultpassword123',
  port: 5432,
})
const store = new GeneratorStore(pool)

async function clean(): Promise<void> {
  await pool.query("DELETE FROM tweets WHERE dedupe_key LIKE 'test:%'")
  await pool.query("DELETE FROM generation_attempts WHERE external_id LIKE 'test:%'")
}

/** Simulates x-poster having posted a row, which this service never does. */
async function markPosted(dedupeKey: string): Promise<void> {
  await pool.query(
    `UPDATE tweets SET status = 'posted', posted_at = NOW()
     WHERE dedupe_key = $1`,
    [dedupeKey],
  )
}

beforeEach(clean)

afterAll(async () => {
  await clean()
  await pool.end()
})

/** Rows the usage query must see have to be inside the day it is given. */
const dayStart = new Date(Date.now() - 60 * 60 * 1000)

describe('enqueue', () => {
  it('returns the new row id', async () => {
    const id = await store.enqueue({
      content: 'hello',
      dedupeKey: 'test:e1',
      source: 'lab_article',
      sourceRef: 'abc',
      archetype: 'digest',
      mediaPath: './media/abc.png',
    })
    expect(id).not.toBeNull()
  })

  it('returns null rather than throwing on a duplicate key', async () => {
    // The UNIQUE constraint is the whole deduplication mechanism for blogs,
    // so losing this race must be ordinary control flow, not an exception.
    await store.enqueue({ content: 'a', dedupeKey: 'test:e2' })
    expect(await store.enqueue({ content: 'b', dedupeKey: 'test:e2' })).toBeNull()
  })

  it('writes a row x-poster can claim', async () => {
    await store.enqueue({ content: 'a', dedupeKey: 'test:e3' })
    const row = await pool.query(
      `SELECT status, attempts, scheduled_at FROM tweets WHERE dedupe_key = 'test:e3'`,
    )
    expect(row.rows[0].status).toBe('pending')
    expect(row.rows[0].attempts).toBe(0)
    expect(row.rows[0].scheduled_at).toBeInstanceOf(Date)
  })
})

describe('usageSince', () => {
  it('counts nothing on an empty day', async () => {
    const usage = await store.usageSince(new Date(Date.now() + 60_000))
    expect(usage.total).toBe(0)
    expect(usage.used.lab_article).toBe(0)
  })

  it('counts rows per source and in total', async () => {
    await store.enqueue({
      content: 'a',
      dedupeKey: 'test:u1',
      source: 'lab_article',
    })
    await store.enqueue({
      content: 'b',
      dedupeKey: 'test:u2',
      source: 'lab_article',
    })
    await store.enqueue({
      content: 'c',
      dedupeKey: 'test:u3',
      source: 'hn_story',
    })

    const usage = await store.usageSince(dayStart)
    expect(usage.used.lab_article).toBe(2)
    expect(usage.used.hn_story).toBe(1)
    expect(usage.used.gh_project).toBe(0)
    expect(usage.total).toBe(3)
  })

  it('counts every row regardless of status', async () => {
    // Quota is spent when the generator commits to a slot, not when x-poster
    // succeeds. Counting only 'posted' would let a failed tweet be silently
    // replaced, quietly exceeding the daily cap.
    await store.enqueue({
      content: 'a',
      dedupeKey: 'test:u4',
      source: 'lab_article',
    })
    await pool.query(
      `UPDATE tweets SET status = 'failed' WHERE dedupe_key = 'test:u4'`,
    )

    expect((await store.usageSince(dayStart)).used.lab_article).toBe(1)
  })
})

describe('knownDedupeKeys', () => {
  it('returns only the keys that already exist', async () => {
    await store.enqueue({ content: 'a', dedupeKey: 'test:k1' })

    const known = await store.knownDedupeKeys(['test:k1', 'test:k2'])
    expect(known.has('test:k1')).toBe(true)
    expect(known.has('test:k2')).toBe(false)
  })

  it('handles an empty list without issuing a query', async () => {
    expect((await store.knownDedupeKeys([])).size).toBe(0)
  })
})

describe('lastArchetype', () => {
  it('returns null when nothing has been enqueued', async () => {
    expect(await store.lastArchetype()).toBeNull()
  })

  it('returns the most recently created archetype', async () => {
    await store.enqueue({
      content: 'a',
      dedupeKey: 'test:a1',
      archetype: 'digest',
    })
    await store.enqueue({
      content: 'b',
      dedupeKey: 'test:a2',
      archetype: 'take',
    })

    expect(await store.lastArchetype()).toBe('take')
  })
})

describe('lastEnqueuedAt', () => {
  it('returns null on an empty table', async () => {
    expect(await store.lastEnqueuedAt()).toBeNull()
  })

  it('returns a recent timestamp after an enqueue', async () => {
    await store.enqueue({ content: 'a', dedupeKey: 'test:t1' })
    const at = await store.lastEnqueuedAt()
    expect(at).not.toBeNull()
    expect(Date.now() - at!.getTime()).toBeLessThan(60_000)
  })
})

describe('projectPostedSince', () => {
  it('is false when the project has never been posted', async () => {
    expect(
      await store.projectPostedSince('ghp:a/b', new Date(0)),
    ).toBe(false)
  })

  it('is true within the cooldown and false outside it', async () => {
    await store.enqueue({
      content: 'a',
      dedupeKey: 'test:p1',
      source: 'gh_project',
      sourceRef: 'test:ghp:a/b',
    })
    await markPosted('test:p1')

    expect(await store.projectPostedSince('test:ghp:a/b', dayStart)).toBe(true)
    expect(
      await store.projectPostedSince(
        'test:ghp:a/b',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(false)
  })
})

describe('failureCounts and recordFailure', () => {
  it('starts at zero and increments', async () => {
    expect((await store.failureCounts(['test:c1'])).get('test:c1')).toBeUndefined()

    await store.recordFailure('test:c1', 'validator gave up')
    await store.recordFailure('test:c1', 'validator gave up again')

    expect((await store.failureCounts(['test:c1'])).get('test:c1')).toBe(2)
  })

  it('handles an empty list', async () => {
    expect((await store.failureCounts([])).size).toBe(0)
  })
})

describe('expiredMedia', () => {
  it('returns paths for tweets posted before the cutoff', async () => {
    await store.enqueue({
      content: 'a',
      dedupeKey: 'test:m1',
      mediaPath: './media/old.png',
    })
    await markPosted('test:m1')

    expect(await store.expiredMedia(new Date(Date.now() + 60_000))).toContain(
      './media/old.png',
    )
    expect(await store.expiredMedia(dayStart)).not.toContain('./media/old.png')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter tweet-generator test store`
Expected: FAIL — `Cannot find module './store.js'`

- [ ] **Step 3: Write the store**

Create `tweet-generator/src/store.ts`:

```ts
import type { Pool } from 'pg'
import type { TweetArchetype } from 'shared'
import { SOURCE_PRIORITY, type SourceKind } from './config.js'
import type { QuotaUsage } from './select/quota.js'

function emptyUsage(): QuotaUsage['used'] {
  return {
    lab_article: 0,
    gh_project: 0,
    x_digest: 0,
    hn_story: 0,
    youtube_video: 0,
  }
}

export interface EnqueueInput {
  content: string
  dedupeKey: string
  source?: SourceKind
  sourceRef?: string
  archetype?: TweetArchetype
  mediaPath?: string
}

/**
 * Every statement this service issues. Collected here so the columns the
 * generator depends on are visible at a glance rather than scattered across
 * the modules that happen to need them.
 */
export class GeneratorStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Writes one queued tweet. Returns null when the key is already taken.
   *
   * This duplicates one statement from x-poster's TweetQueue rather than
   * importing it: the two are separate workspace packages, x-poster
   * publishes no exports map, and depending on it would make the producer
   * depend on its consumer. The generator only ever writes a row — it never
   * claims, marks, or retries one — so a single INSERT is the whole need.
   *
   * Losing the ON CONFLICT race is ordinary control flow, not an error: the
   * UNIQUE constraint is the entire deduplication mechanism for blogs.
   */
  async enqueue(input: EnqueueInput): Promise<number | null> {
    const result = await this.pool.query<{ id: number }>(
      `INSERT INTO tweets
         (content, dedupe_key, source, source_ref, archetype, media_path)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [
        input.content,
        input.dedupeKey,
        input.source ?? null,
        input.sourceRef ?? null,
        input.archetype ?? null,
        input.mediaPath ?? null,
      ],
    )
    return result.rows[0]?.id ?? null
  }

  /** The watchdog's input: when the queue last gained a row. */
  async lastEnqueuedAt(): Promise<Date | null> {
    const result = await this.pool.query<{ at: Date | null }>(
      `SELECT MAX(created_at) AS at FROM tweets`,
    )
    return result.rows[0]?.at ?? null
  }

  /**
   * Counts every row created since `dayStart`, whatever its status.
   *
   * Quota is spent when the generator commits to a slot, not when x-poster
   * succeeds: counting only 'posted' would let a failed tweet be silently
   * replaced, quietly exceeding the daily cap.
   */
  async usageSince(dayStart: Date): Promise<QuotaUsage> {
    const result = await this.pool.query<{ source: string; count: string }>(
      `SELECT source, COUNT(*) AS count
       FROM tweets
       WHERE created_at >= $1 AND source IS NOT NULL
       GROUP BY source`,
      [dayStart],
    )

    const used = emptyUsage()
    let total = 0
    for (const row of result.rows) {
      const count = Number(row.count)
      total += count
      if ((SOURCE_PRIORITY as readonly string[]).includes(row.source)) {
        used[row.source as SourceKind] = count
      }
    }
    return { used, total }
  }

  async knownDedupeKeys(keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set()
    const result = await this.pool.query<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM tweets WHERE dedupe_key = ANY($1)`,
      [keys],
    )
    return new Set(result.rows.map((row) => row.dedupe_key))
  }

  /** Backs the "never the same archetype twice in a row" rule. */
  async lastArchetype(): Promise<TweetArchetype | null> {
    const result = await this.pool.query<{ archetype: TweetArchetype | null }>(
      `SELECT archetype FROM tweets
       WHERE archetype IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    return result.rows[0]?.archetype ?? null
  }

  async projectPostedSince(sourceRef: string, since: Date): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM tweets
         WHERE source_ref = $1 AND posted_at IS NOT NULL AND posted_at >= $2
       ) AS exists`,
      [sourceRef, since],
    )
    return result.rows[0]?.exists ?? false
  }

  async failureCounts(externalIds: string[]): Promise<Map<string, number>> {
    if (externalIds.length === 0) return new Map()
    const result = await this.pool.query<{
      external_id: string
      attempts: number
    }>(
      `SELECT external_id, attempts FROM generation_attempts
       WHERE external_id = ANY($1)`,
      [externalIds],
    )
    return new Map(result.rows.map((row) => [row.external_id, row.attempts]))
  }

  async recordFailure(externalId: string, error: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO generation_attempts (external_id, attempts, last_error)
       VALUES ($1, 1, $2)
       ON CONFLICT (external_id) DO UPDATE
         SET attempts = generation_attempts.attempts + 1,
             last_error = EXCLUDED.last_error,
             updated_at = NOW()`,
      [externalId, error],
    )
  }

  async expiredMedia(before: Date): Promise<string[]> {
    const result = await this.pool.query<{ media_path: string }>(
      `SELECT media_path FROM tweets
       WHERE media_path IS NOT NULL
         AND posted_at IS NOT NULL
         AND posted_at < $1`,
      [before],
    )
    return result.rows.map((row) => row.media_path)
  }
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run:
```bash
docker compose up -d
pnpm --filter discord-monitor run setup-db
pnpm --filter tweet-generator test store
```
Expected: PASS — 17 tests.

- [ ] **Step 5: Commit**

```bash
git add tweet-generator/src/store.ts tweet-generator/src/store.test.ts
git commit -m "feat(tweet-generator): add the store

usageSince counts every row regardless of status: quota is spent when the
generator commits to a slot, not when x-poster succeeds. Counting only
'posted' would let a failed tweet be silently replaced and quietly exceed
the daily cap.

The INSERT is duplicated from x-poster's TweetQueue rather than imported.
The two are separate workspace packages, x-poster publishes no exports map,
and depending on it would make the producer depend on its consumer — for a
service that only ever writes a row."
```

---

### Task 9: Candidate selection and the service loop

End of Phase 1. After this task the service runs, picks correctly, paces correctly, and enqueues real rows — with the tweet body being the dispatch title. That placeholder is what makes the scheduling and deduplication observable before any LLM is involved.

**Files:**
- Create: `tweet-generator/src/select/pool.ts`, `tweet-generator/src/select/pool.test.ts`
- Create: `tweet-generator/src/index.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 3–8.
- Produces: `buildPool(kind, now, deps): Promise<Candidate[]>` and a running service.

- [ ] **Step 1: Write the failing pool test**

Create `tweet-generator/src/select/pool.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config.js'
import { selectCandidate, type PoolDeps } from './pool.js'
import type { BlogDetail, BlogListItem, ProjectDetail, ProjectListItem } from '../sources/agentlens.js'

const config = loadConfig({
  LLM_MODEL: 'pinned',
  TIMEZONE: 'Asia/Shanghai',
} as NodeJS.ProcessEnv)

/** 14:00 Shanghai. */
const now = new Date('2026-08-05T06:00:00.000Z')

function blogItem(overrides: Partial<BlogListItem> = {}): BlogListItem {
  return {
    id: 'b1',
    title: 'A new inference engine',
    summary: 'It is faster.',
    job_type: 'lab_article',
    source_id: 'lab:openai',
    occurred_at: null,
    generated_at: '2026-08-05T05:00:00.000Z',
    ...overrides,
  }
}

function blogDetail(item: BlogListItem): BlogDetail {
  return { ...item, body_markdown: '## Body\n\nText.', references: [] }
}

function deps(overrides: Partial<PoolDeps> = {}): PoolDeps {
  return {
    listBlogs: vi.fn().mockResolvedValue([blogItem()]),
    getBlog: vi.fn(async (id: string) => blogDetail(blogItem({ id }))),
    listProjects: vi.fn().mockResolvedValue([] as ProjectListItem[]),
    getProject: vi.fn() as unknown as (id: string) => Promise<ProjectDetail>,
    knownDedupeKeys: vi.fn().mockResolvedValue(new Set<string>()),
    failureCounts: vi.fn().mockResolvedValue(new Map<string, number>()),
    projectPostedSince: vi.fn().mockResolvedValue(false),
    ...overrides,
  }
}

describe('selectCandidate', () => {
  it('returns the freshest eligible blog', async () => {
    const older = blogItem({ id: 'old', generated_at: '2026-08-05T01:00:00.000Z' })
    const newer = blogItem({ id: 'new', generated_at: '2026-08-05T05:00:00.000Z' })

    const candidate = await selectCandidate(
      'lab_article',
      now,
      config,
      deps({ listBlogs: vi.fn().mockResolvedValue([older, newer]) }),
    )

    expect(candidate!.externalId).toBe('new')
  })

  it('skips items already in the queue, promoting the runner-up', async () => {
    // This is what makes "an item that lost an earlier cycle resurfaces
    // later" work with no extra machinery.
    const older = blogItem({ id: 'old', generated_at: '2026-08-05T01:00:00.000Z' })
    const newer = blogItem({ id: 'new', generated_at: '2026-08-05T05:00:00.000Z' })

    const candidate = await selectCandidate(
      'lab_article',
      now,
      config,
      deps({
        listBlogs: vi.fn().mockResolvedValue([older, newer]),
        knownDedupeKeys: vi.fn().mockResolvedValue(new Set(['agentlens:blog:new'])),
      }),
    )

    expect(candidate!.externalId).toBe('old')
  })

  it('skips items outside the freshness window', async () => {
    const stale = blogItem({ generated_at: '2026-07-01T00:00:00.000Z' })
    const candidate = await selectCandidate(
      'lab_article',
      now,
      config,
      deps({ listBlogs: vi.fn().mockResolvedValue([stale]) }),
    )
    expect(candidate).toBeNull()
  })

  it('skips items the niche gate rejects', async () => {
    const crypto = blogItem({ title: 'AI × Crypto Roundup: agent payments' })
    const candidate = await selectCandidate(
      'lab_article',
      now,
      config,
      deps({ listBlogs: vi.fn().mockResolvedValue([crypto]) }),
    )
    expect(candidate).toBeNull()
  })

  it('skips a candidate that has failed three times', async () => {
    const candidate = await selectCandidate(
      'lab_article',
      now,
      config,
      deps({
        failureCounts: vi.fn().mockResolvedValue(new Map([['b1', 3]])),
      }),
    )
    expect(candidate).toBeNull()
  })

  it('keeps a candidate that has failed twice', async () => {
    const candidate = await selectCandidate(
      'lab_article',
      now,
      config,
      deps({
        failureCounts: vi.fn().mockResolvedValue(new Map([['b1', 2]])),
      }),
    )
    expect(candidate).not.toBeNull()
  })

  it('fetches the body only for the item it selects', async () => {
    // Bodies are one request each. Fetching the whole pool to pick one would
    // multiply the request count by the pool size for no benefit.
    const getBlog = vi.fn(async (id: string) => blogDetail(blogItem({ id })))
    await selectCandidate(
      'lab_article',
      now,
      config,
      deps({
        listBlogs: vi
          .fn()
          .mockResolvedValue([blogItem({ id: 'a' }), blogItem({ id: 'b' })]),
        getBlog,
      }),
    )
    expect(getBlog).toHaveBeenCalledTimes(1)
  })
})

describe('selectCandidate for x_digest', () => {
  const digestAt = (id: string, title: string, generated: string): BlogListItem =>
    blogItem({ id, title, job_type: 'x_digest', generated_at: generated })

  it('takes today\'s non-crypto digest', async () => {
    const candidate = await selectCandidate(
      'x_digest',
      now,
      config,
      deps({
        listBlogs: vi.fn().mockResolvedValue([
          digestAt('d1', 'AI & Frontier Tech Roundup', '2026-08-05T01:05:46.079Z'),
          digestAt('d2', 'AI × Crypto Roundup', '2026-08-05T01:05:15.606Z'),
        ]),
      }),
    )
    expect(candidate!.externalId).toBe('d1')
  })

  it('ignores yesterday\'s digest entirely', async () => {
    // A digest is worthless the next morning, so the window is today's
    // 09:00 anchor rather than a rolling 24 hours.
    const candidate = await selectCandidate(
      'x_digest',
      now,
      config,
      deps({
        listBlogs: vi
          .fn()
          .mockResolvedValue([
            digestAt('d0', 'AI & Frontier Tech Roundup', '2026-08-04T01:05:00.000Z'),
          ]),
      }),
    )
    expect(candidate).toBeNull()
  })
})

describe('selectCandidate for gh_project', () => {
  function project(overrides: Partial<ProjectListItem> = {}): ProjectListItem {
    return {
      id: 'ghp:a/b',
      full_name: 'a/b',
      description: 'A thing',
      summary: 'A thing that does things.',
      language: 'Rust',
      topics: [],
      tags: [],
      license: 'MIT',
      stars: 12_000,
      forks: 400,
      star_velocity_7d: 700,
      star_velocity_per_day: 100,
      momentum_score: 700,
      pushed_at: '2026-08-05T02:00:00.000Z',
      ...overrides,
    }
  }

  const detail = (item: ProjectListItem): ProjectDetail => ({
    ...item,
    explainer_md: '## What it is\n\nA thing.',
    html_url: `https://github.com/${item.full_name}`,
  })

  it('rejects a project below the momentum floor', async () => {
    const candidate = await selectCandidate(
      'gh_project',
      now,
      config,
      deps({
        listProjects: vi
          .fn()
          .mockResolvedValue([project({ star_velocity_per_day: 3 })]),
        getProject: vi.fn(async () => detail(project())),
      }),
    )
    expect(candidate).toBeNull()
  })

  it('rejects a project inside its cooldown', async () => {
    const candidate = await selectCandidate(
      'gh_project',
      now,
      config,
      deps({
        listProjects: vi.fn().mockResolvedValue([project()]),
        getProject: vi.fn(async () => detail(project())),
        projectPostedSince: vi.fn().mockResolvedValue(true),
      }),
    )
    expect(candidate).toBeNull()
  })

  it('accepts a project that clears both gates', async () => {
    const candidate = await selectCandidate(
      'gh_project',
      now,
      config,
      deps({
        listProjects: vi.fn().mockResolvedValue([project()]),
        getProject: vi.fn(async () => detail(project())),
      }),
    )
    expect(candidate!.dedupeKey).toBe('agentlens:project:ghp:a/b:stars-10k')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter tweet-generator test pool`
Expected: FAIL — `Cannot find module './pool.js'`

- [ ] **Step 3: Write the selector**

Create `tweet-generator/src/select/pool.ts`:

```ts
import type { GeneratorConfig, SourceKind } from '../config.js'
import type {
  BlogListItem,
  ProjectDetail,
  ProjectListItem,
} from '../sources/agentlens.js'
import type { BlogDetail } from '../sources/agentlens.js'
import {
  blogToCandidate,
  projectToCandidate,
  type Candidate,
} from '../sources/candidates.js'
import { startOfDayIn } from './clock.js'
import { starBucket } from './dedupe.js'
import { passesNicheGate } from './niche.js'
import { DIGEST_ANCHOR_MINUTE } from './quota.js'
import { windowStart } from './windows.js'

/**
 * The I/O this module needs, as plain functions rather than the client and
 * store objects. Selection is the part with the silent bugs, so it is worth
 * being able to test every rule against literals.
 */
export interface PoolDeps {
  listBlogs(jobType: SourceKind, limit?: number): Promise<BlogListItem[]>
  getBlog(id: string): Promise<BlogDetail>
  listProjects(limit?: number): Promise<ProjectListItem[]>
  getProject(id: string): Promise<ProjectDetail>
  knownDedupeKeys(keys: string[]): Promise<Set<string>>
  failureCounts(externalIds: string[]): Promise<Map<string, number>>
  projectPostedSince(sourceRef: string, since: Date): Promise<boolean>
}

const MAX_FAILURES = 3
const MS_PER_DAY = 86_400_000

/**
 * The digest's window is today's 09:00 anchor, not a rolling 24 hours:
 * AgentLens publishes exactly two digests a day just after it, and one of
 * them is worthless the next morning.
 */
function digestWindowStart(now: Date, config: GeneratorConfig): Date {
  return new Date(
    startOfDayIn(config.timezone, now).getTime() +
      DIGEST_ANCHOR_MINUTE * 60_000,
  )
}

async function selectBlog(
  kind: SourceKind,
  now: Date,
  config: GeneratorConfig,
  deps: PoolDeps,
): Promise<Candidate | null> {
  const since =
    kind === 'x_digest'
      ? digestWindowStart(now, config)
      : windowStart(kind, now)

  const items = (await deps.listBlogs(kind))
    .filter((item) => new Date(item.generated_at) >= since)
    .filter((item) => passesNicheGate(`${item.title} ${item.summary}`))
    .sort(
      (a, b) =>
        new Date(b.generated_at).getTime() - new Date(a.generated_at).getTime(),
    )

  if (items.length === 0) return null

  const known = await deps.knownDedupeKeys(
    items.map((item) => `agentlens:blog:${item.id}`),
  )
  const failures = await deps.failureCounts(items.map((item) => item.id))

  const winner = items.find(
    (item) =>
      !known.has(`agentlens:blog:${item.id}`) &&
      (failures.get(item.id) ?? 0) < MAX_FAILURES,
  )
  if (!winner) return null

  // Bodies cost one request each, so only the selected item is fetched.
  return blogToCandidate(await deps.getBlog(winner.id))
}

async function selectProject(
  now: Date,
  config: GeneratorConfig,
  deps: PoolDeps,
): Promise<Candidate | null> {
  const items = (await deps.listProjects())
    .filter(
      (item) => item.star_velocity_per_day >= config.projectMinVelocityPerDay,
    )
    .filter((item) =>
      passesNicheGate(`${item.full_name} ${item.description ?? ''} ${item.summary}`),
    )
    .sort((a, b) => b.momentum_score - a.momentum_score)

  if (items.length === 0) return null

  const known = await deps.knownDedupeKeys(
    items.map((item) => `agentlens:project:${item.id}:${starBucket(item.stars)}`),
  )
  const failures = await deps.failureCounts(items.map((item) => item.id))
  const cooldownStart = new Date(
    now.getTime() - config.projectCooldownDays * MS_PER_DAY,
  )

  for (const item of items) {
    const key = `agentlens:project:${item.id}:${starBucket(item.stars)}`
    if (known.has(key)) continue
    if ((failures.get(item.id) ?? 0) >= MAX_FAILURES) continue
    // A project can straddle a bucket boundary; the cooldown is what stops
    // it posting twice in a week on the strength of that alone.
    if (await deps.projectPostedSince(item.id, cooldownStart)) continue

    return projectToCandidate(await deps.getProject(item.id))
  }

  return null
}

export function selectCandidate(
  kind: SourceKind,
  now: Date,
  config: GeneratorConfig,
  deps: PoolDeps,
): Promise<Candidate | null> {
  return kind === 'gh_project'
    ? selectProject(now, config, deps)
    : selectBlog(kind, now, config, deps)
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter tweet-generator test pool`
Expected: PASS — 13 tests.

- [ ] **Step 5: Write the service loop**

Create `tweet-generator/src/index.ts`:

```ts
import { createPool } from 'shared/db'
import { createLogger } from 'shared/logger'
import { notifyFailure } from 'shared/notifier'
import { mulberry32, type Rng } from 'shared/rng'
import { loadConfig } from './config.js'
import { startOfDayIn } from './select/clock.js'
import { selectCandidate, type PoolDeps } from './select/pool.js'
import { orderKinds } from './select/quota.js'
import { AgentLensClient, AgentLensError } from './sources/agentlens.js'
import { GeneratorStore } from './store.js'

const logger = createLogger('tweet-generator.log')
const config = loadConfig()
const pool = createPool(config.db)
const store = new GeneratorStore(pool)
const agentlens = new AgentLensClient(config.agentlensBaseUrl)

const deps: PoolDeps = {
  listBlogs: (jobType, limit) => agentlens.listBlogs(jobType, limit),
  getBlog: (id) => agentlens.getBlog(id),
  listProjects: (limit) => agentlens.listProjects(limit),
  getProject: (id) => agentlens.getProject(id),
  knownDedupeKeys: (keys) => store.knownDedupeKeys(keys),
  failureCounts: (ids) => store.failureCounts(ids),
  projectPostedSince: (ref, since) => store.projectPostedSince(ref, since),
}

let stopping = false
let consecutiveSourceFailures = 0
/** Latched, so a quiet week produces one alert rather than eighty. */
let alertedIdle = false

/** Sleeps, but wakes early on shutdown. */
async function sleep(ms: number): Promise<void> {
  const step = 1000
  let elapsed = 0
  while (elapsed < ms && !stopping) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - elapsed)))
    elapsed += step
  }
}

/**
 * Exact spacing between cycles is itself a machine signature, so the
 * interval is resampled every time inside ± the configured jitter.
 */
function nextIntervalMs(rng: Rng = Math.random): number {
  const spread = config.cycleJitterMinutes * 2
  const minutes = config.cycleMinutes - config.cycleJitterMinutes + rng() * spread
  return Math.round(minutes * 60_000)
}

/**
 * Warns when the queue has gained nothing for a day.
 *
 * Every other alert fires on something going wrong. This one fires on
 * nothing happening at all — a niche gate that rejects everything, or a
 * quota misconfiguration, produces no errors and no posts, and would
 * otherwise be noticed only by the absence of tweets.
 */
async function checkIdleWatchdog(now: Date): Promise<void> {
  const last = await store.lastEnqueuedAt()
  if (!last) return
  const idleHours = (now.getTime() - last.getTime()) / 3_600_000
  if (idleHours < 24 || alertedIdle) return

  alertedIdle = true
  await notifyFailure(
    config.discordWebhookUrl,
    'tweet-generator',
    `Nothing has been enqueued for ${Math.floor(idleHours)} hours. ` +
      'Every pool may be empty, or the quota may be misconfigured.',
  )
}

async function tick(): Promise<void> {
  const now = new Date()
  await checkIdleWatchdog(now)

  const dayStart = startOfDayIn(config.timezone, now)
  const usage = await store.usageSince(dayStart)
  const order = orderKinds(now, usage, config)

  if (order.length === 0) {
    logger.info('Nothing left to spend today', { total: usage.total })
    return
  }

  for (const kind of order) {
    const candidate = await selectCandidate(kind, now, config, deps)
    if (!candidate) {
      logger.debug('Pool empty, falling through', { kind })
      continue
    }

    // Phase 1 placeholder. Task 14 replaces this with the LLM pipeline, and
    // until then the queue carries the dispatch title so that scheduling and
    // deduplication are observable end to end with X_DRY_RUN=true.
    const content = candidate.title.slice(0, 280)

    const id = await store.enqueue({
      content,
      dedupeKey: candidate.dedupeKey,
      source: candidate.kind,
      sourceRef: candidate.externalId,
    })

    if (id === null) {
      // Another process won the race, or the key was already spent.
      logger.info('Already queued, skipping', { key: candidate.dedupeKey })
      return
    }

    alertedIdle = false
    logger.info('Enqueued', {
      id,
      kind: candidate.kind,
      externalId: candidate.externalId,
    })
    return
  }

  logger.info('Every pool was empty this cycle')
}

async function shutdown(reason: string, code: number): Promise<void> {
  if (stopping) return
  stopping = true
  logger.info('Shutting down', { reason })
  await pool.end().catch(() => {})
  process.exit(code)
}

async function main(): Promise<void> {
  logger.info('Starting tweet-generator', {
    model: config.llm.model,
    dailyCap: config.dailyCap,
    cycleMinutes: config.cycleMinutes,
    timezone: config.timezone,
  })

  process.on('SIGINT', () => void shutdown('SIGINT', 0))
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0))

  const rng = mulberry32(Date.now() & 0xffffffff)

  while (!stopping) {
    try {
      await tick()
      consecutiveSourceFailures = 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      if (error instanceof AgentLensError) {
        consecutiveSourceFailures += 1
        logger.warn('AgentLens unreachable', {
          error: message,
          consecutive: consecutiveSourceFailures,
        })
        // Three cycles is roughly six hours of silence — long enough to be
        // a real outage rather than a blip, short enough to still matter.
        if (consecutiveSourceFailures === 3) {
          await notifyFailure(
            config.discordWebhookUrl,
            'tweet-generator',
            `AgentLens unreachable for ${consecutiveSourceFailures} cycles: ${message}`,
          )
        }
      } else {
        // Unlike x-poster, an unexpected failure here is not a reason to stop:
        // nothing has been posted, and the next cycle starts from scratch.
        logger.error('Cycle failed', { error: message })
      }
    }

    await sleep(nextIntervalMs(rng))
  }
}

main().catch(async (error) => {
  logger.error('Unrecoverable startup failure', { error: String(error) })
  await notifyFailure(config.discordWebhookUrl, 'tweet-generator', String(error))
  await shutdown('startup failure', 1)
})
```

- [ ] **Step 6: Run the full suite and a type check**

Run: `pnpm --filter tweet-generator test && pnpm --filter tweet-generator build`
Expected: PASS, and `tsc` reports no errors.

- [ ] **Step 7: Run it against the real API for one cycle**

```bash
cp tweet-generator/.env.example tweet-generator/.env
# set LLM_MODEL to any non-empty value; Phase 1 never calls the LLM
pnpm --filter tweet-generator start
```

Expected: within a few seconds, a log line `Enqueued` with a kind and an
external id. Confirm the row:

```bash
docker compose exec postgres psql -U app_user -d multi_tab_listening \
  -c "SELECT id, source, source_ref, archetype, left(content, 60) FROM tweets ORDER BY id DESC LIMIT 5;"
```

Then stop it with Ctrl-C. Leave `x-poster` stopped, or run it with
`X_DRY_RUN=true` — these rows carry placeholder copy and must not be posted.

- [ ] **Step 8: Document the fourth service**

In `README.md`, add to the module list under **Overview**:

```markdown
- **Tweet Generator** — pulls AI-industry dispatches from the AgentLens public API, writes each one up through a pinned local LLM, renders a card image, and enqueues the result for the X Poster to drain.
```

And add a step to **Quick Start**, after the x-poster step:

````markdown
```bash
# 9. In a fourth terminal, start the tweet generator.
#    LLM_MODEL is required and must name one model — "auto" is rejected.
cp tweet-generator/.env.example tweet-generator/.env
pnpm --filter tweet-generator start
```
````

Update the mermaid diagram in **Architecture** to add the generator as a producer:

```
    H["AgentLens API"] --> I["Tweet Generator\n(pinned local LLM)"]
    I -->|"enqueue tweet"| C
```

- [ ] **Step 9: Commit**

```bash
git add tweet-generator README.md
git commit -m "feat(tweet-generator): add candidate selection and the service loop

Phase 1 ends here: real candidates, correctly paced, landing in the queue
with the dispatch title as placeholder copy. That placeholder is what makes
scheduling and deduplication observable before any LLM is involved.

Bodies are fetched only for the selected item — one request per cycle
rather than one per pool member."
```

---

### Task 10: The LLM client

`response_format: { type: 'json_schema' }` is **not** used. OmniRoute's lower provider tiers ignore it, so relying on it would produce a parse error on exactly the days the router falls back. Parsing is lenient instead, and Task 12's validator is what actually enforces structure.

**Files:**
- Create: `tweet-generator/src/llm/client.ts`
- Create: `tweet-generator/src/llm/client.test.ts`

**Interfaces:**
- Consumes: `LlmConfig` from `../config.js`.
- Produces:
  - `class LlmError extends Error`
  - `interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }`
  - `class LlmClient { constructor(config: LlmConfig, fetchImpl?: typeof fetch); chat(messages: ChatMessage[]): Promise<string> }`
  - `extractJson<T>(raw: string): T`

- [ ] **Step 1: Write the failing test**

Create `tweet-generator/src/llm/client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { extractJson, LlmClient, LlmError } from './client.js'
import type { LlmConfig } from '../config.js'

const config: LlmConfig = {
  baseUrl: 'http://localhost:20128/v1',
  apiKey: null,
  model: 'pinned-model',
  timeoutMs: 5000,
}

function stubChat(content: string, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
  })
}

describe('LlmClient.chat', () => {
  it('posts to /chat/completions with the pinned model', async () => {
    const fetchImpl = stubChat('hello')
    const client = new LlmClient(config, fetchImpl as never)

    const reply = await client.chat([{ role: 'user', content: 'hi' }])

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://localhost:20128/v1/chat/completions')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe('pinned-model')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(body.stream).toBe(false)
    expect(reply).toBe('hello')
  })

  it('omits the Authorization header when no key is configured', async () => {
    const fetchImpl = stubChat('hello')
    await new LlmClient(config, fetchImpl as never).chat([
      { role: 'user', content: 'hi' },
    ])

    const init = fetchImpl.mock.calls[0]![1] as RequestInit
    expect(init.headers).not.toHaveProperty('Authorization')
  })

  it('sends the key when one is configured', async () => {
    const fetchImpl = stubChat('hello')
    await new LlmClient(
      { ...config, apiKey: 'sk-test' },
      fetchImpl as never,
    ).chat([{ role: 'user', content: 'hi' }])

    const init = fetchImpl.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-test',
    )
  })

  it('throws LlmError on a non-200', async () => {
    const client = new LlmClient(config, stubChat('', 503) as never)
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      LlmError,
    )
  })

  it('throws LlmError when the response has no content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
    })
    const client = new LlmClient(config, fetchImpl as never)
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      LlmError,
    )
  })

  it('throws LlmError when the transport fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const client = new LlmClient(config, fetchImpl as never)
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      LlmError,
    )
  })
})

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('strips a fenced code block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('ignores prose before and after', () => {
    // Weaker models narrate. The object is still in there.
    expect(
      extractJson('Sure! Here is the draft:\n{"a":1}\nLet me know.'),
    ).toEqual({ a: 1 })
  })

  it('handles braces inside strings', () => {
    expect(extractJson('{"a":"a } b"}')).toEqual({ a: 'a } b' })
  })

  it('handles an escaped quote inside a string', () => {
    expect(extractJson('{"a":"say \\" now"}')).toEqual({ a: 'say " now' })
  })

  it('handles nested objects', () => {
    expect(extractJson('noise {"a":{"b":[1,2]}} noise')).toEqual({
      a: { b: [1, 2] },
    })
  })

  it('throws LlmError when there is no object at all', () => {
    expect(() => extractJson('I cannot help with that.')).toThrow(LlmError)
  })

  it('throws LlmError when the object never closes', () => {
    expect(() => extractJson('{"a":1')).toThrow(LlmError)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter tweet-generator test client`
Expected: FAIL — `Cannot find module './client.js'`

- [ ] **Step 3: Write the client**

Create `tweet-generator/src/llm/client.ts`:

```ts
import type { LlmConfig } from '../config.js'

/** Any failure talking to the model. The cycle is skipped; nothing is written. */
export class LlmError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmError'
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>
}

export class LlmClient {
  constructor(
    private readonly config: LlmConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`
    }

    let response: Response
    try {
      response = await this.fetchImpl(
        `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: this.config.model,
            messages,
            stream: false,
            // Deliberately no response_format. OmniRoute's lower provider
            // tiers ignore it, so depending on it would break on exactly the
            // days the router falls back. extractJson plus the validator do
            // the job instead.
            temperature: 0.7,
          }),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        },
      )
    } catch (cause) {
      throw new LlmError('The LLM request failed', { cause })
    }

    if (!response.ok) {
      throw new LlmError(`The LLM returned ${response.status}`)
    }

    const body = (await response.json()) as ChatResponse
    const content = body.choices?.[0]?.message?.content
    if (!content) {
      throw new LlmError('The LLM returned no content')
    }
    return content
  }
}

/**
 * Pulls the first complete JSON object out of a reply.
 *
 * Weaker models narrate around their output and wrap it in code fences, and
 * no amount of prompting reliably stops that. Scanning for a balanced object
 * — while tracking string state, so a brace inside a string does not end it —
 * costs twenty lines and removes a whole class of retry.
 */
export function extractJson<T>(raw: string): T {
  const start = raw.indexOf('{')
  if (start === -1) {
    throw new LlmError('The LLM reply contained no JSON object')
  }

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < raw.length; i++) {
    const char = raw[i]!

    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && inString) {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (char === '{') depth++
    if (char === '}') {
      depth--
      if (depth === 0) {
        const slice = raw.slice(start, i + 1)
        try {
          return JSON.parse(slice) as T
        } catch (cause) {
          throw new LlmError('The LLM reply was not valid JSON', { cause })
        }
      }
    }
  }

  throw new LlmError('The LLM reply contained an unterminated JSON object')
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter tweet-generator test client`
Expected: PASS — 14 tests.

- [ ] **Step 5: Commit**

```bash
git add tweet-generator/src/llm
git commit -m "feat(tweet-generator): add the OpenAI-compatible LLM client

No response_format: OmniRoute's lower tiers ignore it, so depending on it
would break on exactly the days the router falls back. extractJson scans
for a balanced object instead, which also survives models that narrate."
```

---

### Task 11: Archetypes and assembly

The model returns **separate fields**, never a finished tweet string. Code assembles and counts, which makes the 280-character limit a property of construction rather than something the model is asked to achieve — and models cannot count characters, because tokenisation hides character boundaries from them.

**Files:**
- Create: `tweet-generator/src/llm/archetypes.ts`, `tweet-generator/src/llm/archetypes.test.ts`
- Create: `tweet-generator/src/llm/assemble.ts`, `tweet-generator/src/llm/assemble.test.ts`

**Interfaces:**
- Consumes: `TweetArchetype` from `shared`; `Rng` from `shared/rng`.
- Produces:
  - `interface ArchetypeSpec { name: TweetArchetype; weight: number; hasImage: boolean; fields: Record<string, number> }`
  - `ARCHETYPES: Record<TweetArchetype, ArchetypeSpec>`
  - `pickArchetype(last: TweetArchetype | null, rng?: Rng): TweetArchetype`
  - `type Draft = DigestDraft | MetricDraft | ProseDraft`
  - `weightedLength(text: string): number`
  - `assemble(draft: Draft): string`
  - `MAX_WEIGHTED_LENGTH = 280`

- [ ] **Step 1: Write the failing archetype test**

Create `tweet-generator/src/llm/archetypes.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mulberry32 } from 'shared/rng'
import { ARCHETYPES, pickArchetype } from './archetypes.js'

describe('ARCHETYPES', () => {
  it('weights sum to 100', () => {
    const total = Object.values(ARCHETYPES).reduce(
      (sum, spec) => sum + spec.weight,
      0,
    )
    expect(total).toBe(100)
  })

  it('leaves take and question image-less', () => {
    // Half the posts carrying no image cuts the content-farm fingerprint,
    // cuts render cost, and makes the timeline read like a person.
    expect(ARCHETYPES.take.hasImage).toBe(false)
    expect(ARCHETYPES.question.hasImage).toBe(false)
    expect(ARCHETYPES.digest.hasImage).toBe(true)
    expect(ARCHETYPES.metric.hasImage).toBe(true)
  })
})

describe('pickArchetype', () => {
  it('never repeats the previous archetype', () => {
    const rng = mulberry32(11)
    for (let i = 0; i < 500; i++) {
      expect(pickArchetype('digest', rng)).not.toBe('digest')
    }
  })

  it('can return any archetype when there is no history', () => {
    const rng = mulberry32(3)
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(pickArchetype(null, rng))
    expect(seen.size).toBe(4)
  })

  it('is deterministic for a given seed', () => {
    expect(pickArchetype(null, mulberry32(42))).toBe(
      pickArchetype(null, mulberry32(42)),
    )
  })

  it('still reflects the weights after excluding the previous', () => {
    const rng = mulberry32(9)
    const counts: Record<string, number> = {}
    for (let i = 0; i < 4000; i++) {
      const pick = pickArchetype('question', rng)
      counts[pick] = (counts[pick] ?? 0) + 1
    }
    // digest carries 45 of the remaining 85 weight, so it should dominate.
    expect(counts.digest!).toBeGreaterThan(counts.metric!)
    expect(counts.digest!).toBeGreaterThan(counts.take!)
    expect(counts.question).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter tweet-generator test archetypes`
Expected: FAIL — `Cannot find module './archetypes.js'`

- [ ] **Step 3: Write the archetypes**

Create `tweet-generator/src/llm/archetypes.ts`:

```ts
import type { TweetArchetype } from 'shared'
import type { Rng } from 'shared/rng'

export interface ArchetypeSpec {
  name: TweetArchetype
  /** Relative frequency. The four weights sum to 100. */
  weight: number
  hasImage: boolean
  /** Field name → weighted-character budget, enforced by the validator. */
  fields: Record<string, number>
}

/**
 * The four shapes a post can take.
 *
 * Structural monotony, not volume, is what makes an account read as a
 * content farm: every post being a hook, three arrows, and an identically
 * watermarked card is a trivially learnable fingerprint, and ten identical
 * posts a day give a classifier more to work with than three do.
 *
 * The mix also covers the three kinds of account that grow — useful value
 * (digest), results and progress (metric), and something with a human voice
 * (take, question) — rather than only the first.
 */
export const ARCHETYPES: Record<TweetArchetype, ArchetypeSpec> = {
  digest: {
    name: 'digest',
    weight: 45,
    hasImage: true,
    fields: { hook: 90, highlight: 55 },
  },
  metric: {
    name: 'metric',
    weight: 20,
    hasImage: true,
    fields: { metric: 40, line: 200 },
  },
  take: { name: 'take', weight: 20, hasImage: false, fields: { text: 240 } },
  question: {
    name: 'question',
    weight: 15,
    hasImage: false,
    fields: { text: 200 },
  },
}

/**
 * Weighted pick, excluding whatever went out last.
 *
 * The exclusion is a hard rule rather than a nudge: two identical shapes in
 * a row is the most visible thing a reader scrolling a profile notices.
 */
export function pickArchetype(
  last: TweetArchetype | null,
  rng: Rng = Math.random,
): TweetArchetype {
  const eligible = Object.values(ARCHETYPES).filter(
    (spec) => spec.name !== last,
  )
  const total = eligible.reduce((sum, spec) => sum + spec.weight, 0)

  let roll = rng() * total
  for (const spec of eligible) {
    roll -= spec.weight
    if (roll < 0) return spec.name
  }
  return eligible[eligible.length - 1]!.name
}
```

- [ ] **Step 4: Write the failing assembly test**

Create `tweet-generator/src/llm/assemble.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { assemble, MAX_WEIGHTED_LENGTH, weightedLength } from './assemble.js'

describe('weightedLength', () => {
  it('counts plain ASCII as one each', () => {
    expect(weightedLength('hello')).toBe(5)
  })

  it('counts an emoji as two', () => {
    // X's weighted-length config gives everything outside a few Latin and
    // punctuation ranges a weight of 2.
    expect(weightedLength('🚀')).toBe(2)
  })

  it('counts an em dash as one', () => {
    // U+2014 sits inside the 8208–8223 range, which X weights at 1.
    expect(weightedLength('—')).toBe(1)
  })

  it('counts an arrow as two', () => {
    // U+2192 is outside every weight-1 range, so the separator this project
    // uses costs two characters each. Three of them is six of the budget.
    expect(weightedLength('→')).toBe(2)
  })

  it('counts a newline as one', () => {
    expect(weightedLength('a\nb')).toBe(3)
  })

  it('does not split a surrogate pair into two code units', () => {
    expect(weightedLength('👍')).toBe(2)
  })
})

describe('assemble', () => {
  it('renders a digest as a hook and three arrows', () => {
    const text = assemble({
      archetype: 'digest',
      hook: 'vLLM ships speculative decoding v2.',
      highlights: ['2.1x throughput', '18.4k stars', 'Apache-2.0'],
    })

    expect(text).toBe(
      'vLLM ships speculative decoding v2.\n\n' +
        '→ 2.1x throughput\n→ 18.4k stars\n→ Apache-2.0',
    )
  })

  it('renders a metric as a number line then a body', () => {
    const text = assemble({
      archetype: 'metric',
      metric: '+443 stars/day',
      line: 'OmniRoute puts 290 providers behind one local endpoint.',
    })

    expect(text).toBe(
      '+443 stars/day\n\nOmniRoute puts 290 providers behind one local endpoint.',
    )
  })

  it('renders take and question as bare prose', () => {
    expect(assemble({ archetype: 'take', text: 'It fits on a phone.' })).toBe(
      'It fits on a phone.',
    )
    expect(
      assemble({ archetype: 'question', text: 'What is your eval harness?' }),
    ).toBe('What is your eval harness?')
  })

  it('trims stray whitespace from every field', () => {
    // Models pad fields with newlines. Trimming here rather than asking the
    // prompt to stop is one fewer thing that can fail the length check for
    // no reason.
    expect(
      assemble({
        archetype: 'digest',
        hook: '  Hook.  ',
        highlights: [' a ', 'b\n', '\tc'],
      }),
    ).toBe('Hook.\n\n→ a\n→ b\n→ c')
  })

  it('stays inside the limit at every field budget', () => {
    // 90 + 2 + 3 * (3 + 55) + 2 = 268.
    const text = assemble({
      archetype: 'digest',
      hook: 'x'.repeat(90),
      highlights: ['y'.repeat(55), 'y'.repeat(55), 'y'.repeat(55)],
    })
    expect(weightedLength(text)).toBeLessThanOrEqual(MAX_WEIGHTED_LENGTH)
    expect(weightedLength(text)).toBe(268)
  })
})
```

- [ ] **Step 5: Run it to confirm it fails**

Run: `pnpm --filter tweet-generator test assemble`
Expected: FAIL — `Cannot find module './assemble.js'`

- [ ] **Step 6: Write the assembler**

Create `tweet-generator/src/llm/assemble.ts`:

```ts
export const MAX_WEIGHTED_LENGTH = 280

export interface DigestDraft {
  archetype: 'digest'
  hook: string
  highlights: string[]
}

export interface MetricDraft {
  archetype: 'metric'
  metric: string
  line: string
}

export interface ProseDraft {
  archetype: 'take' | 'question'
  text: string
}

export type Draft = DigestDraft | MetricDraft | ProseDraft

/**
 * X's weighted-length ranges. Everything inside them counts 1; everything
 * else counts 2.
 *
 * This matters more than it looks: the `→` separator this project uses is
 * U+2192, outside every range, so each one costs two characters. Three of
 * them plus their spaces is nine of the 280.
 */
const WEIGHT_ONE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
]

export function weightedLength(text: string): number {
  let total = 0
  // Iterating the string yields code points, not code units, so a surrogate
  // pair counts once rather than twice.
  for (const character of text) {
    const point = character.codePointAt(0)!
    const light = WEIGHT_ONE_RANGES.some(
      ([low, high]) => point >= low && point <= high,
    )
    total += light ? 1 : 2
  }
  return total
}

export function assemble(draft: Draft): string {
  switch (draft.archetype) {
    case 'digest': {
      const hook = draft.hook.trim()
      const lines = draft.highlights
        .map((highlight) => `→ ${highlight.trim()}`)
        .join('\n')
      return `${hook}\n\n${lines}`
    }
    case 'metric':
      return `${draft.metric.trim()}\n\n${draft.line.trim()}`
    default:
      return draft.text.trim()
  }
}
```

- [ ] **Step 7: Run both suites**

Run: `pnpm --filter tweet-generator test`
Expected: PASS — archetypes (6) and assemble (12) green alongside everything before.

- [ ] **Step 8: Commit**

```bash
git add tweet-generator/src/llm
git commit -m "feat(tweet-generator): add archetypes and tweet assembly

The model returns fields, never a finished string. Code assembles and
counts, so 280 is a property of construction rather than something the
model is asked to achieve — models cannot count characters, because
tokenisation hides character boundaries from them.

weightedLength follows X's real ranges: the arrow separator is U+2192 and
costs two characters each, which a naive .length would miss."
```

---

### Task 12: The validator

Pure, free, and the last thing standing between a local model and a personal brand. It runs **before** the critique call, because a critique should never be spent on a draft that is already mechanically broken.

Two decisions carry most of the weight here:

- **Single words are never hard-failed, only phrases.** `seamless failover` and `elevated privileges` are standard technical terms, and rejecting a post about privilege escalation for containing "elevated" is absurd. Single words become soft flags handed to the critic, which has the context a regex does not.
- **Only stylistic rules can be downgraded by the loop guard.** Length, structure, and the number whitelist never are: an over-length tweet fails to submit, and a hallucinated number is the one thing that must never ship.

**Files:**
- Create: `tweet-generator/banned-phrases.json`
- Create: `tweet-generator/src/llm/validate.ts`, `tweet-generator/src/llm/validate.test.ts`

**Interfaces:**
- Consumes: `Draft`, `weightedLength`, `MAX_WEIGHTED_LENGTH` from `./assemble.js`; `ARCHETYPES` from `./archetypes.js`.
- Produces:
  - `interface Violation { rule: string; message: string }`
  - `interface ValidationResult { ok: boolean; hard: Violation[]; soft: Violation[] }`
  - `interface BannedPhrases { hard: string[]; soft: string[] }`
  - `validate(input: ValidationInput): ValidationResult`
  - `loadBannedPhrases(path: string): Promise<BannedPhrases>`
  - `DEFAULT_BANNED_PHRASES: BannedPhrases`

- [ ] **Step 1: Write the banned-phrase file**

Create `tweet-generator/banned-phrases.json`. Entries are regular-expression sources, matched case-insensitively:

```json
{
  "hard": [
    "in the ever-evolving",
    "in today's fast-paced",
    "delve into",
    "paradigm shift",
    "harness the power",
    "unlock the (power|potential)",
    "it's worth noting",
    "buckle up",
    "let that sink in",
    "the AI landscape",
    "game.?changer"
  ],
  "soft": [
    "seamless",
    "elevate",
    "unleash",
    "robust",
    "leverage",
    "supercharge",
    "revolutionize",
    "cutting.?edge"
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `tweet-generator/src/llm/validate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Draft } from './assemble.js'
import { assemble } from './assemble.js'
import {
  DEFAULT_BANNED_PHRASES,
  validate,
  type ValidationInput,
} from './validate.js'

const source =
  'OmniRoute is a free AI gateway. diegosouzapw/OmniRoute. 18.4k stars. ' +
  '+443 stars/day. TypeScript. MIT. It routes across 290 providers and ' +
  '500 models with automatic fallback.'

const cleanDigest: Draft = {
  archetype: 'digest',
  hook: 'OmniRoute puts 290 providers behind one local endpoint.',
  highlights: ['18.4k stars', '+443 stars/day', 'MIT, TypeScript'],
}

function input(overrides: Partial<ValidationInput> = {}): ValidationInput {
  const draft = overrides.draft ?? cleanDigest
  return {
    draft,
    text: overrides.text ?? assemble(draft),
    sourceText: source,
    repeatedRules: new Set<string>(),
    banned: DEFAULT_BANNED_PHRASES,
    ...overrides,
  }
}

describe('validate — the happy path', () => {
  it('accepts a clean draft', () => {
    const result = validate(input())
    expect(result.hard).toEqual([])
    expect(result.ok).toBe(true)
  })
})

describe('validate — length and structure', () => {
  it('rejects a tweet over 280 weighted characters', () => {
    const draft: Draft = { archetype: 'take', text: 'x'.repeat(300) }
    const result = validate(input({ draft }))
    expect(result.ok).toBe(false)
    expect(result.hard.map((v) => v.rule)).toContain('length')
  })

  it('rejects a field over its own budget', () => {
    // The take budget is 240, well inside the 280 total, so this fails the
    // field rule without tripping the length rule.
    const draft: Draft = { archetype: 'take', text: 'x'.repeat(250) }
    const result = validate(input({ draft }))
    expect(result.hard.map((v) => v.rule)).toContain('field-budget')
    expect(result.hard.map((v) => v.rule)).not.toContain('length')
  })

  it('rejects a digest without exactly three highlights', () => {
    const two: Draft = { ...cleanDigest, highlights: ['a', 'b'] }
    expect(validate(input({ draft: two })).hard.map((v) => v.rule)).toContain(
      'structure',
    )

    const four: Draft = { ...cleanDigest, highlights: ['a', 'b', 'c', 'd'] }
    expect(validate(input({ draft: four })).hard.map((v) => v.rule)).toContain(
      'structure',
    )
  })

  it('rejects an empty field', () => {
    const draft: Draft = { ...cleanDigest, hook: '   ' }
    expect(validate(input({ draft })).hard.map((v) => v.rule)).toContain(
      'structure',
    )
  })
})

describe('validate — the number whitelist', () => {
  it('rejects a number that appears nowhere in the source', () => {
    const draft: Draft = {
      archetype: 'take',
      text: 'It cuts latency by 87% on a single GPU.',
    }
    const result = validate(input({ draft }))
    expect(result.ok).toBe(false)
    expect(result.hard.map((v) => v.rule)).toContain('numbers')
    expect(result.hard[0]!.message).toContain('87%')
  })

  it('accepts numbers quoted from the source', () => {
    const draft: Draft = {
      archetype: 'take',
      text: 'One endpoint, 290 providers, 500 models.',
    }
    expect(validate(input({ draft })).ok).toBe(true)
  })

  it('accepts an abbreviated count the facts already formatted', () => {
    const draft: Draft = {
      archetype: 'take',
      text: 'OmniRoute is at 18.4k stars.',
    }
    expect(validate(input({ draft })).ok).toBe(true)
  })

  it('allows small bare numbers, which are prose rather than claims', () => {
    // "one of three", "v2", "GPT-5.6" — rejecting these would be absurd, and
    // the rule exists to catch invented figures, not ordinary counting.
    const draft: Draft = {
      archetype: 'take',
      text: 'The 3 numbers that matter are in the readme.',
    }
    expect(validate(input({ draft })).ok).toBe(true)
  })

  it('still checks a small number carrying a unit', () => {
    const draft: Draft = {
      archetype: 'take',
      text: 'It is 4x faster than the previous release.',
    }
    expect(validate(input({ draft })).hard.map((v) => v.rule)).toContain(
      'numbers',
    )
  })

  it('checks against the whole source, not only the facts list', () => {
    // Scoping this to facts[] would reject model names and version strings —
    // LFM2.5-2.6B, GPT-5.6, v2 — which are quoted, not invented.
    const draft: Draft = { archetype: 'take', text: 'LFM2.5-2.6B fits on a phone.' }
    const result = validate(
      input({
        draft,
        sourceText: 'Liquid AI released LFM2.5-2.6B for on-device agents.',
      }),
    )
    expect(result.ok).toBe(true)
  })
})

describe('validate — banned phrases', () => {
  it('hard-fails a tier-1 phrase', () => {
    const draft: Draft = {
      archetype: 'take',
      text: 'A real paradigm shift for local inference.',
    }
    const result = validate(input({ draft }))
    expect(result.ok).toBe(false)
    expect(result.hard.some((v) => v.rule.startsWith('banned-phrase:'))).toBe(
      true,
    )
  })

  it('exempts a phrase quoted verbatim from the source', () => {
    // A project actually named "Unleash" must not convict the model of
    // saying its name.
    const draft: Draft = {
      archetype: 'take',
      text: 'Unleash ships a new flag evaluator.',
    }
    const result = validate(
      input({
        draft,
        sourceText: 'Unleash is an open-source feature flag service.',
      }),
    )
    expect(result.soft).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('soft-flags a tier-2 word without failing', () => {
    // seamless failover and elevated privileges are standard terms. A regex
    // cannot see which sense is meant; the critic can.
    const draft: Draft = {
      archetype: 'take',
      text: 'Failover is seamless across providers.',
    }
    const result = validate(input({ draft }))
    expect(result.ok).toBe(true)
    expect(result.hard).toEqual([])
    expect(result.soft.map((v) => v.rule)).toContain('banned-phrase:seamless')
  })

  it('is case-insensitive', () => {
    const draft: Draft = { archetype: 'take', text: 'Buckle Up for this one.' }
    expect(validate(input({ draft })).ok).toBe(false)
  })
})

describe('validate — style rules', () => {
  it('rejects a hashtag', () => {
    const draft: Draft = { archetype: 'take', text: 'Local models. #AI' }
    expect(validate(input({ draft })).hard.map((v) => v.rule)).toContain(
      'hashtag',
    )
  })

  it('rejects a URL', () => {
    const draft: Draft = {
      archetype: 'take',
      text: 'See https://example.test for the numbers.',
    }
    expect(validate(input({ draft })).hard.map((v) => v.rule)).toContain('url')
  })

  it('allows one em dash and rejects two', () => {
    const one: Draft = {
      archetype: 'take',
      text: 'It runs locally — that is the whole point.',
    }
    expect(validate(input({ draft: one })).ok).toBe(true)

    const two: Draft = {
      archetype: 'take',
      text: 'It runs locally — on device — with no network.',
    }
    expect(validate(input({ draft: two })).hard.map((v) => v.rule)).toContain(
      'em-dash',
    )
  })

  it('rejects thread bait', () => {
    const leading: Draft = { archetype: 'take', text: '🔥 Local models win.' }
    expect(
      validate(input({ draft: leading })).hard.map((v) => v.rule),
    ).toContain('thread-bait')

    const numbered: Draft = { archetype: 'take', text: '1/ Local models win.' }
    expect(
      validate(input({ draft: numbered })).hard.map((v) => v.rule),
    ).toContain('thread-bait')

    const needle: Draft = { archetype: 'take', text: 'Local models win 🧵' }
    expect(validate(input({ draft: needle })).hard.map((v) => v.rule)).toContain(
      'thread-bait',
    )
  })
})

describe('validate — the loop guard', () => {
  it('downgrades a stylistic rule that fired last round', () => {
    // A rule the model cannot satisfy is a broken rule, and a tweet
    // containing "buckle up" beats a tweet that never shipped.
    const draft: Draft = { archetype: 'take', text: 'Buckle up, this is fast.' }
    const first = validate(input({ draft }))
    expect(first.ok).toBe(false)

    const rules = new Set(first.hard.map((v) => v.rule))
    const second = validate(input({ draft, repeatedRules: rules }))
    expect(second.ok).toBe(true)
    expect(second.soft.map((v) => v.rule)).toEqual([...rules])
  })

  it('never downgrades the length rule', () => {
    // An over-length tweet does not post at all, so letting it through
    // would trade a skipped post for a guaranteed failure.
    const draft: Draft = { archetype: 'take', text: 'x'.repeat(300) }
    const result = validate(
      input({ draft, repeatedRules: new Set(['length', 'field-budget']) }),
    )
    expect(result.ok).toBe(false)
    expect(result.hard.map((v) => v.rule)).toContain('length')
  })

  it('never downgrades the number whitelist', () => {
    const draft: Draft = {
      archetype: 'take',
      text: 'It cuts latency by 87% on a single GPU.',
    }
    const result = validate(input({ draft, repeatedRules: new Set(['numbers']) }))
    expect(result.ok).toBe(false)
    expect(result.hard.map((v) => v.rule)).toContain('numbers')
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm --filter tweet-generator test validate`
Expected: FAIL — `Cannot find module './validate.js'`

- [ ] **Step 4: Write the validator**

Create `tweet-generator/src/llm/validate.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { ARCHETYPES } from './archetypes.js'
import {
  MAX_WEIGHTED_LENGTH,
  weightedLength,
  type Draft,
} from './assemble.js'

export interface Violation {
  rule: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  /** Regenerate. */
  hard: Violation[]
  /** Passed to the critic as pointed questions. Never blocks on its own. */
  soft: Violation[]
}

export interface BannedPhrases {
  hard: string[]
  soft: string[]
}

export interface ValidationInput {
  draft: Draft
  /** The assembled tweet, exactly as it would be posted. */
  text: string
  /** title + summary + body + facts, joined. The number whitelist's scope. */
  sourceText: string
  /** Rules that already fired on the previous round. Feeds the loop guard. */
  repeatedRules: Set<string>
  banned: BannedPhrases
}

export const DEFAULT_BANNED_PHRASES: BannedPhrases = {
  hard: [
    'in the ever-evolving',
    "in today's fast-paced",
    'delve into',
    'paradigm shift',
    'harness the power',
    'unlock the (power|potential)',
    "it's worth noting",
    'buckle up',
    'let that sink in',
    'the AI landscape',
    'game.?changer',
  ],
  soft: [
    'seamless',
    'elevate',
    'unleash',
    'robust',
    'leverage',
    'supercharge',
    'revolutionize',
    'cutting.?edge',
  ],
}

/**
 * Rules the loop guard may downgrade to a warning after firing twice.
 *
 * Length, structure, and the number whitelist are deliberately absent. An
 * over-length tweet does not post at all, and a hallucinated number is the
 * one thing that must never reach the timeline — for those, a skipped post
 * is the correct outcome however many rounds it takes.
 */
const DOWNGRADABLE = ['banned-phrase:', 'hashtag', 'em-dash', 'thread-bait']

function isDowngradable(rule: string): boolean {
  return DOWNGRADABLE.some((prefix) => rule.startsWith(prefix))
}

/** Every field of a draft, as `[name, value]` pairs the budget map can key on. */
function fieldsOf(draft: Draft): Array<[string, string]> {
  switch (draft.archetype) {
    case 'digest':
      // Every highlight keys on the same budget name, which is what lets the
      // budget map hold one entry rather than three identical ones.
      return [
        ['hook', draft.hook],
        ...draft.highlights.map(
          (highlight) => ['highlight', highlight] as [string, string],
        ),
      ]
    case 'metric':
      return [
        ['metric', draft.metric],
        ['line', draft.line],
      ]
    default:
      return [['text', draft.text]]
  }
}

function checkStructure(draft: Draft): Violation[] {
  const violations: Violation[] = []

  if (draft.archetype === 'digest' && draft.highlights.length !== 3) {
    violations.push({
      rule: 'structure',
      message: `A digest needs exactly 3 highlights, got ${draft.highlights.length}.`,
    })
  }

  for (const [name, value] of fieldsOf(draft)) {
    if (value.trim() === '') {
      violations.push({ rule: 'structure', message: `The ${name} is empty.` })
    }
  }

  return violations
}

function checkBudgets(draft: Draft): Violation[] {
  const budgets = ARCHETYPES[draft.archetype].fields
  const violations: Violation[] = []

  for (const [name, value] of fieldsOf(draft)) {
    const budget = budgets[name]
    if (budget === undefined) continue
    const length = weightedLength(value.trim())
    if (length > budget) {
      violations.push({
        rule: 'field-budget',
        message: `The ${name} is ${length} characters; the budget is ${budget}. Shorten it.`,
      })
    }
  }

  return violations
}

/** Numbers with a unit, or of any size, as written: `87%`, `18.4k`, `4x`, `290`. */
const NUMBER_PATTERN = /\d[\d,.]*\s*(%|k|m|b|x)?/gi

function normalise(text: string): string {
  return text.toLowerCase().replace(/,/g, '').replace(/\s+/g, '')
}

/**
 * Every number in the output must already appear in the source material.
 *
 * The scope is the whole source rather than just `facts[]`: model names and
 * version strings (LFM2.5-2.6B, GPT-5.6, v2) are quoted, not invented, and
 * the rule exists to catch invention.
 *
 * Bare numbers below 10 are exempt. "the 3 numbers that matter" is prose,
 * not a claim, and rejecting it would be absurd — a unit suffix is what
 * turns a digit into an assertion.
 */
function checkNumbers(text: string, sourceText: string): Violation[] {
  const haystack = normalise(sourceText)
  const violations: Violation[] = []

  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const token = match[0]
    const unit = match[1]
    const value = Number(token.replace(/[^\d.]/g, ''))

    if (!unit && Number.isFinite(value) && value < 10) continue
    if (haystack.includes(normalise(token))) continue

    violations.push({
      rule: 'numbers',
      message:
        `"${token.trim()}" does not appear in the source material. Use only ` +
        `figures quoted from it, or drop the claim.`,
    })
  }

  return violations
}

function checkPhrases(
  text: string,
  sourceText: string,
  banned: BannedPhrases,
): { hard: Violation[]; soft: Violation[] } {
  const hard: Violation[] = []
  const soft: Violation[] = []

  const scan = (patterns: string[], target: Violation[], tier: string): void => {
    for (const source of patterns) {
      const match = new RegExp(source, 'i').exec(text)
      if (!match) continue

      // Quotation exemption. Masking anything the source already says stops
      // the phrase list fighting the instruction to quote facts verbatim —
      // a fight the model cannot win, because accuracy forces the hit.
      if (new RegExp(source, 'i').test(sourceText)) continue

      target.push({
        rule: `banned-phrase:${source}`,
        message:
          tier === 'hard'
            ? `"${match[0]}" is filler. Rewrite the line without it.`
            : `The draft uses "${match[0]}". Is it doing real semantic work here, or is it filler? If filler, rewrite that line.`,
      })
    }
  }

  scan(banned.hard, hard, 'hard')
  scan(banned.soft, soft, 'soft')
  return { hard, soft }
}

function checkStyle(text: string): Violation[] {
  const violations: Violation[] = []

  if (/#\w/.test(text)) {
    violations.push({
      rule: 'hashtag',
      message: 'No hashtags. Remove it.',
    })
  }

  if (/https?:\/\/|\bwww\./i.test(text)) {
    violations.push({
      rule: 'url',
      message: 'No links. Attribution rides on the card image.',
    })
  }

  const emDashes = (text.match(/—/g) ?? []).length
  if (emDashes > 1) {
    violations.push({
      rule: 'em-dash',
      message: `${emDashes} em dashes. Use at most one.`,
    })
  }

  if (
    /^\s*\d+\s*\//.test(text) ||
    /🧵/u.test(text) ||
    /^\s*\p{Extended_Pictographic}/u.test(text)
  ) {
    violations.push({
      rule: 'thread-bait',
      message:
        'No leading emoji, no "1/", no thread emoji. Open with the point.',
    })
  }

  return violations
}

export function validate(input: ValidationInput): ValidationResult {
  const phrases = checkPhrases(input.text, input.sourceText, input.banned)

  const raw: Violation[] = [
    ...checkStructure(input.draft),
    ...checkBudgets(input.draft),
    ...checkNumbers(input.text, input.sourceText),
    ...phrases.hard,
    ...checkStyle(input.text),
  ]

  if (weightedLength(input.text) > MAX_WEIGHTED_LENGTH) {
    raw.unshift({
      rule: 'length',
      message: `The tweet is ${weightedLength(input.text)} weighted characters; the limit is ${MAX_WEIGHTED_LENGTH}.`,
    })
  }

  const hard: Violation[] = []
  const soft: Violation[] = [...phrases.soft]

  for (const violation of raw) {
    if (input.repeatedRules.has(violation.rule) && isDowngradable(violation.rule)) {
      soft.push(violation)
    } else {
      hard.push(violation)
    }
  }

  return { ok: hard.length === 0, hard, soft }
}

/**
 * Loads the phrase list from disk, falling back to the built-in one.
 *
 * A missing file is not an error: new clichés will need adding and editing
 * config is faster than editing code, but the service must still start on a
 * fresh checkout.
 */
export async function loadBannedPhrases(path: string): Promise<BannedPhrases> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as BannedPhrases
    return {
      hard: parsed.hard ?? DEFAULT_BANNED_PHRASES.hard,
      soft: parsed.soft ?? DEFAULT_BANNED_PHRASES.soft,
    }
  } catch {
    return DEFAULT_BANNED_PHRASES
  }
}
```

- [ ] **Step 5: Run it to confirm it passes**

Run: `pnpm --filter tweet-generator test validate`
Expected: PASS — 22 tests.

- [ ] **Step 6: Commit**

```bash
git add tweet-generator/src/llm/validate.ts tweet-generator/src/llm/validate.test.ts tweet-generator/banned-phrases.json
git commit -m "feat(tweet-generator): add the deterministic validator

Two tiers of banned phrase. Single words are never hard-failed: 'seamless
failover' and 'elevated privileges' are standard terms, so those become
soft flags for the critic, which has the context a regex does not.

A quotation exemption stops the phrase list fighting the instruction to
quote facts verbatim — a fight the model cannot win, because accuracy
forces the hit.

The loop guard downgrades only stylistic rules. Length, structure, and the
number whitelist never downgrade: an over-length tweet does not post, and a
hallucinated number is the one thing that must never ship."
```

---

### Task 13: Prompts

Pure string builders, so the persona is reviewable as text rather than buried in the orchestration.

**Files:**
- Create: `tweet-generator/src/llm/prompts.ts`, `tweet-generator/src/llm/prompts.test.ts`

**Interfaces:**
- Consumes: `Candidate` from `../sources/candidates.js`; `Draft`, `Violation`, `ARCHETYPES`.
- Produces:
  - `SYSTEM_PROMPT: string`
  - `buildGeneratePrompt(candidate: Candidate, archetype: TweetArchetype): string`
  - `buildCritiquePrompt(candidate: Candidate, text: string, soft: Violation[]): string`
  - `buildRewritePrompt(text: string, issues: string[]): string`
  - `sourceTextOf(candidate: Candidate): string`
  - `interface Critique { verdict: 'pass' | 'revise'; issues: string[] }`

- [ ] **Step 1: Write the failing test**

Create `tweet-generator/src/llm/prompts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Candidate } from '../sources/candidates.js'
import {
  buildCritiquePrompt,
  buildGeneratePrompt,
  buildRewritePrompt,
  sourceTextOf,
  SYSTEM_PROMPT,
} from './prompts.js'

const candidate: Candidate = {
  kind: 'gh_project',
  externalId: 'ghp:a/b',
  title: 'a/b',
  summary: 'A gateway.',
  body: '## What it is\n\nOne endpoint for 290 providers.',
  facts: ['a/b', '18.4k stars', '+443 stars/day', 'TypeScript', 'MIT'],
  sourceUrl: 'https://github.com/a/b',
  freshness: new Date('2026-08-05T02:00:00.000Z'),
  dedupeKey: 'agentlens:project:ghp:a/b:stars-10k',
}

describe('SYSTEM_PROMPT', () => {
  it('names the audience as peers, not recruiters', () => {
    expect(SYSTEM_PROMPT).toMatch(/peers/i)
  })

  it('does not itself contain the clichés it bans', () => {
    // A prompt that says "avoid 'delve into'" puts the phrase in context and
    // makes it more likely, not less. The ban is enforced by the validator.
    expect(SYSTEM_PROMPT).not.toMatch(/delve into/i)
  })
})

describe('buildGeneratePrompt', () => {
  it('states the exact JSON fields for the archetype', () => {
    const prompt = buildGeneratePrompt(candidate, 'digest')
    expect(prompt).toContain('"hook"')
    expect(prompt).toContain('"highlights"')
    expect(prompt).toContain('exactly 3')
  })

  it('states the per-field budgets', () => {
    const prompt = buildGeneratePrompt(candidate, 'digest')
    expect(prompt).toContain('90')
    expect(prompt).toContain('55')
  })

  it('asks for different fields for a metric post', () => {
    const prompt = buildGeneratePrompt(candidate, 'metric')
    expect(prompt).toContain('"metric"')
    expect(prompt).toContain('"line"')
    expect(prompt).not.toContain('"highlights"')
  })

  it('lists every fact verbatim', () => {
    const prompt = buildGeneratePrompt(candidate, 'digest')
    for (const fact of candidate.facts) expect(prompt).toContain(fact)
  })

  it('includes the source material', () => {
    const prompt = buildGeneratePrompt(candidate, 'take')
    expect(prompt).toContain('One endpoint for 290 providers')
  })

  it('truncates a very long body', () => {
    // Whole dispatch bodies run to thousands of words. Sending all of it
    // costs latency and buys nothing: the first section carries the news.
    const long: Candidate = { ...candidate, body: 'x'.repeat(20_000) }
    expect(buildGeneratePrompt(long, 'take').length).toBeLessThan(8000)
  })
})

describe('buildCritiquePrompt', () => {
  it('carries the draft and asks for a verdict', () => {
    const prompt = buildCritiquePrompt(candidate, 'The draft text.', [])
    expect(prompt).toContain('The draft text.')
    expect(prompt).toContain('"verdict"')
    expect(prompt).toContain('"issues"')
  })

  it('turns each soft flag into a pointed question', () => {
    const prompt = buildCritiquePrompt(candidate, 'Failover is seamless.', [
      {
        rule: 'banned-phrase:seamless',
        message: 'The draft uses "seamless". Is it doing real semantic work?',
      },
    ])
    expect(prompt).toContain('seamless')
    expect(prompt).toContain('real semantic work')
  })
})

describe('buildRewritePrompt', () => {
  it('lists every issue', () => {
    const prompt = buildRewritePrompt('The draft.', ['too long', 'no numbers'])
    expect(prompt).toContain('too long')
    expect(prompt).toContain('no numbers')
    expect(prompt).toContain('The draft.')
  })
})

describe('sourceTextOf', () => {
  it('joins everything the number whitelist checks against', () => {
    const text = sourceTextOf(candidate)
    expect(text).toContain('a/b')
    expect(text).toContain('A gateway.')
    expect(text).toContain('290 providers')
    expect(text).toContain('18.4k stars')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter tweet-generator test prompts`
Expected: FAIL — `Cannot find module './prompts.js'`

- [ ] **Step 3: Write the prompts**

Create `tweet-generator/src/llm/prompts.ts`:

```ts
import type { TweetArchetype } from 'shared'
import type { Candidate } from '../sources/candidates.js'
import { ARCHETYPES } from './archetypes.js'
import type { Violation } from './validate.js'

export interface Critique {
  verdict: 'pass' | 'revise'
  issues: string[]
}

/**
 * The persona.
 *
 * Note what is absent: any list of forbidden phrases. Naming a cliché in a
 * prompt puts it in context and makes it more likely, not less — the ban
 * belongs in the validator, which sees the finished text.
 */
export const SYSTEM_PROMPT = `You are an AI engineer who ships code, writing short posts for other engineers.

Your readers are peers. They already know what an LLM is, what a GPU costs, and why latency matters. Never explain the obvious.

How you write:
- One idea per post. Nothing else.
- The first word is already the point. No preamble, no throat-clearing.
- Concrete over abstract: numbers, model sizes, throughput, VRAM, licences, languages.
- Flat and dry. Never enthusiastic, never promotional.
- Short sentences. Ordinary words.
- You are not selling anything and you are not writing for recruiters or investors.

You always reply with a single JSON object and nothing else.`

/** Enough of a dispatch to write from. The first section carries the news. */
const BODY_LIMIT = 4000

/** Everything the number whitelist checks a draft against. */
export function sourceTextOf(candidate: Candidate): string {
  return [
    candidate.title,
    candidate.summary,
    candidate.body,
    ...candidate.facts,
  ].join('\n')
}

function shapeInstruction(archetype: TweetArchetype): string {
  const fields = ARCHETYPES[archetype].fields
  switch (archetype) {
    case 'digest':
      return `Reply with: {"hook": string, "highlights": string[]}

- "hook": the single most interesting thing here, at most ${fields.hook} characters.
- "highlights": exactly 3 strings, at most ${fields.highlight} characters each. Each one must carry a concrete number or a hard specific (a licence, a language, a model size).`
    case 'metric':
      return `Reply with: {"metric": string, "line": string}

- "metric": one hard number and its unit, at most ${fields.metric} characters. Nothing else — no sentence around it.
- "line": one sentence saying what the thing is and why that number matters, at most ${fields.line} characters.`
    case 'take':
      return `Reply with: {"text": string}

- "text": one opinionated sentence, at most ${fields.text} characters. State a judgement a peer might disagree with. Not a summary.`
    default:
      return `Reply with: {"text": string}

- "text": one pointed question for other engineers, at most ${fields.text} characters. It must come out of the material below and be answerable from experience. Never generic engagement bait.`
  }
}

export function buildGeneratePrompt(
  candidate: Candidate,
  archetype: TweetArchetype,
): string {
  const facts = candidate.facts.length
    ? candidate.facts.map((fact) => `- ${fact}`).join('\n')
    : '(none supplied — take every figure from the material below, verbatim)'

  return `${shapeInstruction(archetype)}

Hard rules:
- Every number you write must appear verbatim in the material below. Invent nothing.
- No links, no hashtags, no emoji.
- Write in English.

Figures you may quote, exactly as written here:
${facts}

Material:
---
TITLE: ${candidate.title}
SUMMARY: ${candidate.summary}

${candidate.body.slice(0, BODY_LIMIT)}
---`
}

export function buildCritiquePrompt(
  candidate: Candidate,
  text: string,
  soft: Violation[],
): string {
  const questions = soft.length
    ? `\nSpecific things to judge:\n${soft.map((v) => `- ${v.message}`).join('\n')}\n`
    : ''

  return `Judge this draft post as an engineer would when it appears in their timeline.

Draft:
---
${text}
---

Source material:
---
${candidate.title}
${candidate.summary}
---
${questions}
Reject it if: it reads like marketing, it says something a peer already knows, the hook does not land, a claim is not supported by the source, or any sentence could be deleted without loss.

Reply with: {"verdict": "pass" | "revise", "issues": string[]}

"issues" must be empty when the verdict is "pass". Otherwise each issue names one concrete thing to change. Be specific — "the hook is vague" is useless, "the hook says 'faster' without saying faster than what" is useful.`
}

export function buildRewritePrompt(text: string, issues: string[]): string {
  return `Rewrite this draft. Keep the same JSON shape you produced before.

Draft:
---
${text}
---

Fix every one of these, and change nothing else:
${issues.map((issue) => `- ${issue}`).join('\n')}`
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter tweet-generator test prompts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add tweet-generator/src/llm/prompts.ts tweet-generator/src/llm/prompts.test.ts
git commit -m "feat(tweet-generator): add the persona and pipeline prompts

The system prompt lists no forbidden phrases on purpose: naming a cliché in
a prompt puts it in context and makes it more likely. The ban belongs in
the validator, which sees the finished text."
```

---

### Task 14: The four-stage pipeline

**Files:**
- Create: `tweet-generator/src/llm/pipeline.ts`, `tweet-generator/src/llm/pipeline.test.ts`
- Modify: `tweet-generator/src/index.ts`

**Interfaces:**
- Consumes: everything in `src/llm/`.
- Produces:
  - `interface PipelineResult { text: string; draft: Draft; rounds: number }`
  - `generateTweet(candidate, archetype, deps): Promise<PipelineResult>`
  - `class GenerationGaveUp extends Error { readonly violations: string[] }`

- [ ] **Step 1: Write the failing test**

Create `tweet-generator/src/llm/pipeline.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { Candidate } from '../sources/candidates.js'
import { DEFAULT_BANNED_PHRASES } from './validate.js'
import {
  generateTweet,
  GenerationGaveUp,
  type PipelineDeps,
} from './pipeline.js'

const candidate: Candidate = {
  kind: 'gh_project',
  externalId: 'ghp:a/b',
  title: 'a/b',
  summary: 'A gateway with 290 providers.',
  body: 'One endpoint for 290 providers and 500 models.',
  facts: ['a/b', '18.4k stars', '+443 stars/day', 'MIT'],
  sourceUrl: 'https://github.com/a/b',
  freshness: new Date('2026-08-05T02:00:00.000Z'),
  dedupeKey: 'agentlens:project:ghp:a/b:stars-10k',
}

const goodDraft = JSON.stringify({
  hook: 'One endpoint, 290 providers.',
  highlights: ['18.4k stars', '+443 stars/day', 'MIT'],
})

const badNumberDraft = JSON.stringify({
  hook: 'It cuts cost by 93%.',
  highlights: ['18.4k stars', '+443 stars/day', 'MIT'],
})

const pass = JSON.stringify({ verdict: 'pass', issues: [] })
const revise = JSON.stringify({
  verdict: 'revise',
  issues: ['the hook does not say what it replaces'],
})

function deps(chat: (messages: unknown) => Promise<string>): PipelineDeps {
  return {
    chat: chat as PipelineDeps['chat'],
    banned: DEFAULT_BANNED_PHRASES,
    maxRounds: 3,
  }
}

describe('generateTweet', () => {
  it('returns on the first round when the draft validates and passes critique', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(goodDraft)
      .mockResolvedValueOnce(pass)

    const result = await generateTweet(candidate, 'digest', deps(chat))

    expect(result.rounds).toBe(1)
    expect(result.text).toContain('One endpoint, 290 providers.')
    expect(result.text).toContain('→ 18.4k stars')
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('does not spend a critique call on a draft that fails validation', async () => {
    // The deterministic gate runs first because it is free.
    const chat = vi
      .fn()
      .mockResolvedValueOnce(badNumberDraft)
      .mockResolvedValueOnce(goodDraft)
      .mockResolvedValueOnce(pass)

    await generateTweet(candidate, 'digest', deps(chat))

    // Three calls: generate, rewrite, critique. Never a critique on round 1.
    expect(chat).toHaveBeenCalledTimes(3)
  })

  it('rewrites against critique issues and returns the fixed draft', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(goodDraft)
      .mockResolvedValueOnce(revise)
      .mockResolvedValueOnce(goodDraft)
      .mockResolvedValueOnce(pass)

    const result = await generateTweet(candidate, 'digest', deps(chat))

    expect(result.rounds).toBe(2)
    const rewritePrompt = JSON.stringify(chat.mock.calls[2]![0])
    expect(rewritePrompt).toContain('the hook does not say what it replaces')
  })

  it('gives up after maxRounds and reports what was still wrong', async () => {
    const chat = vi.fn().mockResolvedValue(badNumberDraft)

    await expect(
      generateTweet(candidate, 'digest', deps(chat)),
    ).rejects.toThrow(GenerationGaveUp)

    try {
      await generateTweet(candidate, 'digest', deps(chat))
    } catch (error) {
      expect((error as GenerationGaveUp).violations.join(' ')).toContain('93%')
    }
  })

  it('feeds the previous round\'s rules forward so the loop guard can fire', async () => {
    // Round 1 fails on "buckle up"; round 2 sees it repeat and downgrades it,
    // so the post ships rather than being lost to an unsatisfiable rule.
    const cliche = JSON.stringify({ text: 'Buckle up, 290 providers.' })
    const chat = vi
      .fn()
      .mockResolvedValueOnce(cliche)
      .mockResolvedValueOnce(cliche)
      .mockResolvedValueOnce(pass)

    const result = await generateTweet(candidate, 'take', deps(chat))

    expect(result.rounds).toBe(2)
    expect(result.text).toContain('Buckle up')
  })

  it('passes soft flags to the critique prompt', async () => {
    const soft = JSON.stringify({ text: 'Failover is seamless across 290 providers.' })
    const chat = vi.fn().mockResolvedValueOnce(soft).mockResolvedValueOnce(pass)

    await generateTweet(candidate, 'take', deps(chat))

    const critiquePrompt = JSON.stringify(chat.mock.calls[1]![0])
    expect(critiquePrompt).toContain('seamless')
  })

  it('treats an unparseable reply as a failed round rather than a crash', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce('I cannot help with that.')
      .mockResolvedValueOnce(goodDraft)
      .mockResolvedValueOnce(pass)

    const result = await generateTweet(candidate, 'digest', deps(chat))
    expect(result.rounds).toBe(2)
  })

  it('treats an unparseable critique as a pass rather than losing the draft', async () => {
    // The draft already cleared the deterministic gate. Discarding it
    // because the critic replied badly trades a good post for nothing.
    const chat = vi
      .fn()
      .mockResolvedValueOnce(goodDraft)
      .mockResolvedValueOnce('looks fine to me!')

    const result = await generateTweet(candidate, 'digest', deps(chat))
    expect(result.rounds).toBe(1)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter tweet-generator test pipeline`
Expected: FAIL — `Cannot find module './pipeline.js'`

- [ ] **Step 3: Write the pipeline**

Create `tweet-generator/src/llm/pipeline.ts`:

```ts
import type { TweetArchetype } from 'shared'
import type { Candidate } from '../sources/candidates.js'
import { assemble, type Draft } from './assemble.js'
import { extractJson, LlmError, type ChatMessage } from './client.js'
import {
  buildCritiquePrompt,
  buildGeneratePrompt,
  buildRewritePrompt,
  sourceTextOf,
  SYSTEM_PROMPT,
  type Critique,
} from './prompts.js'
import { validate, type BannedPhrases, type Violation } from './validate.js'

export interface PipelineDeps {
  chat(messages: ChatMessage[]): Promise<string>
  banned: BannedPhrases
  maxRounds: number
}

export interface PipelineResult {
  text: string
  draft: Draft
  rounds: number
}

/** Every round used up without a draft that passed. The cycle skips. */
export class GenerationGaveUp extends Error {
  constructor(
    message: string,
    readonly violations: string[],
  ) {
    super(message)
    this.name = 'GenerationGaveUp'
  }
}

/** The model returns loose fields; this pins them to the archetype's shape. */
function toDraft(archetype: TweetArchetype, parsed: Record<string, unknown>): Draft {
  switch (archetype) {
    case 'digest':
      return {
        archetype,
        hook: String(parsed.hook ?? ''),
        highlights: Array.isArray(parsed.highlights)
          ? parsed.highlights.map(String)
          : [],
      }
    case 'metric':
      return {
        archetype,
        metric: String(parsed.metric ?? ''),
        line: String(parsed.line ?? ''),
      }
    default:
      return { archetype, text: String(parsed.text ?? '') }
  }
}

/**
 * Generate → validate → critique → rewrite.
 *
 * Validation runs before the critique because it is free: a critique call
 * should never be spent on a draft that is already mechanically broken.
 *
 * Rules that fired on the previous round are carried forward so the
 * validator's loop guard can downgrade a stylistic rule the model has now
 * failed twice — a rule the model cannot satisfy is a broken rule.
 */
export async function generateTweet(
  candidate: Candidate,
  archetype: TweetArchetype,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const sourceText = sourceTextOf(candidate)
  const system: ChatMessage = { role: 'system', content: SYSTEM_PROMPT }

  let prompt = buildGeneratePrompt(candidate, archetype)
  let previousRules = new Set<string>()
  let lastViolations: string[] = ['no draft was produced']

  for (let round = 1; round <= deps.maxRounds; round++) {
    let draft: Draft
    let text: string
    try {
      const reply = await deps.chat([system, { role: 'user', content: prompt }])
      draft = toDraft(archetype, extractJson<Record<string, unknown>>(reply))
      text = assemble(draft)
    } catch (error) {
      if (!(error instanceof LlmError)) throw error
      // A reply we could not parse is a failed round, not a crash. The next
      // round re-asks from scratch.
      lastViolations = [error.message]
      prompt = buildGeneratePrompt(candidate, archetype)
      previousRules = new Set()
      continue
    }

    const result = validate({
      draft,
      text,
      sourceText,
      repeatedRules: previousRules,
      banned: deps.banned,
    })

    if (!result.ok) {
      lastViolations = result.hard.map((violation) => violation.message)
      previousRules = new Set(result.hard.map((violation) => violation.rule))
      prompt = buildRewritePrompt(text, lastViolations)
      continue
    }

    const critique = await runCritique(candidate, text, result.soft, deps, system)
    if (critique.verdict === 'pass' || critique.issues.length === 0) {
      return { text, draft, rounds: round }
    }

    lastViolations = critique.issues
    previousRules = new Set()
    prompt = buildRewritePrompt(text, critique.issues)
  }

  throw new GenerationGaveUp(
    `Gave up after ${deps.maxRounds} rounds`,
    lastViolations,
  )
}

/**
 * A critic that replies with something unparseable is treated as a pass.
 *
 * The draft has already cleared the deterministic gate, so it is publishable.
 * Discarding it because the critic answered badly trades a good post for
 * nothing at all.
 */
async function runCritique(
  candidate: Candidate,
  text: string,
  soft: Violation[],
  deps: PipelineDeps,
  system: ChatMessage,
): Promise<Critique> {
  try {
    const reply = await deps.chat([
      system,
      { role: 'user', content: buildCritiquePrompt(candidate, text, soft) },
    ])
    const parsed = extractJson<Partial<Critique>>(reply)
    return {
      verdict: parsed.verdict === 'revise' ? 'revise' : 'pass',
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
    }
  } catch (error) {
    if (!(error instanceof LlmError)) throw error
    return { verdict: 'pass', issues: [] }
  }
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter tweet-generator test pipeline`
Expected: PASS — 8 tests.

- [ ] **Step 5: Wire the pipeline into the service loop**

In `tweet-generator/src/index.ts`, add the imports:

```ts
import { pickArchetype } from './llm/archetypes.js'
import { LlmClient, LlmError } from './llm/client.js'
import { loadBannedPhrases, type BannedPhrases } from './llm/validate.js'
```

Add the client and a lazily loaded phrase list beside the other singletons:

```ts
const llm = new LlmClient(config.llm)
let banned: BannedPhrases | null = null
```

Replace the placeholder block inside the `for (const kind of order)` loop —
everything from `// Phase 1 placeholder.` down to and including the
`store.enqueue` call — with:

```ts
    banned ??= await loadBannedPhrases(config.bannedPhrasesFile)
    const archetype = pickArchetype(await store.lastArchetype())

    // Declared outside the try so Task 16 can reach `generated.draft` when
    // it renders the card.
    let generated: PipelineResult
    try {
      generated = await generateTweet(candidate, archetype, {
        chat: (messages) => llm.chat(messages),
        banned,
        maxRounds: config.maxRounds,
      })
      logger.info('Generated', {
        externalId: candidate.externalId,
        archetype,
        rounds: generated.rounds,
      })
    } catch (error) {
      if (error instanceof GenerationGaveUp) {
        // The candidate stays out of the pool for good after three of these,
        // so one item the model cannot handle cannot starve its source.
        await store.recordFailure(
          candidate.externalId,
          error.violations.join('; '),
        )
        logger.warn('Gave up on a candidate', {
          externalId: candidate.externalId,
          violations: error.violations,
        })
        return
      }
      throw error
    }

    const id = await store.enqueue({
      content: generated.text,
      dedupeKey: candidate.dedupeKey,
      source: candidate.kind,
      sourceRef: candidate.externalId,
      archetype,
    })
```

The `PipelineResult` type comes from the same import as `generateTweet`:

```ts
import {
  generateTweet,
  GenerationGaveUp,
  type PipelineResult,
} from './llm/pipeline.js'
```

Then extend the error handling in `main` so an unreachable LLM alerts the same
way an unreachable AgentLens does. Replace the `if (error instanceof AgentLensError)`
condition with:

```ts
      if (error instanceof AgentLensError || error instanceof LlmError) {
        consecutiveSourceFailures += 1
        logger.warn('An upstream dependency is unreachable', {
          error: message,
          consecutive: consecutiveSourceFailures,
        })
        if (consecutiveSourceFailures === 3) {
          await notifyFailure(
            config.discordWebhookUrl,
            'tweet-generator',
            `Upstream unreachable for ${consecutiveSourceFailures} cycles: ${message}`,
          )
        }
      } else {
```

- [ ] **Step 6: Run the full suite and type check**

Run: `pnpm --filter tweet-generator test && pnpm --filter tweet-generator build`
Expected: PASS, `tsc` clean.

- [ ] **Step 7: Run one real cycle against the pinned model**

```bash
# set LLM_MODEL in tweet-generator/.env to your pinned model first,
# and disable prompt compression on that OmniRoute route
pnpm --filter tweet-generator start
```

Expected: a `Generated` log line with a round count, then `Enqueued`. Read the
row and judge the copy yourself:

```bash
docker compose exec postgres psql -U app_user -d multi_tab_listening \
  -c "SELECT archetype, source, content FROM tweets ORDER BY id DESC LIMIT 3;"
```

If the copy is weak, that is a prompt problem, not a code problem — iterate on
`SYSTEM_PROMPT` and `shapeInstruction` in `prompts.ts` before moving on. This is
the last checkpoint before real posts.

- [ ] **Step 8: Commit**

```bash
git add tweet-generator/src
git commit -m "feat(tweet-generator): add the four-stage generation pipeline

Validation runs before critique because it is free: a critique call should
never be spent on a draft that is already mechanically broken.

An unparseable critique counts as a pass. The draft already cleared the
deterministic gate, so discarding it because the critic answered badly
trades a good post for nothing."
```

---

### Task 15: Card templates

**Files:**
- Create: `tweet-generator/scripts/embed-fonts.mjs`
- Create: `tweet-generator/src/image/fonts.ts` (generated, committed)
- Create: `tweet-generator/src/image/template.ts`, `tweet-generator/src/image/template.test.ts`
- Modify: `tweet-generator/package.json`

**Interfaces:**
- Consumes: `Draft` from `../llm/assemble.js`; `Candidate`.
- Produces:
  - `interface CardInput { draft: Draft; candidate: Candidate; variant: string }`
  - `VARIANTS` — an `as const` object: `{ digest: ['slate', 'paper'], metric: ['slate'] }`
  - `pickVariant(archetype: 'digest' | 'metric', last: string | null, rng?: Rng): string`
  - `renderTemplate(input: CardInput): string`
  - `WATERMARK = 'agentlenshq.com'`

- [ ] **Step 1: Add the font packages and the embed script**

```bash
pnpm --filter tweet-generator add -D @fontsource/inter @fontsource/jetbrains-mono
```

Create `tweet-generator/scripts/embed-fonts.mjs`:

```js
/**
 * Bakes two woff2 files into a committed TypeScript module.
 *
 * A `font-family: Inter, sans-serif` declaration renders differently on
 * macOS and in a container — different metrics, different wrapping, broken
 * cards. Reading the fonts from node_modules at runtime would work until
 * someone prunes dev dependencies, so the bytes are committed instead.
 *
 * Run: node scripts/embed-fonts.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'

const FILES = {
  inter: 'node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2',
  mono: 'node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2',
}

const parts = []
for (const [name, path] of Object.entries(FILES)) {
  const base64 = (await readFile(path)).toString('base64')
  parts.push(`export const ${name}Woff2 = '${base64}'`)
}

await writeFile(
  'src/image/fonts.ts',
  `/* Generated by scripts/embed-fonts.mjs. Do not edit. */\n\n${parts.join('\n\n')}\n`,
)
console.log('Wrote src/image/fonts.ts')
```

Add the script to `tweet-generator/package.json`:

```json
    "embed-fonts": "node scripts/embed-fonts.mjs",
```

Run it:

```bash
pnpm --filter tweet-generator run embed-fonts
```

Expected: `src/image/fonts.ts` exists and exports two long base64 strings.

- [ ] **Step 2: Write the failing template test**

Create `tweet-generator/src/image/template.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mulberry32 } from 'shared/rng'
import type { Candidate } from '../sources/candidates.js'
import { pickVariant, renderTemplate, VARIANTS, WATERMARK } from './template.js'

const candidate: Candidate = {
  kind: 'gh_project',
  externalId: 'ghp:a/b',
  title: 'a/b',
  summary: 'A gateway.',
  body: 'One endpoint.',
  facts: ['a/b', '18.4k stars', '+443 stars/day', 'MIT'],
  sourceUrl: 'https://github.com/a/b',
  freshness: new Date('2026-08-05T02:00:00.000Z'),
  dedupeKey: 'agentlens:project:ghp:a/b:stars-10k',
}

describe('pickVariant', () => {
  it('never repeats the previous variant when there is a choice', () => {
    const rng = mulberry32(5)
    for (let i = 0; i < 200; i++) {
      expect(pickVariant('digest', VARIANTS.digest[0]!, rng)).not.toBe(
        VARIANTS.digest[0],
      )
    }
  })

  it('returns the only variant when an archetype has just one', () => {
    // metric ships a single card, so "never twice in a row" cannot apply to
    // it — enforcing it there would make the picker unsatisfiable.
    expect(VARIANTS.metric).toHaveLength(1)
    expect(pickVariant('metric', VARIANTS.metric[0]!)).toBe(VARIANTS.metric[0])
  })
})

describe('renderTemplate', () => {
  const html = renderTemplate({
    draft: {
      archetype: 'digest',
      hook: 'One endpoint, 290 providers.',
      highlights: ['18.4k stars', '+443 stars/day', 'MIT'],
    },
    candidate,
    variant: VARIANTS.digest[0]!,
  })

  it('carries the hook and every highlight', () => {
    expect(html).toContain('One endpoint, 290 providers.')
    expect(html).toContain('18.4k stars')
    expect(html).toContain('+443 stars/day')
    expect(html).toContain('MIT')
  })

  it('carries the watermark', () => {
    expect(html).toContain(WATERMARK)
  })

  it('names the source on the card', () => {
    // With no link in the tweet body, the card is the only attribution.
    expect(html).toContain('a/b')
  })

  it('embeds both fonts rather than referencing a family by name', () => {
    expect(html).toContain('@font-face')
    expect(html).toContain('data:font/woff2;base64,')
  })

  it('makes no external request', () => {
    // The renderer runs offline and a missing asset silently changes the
    // layout rather than failing.
    expect(html).not.toMatch(/https?:\/\//)
  })

  it('escapes HTML in model output', () => {
    const escaped = renderTemplate({
      draft: {
        archetype: 'digest',
        hook: '<script>alert(1)</script>',
        highlights: ['a & b', '"quoted"', "it's"],
      },
      candidate,
      variant: VARIANTS.digest[0]!,
    })
    expect(escaped).not.toContain('<script>')
    expect(escaped).toContain('&lt;script&gt;')
    expect(escaped).toContain('a &amp; b')
  })

  it('renders a metric card from a metric draft', () => {
    const metric = renderTemplate({
      draft: { archetype: 'metric', metric: '+443 stars/day', line: 'A gateway.' },
      candidate,
      variant: VARIANTS.metric[0]!,
    })
    expect(metric).toContain('+443 stars/day')
    expect(metric).toContain('A gateway.')
  })

  it('produces a stable string for the same input', () => {
    // Snapshot stability is what makes this testable at all — comparing
    // screenshots would be brittle for no benefit.
    const again = renderTemplate({
      draft: {
        archetype: 'digest',
        hook: 'One endpoint, 290 providers.',
        highlights: ['18.4k stars', '+443 stars/day', 'MIT'],
      },
      candidate,
      variant: VARIANTS.digest[0]!,
    })
    expect(again).toBe(html)
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm --filter tweet-generator test template`
Expected: FAIL — `Cannot find module './template.js'`

- [ ] **Step 4: Write the templates**

Create `tweet-generator/src/image/template.ts`:

```ts
import type { Rng } from 'shared/rng'
import type { Draft } from '../llm/assemble.js'
import type { Candidate } from '../sources/candidates.js'
import { interWoff2, monoWoff2 } from './fonts.js'

export const WATERMARK = 'agentlenshq.com'

/**
 * Visual variants per archetype.
 *
 * More than one exists for the same reason there is more than one archetype:
 * an identically styled card on every post is a trivially learnable
 * fingerprint. `metric` has one because its layout is a single number and
 * there is no second honest way to lay that out.
 */
export const VARIANTS = {
  digest: ['slate', 'paper'],
  metric: ['slate'],
} as const

export function pickVariant(
  archetype: 'digest' | 'metric',
  last: string | null,
  rng: Rng = Math.random,
): string {
  const all = VARIANTS[archetype]
  const eligible = all.filter((variant) => variant !== last)
  const pool = eligible.length > 0 ? eligible : all
  return pool[Math.floor(rng() * pool.length)]!
}

export interface CardInput {
  draft: Draft
  candidate: Candidate
  variant: string
}

/** Model output goes straight into markup, so it is escaped without exception. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface Palette {
  background: string
  foreground: string
  muted: string
  accent: string
  rule: string
}

const PALETTES: Record<string, Palette> = {
  slate: {
    background: '#0d1117',
    foreground: '#e6edf3',
    muted: '#7d8590',
    accent: '#4ec9b0',
    rule: '#21262d',
  },
  paper: {
    background: '#fbf9f4',
    foreground: '#1c1917',
    muted: '#78716c',
    accent: '#b4530a',
    rule: '#e7e2d8',
  },
}

function shell(palette: Palette, source: string, body: string): string {
  return `<style>
@font-face {
  font-family: 'Card';
  src: url(data:font/woff2;base64,${interWoff2}) format('woff2');
  font-weight: 600;
}
@font-face {
  font-family: 'CardMono';
  src: url(data:font/woff2;base64,${monoWoff2}) format('woff2');
  font-weight: 500;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  width: 1600px; height: 900px;
  background: ${palette.background};
  color: ${palette.foreground};
  font-family: 'Card', sans-serif;
  display: flex; flex-direction: column;
  padding: 88px 96px;
}
.source {
  font-family: 'CardMono', monospace;
  font-size: 30px; color: ${palette.accent};
  letter-spacing: 0.02em;
}
.spacer { flex: 1; }
.hook { font-size: 76px; line-height: 1.15; letter-spacing: -0.02em; }
.rows { margin-top: 56px; display: flex; flex-direction: column; gap: 26px; }
.row {
  font-family: 'CardMono', monospace;
  font-size: 38px; color: ${palette.foreground};
  display: flex; gap: 24px; align-items: baseline;
}
.row::before { content: '—'; color: ${palette.accent}; }
.big {
  font-family: 'CardMono', monospace;
  font-size: 168px; line-height: 1; letter-spacing: -0.03em;
  color: ${palette.accent};
}
.line { margin-top: 48px; font-size: 46px; line-height: 1.3; color: ${palette.foreground}; }
.foot {
  margin-top: 64px; padding-top: 32px;
  border-top: 2px solid ${palette.rule};
  display: flex; justify-content: flex-end;
  font-family: 'CardMono', monospace;
  font-size: 26px; color: ${palette.muted};
}
</style>
<div class="source">${escapeHtml(source)}</div>
<div class="spacer"></div>
${body}
<div class="foot">${WATERMARK}</div>`
}

export function renderTemplate(input: CardInput): string {
  const palette = PALETTES[input.variant] ?? PALETTES.slate!
  const source = input.candidate.title

  if (input.draft.archetype === 'metric') {
    return shell(
      palette,
      source,
      `<div class="big">${escapeHtml(input.draft.metric)}</div>
<div class="line">${escapeHtml(input.draft.line)}</div>`,
    )
  }

  if (input.draft.archetype === 'digest') {
    const rows = input.draft.highlights
      .map((highlight) => `  <div class="row">${escapeHtml(highlight)}</div>`)
      .join('\n')
    return shell(
      palette,
      source,
      `<div class="hook">${escapeHtml(input.draft.hook)}</div>
<div class="rows">
${rows}
</div>`,
    )
  }

  // take and question never render a card; callers check `hasImage` first.
  throw new Error(`${input.draft.archetype} posts do not have a card`)
}
```

- [ ] **Step 5: Run it to confirm it passes**

Run: `pnpm --filter tweet-generator test template`
Expected: PASS — 10 tests.

- [ ] **Step 6: Commit**

```bash
git add tweet-generator
git commit -m "feat(tweet-generator): add card templates with embedded fonts

Fonts are baked into the module rather than named. A font-family
declaration renders differently on macOS and in a container — different
metrics, different wrapping, broken cards — and the template makes zero
external requests as a result.

Model output is escaped without exception: it goes straight into markup."
```

---

### Task 16: Rendering and media retention

**Files:**
- Create: `tweet-generator/src/image/render.ts`, `tweet-generator/src/image/render.test.ts`
- Modify: `tweet-generator/src/index.ts`

**Interfaces:**
- Consumes: `renderTemplate` from `./template.js`; `playwright`.
- Produces:
  - `mediaPathFor(mediaDir: string, dedupeKey: string): string`
  - `renderCard(html: string, outPath: string): Promise<void>`
  - `cleanupMedia(paths: string[]): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `tweet-generator/src/image/render.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanupMedia, mediaPathFor, renderCard } from './render.js'
import { renderTemplate, VARIANTS } from './template.js'
import type { Candidate } from '../sources/candidates.js'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tweet-generator-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('mediaPathFor', () => {
  it('is deterministic, so a retry overwrites its own file', () => {
    expect(mediaPathFor('./media', 'agentlens:blog:abc')).toBe(
      mediaPathFor('./media', 'agentlens:blog:abc'),
    )
  })

  it('differs per dedupe key', () => {
    expect(mediaPathFor('./media', 'a')).not.toBe(mediaPathFor('./media', 'b'))
  })

  it('produces a filesystem-safe name from a key full of colons and slashes', () => {
    const path = mediaPathFor('./media', 'agentlens:project:ghp:a/b:stars-10k')
    expect(path.startsWith('media/')).toBe(true)
    expect(path.slice('media/'.length)).toMatch(/^[0-9a-f]{16}\.png$/)
  })
})

describe('renderCard', () => {
  it('writes a PNG of the expected dimensions', async () => {
    const candidate = {
      kind: 'gh_project',
      externalId: 'ghp:a/b',
      title: 'a/b',
      summary: 'A gateway.',
      body: '',
      facts: [],
      sourceUrl: null,
      freshness: new Date(),
      dedupeKey: 'k',
    } as Candidate

    const html = renderTemplate({
      draft: {
        archetype: 'digest',
        hook: 'One endpoint, 290 providers.',
        highlights: ['18.4k stars', '+443 stars/day', 'MIT'],
      },
      candidate,
      variant: VARIANTS.digest[0]!,
    })

    const out = join(dir, 'card.png')
    await renderCard(html, out)

    const bytes = await readFile(out)
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
    // PNG stores width and height as big-endian uint32 at offsets 16 and 20.
    // deviceScaleFactor 2 doubles the 1600x900 viewport.
    expect(bytes.readUInt32BE(16)).toBe(3200)
    expect(bytes.readUInt32BE(20)).toBe(1800)
  }, 60_000)
})

describe('cleanupMedia', () => {
  it('deletes the files it is given and counts them', async () => {
    const path = join(dir, 'old.png')
    await writeFile(path, 'x')
    expect(await cleanupMedia([path])).toBe(1)
  })

  it('ignores a file that is already gone', async () => {
    // Retention runs every cycle against rows that may have been cleaned by
    // a previous run. A missing file is the expected steady state.
    expect(await cleanupMedia([join(dir, 'never-existed.png')])).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter tweet-generator test render`
Expected: FAIL — `Cannot find module './render.js'`

- [ ] **Step 3: Write the renderer**

Create `tweet-generator/src/image/render.ts`:

```ts
import { createHash } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'

const WIDTH = 1600
const HEIGHT = 900

/**
 * A deterministic filename, so a retried candidate overwrites its own file
 * rather than orphaning one. Hashing is also what makes a dedupe key full of
 * colons and slashes safe to put on a filesystem.
 */
export function mediaPathFor(mediaDir: string, dedupeKey: string): string {
  const digest = createHash('sha256').update(dedupeKey).digest('hex').slice(0, 16)
  return join(mediaDir, `${digest}.png`)
}

/**
 * Renders one card in a throwaway headless Chromium.
 *
 * A browser is launched and closed per render on purpose. At one image every
 * two hours there is no throughput to gain, and a long-lived instance is a
 * leak, a wedge risk, and a health check to maintain.
 *
 * This must never touch the x-poster's Chrome profile: that one holds a live
 * x.com session behind an open CDP debugging port, and any local process
 * that connects to it gains full control of the account.
 */
export async function renderCard(html: string, outPath: string): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true })

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 2,
    })
    await page.setContent(html, { waitUntil: 'load' })
    // Embedded fonts decode asynchronously; screenshotting before they are
    // ready captures a fallback face and different metrics.
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: outPath })
  } finally {
    await browser.close()
  }
}

/** Returns how many files were actually removed. */
export async function cleanupMedia(paths: string[]): Promise<number> {
  let removed = 0
  for (const path of paths) {
    try {
      await unlink(path)
      removed++
    } catch {
      // Already gone is the expected steady state: retention runs every
      // cycle against rows a previous run may have cleaned.
    }
  }
  return removed
}
```

- [ ] **Step 4: Install the browser and run the test**

```bash
pnpm --filter tweet-generator exec playwright install chromium
pnpm --filter tweet-generator test render
```
Expected: PASS — 5 tests. The render test takes a few seconds.

- [ ] **Step 5: Inspect one card by eye**

```bash
node --input-type=module -e "
import { renderTemplate, VARIANTS } from './tweet-generator/src/image/template.js'
" 2>/dev/null || true
```

Rather than scripting it, run the service once with the pipeline wired
(Step 6 below) and open the PNG that lands in `tweet-generator/media/`. A
card is a visual artefact; the only useful check is looking at it. Confirm
the watermark is legible, nothing overflows the frame, and both fonts
rendered (the metric rows should be monospaced).

- [ ] **Step 6: Wire rendering into the service loop**

In `tweet-generator/src/index.ts`, add:

```ts
import { ARCHETYPES } from './llm/archetypes.js'
import { cleanupMedia, mediaPathFor, renderCard } from './image/render.js'
import { pickVariant, renderTemplate } from './image/template.js'
```

Add a variant memory beside the other module state. Unlike the archetype,
this is not worth a database column: repeating a card style is far less
visible than repeating a post shape, and losing the value on restart costs
nothing:

```ts
let lastVariant: string | null = null
```

After the `generateTweet` block and before `store.enqueue`, insert:

```ts
    let mediaPath: string | undefined
    if (ARCHETYPES[archetype].hasImage) {
      const cardArchetype = archetype as 'digest' | 'metric'
      const variant = pickVariant(cardArchetype, lastVariant)
      const path = mediaPathFor(config.mediaDir, candidate.dedupeKey)
      // A render failure abandons the whole item. Enqueueing the text alone
      // would ship a degraded post that can never be repaired, because the
      // dedupe key is spent the moment the row exists.
      await renderCard(
        renderTemplate({ draft: generated.draft, candidate, variant }),
        path,
      )
      lastVariant = variant
      mediaPath = path
    }
```

`generated` is already declared outside the `try` from Task 14, so no
restructuring is needed. Add `mediaPath` to the enqueue call:

```ts
    const id = await store.enqueue({
      content: generated.text,
      dedupeKey: candidate.dedupeKey,
      source: candidate.kind,
      sourceRef: candidate.externalId,
      archetype,
      mediaPath,
    })
```

Finally, add retention at the top of `tick()`, before the usage query:

```ts
  const retentionCutoff = new Date(
    Date.now() - config.mediaRetentionDays * 86_400_000,
  )
  const removed = await cleanupMedia(await store.expiredMedia(retentionCutoff))
  if (removed > 0) logger.info('Cleaned up old media', { removed })
```

- [ ] **Step 7: Run the full suite and one real cycle**

```bash
pnpm --filter tweet-generator test && pnpm --filter tweet-generator build
pnpm --filter tweet-generator start
```

Expected: a `Generated` line, then `Enqueued`. Roughly two cycles in three
should produce a file in `tweet-generator/media/` — `take` and `question`
posts have no card. Open one and check it.

- [ ] **Step 8: Commit**

```bash
git add tweet-generator/src
git commit -m "feat(tweet-generator): render card images

A browser per render, closed immediately: at one image every two hours
there is no throughput to gain, and a long-lived instance is a leak and a
wedge risk. It also must never share the x-poster's profile, which holds a
live session behind an open debugging port.

A render failure abandons the whole item rather than shipping text alone —
the dedupe key is spent the moment the row exists, so a degraded post can
never be repaired."
```

---

### Task 17: Media upload in the composer

**Files:**
- Modify: `x-poster/src/x/selectors.ts`
- Modify: `x-poster/src/x/composer.ts`
- Modify: `x-poster/src/index.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `Tweet.mediaPath`.
- Produces: `postTweet(page, content, mediaPath: string | null, config, logger)` — the signature gains one parameter.

- [ ] **Step 1: Add the selectors**

In `x-poster/src/x/selectors.ts`, add two entries and keep the file's habit of
explaining each one:

```ts
  /**
   * The composer's hidden file input.
   *
   * `setInputFiles` writes this directly. Clicking the visible media button
   * instead opens a NATIVE OS file dialog in a real, non-headless Chrome;
   * Playwright's filechooser interception is less reliable against a
   * CDP-attached browser, and one missed interception leaves a modal system
   * dialog blocking the session — on an unattended process, until someone
   * notices.
   */
  fileInput: '[role="dialog"] input[type="file"][data-testid="fileInput"]',

  /**
   * Appears once an attachment has finished uploading and is previewable.
   *
   * X disables the submit button while an upload is in flight, so this is
   * the signal that submitting is safe. Submitting early either posts
   * without the image or throws.
   */
  mediaReady: '[role="dialog"] [data-testid="removeMedia"]',
```

- [ ] **Step 2: Add the upload step to the composer**

In `x-poster/src/x/composer.ts`, add the import:

```ts
import { RetryableError } from '../errors.js'
```

(`FatalError` and `UncertainError` are already imported; add `RetryableError`
to the existing import statement rather than adding a second one.)

Change the signature:

```ts
export async function postTweet(
  page: Page,
  content: string,
  mediaPath: string | null,
  config: XPosterConfig,
  logger: winston.Logger,
): Promise<PostResult> {
```

Insert this between step 4 (the paste verification) and step 5 (the re-read),
immediately after the `if (!typed.includes(head))` block:

```ts
  // 4b. Attach the card, if this tweet has one.
  if (mediaPath) {
    await page.locator(selectors.fileInput).first().setInputFiles(mediaPath)

    try {
      await page
        .locator(selectors.mediaReady)
        .first()
        .waitFor({ state: 'visible', timeout: 60_000 })
    } catch (error) {
      // Submit has not been clicked, so the tweet definitively did not post
      // and retrying is safe. Classifying this as uncertain would strand a
      // healthy tweet awaiting manual review.
      throw new RetryableError(
        `The image at ${mediaPath} never finished uploading`,
        { cause: error },
      )
    }

    // The preview appearing and the upload being committed are not quite the
    // same instant, and this is also just what a person does after attaching
    // something.
    await humanDelay(900, 2400)
    logger.debug('Attached media', { mediaPath })
  }
```

- [ ] **Step 3: Pass the path from the service loop**

In `x-poster/src/index.ts`, update the call:

```ts
    const result = await postTweet(
      handle.page,
      tweet.content,
      tweet.mediaPath,
      config,
      logger,
    )
```

- [ ] **Step 4: Type check both packages**

Run: `pnpm --filter x-poster test && pnpm --filter x-poster build`
Expected: PASS, `tsc` clean.

- [ ] **Step 5: Verify the upload by hand**

This step cannot be unit-tested — it drives a live logged-in browser — so it
is verified by eye. With `X_DRY_RUN=true` in `x-poster/.env`:

```bash
# ensure the queue holds at least one row with a media_path
docker compose exec postgres psql -U app_user -d multi_tab_listening \
  -c "SELECT id, archetype, media_path FROM tweets WHERE status = 'pending' AND media_path IS NOT NULL LIMIT 3;"

pnpm --filter x-poster start
```

Expected: `x-poster` opens the composer, pastes the text, attaches the image,
and stops before submit, writing `screenshots/dry-run-*.png`. **Open that
screenshot and confirm the image thumbnail is present in the composer.** A
dry run that shows text but no thumbnail means the upload silently failed and
must be fixed before going live.

- [ ] **Step 6: Document the operator steps**

In `README.md`, under the X Poster section, note that tweets carrying a
`media_path` attach that file, and add the two OmniRoute prerequisites to the
Tweet Generator section:

```markdown
The tweet generator needs a local OpenAI-compatible endpoint. With OmniRoute:

- **Pin `LLM_MODEL` to one model.** `auto` is rejected by the config loader —
  it falls back across four provider tiers, so the same prompt is served by a
  frontier model one day and a free tier-4 model the next, and these posts go
  out unattended.
- **Disable prompt compression (RTK / Caveman) on this route.** The prompts
  carry a banned-phrase list and a hard character budget: material whose exact
  wording is the point.
```

Add to the Features list:

```markdown
- Tweets written from AgentLens dispatches by a pinned local LLM, gated by a deterministic validator (character budget, banned-phrase tiers, and a whitelist that rejects any number not present in the source material)
```

- [ ] **Step 7: Commit**

```bash
git add x-poster README.md
git commit -m "feat(x-poster): attach card images to tweets

setInputFiles writes the hidden input directly. Clicking the media button
opens a native OS file dialog in a real Chrome, and one missed filechooser
interception leaves a modal system dialog blocking an unattended session.

A media timeout is retryable, not uncertain: submit has not been clicked,
so the tweet definitively did not post."
```

---

## Verification Checklist

Run after Task 17.

- [ ] `pnpm --filter shared test` — passes
- [ ] `pnpm --filter x-poster test` — passes
- [ ] `pnpm --filter tweet-generator test` — passes
- [ ] `pnpm --filter tweet-generator build` — `tsc` clean
- [ ] `pnpm --filter x-poster build` — `tsc` clean
- [ ] `pnpm --filter discord-monitor run setup-db` — idempotent on an existing database
- [ ] A full generator cycle enqueues one row with a plausible `content`, the right `source`, and `archetype` set
- [ ] Two consecutive rows never share an `archetype`
- [ ] `tweet-generator/media/` holds a PNG for `digest` and `metric` rows and nothing for `take` and `question`
- [ ] The card renders with both embedded fonts, nothing overflows, and the watermark is legible
- [ ] `x-poster` with `X_DRY_RUN=true` produces a screenshot **showing the image thumbnail attached**
- [ ] Killing the LLM endpoint makes the generator skip cycles and log, without exiting
- [ ] Three consecutive upstream failures fire the Discord alert
- [ ] Restarting the generator does not re-enqueue a candidate it already used

## Before going live

`X_DRY_RUN=true` is the safe way to watch a full day of output before a single
post reaches the timeline. Leave it on for at least one full day and read every
generated row — nothing reviews these between the validator and the timeline,
and the phrase tiers, the number whitelist, and the pinned model are what stand
in for a human reviewer.

