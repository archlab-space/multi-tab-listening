# X Auto-Poster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `x-poster`, a workspace service that drains a queue of pending tweets from Postgres and posts each one through a real Chrome browser driven over CDP, with human-like pacing and no automation fingerprint.

**Architecture:** A third pnpm workspace package that knows only the `tweets` table — it never imports from `scraper` or `ai-assistant`, matching the existing "services meet only in Postgres" contract. It cold-starts (or attaches to) a real Chrome with a dedicated profile directory, connects via `connectOverCDP`, and runs a seven-step behaviour script per tweet. Pure-logic modules (delays, mouse paths, rate limiting, error classification, queue state machine) are unit-tested; browser interaction is covered by a dry-run mode.

**Tech Stack:** TypeScript (nodenext), Node 24, pnpm workspace, Playwright, `pg`, winston, vitest, real Chrome over CDP.

> **Note added after this document was written:** the `scraper` package was
> renamed to `discord-monitor`, aligning it with the `DiscordMonitor` class,
> `discord-monitor.log`, and the `discord_monitor` database that already used
> that name. Paths below still say `scraper/` — they were accurate on the date
> above, and this document is a record of the work rather than live
> instructions.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-08-04-x-auto-poster-design.md`. Every task's requirements implicitly include this section.

- **`x-poster` must not call `page.evaluate()`, `page.evaluateHandle()`, or `page.addInitScript()`.** All page interaction goes through Playwright locator APIs and CDP input events. This is a binding coding constraint, not an aspiration.
- **No fingerprint-spoofing library** (`puppeteer-extra-plugin-stealth` and relatives). A spoofed value that disagrees with the genuine environment is a stronger signal than no spoofing at all.
- **Launch arguments are exactly these six, and nothing else:** `--user-data-dir`, `--remote-debugging-port`, `--remote-debugging-address=127.0.0.1`, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`, `--disable-background-timer-throttling`.
- **Chrome 136+ ignores `--remote-debugging-port` unless a non-default `--user-data-dir` is passed explicitly.** The dedicated profile directory is mandatory, not a convenience.
- **Prefer a missed tweet over a duplicate tweet.** This decides every ambiguous case.
- **The service never calls `page.bringToFront()`** — it must not steal the operator's focus.
- **New time columns use `TIMESTAMPTZ`**, deviating from the existing tables' `TIMESTAMP`, because they all participate in scheduling decisions.
- **macOS only.** `pbcopy`/`pbpaste` are macOS commands.

**Local Postgres** (from `docker-compose.yml`): host `localhost`, port `5432`, db `discord_monitor`, user `discord_user`, password `defaultpassword123`. Start it with `docker compose up -d` from the repo root.

**Branch:** all work lands on `feat/x-auto-poster`, already created.

---

### Task 1: Fix the silently broken schema setup

This is blocking. `setup-database.ts` currently throws partway through and swallows the error, so no index in the file has ever been created — and a `tweets` table appended after the broken statement would never be created either.

**Files:**
- Modify: `scraper/src/setup-database.ts:50-58` (the `threads` DDL and the `catch` block)

**Interfaces:**
- Consumes: nothing
- Produces: `setupDatabase(): Promise<void>` — now rejects on schema failure instead of resolving

- [ ] **Step 1: Reproduce the failure**

Start Postgres and run the existing setup to see the swallowed error:

```bash
cd /Users/hanlynn/Projects/my/multi-tab-listening
docker compose up -d
sleep 5
pnpm --filter scraper run setup-db
```

Expected output contains `Error setting up database:` followed by a syntax error mentioning `")"`, and does **not** contain `Database schema created successfully`. Note that the process still exits 0 — that is the second half of the bug.

- [ ] **Step 2: Confirm the indexes are missing**

```bash
docker exec discord-postgres psql -U discord_user -d discord_monitor \
  -c "\di idx_messages_*"
```

Expected: `Did not find any relation named "idx_messages_*".`

- [ ] **Step 3: Fix the trailing comma**

In `scraper/src/setup-database.ts`, the `threads` table DDL ends with:

```
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      )
```

Remove the trailing comma:

```
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
```

- [ ] **Step 4: Make the catch rethrow**

Replace the `catch` block:

```ts
  } catch (err) {
    console.error('Error setting up database:', err)
  } finally {
```

with:

```ts
  } catch (err) {
    // Rethrow: a schema failure that only logs means every statement after it
    // is skipped silently, which is exactly how the trailing comma above went
    // unnoticed while none of the indexes below it were ever created.
    console.error('Error setting up database:', err)
    throw err
  } finally {
```

- [ ] **Step 5: Re-run setup and verify it now succeeds**

```bash
pnpm --filter scraper run setup-db
```

Expected: `Database schema created successfully`, no error line.

- [ ] **Step 6: Verify the indexes now exist**

```bash
docker exec discord-postgres psql -U discord_user -d discord_monitor \
  -c "\di idx_messages_*"
```

Expected: a table listing 10 indexes, including `idx_messages_channel_id`, `idx_messages_processed`, and `idx_messages_content_fts`.

- [ ] **Step 7: Verify the failure path now exits non-zero**

Temporarily break the DDL again to confirm the rethrow works. Change `CREATE TABLE IF NOT EXISTS channels (` to `CREATE TABLE IF NOT EXISTS channels ((` , then:

```bash
pnpm --filter scraper run setup-db; echo "exit=$?"
```

Expected: `exit=1`. Now revert that temporary edit and re-run to confirm `exit=0`.

- [ ] **Step 8: Commit**

```bash
git add scraper/src/setup-database.ts
git commit -m "fix: stop setup-database from silently skipping half the schema

A trailing comma in the threads DDL made the statement a syntax error. The
surrounding catch logged it without rethrowing, so the failure was invisible
and every statement after it was skipped — meaning none of the ten declared
indexes had ever been created.

Removes the comma and makes the catch rethrow, so a schema failure fails the
setup-db command instead of passing for success.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Shared logger

Seven files construct their own winston logger today, with two different formats. Extract one factory that all three packages use.

**Files:**
- Create: `shared/src/logger.ts`
- Create: `shared/src/logger.test.ts`
- Create: `shared/vitest.config.ts`
- Modify: `shared/package.json` (subpath exports, `winston` dependency, `test` script, vitest devDependency)
- Modify: `pnpm-workspace.yaml` (add `vitest` to the catalog)

**Interfaces:**
- Consumes: nothing
- Produces: `createLogger(filename: string, level?: string): winston.Logger` — importable as `import { createLogger } from 'shared/logger'`

- [ ] **Step 1: Add vitest to the workspace catalog**

In `pnpm-workspace.yaml`, extend the `catalog:` block:

```yaml
# Shared across both packages — bump here, not in each package.json.
catalog:
  pg: ^8.22.0
  winston: ^3.19.0
  '@types/pg': ^8.20.0
  vitest: ^3.2.4
```

- [ ] **Step 2: Rewrite `shared/package.json`**

The current file exports a single path. It needs subpath exports so consumers can import `shared/logger` and `shared/db` separately, plus the dependencies those modules use.

```json
{
  "name": "shared",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/types.ts",
    "./logger": "./src/logger.ts",
    "./db": "./src/db.ts"
  },
  "types": "./src/types.ts",
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "pg": "catalog:",
    "winston": "catalog:"
  },
  "devDependencies": {
    "@types/pg": "catalog:",
    "vitest": "catalog:"
  }
}
```

Note this declares `./db` before that file exists. Task 3 creates it. Nothing imports `shared/db` until then, so this is inert.

- [ ] **Step 3: Add the vitest config**

Create `shared/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
```

- [ ] **Step 4: Install**

```bash
cd /Users/hanlynn/Projects/my/multi-tab-listening
pnpm install
```

- [ ] **Step 5: Write the failing test**

Create `shared/src/logger.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createLogger } from './logger.js'

describe('createLogger', () => {
  it('writes to the named file and to the console', () => {
    const logger = createLogger('example.log')

    const filenames = logger.transports
      .map((t) => (t as { filename?: string }).filename)
      .filter((name): name is string => typeof name === 'string')

    expect(filenames).toEqual(['example.log'])
    expect(logger.transports).toHaveLength(2)
  })

  it('defaults to the info level', () => {
    expect(createLogger('example.log').level).toBe('info')
  })

  it('honours an explicit level', () => {
    expect(createLogger('example.log', 'debug').level).toBe('debug')
  })

  it('reads the level from LOG_LEVEL when none is given', () => {
    const previous = process.env.LOG_LEVEL
    process.env.LOG_LEVEL = 'warn'
    try {
      expect(createLogger('example.log').level).toBe('warn')
    } finally {
      if (previous === undefined) delete process.env.LOG_LEVEL
      else process.env.LOG_LEVEL = previous
    }
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
pnpm --filter shared test
```

Expected: FAIL — cannot resolve `./logger.js`.

- [ ] **Step 7: Write the implementation**

Create `shared/src/logger.ts`:

```ts
import winston from 'winston'

/**
 * The one logger factory for the workspace.
 *
 * Both formats that grew up independently are kept, each where it belongs:
 * `printf` for the console, because a human is reading it, and `json` for the
 * file, because a machine is.
 */
export function createLogger(filename: string, level?: string): winston.Logger {
  return winston.createLogger({
    level: level ?? process.env.LOG_LEVEL ?? 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    ),
    transports: [
      new winston.transports.File({ filename }),
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : ''
            return `${timestamp} [${level}]: ${message}${rest}`
          }),
        ),
      }),
    ],
  })
}
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
pnpm --filter shared test
```

Expected: PASS, 4 tests.

- [ ] **Step 9: Commit**

```bash
git add pnpm-workspace.yaml shared/package.json shared/vitest.config.ts shared/src/logger.ts shared/src/logger.test.ts
git commit -m "feat(shared): add one logger factory for all three services

Seven files built their own winston logger, with two different formats
between them. This keeps both formats where each earns its place: printf on
the console because a human reads it, json in the file because a machine does.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Shared database connection

`scraper` and `ai-assistant` each read the same five environment variables and build their own `pg` Pool. Extract both halves.

**Files:**
- Create: `shared/src/db.ts`
- Create: `shared/src/db.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces, importable as `import { loadDbConfig, createPool, type DbConfig } from 'shared/db'`:
  - `interface DbConfig { user: string; host: string; database: string; password: string; port: number }`
  - `loadDbConfig(env?: NodeJS.ProcessEnv): DbConfig`
  - `createPool(config?: DbConfig): Pool`

- [ ] **Step 1: Write the failing test**

Create `shared/src/db.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createPool, loadDbConfig } from './db.js'

describe('loadDbConfig', () => {
  it('reads every field from the environment', () => {
    expect(
      loadDbConfig({
        DB_USER: 'someone',
        DB_HOST: 'db.example.com',
        DB_NAME: 'somedb',
        DB_PASSWORD: 'secret',
        DB_PORT: '6543',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      user: 'someone',
      host: 'db.example.com',
      database: 'somedb',
      password: 'secret',
      port: 6543,
    })
  })

  it('applies the same defaults the services used before', () => {
    expect(loadDbConfig({} as NodeJS.ProcessEnv)).toEqual({
      user: 'postgres',
      host: 'localhost',
      database: 'discord_monitor',
      password: '',
      port: 5432,
    })
  })

  it('rejects a port that is not a number', () => {
    expect(() =>
      loadDbConfig({ DB_PORT: 'not-a-port' } as NodeJS.ProcessEnv),
    ).toThrow(/DB_PORT/)
  })

  it('rejects a port outside the valid range', () => {
    expect(() =>
      loadDbConfig({ DB_PORT: '70000' } as NodeJS.ProcessEnv),
    ).toThrow(/DB_PORT/)
  })
})

describe('createPool', () => {
  it('builds a pool from the given config', async () => {
    const pool = createPool({
      user: 'discord_user',
      host: 'localhost',
      database: 'discord_monitor',
      password: 'defaultpassword123',
      port: 5432,
    })
    try {
      const result = await pool.query('SELECT 1 AS one')
      expect(result.rows[0]).toEqual({ one: 1 })
    } finally {
      await pool.end()
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter shared test
```

Expected: FAIL — cannot resolve `./db.js`.

- [ ] **Step 3: Write the implementation**

Create `shared/src/db.ts`:

```ts
import { Pool } from 'pg'

/** The Postgres connection shape every service in this workspace uses. */
export interface DbConfig {
  user: string
  host: string
  database: string
  password: string
  port: number
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 5432
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DB_PORT must be an integer between 1 and 65535, got: ${raw}`)
  }
  return port
}

export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    user: env.DB_USER ?? 'postgres',
    host: env.DB_HOST ?? 'localhost',
    database: env.DB_NAME ?? 'discord_monitor',
    password: env.DB_PASSWORD ?? '',
    port: parsePort(env.DB_PORT),
  }
}

export function createPool(config: DbConfig = loadDbConfig()): Pool {
  return new Pool(config)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Postgres must be running.

```bash
docker compose up -d
pnpm --filter shared test
```

Expected: PASS, 9 tests total across both files.

- [ ] **Step 5: Commit**

```bash
git add shared/src/db.ts shared/src/db.test.ts
git commit -m "feat(shared): add one Postgres config loader and pool factory

Both services read the same five variables and built their own Pool. The
port is now validated rather than passed through parseInt, which silently
yielded NaN for a malformed value.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The `tweets` table and its types

**Files:**
- Modify: `shared/src/types.ts` (append)
- Modify: `scraper/src/setup-database.ts` (add the table and indexes before the success log)

**Interfaces:**
- Consumes: nothing
- Produces, importable as `import type { Tweet, TweetStatus } from 'shared'`:
  - `type TweetStatus = 'pending' | 'sending' | 'posted' | 'failed' | 'uncertain'`
  - `interface Tweet` with camelCase fields mirroring the table

- [ ] **Step 1: Append the types**

Add to the end of `shared/src/types.ts`:

```ts
/**
 * Where a queued tweet is in its lifecycle.
 *
 * `uncertain` is not a flavour of failure. It means the submit button was
 * clicked but the outcome could not be confirmed — the tweet may well be
 * live. Rows in this state are never retried automatically, because the
 * queue prefers a missed tweet over a duplicate one.
 */
export type TweetStatus =
  | 'pending'
  | 'sending'
  | 'posted'
  | 'failed'
  | 'uncertain'

/** One row of the `tweets` table. */
export interface Tweet {
  id: number
  content: string
  status: TweetStatus
  /**
   * Idempotency key supplied by whoever enqueued the tweet. UNIQUE, so
   * enqueueing the same logical tweet twice is rejected by Postgres rather
   * than by application logic.
   */
  dedupeKey: string
  source: string | null
  sourceRef: string | null
  attempts: number
  lastError: string | null
  scheduledAt: Date
  postedAt: Date | null
  postedUrl: string | null
  createdAt: Date
  updatedAt: Date
}
```

- [ ] **Step 2: Add the table to the schema setup**

In `scraper/src/setup-database.ts`, insert this after the `threads` table query and before the `CREATE INDEX` block:

```ts
    // Create tweets table — the queue drained by the x-poster service.
    // Time columns are TIMESTAMPTZ, unlike the tables above, because every
    // one of them feeds a scheduling decision (active-hours window, minimum
    // interval, daily cap) where a naive timestamp is a correctness bug.
    await client.query(`
      CREATE TABLE IF NOT EXISTS tweets (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        dedupe_key VARCHAR(255) UNIQUE NOT NULL,
        source VARCHAR(50),
        source_ref VARCHAR(255),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        posted_at TIMESTAMPTZ,
        posted_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
```

Then add these two lines inside the existing `CREATE INDEX` template literal, after the last `idx_messages_guild_id` line:

```sql
      CREATE INDEX IF NOT EXISTS idx_tweets_claim ON tweets(status, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_tweets_posted_at ON tweets(posted_at);
```

- [ ] **Step 3: Run the schema setup**

```bash
pnpm --filter scraper run setup-db
```

Expected: `Database schema created successfully`.

- [ ] **Step 4: Verify the table and indexes**

```bash
docker exec discord-postgres psql -U discord_user -d discord_monitor \
  -c "\d tweets"
```

Expected: 13 columns, `dedupe_key` shown as `not null` with a unique constraint, `scheduled_at` / `posted_at` / `created_at` / `updated_at` typed `timestamp with time zone`, and both `idx_tweets_*` indexes listed.

- [ ] **Step 5: Commit**

```bash
git add shared/src/types.ts scraper/src/setup-database.ts
git commit -m "feat: add the tweets queue table and its shared types

Time columns here are TIMESTAMPTZ rather than the TIMESTAMP the older tables
use, because all four feed scheduling decisions where a naive timestamp is a
correctness bug rather than a style choice.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Package scaffold, config, and error taxonomy

**Files:**
- Create: `x-poster/package.json`
- Create: `x-poster/tsconfig.json`
- Create: `x-poster/vitest.config.ts`
- Create: `x-poster/.gitignore`
- Create: `x-poster/.env.example`
- Create: `x-poster/src/errors.ts`
- Create: `x-poster/src/errors.test.ts`
- Create: `x-poster/src/config.ts`
- Create: `x-poster/src/config.test.ts`
- Modify: `pnpm-workspace.yaml` (add the member and catalog entries)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `class RetryableError extends Error`, `class FatalError extends Error`, `class UncertainError extends Error` — each `constructor(message: string, options?: { cause?: unknown })`
  - `classifyError(error: unknown): RetryableError | FatalError | UncertainError`
  - `interface ActiveHours { startMinute: number; endMinute: number }`
  - `interface XPosterConfig { profileDir, debugPort, chromePath, dryRun, minIntervalMinutes, maxIntervalMinutes, dailyCap, activeHours, maxAttempts, discordWebhookUrl }`
  - `loadConfig(env?: NodeJS.ProcessEnv): XPosterConfig`

- [ ] **Step 1: Register the package and its dependencies**

In `pnpm-workspace.yaml`, add `x-poster` to `packages` and `playwright` / `dotenv` to the catalog:

```yaml
packages:
  - shared
  - scraper
  - ai-assistant
  - x-poster

# Shared across both packages — bump here, not in each package.json.
catalog:
  pg: ^8.22.0
  winston: ^3.19.0
  '@types/pg': ^8.20.0
  vitest: ^3.2.4
  playwright: ^1.62.1
  dotenv: ^17.4.2
```

- [ ] **Step 2: Create `x-poster/package.json`**

```json
{
  "name": "x-poster",
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

- [ ] **Step 3: Create `x-poster/tsconfig.json`**

Mirrors `scraper/tsconfig.json` with two deliberate differences: no `DOM` lib, because this package never runs code in the page, and `ES2022` rather than `ES2020`, because `errors.ts` uses `Error(message, { cause })` — `Error.cause` is an ES2022 addition and `tsc` rejects it under `ES2020`. Node 24 supports ES2022 fully.

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

- [ ] **Step 4: Create `x-poster/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
```

- [ ] **Step 5: Create `x-poster/.gitignore`**

The profile directory and dry-run screenshots must never be committed — the profile holds a live X session.

```
node_modules
dist
*.log
.env
chrome-profile/
screenshots/
```

- [ ] **Step 6: Create `x-poster/.env.example`**

```
# Database Configuration
DB_USER=discord_user
DB_HOST=localhost
DB_NAME=discord_monitor
DB_PASSWORD=defaultpassword123
DB_PORT=5432

# Dedicated Chrome profile directory. MUST NOT be your everyday Chrome
# profile: Chrome 136+ ignores --remote-debugging-port unless a non-default
# --user-data-dir is passed, and an open debugging port grants any local
# process full control over every session in that profile.
X_PROFILE_DIR=./chrome-profile

# CDP port, bound to 127.0.0.1 only
X_DEBUG_PORT=9333

# Chrome binary. Defaults to the macOS install path.
X_CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome

# Run the full behaviour script but never click submit. Screenshots instead.
X_DRY_RUN=true

# Pacing. Interval between tweets is sampled between the floor and ceiling.
X_MIN_INTERVAL_MINUTES=20
X_MAX_INTERVAL_MINUTES=60
X_DAILY_CAP=10

# Local-time window in which posting is allowed. Must not wrap past midnight.
X_ACTIVE_HOURS=09:00-23:00

# Retries for retryable errors (network, timeouts)
X_MAX_ATTEMPTS=3

# Circuit-breaker notifications reuse the existing Discord webhook
DISCORD_WEBHOOK_URL=

# Logging Level (error, warn, info, debug)
LOG_LEVEL=info
```

- [ ] **Step 7: Install**

```bash
cd /Users/hanlynn/Projects/my/multi-tab-listening
pnpm install
```

- [ ] **Step 8: Write the failing test for the error taxonomy**

Create `x-poster/src/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  FatalError,
  RetryableError,
  UncertainError,
  classifyError,
} from './errors.js'

describe('classifyError', () => {
  it('passes an already-classified error straight through', () => {
    const original = new FatalError('session expired')
    expect(classifyError(original)).toBe(original)
  })

  it('treats a Playwright timeout as retryable', () => {
    const error = new Error('Timeout 30000ms exceeded.')
    error.name = 'TimeoutError'
    expect(classifyError(error)).toBeInstanceOf(RetryableError)
  })

  it('treats a connection refusal as retryable', () => {
    expect(classifyError(new Error('connect ECONNREFUSED 127.0.0.1:443')))
      .toBeInstanceOf(RetryableError)
  })

  it('treats a navigation failure as retryable', () => {
    expect(classifyError(new Error('net::ERR_NAME_NOT_RESOLVED at https://x.com')))
      .toBeInstanceOf(RetryableError)
  })

  it('defaults an unrecognised error to fatal', () => {
    expect(classifyError(new Error('something nobody anticipated')))
      .toBeInstanceOf(FatalError)
  })

  it('defaults a non-Error throw to fatal', () => {
    expect(classifyError('a bare string')).toBeInstanceOf(FatalError)
  })

  it('preserves the original as the cause', () => {
    const original = new Error('connect ECONNREFUSED 127.0.0.1:443')
    expect(classifyError(original).cause).toBe(original)
  })
})

describe('UncertainError', () => {
  it('is never produced by classification and must be thrown deliberately', () => {
    expect(classifyError(new Error('anything'))).not.toBeInstanceOf(UncertainError)
    expect(new UncertainError('clicked but unverified')).toBeInstanceOf(Error)
  })
})
```

- [ ] **Step 9: Run it to verify it fails**

```bash
pnpm --filter x-poster test
```

Expected: FAIL — cannot resolve `./errors.js`.

- [ ] **Step 10: Write the error taxonomy**

Create `x-poster/src/errors.ts`:

```ts
/**
 * Every failure path in this service maps to exactly one of three categories.
 * The category, not the message, decides what happens next.
 */

/** Transient. Back off and try again, up to the configured attempt limit. */
export class RetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RetryableError'
  }
}

/**
 * Unrecoverable without a human: session expired, verification challenge,
 * every selector missing. Breaks the circuit rather than advancing to the
 * next row, because a dead session makes every subsequent attempt fail too —
 * and hammering a challenged account only deepens the problem.
 */
export class FatalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'FatalError'
  }
}

/**
 * Submit was clicked but the outcome could not be confirmed. The tweet may
 * be live. Never retried — the queue prefers a missed tweet over a duplicate
 * one. Thrown deliberately by the composer; never produced by classification.
 */
export class UncertainError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'UncertainError'
  }
}

const RETRYABLE_PATTERNS = [
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /^net::ERR_/m,
  /net::ERR_/,
  /Timeout \d+ms exceeded/,
  /Navigation timeout/i,
]

/**
 * Anything unrecognised is fatal, not retryable. An unknown failure while
 * driving a logged-in browser is more likely a changed page or a challenged
 * session than a blip, and retrying into that makes things worse.
 */
export function classifyError(
  error: unknown,
): RetryableError | FatalError | UncertainError {
  if (
    error instanceof RetryableError ||
    error instanceof FatalError ||
    error instanceof UncertainError
  ) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''

  if (name === 'TimeoutError' || RETRYABLE_PATTERNS.some((p) => p.test(message))) {
    return new RetryableError(message, { cause: error })
  }

  return new FatalError(message, { cause: error })
}
```

- [ ] **Step 11: Run the tests to verify they pass**

```bash
pnpm --filter x-poster test
```

Expected: PASS, 8 tests.

- [ ] **Step 12: Write the failing test for config**

Create `x-poster/src/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const required = { X_PROFILE_DIR: '/tmp/x-profile' } as NodeJS.ProcessEnv

describe('loadConfig', () => {
  it('requires a profile directory', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/X_PROFILE_DIR/)
  })

  it('applies documented defaults', () => {
    const config = loadConfig({ ...required })
    expect(config.debugPort).toBe(9333)
    expect(config.dryRun).toBe(false)
    expect(config.minIntervalMinutes).toBe(20)
    expect(config.maxIntervalMinutes).toBe(60)
    expect(config.dailyCap).toBe(10)
    expect(config.maxAttempts).toBe(3)
    expect(config.discordWebhookUrl).toBeNull()
    expect(config.activeHours).toEqual({ startMinute: 540, endMinute: 1380 })
  })

  it('parses an active-hours window into minutes from midnight', () => {
    expect(
      loadConfig({ ...required, X_ACTIVE_HOURS: '07:30-21:15' }).activeHours,
    ).toEqual({ startMinute: 450, endMinute: 1275 })
  })

  it('rejects an active-hours window that wraps past midnight', () => {
    expect(() =>
      loadConfig({ ...required, X_ACTIVE_HOURS: '22:00-02:00' }),
    ).toThrow(/must not wrap past midnight/)
  })

  it('rejects a malformed active-hours window', () => {
    expect(() => loadConfig({ ...required, X_ACTIVE_HOURS: '9-5' })).toThrow(
      /X_ACTIVE_HOURS/,
    )
  })

  it('rejects an interval floor above its ceiling', () => {
    expect(() =>
      loadConfig({
        ...required,
        X_MIN_INTERVAL_MINUTES: '90',
        X_MAX_INTERVAL_MINUTES: '30',
      }),
    ).toThrow(/X_MIN_INTERVAL_MINUTES/)
  })

  it('treats X_DRY_RUN=true as enabled and anything else as disabled', () => {
    expect(loadConfig({ ...required, X_DRY_RUN: 'true' }).dryRun).toBe(true)
    expect(loadConfig({ ...required, X_DRY_RUN: 'TRUE' }).dryRun).toBe(true)
    expect(loadConfig({ ...required, X_DRY_RUN: 'yes' }).dryRun).toBe(false)
    expect(loadConfig({ ...required, X_DRY_RUN: '' }).dryRun).toBe(false)
  })

  it('keeps an empty webhook url as null rather than an empty string', () => {
    expect(loadConfig({ ...required, DISCORD_WEBHOOK_URL: '' }).discordWebhookUrl)
      .toBeNull()
    expect(
      loadConfig({ ...required, DISCORD_WEBHOOK_URL: 'https://example.test/hook' })
        .discordWebhookUrl,
    ).toBe('https://example.test/hook')
  })
})
```

- [ ] **Step 13: Run it to verify it fails**

```bash
pnpm --filter x-poster test
```

Expected: FAIL — cannot resolve `./config.js`.

- [ ] **Step 14: Write the config loader**

Create `x-poster/src/config.ts`:

```ts
import dotenv from 'dotenv'

dotenv.config()

/** Local-time posting window, expressed as minutes from midnight. */
export interface ActiveHours {
  startMinute: number
  endMinute: number
}

export interface XPosterConfig {
  profileDir: string
  debugPort: number
  chromePath: string
  dryRun: boolean
  minIntervalMinutes: number
  maxIntervalMinutes: number
  dailyCap: number
  activeHours: ActiveHours
  maxAttempts: number
  discordWebhookUrl: string | null
}

const DEFAULT_CHROME_PATH =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function requiredString(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`${key} is required`)
  return value
}

function positiveInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer, got: ${raw}`)
  }
  return value
}

/**
 * A window that wrapped past midnight would need its own set of comparisons
 * throughout the rate limiter. Rejecting it keeps one untested edge case out
 * of the scheduler entirely.
 */
function parseActiveHours(raw: string | undefined): ActiveHours {
  const value = raw ?? '09:00-23:00'
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(value)
  if (!match) {
    throw new Error(`X_ACTIVE_HOURS must look like "09:00-23:00", got: ${value}`)
  }
  const [, sh, sm, eh, em] = match as unknown as [string, string, string, string, string]
  const startMinute = Number(sh) * 60 + Number(sm)
  const endMinute = Number(eh) * 60 + Number(em)

  if (Number(sh) > 23 || Number(eh) > 23 || Number(sm) > 59 || Number(em) > 59) {
    throw new Error(`X_ACTIVE_HOURS contains an invalid time: ${value}`)
  }
  if (endMinute <= startMinute) {
    throw new Error(
      `X_ACTIVE_HOURS must not wrap past midnight, got: ${value}`,
    )
  }
  return { startMinute, endMinute }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): XPosterConfig {
  const minIntervalMinutes = positiveInt(env, 'X_MIN_INTERVAL_MINUTES', 20)
  const maxIntervalMinutes = positiveInt(env, 'X_MAX_INTERVAL_MINUTES', 60)

  if (minIntervalMinutes > maxIntervalMinutes) {
    throw new Error(
      `X_MIN_INTERVAL_MINUTES (${minIntervalMinutes}) must not exceed ` +
        `X_MAX_INTERVAL_MINUTES (${maxIntervalMinutes})`,
    )
  }

  return {
    profileDir: requiredString(env, 'X_PROFILE_DIR'),
    debugPort: positiveInt(env, 'X_DEBUG_PORT', 9333),
    chromePath: env.X_CHROME_PATH || DEFAULT_CHROME_PATH,
    dryRun: (env.X_DRY_RUN ?? '').toLowerCase() === 'true',
    minIntervalMinutes,
    maxIntervalMinutes,
    dailyCap: positiveInt(env, 'X_DAILY_CAP', 10),
    activeHours: parseActiveHours(env.X_ACTIVE_HOURS),
    maxAttempts: positiveInt(env, 'X_MAX_ATTEMPTS', 3),
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL || null,
  }
}
```

- [ ] **Step 15: Run the tests to verify they pass**

```bash
pnpm --filter x-poster test
```

Expected: PASS, 16 tests.

- [ ] **Step 16: Commit**

```bash
git add pnpm-workspace.yaml x-poster/
git commit -m "feat(x-poster): scaffold the package with config and error taxonomy

Three error categories, because the category rather than the message decides
what happens next: retryable backs off, fatal breaks the circuit, uncertain
is never retried. Unrecognised errors default to fatal — an unknown failure
while driving a logged-in browser is more likely a changed page or a
challenged session than a blip, and retrying into that makes it worse.

Active-hours windows that wrap past midnight are rejected at load time,
keeping an untested edge case out of the scheduler entirely.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Human delays

**Files:**
- Create: `x-poster/src/human/delay.ts`
- Create: `x-poster/src/human/delay.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type Rng = () => number`
  - `mulberry32(seed: number): Rng` — seeded generator, exported for tests in this and later tasks
  - `sampleDelay(minMs: number, maxMs: number, rng?: Rng): number`
  - `humanDelay(minMs: number, maxMs: number, rng?: Rng): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `x-poster/src/human/delay.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { humanDelay, mulberry32, sampleDelay } from './delay.js'

function samples(count: number, min: number, max: number): number[] {
  const rng = mulberry32(20260804)
  return Array.from({ length: count }, () => sampleDelay(min, max, rng))
}

describe('sampleDelay', () => {
  it('always stays within the requested range', () => {
    for (const value of samples(2000, 100, 900)) {
      expect(value).toBeGreaterThanOrEqual(100)
      expect(value).toBeLessThanOrEqual(900)
    }
  })

  it('returns integers', () => {
    for (const value of samples(200, 100, 900)) {
      expect(Number.isInteger(value)).toBe(true)
    }
  })

  it('is right-skewed: most samples fall below the arithmetic midpoint', () => {
    // A uniform distribution would put ~50% above the midpoint. Human pauses
    // cluster low with an occasional long one, and that asymmetry is the
    // whole point of not using Math.random() directly.
    const values = samples(2000, 100, 900)
    const aboveMidpoint = values.filter((v) => v > 500).length
    expect(aboveMidpoint / values.length).toBeLessThan(0.3)
  })

  it('still produces a long tail rather than clustering at the floor', () => {
    const values = samples(2000, 100, 900)
    const nearCeiling = values.filter((v) => v > 700).length
    expect(nearCeiling).toBeGreaterThan(0)
  })

  it('is deterministic for a given seed', () => {
    expect(samples(20, 100, 900)).toEqual(samples(20, 100, 900))
  })

  it('handles a degenerate range', () => {
    expect(sampleDelay(500, 500, mulberry32(1))).toBe(500)
  })
})

describe('mulberry32', () => {
  it('produces values in [0, 1)', () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 500; i++) {
      const value = rng()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe('humanDelay', () => {
  it('waits for at least the sampled floor', async () => {
    const started = Date.now()
    await humanDelay(30, 40, mulberry32(3))
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter x-poster test
```

Expected: FAIL — cannot resolve `./delay.js`.

- [ ] **Step 3: Write the implementation**

Create `x-poster/src/human/delay.ts`:

```ts
export type Rng = () => number

/**
 * Small seeded PRNG. Exported so the randomised behaviour in this package is
 * reproducible under test — every module that takes an `rng` accepts this.
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

/** Box-Muller transform: two uniforms in, one standard normal out. */
function standardNormal(rng: Rng): number {
  const u1 = Math.max(rng(), Number.EPSILON)
  const u2 = rng()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

const SIGMA = 0.45
/** Where the median sits inside the range, as a fraction of its width. */
const MEDIAN_POSITION = 0.25

/**
 * A delay drawn from a log-normal distribution, clamped to [minMs, maxMs].
 *
 * Uniformly distributed delays are themselves an anomaly: human intervals
 * between actions are mostly short with an occasional long tail, and that
 * shape is what this reproduces.
 */
export function sampleDelay(minMs: number, maxMs: number, rng: Rng = Math.random): number {
  if (maxMs <= minMs) return Math.round(minMs)

  const span = maxMs - minMs
  const median = span * MEDIAN_POSITION
  const value = minMs + Math.exp(Math.log(median) + SIGMA * standardNormal(rng))

  return Math.round(Math.min(maxMs, Math.max(minMs, value)))
}

export function humanDelay(
  minMs: number,
  maxMs: number,
  rng: Rng = Math.random,
): Promise<void> {
  const ms = sampleDelay(minMs, maxMs, rng)
  return new Promise((resolve) => setTimeout(resolve, ms))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter x-poster test
```

Expected: PASS, 24 tests total. If the right-skew or long-tail assertions fail, adjust `SIGMA` and `MEDIAN_POSITION` — do **not** relax the assertions, since they encode the property that justifies this module's existence.

- [ ] **Step 5: Commit**

```bash
git add x-poster/src/human/delay.ts x-poster/src/human/delay.test.ts
git commit -m "feat(x-poster): sample action delays from a log-normal distribution

Uniformly distributed delays are themselves an anomaly. Human intervals are
mostly short with an occasional long pause, and the tests assert that shape
rather than merely asserting the bounds.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Mouse travel paths

**Files:**
- Create: `x-poster/src/human/mouse.ts`
- Create: `x-poster/src/human/mouse.test.ts`

**Interfaces:**
- Consumes: `Rng`, `mulberry32`, `sampleDelay` from `./delay.js`
- Produces:
  - `interface Point { x: number; y: number }`
  - `interface TravelOptions { steps?: number; overshoot?: boolean; rng?: Rng }`
  - `buildTravelPath(from: Point, to: Point, options?: TravelOptions): Point[]`
  - `travelTo(page: Page, from: Point, to: Point, options?: TravelOptions): Promise<Point>` — returns the final cursor position
  - `elementCentre(box: { x: number; y: number; width: number; height: number }, rng?: Rng): Point`

- [ ] **Step 1: Write the failing test**

Create `x-poster/src/human/mouse.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mulberry32 } from './delay.js'
import { buildTravelPath, elementCentre, type Point } from './mouse.js'

const FROM: Point = { x: 100, y: 100 }
const TO: Point = { x: 800, y: 400 }

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

describe('buildTravelPath', () => {
  it('starts exactly at the origin', () => {
    const path = buildTravelPath(FROM, TO, { rng: mulberry32(1) })
    expect(path[0]).toEqual(FROM)
  })

  it('lands near but not exactly on the target', () => {
    // Never a pixel-perfect hit on the element centre.
    let anyOffCentre = false
    for (let seed = 0; seed < 40; seed++) {
      const path = buildTravelPath(FROM, TO, {
        rng: mulberry32(seed),
        overshoot: false,
      })
      const last = path[path.length - 1]!
      expect(distance(last, TO)).toBeLessThanOrEqual(3)
      if (distance(last, TO) > 0) anyOffCentre = true
    }
    expect(anyOffCentre).toBe(true)
  })

  it('uses between 20 and 40 intermediate points when not overshooting', () => {
    for (let seed = 0; seed < 40; seed++) {
      const path = buildTravelPath(FROM, TO, {
        rng: mulberry32(seed),
        overshoot: false,
      })
      expect(path.length).toBeGreaterThanOrEqual(20)
      expect(path.length).toBeLessThanOrEqual(40)
    }
  })

  it('advances monotonically toward the target when not overshooting', () => {
    const path = buildTravelPath(FROM, TO, {
      rng: mulberry32(5),
      overshoot: false,
    })
    for (let i = 1; i < path.length; i++) {
      expect(distance(FROM, path[i]!)).toBeGreaterThan(distance(FROM, path[i - 1]!))
    }
  })

  it('moves faster in the middle than at either end', () => {
    // Ease-in-out: a human accelerates, then decelerates onto the target.
    const path = buildTravelPath(FROM, TO, {
      rng: mulberry32(9),
      overshoot: false,
      steps: 30,
    })
    const step = (i: number) => distance(path[i]!, path[i + 1]!)
    const middle = step(Math.floor(path.length / 2))
    expect(middle).toBeGreaterThan(step(0))
    expect(middle).toBeGreaterThan(step(path.length - 2))
  })

  it('does not travel in a straight line', () => {
    // A straight line is the single most obvious synthetic-cursor tell.
    const path = buildTravelPath(FROM, TO, {
      rng: mulberry32(11),
      overshoot: false,
    })
    const maxDeviation = Math.max(
      ...path.map((p) => {
        const t =
          ((p.x - FROM.x) * (TO.x - FROM.x) + (p.y - FROM.y) * (TO.y - FROM.y)) /
          distance(FROM, TO) ** 2
        const onLine = {
          x: FROM.x + t * (TO.x - FROM.x),
          y: FROM.y + t * (TO.y - FROM.y),
        }
        return distance(p, onLine)
      }),
    )
    expect(maxDeviation).toBeGreaterThan(2)
  })

  it('overshoots the target on roughly a third of travels', () => {
    let overshot = 0
    const total = 400
    for (let seed = 0; seed < total; seed++) {
      const path = buildTravelPath(FROM, TO, { rng: mulberry32(seed) })
      const furthest = Math.max(...path.map((p) => distance(FROM, p)))
      if (furthest > distance(FROM, TO) + 1) overshot++
    }
    expect(overshot / total).toBeGreaterThan(0.15)
    expect(overshot / total).toBeLessThan(0.45)
  })

  it('always returns to the target after overshooting', () => {
    for (let seed = 0; seed < 100; seed++) {
      const path = buildTravelPath(FROM, TO, { rng: mulberry32(seed) })
      expect(distance(path[path.length - 1]!, TO)).toBeLessThanOrEqual(3)
    }
  })

  it('is deterministic for a given seed', () => {
    expect(buildTravelPath(FROM, TO, { rng: mulberry32(42) })).toEqual(
      buildTravelPath(FROM, TO, { rng: mulberry32(42) }),
    )
  })
})

describe('elementCentre', () => {
  it('picks a point inside the box but off its exact centre', () => {
    const box = { x: 200, y: 100, width: 80, height: 40 }
    let anyOffCentre = false
    for (let seed = 0; seed < 40; seed++) {
      const point = elementCentre(box, mulberry32(seed))
      expect(point.x).toBeGreaterThan(box.x)
      expect(point.x).toBeLessThan(box.x + box.width)
      expect(point.y).toBeGreaterThan(box.y)
      expect(point.y).toBeLessThan(box.y + box.height)
      if (point.x !== 240 || point.y !== 120) anyOffCentre = true
    }
    expect(anyOffCentre).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter x-poster test
```

Expected: FAIL — cannot resolve `./mouse.js`.

- [ ] **Step 3: Write the implementation**

Create `x-poster/src/human/mouse.ts`:

```ts
import type { Page } from 'playwright'
import { humanDelay, sampleDelay, type Rng } from './delay.js'

export interface Point {
  x: number
  y: number
}

export interface TravelOptions {
  steps?: number
  overshoot?: boolean
  rng?: Rng
}

const MIN_STEPS = 20
const MAX_STEPS = 40
const OVERSHOOT_PROBABILITY = 0.3
const ENDPOINT_JITTER_PX = 2

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Cubic Bézier at parameter t. */
function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t
  const w0 = u * u * u
  const w1 = 3 * u * u * t
  const w2 = 3 * u * t * t
  const w3 = t * t * t
  return {
    x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
    y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
  }
}

/** Ease-in-out: slow at both ends, fast through the middle. */
function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

/**
 * Control points pushed perpendicular to the straight line, by a fraction of
 * its length. A straight cursor path is the single most obvious synthetic
 * tell; this makes the travel bow the way a hand does.
 */
function controlPoints(from: Point, to: Point, rng: Rng): [Point, Point] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy) || 1
  const nx = -dy / length
  const ny = dx / length

  const bow = (0.08 + rng() * 0.12) * length * (rng() < 0.5 ? -1 : 1)

  return [
    {
      x: lerp(from.x, to.x, 0.3) + nx * bow,
      y: lerp(from.y, to.y, 0.3) + ny * bow,
    },
    {
      x: lerp(from.x, to.x, 0.7) + nx * bow * 0.6,
      y: lerp(from.y, to.y, 0.7) + ny * bow * 0.6,
    },
  ]
}

function jitter(point: Point, rng: Rng): Point {
  return {
    x: Math.round(point.x + (rng() * 2 - 1) * ENDPOINT_JITTER_PX),
    y: Math.round(point.y + (rng() * 2 - 1) * ENDPOINT_JITTER_PX),
  }
}

function curve(from: Point, to: Point, steps: number, rng: Rng): Point[] {
  const [c1, c2] = controlPoints(from, to, rng)
  const points: Point[] = []
  for (let i = 1; i <= steps; i++) {
    points.push(bezier(from, c1, c2, to, ease(i / steps)))
  }
  return points
}

/**
 * The sequence of cursor positions for one travel, from origin to target.
 *
 * Roughly a third of travels overshoot the target and come back — the single
 * most characteristic trait of a real hand on a mouse, and the reason this
 * returns a path rather than interpolating inline.
 */
export function buildTravelPath(
  from: Point,
  to: Point,
  options: TravelOptions = {},
): Point[] {
  const rng = options.rng ?? Math.random
  const steps =
    options.steps ?? MIN_STEPS + Math.floor(rng() * (MAX_STEPS - MIN_STEPS + 1))

  const willOvershoot = options.overshoot ?? rng() < OVERSHOOT_PROBABILITY
  const landing = jitter(to, rng)

  if (!willOvershoot) {
    return [from, ...curve(from, landing, steps - 1, rng)]
  }

  const dx = landing.x - from.x
  const dy = landing.y - from.y
  const beyond: Point = {
    x: Math.round(landing.x + dx * (0.04 + rng() * 0.06)),
    y: Math.round(landing.y + dy * (0.04 + rng() * 0.06)),
  }
  const correctionSteps = 4 + Math.floor(rng() * 4)

  return [
    from,
    ...curve(from, beyond, steps - 1, rng),
    ...curve(beyond, landing, correctionSteps, rng),
  ]
}

/** A point inside the element's box, deliberately not its exact centre. */
export function elementCentre(
  box: { x: number; y: number; width: number; height: number },
  rng: Rng = Math.random,
): Point {
  const inset = 0.3
  return {
    x: Math.round(box.x + box.width * (inset + rng() * (1 - inset * 2))),
    y: Math.round(box.y + box.height * (inset + rng() * (1 - inset * 2))),
  }
}

/** Walks the cursor along a generated path. Returns where it ended up. */
export async function travelTo(
  page: Page,
  from: Point,
  to: Point,
  options: TravelOptions = {},
): Promise<Point> {
  const rng = options.rng ?? Math.random
  const path = buildTravelPath(from, to, options)

  for (const point of path) {
    await page.mouse.move(point.x, point.y)
    await new Promise((resolve) =>
      setTimeout(resolve, sampleDelay(4, 18, rng)),
    )
  }

  // A hand settles on a target before it clicks.
  await humanDelay(90, 320, rng)
  return path[path.length - 1]!
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter x-poster test
```

Expected: PASS, 34 tests total.

- [ ] **Step 5: Commit**

```bash
git add x-poster/src/human/mouse.ts x-poster/src/human/mouse.test.ts
git commit -m "feat(x-poster): build human cursor paths with bow and overshoot

Bézier control points pushed perpendicular to the straight line, ease-in-out
speed, ±2px endpoint jitter, and a target overshoot on roughly a third of
travels. The tests assert each of those properties rather than just the
endpoints, because the properties are the point.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Clipboard handling

**Files:**
- Create: `x-poster/src/human/clipboard.ts`
- Create: `x-poster/src/human/clipboard.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface ClipboardBackend { read(): Promise<string>; write(text: string): Promise<void> }`
  - `const macClipboard: ClipboardBackend`
  - `withClipboard<T>(text: string, fn: () => Promise<T>, backend?: ClipboardBackend): Promise<T>`

- [ ] **Step 1: Write the failing test**

Create `x-poster/src/human/clipboard.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  macClipboard,
  withClipboard,
  type ClipboardBackend,
} from './clipboard.js'

function fakeClipboard(initial: string): ClipboardBackend & { value: string } {
  return {
    value: initial,
    async read() {
      return this.value
    },
    async write(text: string) {
      this.value = text
    },
  }
}

describe('withClipboard', () => {
  it('puts the text on the clipboard for the duration of the callback', async () => {
    const clipboard = fakeClipboard('whatever was there')
    let seenDuringCallback = ''

    await withClipboard(
      'the tweet body',
      async () => {
        seenDuringCallback = await clipboard.read()
      },
      clipboard,
    )

    expect(seenDuringCallback).toBe('the tweet body')
  })

  it('restores the previous clipboard contents afterwards', async () => {
    const clipboard = fakeClipboard('whatever was there')
    await withClipboard('the tweet body', async () => {}, clipboard)
    expect(clipboard.value).toBe('whatever was there')
  })

  it('restores the clipboard even when the callback throws', async () => {
    // The operator's clipboard is not ours to lose on an error path.
    const clipboard = fakeClipboard('whatever was there')

    await expect(
      withClipboard(
        'the tweet body',
        async () => {
          throw new Error('posting blew up')
        },
        clipboard,
      ),
    ).rejects.toThrow('posting blew up')

    expect(clipboard.value).toBe('whatever was there')
  })

  it('returns the callback result', async () => {
    const clipboard = fakeClipboard('')
    const result = await withClipboard('body', async () => 'done', clipboard)
    expect(result).toBe('done')
  })

  it('still runs the callback when the backup read fails', async () => {
    // An unreadable clipboard must not block posting; it only means there is
    // nothing to restore.
    const clipboard: ClipboardBackend = {
      read: async () => {
        throw new Error('pbpaste unavailable')
      },
      write: async () => {},
    }
    await expect(
      withClipboard('body', async () => 'done', clipboard),
    ).resolves.toBe('done')
  })
})

describe('macClipboard', () => {
  it('round-trips through the real system clipboard', async () => {
    const backup = await macClipboard.read().catch(() => '')
    try {
      await macClipboard.write('x-poster round trip')
      expect(await macClipboard.read()).toBe('x-poster round trip')
    } finally {
      await macClipboard.write(backup)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter x-poster test
```

Expected: FAIL — cannot resolve `./clipboard.js`.

- [ ] **Step 3: Write the implementation**

Create `x-poster/src/human/clipboard.ts`:

```ts
import { spawn } from 'node:child_process'

export interface ClipboardBackend {
  read(): Promise<string>
  write(text: string): Promise<void>
}

function run(command: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command)
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} exited with code ${code}`))
    })
    if (input !== undefined) {
      child.stdin.end(input)
    }
  })
}

/**
 * The system clipboard, driven through pbcopy/pbpaste.
 *
 * Deliberately not navigator.clipboard.writeText(): that would require
 * page.evaluate() — forbidden in this package — and a clipboard permission
 * grant. Driving the OS clipboard keeps the browser's view of the input a
 * pure keyboard paste, indistinguishable from a human one.
 */
export const macClipboard: ClipboardBackend = {
  read: () => run('pbpaste'),
  write: async (text: string) => {
    await run('pbcopy', text)
  },
}

/**
 * Runs `fn` with `text` on the clipboard, then puts back whatever was there.
 *
 * Restoration runs on the error path too — the operator's clipboard is not
 * ours to lose because posting failed.
 */
export async function withClipboard<T>(
  text: string,
  fn: () => Promise<T>,
  backend: ClipboardBackend = macClipboard,
): Promise<T> {
  let backup: string | null = null
  try {
    backup = await backend.read()
  } catch {
    // An unreadable clipboard is not a reason to refuse to post. It only
    // means there is nothing to put back.
    backup = null
  }

  await backend.write(text)
  try {
    return await fn()
  } finally {
    if (backup !== null) {
      await backend.write(backup).catch(() => {})
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter x-poster test
```

Expected: PASS, 40 tests total.

- [ ] **Step 5: Commit**

```bash
git add x-poster/src/human/clipboard.ts x-poster/src/human/clipboard.test.ts
git commit -m "feat(x-poster): paste tweet text through the system clipboard

Driving pbcopy/pbpaste rather than navigator.clipboard.writeText keeps the
browser's view of the input a pure keyboard paste, and avoids the
page.evaluate() this package forbids.

The previous clipboard contents are restored on the error path as well as
the success path — the operator's clipboard is not ours to lose because
posting failed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Rate limiting

**Files:**
- Create: `x-poster/src/queue/rate-limiter.ts`
- Create: `x-poster/src/queue/rate-limiter.test.ts`

**Interfaces:**
- Consumes: `XPosterConfig` from `../config.js`; `Rng`, `sampleDelay` from `../human/delay.js`
- Produces:
  - `interface PostingHistory { lastPostedAt: Date | null; postedToday: number }`
  - `type RateLimitReason = 'ok' | 'interval' | 'daily-cap' | 'outside-active-hours'`
  - `interface RateLimitDecision { allowed: boolean; waitUntil: Date | null; reason: RateLimitReason }`
  - `decide(now: Date, history: PostingHistory, config: XPosterConfig, rng?: Rng): RateLimitDecision`
  - `startOfDay(now: Date): Date`

- [ ] **Step 1: Write the failing test**

Create `x-poster/src/queue/rate-limiter.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { mulberry32 } from '../human/delay.js'
import { decide, startOfDay, type PostingHistory } from './rate-limiter.js'

const config = loadConfig({
  X_PROFILE_DIR: '/tmp/x-profile',
  X_ACTIVE_HOURS: '09:00-23:00',
  X_MIN_INTERVAL_MINUTES: '20',
  X_MAX_INTERVAL_MINUTES: '60',
  X_DAILY_CAP: '10',
} as NodeJS.ProcessEnv)

/** Local time, since the active-hours window is expressed in local time. */
function at(iso: string): Date {
  return new Date(iso)
}

const fresh: PostingHistory = { lastPostedAt: null, postedToday: 0 }
const rng = () => mulberry32(2026)()

describe('decide', () => {
  it('allows a first post inside the window', () => {
    const result = decide(at('2026-08-04T12:00:00'), fresh, config, rng)
    expect(result).toEqual({ allowed: true, waitUntil: null, reason: 'ok' })
  })

  it('waits until the window opens when the day has not started', () => {
    const result = decide(at('2026-08-04T07:30:00'), fresh, config, rng)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('outside-active-hours')
    expect(result.waitUntil).toEqual(at('2026-08-04T09:00:00'))
  })

  it('waits until tomorrow when the window has already closed', () => {
    const result = decide(at('2026-08-04T23:30:00'), fresh, config, rng)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('outside-active-hours')
    expect(result.waitUntil).toEqual(at('2026-08-05T09:00:00'))
  })

  it('treats the window start as inside the window', () => {
    expect(decide(at('2026-08-04T09:00:00'), fresh, config, rng).allowed).toBe(true)
  })

  it('treats the window end as outside the window', () => {
    expect(decide(at('2026-08-04T23:00:00'), fresh, config, rng).allowed).toBe(false)
  })

  it('holds off until the sampled interval has elapsed', () => {
    const result = decide(
      at('2026-08-04T12:05:00'),
      { lastPostedAt: at('2026-08-04T12:00:00'), postedToday: 1 },
      config,
      rng,
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('interval')

    const waitMinutes =
      (result.waitUntil!.getTime() - at('2026-08-04T12:00:00').getTime()) / 60000
    expect(waitMinutes).toBeGreaterThanOrEqual(20)
    expect(waitMinutes).toBeLessThanOrEqual(60)
  })

  it('allows the next post once the ceiling interval has passed', () => {
    const result = decide(
      at('2026-08-04T13:30:00'),
      { lastPostedAt: at('2026-08-04T12:00:00'), postedToday: 1 },
      config,
      rng,
    )
    expect(result).toEqual({ allowed: true, waitUntil: null, reason: 'ok' })
  })

  it('stops at the daily cap and waits for tomorrow', () => {
    const result = decide(
      at('2026-08-04T14:00:00'),
      { lastPostedAt: at('2026-08-04T13:00:00'), postedToday: 10 },
      config,
      rng,
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('daily-cap')
    expect(result.waitUntil).toEqual(at('2026-08-05T09:00:00'))
  })

  it('checks the daily cap before the interval', () => {
    // At the cap, the answer is "not today", not "in 20 minutes".
    const result = decide(
      at('2026-08-04T22:59:00'),
      { lastPostedAt: at('2026-08-04T22:58:00'), postedToday: 10 },
      config,
      rng,
    )
    expect(result.reason).toBe('daily-cap')
  })

  it('checks the active-hours window before anything else', () => {
    const result = decide(
      at('2026-08-04T03:00:00'),
      { lastPostedAt: at('2026-08-03T22:00:00'), postedToday: 10 },
      config,
      rng,
    )
    expect(result.reason).toBe('outside-active-hours')
  })

  it('never proposes a wait in the past', () => {
    for (const hour of [0, 6, 9, 15, 22, 23]) {
      const now = at(`2026-08-04T${String(hour).padStart(2, '0')}:00:00`)
      const result = decide(now, { lastPostedAt: now, postedToday: 3 }, config, rng)
      if (result.waitUntil) {
        expect(result.waitUntil.getTime()).toBeGreaterThanOrEqual(now.getTime())
      }
    }
  })
})

describe('startOfDay', () => {
  it('returns local midnight', () => {
    expect(startOfDay(at('2026-08-04T17:43:21'))).toEqual(at('2026-08-04T00:00:00'))
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter x-poster test
```

Expected: FAIL — cannot resolve `./rate-limiter.js`.

- [ ] **Step 3: Write the implementation**

Create `x-poster/src/queue/rate-limiter.ts`:

```ts
import type { XPosterConfig } from '../config.js'
import { sampleDelay, type Rng } from '../human/delay.js'

export interface PostingHistory {
  lastPostedAt: Date | null
  postedToday: number
}

export type RateLimitReason =
  | 'ok'
  | 'interval'
  | 'daily-cap'
  | 'outside-active-hours'

export interface RateLimitDecision {
  allowed: boolean
  waitUntil: Date | null
  reason: RateLimitReason
}

const MS_PER_MINUTE = 60_000

/** Local midnight for the day containing `now`. */
export function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function minutesIntoDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes()
}

function windowOpensOn(day: Date, config: XPosterConfig): Date {
  return new Date(day.getTime() + config.activeHours.startMinute * MS_PER_MINUTE)
}

function tomorrow(now: Date): Date {
  const day = startOfDay(now)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
}

/**
 * The three gates, in the order that produces the most useful answer.
 *
 * Order matters: at the daily cap the honest answer is "not today", not "in
 * twenty minutes", and outside the window neither of the other two gates is
 * worth evaluating. This ordering is asserted by the tests.
 *
 * The interval is resampled on every call rather than fixed at post time, so
 * the gap between tweets carries no fixed-period signature.
 */
export function decide(
  now: Date,
  history: PostingHistory,
  config: XPosterConfig,
  rng: Rng = Math.random,
): RateLimitDecision {
  const minute = minutesIntoDay(now)

  if (minute < config.activeHours.startMinute) {
    return {
      allowed: false,
      waitUntil: windowOpensOn(startOfDay(now), config),
      reason: 'outside-active-hours',
    }
  }

  if (minute >= config.activeHours.endMinute) {
    return {
      allowed: false,
      waitUntil: windowOpensOn(tomorrow(now), config),
      reason: 'outside-active-hours',
    }
  }

  if (history.postedToday >= config.dailyCap) {
    return {
      allowed: false,
      waitUntil: windowOpensOn(tomorrow(now), config),
      reason: 'daily-cap',
    }
  }

  if (history.lastPostedAt) {
    const requiredMs =
      sampleDelay(
        config.minIntervalMinutes,
        config.maxIntervalMinutes,
        rng,
      ) * MS_PER_MINUTE
    const readyAt = new Date(history.lastPostedAt.getTime() + requiredMs)
    if (readyAt > now) {
      return { allowed: false, waitUntil: readyAt, reason: 'interval' }
    }
  }

  return { allowed: true, waitUntil: null, reason: 'ok' }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter x-poster test
```

Expected: PASS, 52 tests total.

- [ ] **Step 5: Commit**

```bash
git add x-poster/src/queue/rate-limiter.ts x-poster/src/queue/rate-limiter.test.ts
git commit -m "feat(x-poster): gate posting on hours, daily cap, and interval

X weighs account behaviour patterns — frequency, time distribution — far
more heavily than input mechanics, so this matters more than the typing
simulation does.

Gate order is asserted, not incidental: at the daily cap the honest answer
is 'not today' rather than 'in twenty minutes'.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: The tweet queue

**Files:**
- Create: `x-poster/src/queue/tweet-queue.ts`
- Create: `x-poster/src/queue/tweet-queue.test.ts`

**Interfaces:**
- Consumes: `Tweet`, `TweetStatus` from `shared`; `Pool` from `pg`
- Produces `class TweetQueue`:
  - `constructor(pool: Pool)`
  - `enqueue(input: { content: string; dedupeKey: string; source?: string; sourceRef?: string; scheduledAt?: Date }): Promise<Tweet | null>` — `null` when the dedupe key already exists
  - `claimNext(now?: Date): Promise<Tweet | null>`
  - `markPosted(id: number, url: string | null): Promise<void>`
  - `markFailed(id: number, error: string): Promise<void>`
  - `markUncertain(id: number, error: string): Promise<void>`
  - `releaseForRetry(id: number, error: string, retryAt: Date): Promise<void>`
  - `history(now?: Date): Promise<PostingHistory>`
  - `getById(id: number): Promise<Tweet | null>`

- [ ] **Step 1: Write the failing test**

Create `x-poster/src/queue/tweet-queue.test.ts`. It runs against the real Postgres from `docker-compose.yml`.

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool } from 'shared/db'
import { TweetQueue } from './tweet-queue.js'

const pool = createPool({
  user: 'discord_user',
  host: 'localhost',
  database: 'discord_monitor',
  password: 'defaultpassword123',
  port: 5432,
})
const queue = new TweetQueue(pool)

beforeEach(async () => {
  await pool.query("DELETE FROM tweets WHERE dedupe_key LIKE 'test:%'")
})

afterAll(async () => {
  await pool.query("DELETE FROM tweets WHERE dedupe_key LIKE 'test:%'")
  await pool.end()
})

describe('enqueue', () => {
  it('stores a pending tweet', async () => {
    const tweet = await queue.enqueue({
      content: 'hello world',
      dedupeKey: 'test:1',
    })
    expect(tweet).not.toBeNull()
    expect(tweet!.content).toBe('hello world')
    expect(tweet!.status).toBe('pending')
    expect(tweet!.attempts).toBe(0)
    expect(tweet!.postedAt).toBeNull()
  })

  it('returns null rather than throwing on a duplicate dedupe key', async () => {
    await queue.enqueue({ content: 'first', dedupeKey: 'test:dup' })
    const second = await queue.enqueue({ content: 'second', dedupeKey: 'test:dup' })
    expect(second).toBeNull()
  })

  it('records source attribution', async () => {
    const tweet = await queue.enqueue({
      content: 'sourced',
      dedupeKey: 'test:src',
      source: 'ai-assistant',
      sourceRef: '123456789',
    })
    expect(tweet!.source).toBe('ai-assistant')
    expect(tweet!.sourceRef).toBe('123456789')
  })
})

describe('claimNext', () => {
  it('claims the oldest due tweet and marks it sending', async () => {
    await queue.enqueue({ content: 'older', dedupeKey: 'test:a' })
    await queue.enqueue({ content: 'newer', dedupeKey: 'test:b' })

    const claimed = await queue.claimNext()
    expect(claimed!.content).toBe('older')
    expect(claimed!.status).toBe('sending')
    expect(claimed!.attempts).toBe(1)
  })

  it('does not claim the same row twice', async () => {
    await queue.enqueue({ content: 'only one', dedupeKey: 'test:one' })
    const first = await queue.claimNext()
    const second = await queue.claimNext()
    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  it('skips tweets scheduled for the future', async () => {
    await queue.enqueue({
      content: 'later',
      dedupeKey: 'test:later',
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    expect(await queue.claimNext()).toBeNull()
  })

  it('returns null on an empty queue', async () => {
    expect(await queue.claimNext()).toBeNull()
  })
})

describe('terminal transitions', () => {
  it('marks a tweet posted with its url', async () => {
    await queue.enqueue({ content: 'ok', dedupeKey: 'test:ok' })
    const claimed = await queue.claimNext()
    await queue.markPosted(claimed!.id, 'https://x.com/someone/status/1')

    const stored = await queue.getById(claimed!.id)
    expect(stored!.status).toBe('posted')
    expect(stored!.postedUrl).toBe('https://x.com/someone/status/1')
    expect(stored!.postedAt).toBeInstanceOf(Date)
  })

  it('marks a tweet failed with its error', async () => {
    await queue.enqueue({ content: 'bad', dedupeKey: 'test:bad' })
    const claimed = await queue.claimNext()
    await queue.markFailed(claimed!.id, 'gave up after 3 attempts')

    const stored = await queue.getById(claimed!.id)
    expect(stored!.status).toBe('failed')
    expect(stored!.lastError).toBe('gave up after 3 attempts')
    expect(stored!.postedAt).toBeNull()
  })

  it('marks a tweet uncertain and leaves it unclaimable', async () => {
    // Uncertain rows must never be picked up again: the tweet may be live.
    await queue.enqueue({ content: 'maybe sent', dedupeKey: 'test:maybe' })
    const claimed = await queue.claimNext()
    await queue.markUncertain(claimed!.id, 'clicked but could not verify')

    expect((await queue.getById(claimed!.id))!.status).toBe('uncertain')
    expect(await queue.claimNext()).toBeNull()
  })
})

describe('releaseForRetry', () => {
  it('returns the tweet to pending with a future schedule', async () => {
    await queue.enqueue({ content: 'retry me', dedupeKey: 'test:retry' })
    const claimed = await queue.claimNext()
    const retryAt = new Date(Date.now() + 60 * 60 * 1000)
    await queue.releaseForRetry(claimed!.id, 'network hiccup', retryAt)

    const stored = await queue.getById(claimed!.id)
    expect(stored!.status).toBe('pending')
    expect(stored!.lastError).toBe('network hiccup')
    expect(stored!.attempts).toBe(1)
    expect(await queue.claimNext()).toBeNull()
  })

  it('keeps incrementing attempts across claims', async () => {
    await queue.enqueue({ content: 'flaky', dedupeKey: 'test:flaky' })
    const first = await queue.claimNext()
    await queue.releaseForRetry(first!.id, 'once', new Date(Date.now() - 1000))
    const second = await queue.claimNext()
    expect(second!.attempts).toBe(2)
  })
})

describe('history', () => {
  it('reports nothing posted on a clean slate', async () => {
    expect(await queue.history()).toEqual({ lastPostedAt: null, postedToday: 0 })
  })

  it('counts today posts and reports the most recent', async () => {
    await queue.enqueue({ content: 'one', dedupeKey: 'test:h1' })
    await queue.enqueue({ content: 'two', dedupeKey: 'test:h2' })

    const first = await queue.claimNext()
    await queue.markPosted(first!.id, null)
    const second = await queue.claimNext()
    await queue.markPosted(second!.id, null)

    const history = await queue.history()
    expect(history.postedToday).toBe(2)
    expect(history.lastPostedAt).toBeInstanceOf(Date)
  })

  it('does not count failed or uncertain tweets as posted', async () => {
    await queue.enqueue({ content: 'nope', dedupeKey: 'test:h3' })
    const claimed = await queue.claimNext()
    await queue.markFailed(claimed!.id, 'nope')
    expect((await queue.history()).postedToday).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
docker compose up -d
pnpm --filter x-poster test
```

Expected: FAIL — cannot resolve `./tweet-queue.js`.

- [ ] **Step 3: Write the implementation**

Create `x-poster/src/queue/tweet-queue.ts`:

```ts
import type { Pool } from 'pg'
import type { Tweet } from 'shared'
import type { PostingHistory } from './rate-limiter.js'

interface TweetRow {
  id: number
  content: string
  status: Tweet['status']
  dedupe_key: string
  source: string | null
  source_ref: string | null
  attempts: number
  last_error: string | null
  scheduled_at: Date
  posted_at: Date | null
  posted_url: string | null
  created_at: Date
  updated_at: Date
}

function toTweet(row: TweetRow): Tweet {
  return {
    id: row.id,
    content: row.content,
    status: row.status,
    dedupeKey: row.dedupe_key,
    source: row.source,
    sourceRef: row.source_ref,
    attempts: row.attempts,
    lastError: row.last_error,
    scheduledAt: row.scheduled_at,
    postedAt: row.posted_at,
    postedUrl: row.posted_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const COLUMNS = `
  id, content, status, dedupe_key, source, source_ref, attempts, last_error,
  scheduled_at, posted_at, posted_url, created_at, updated_at
`

export interface EnqueueInput {
  content: string
  dedupeKey: string
  source?: string
  sourceRef?: string
  scheduledAt?: Date
}

export class TweetQueue {
  constructor(private readonly pool: Pool) {}

  /** Returns null when the dedupe key is already taken. */
  async enqueue(input: EnqueueInput): Promise<Tweet | null> {
    const result = await this.pool.query<TweetRow>(
      `INSERT INTO tweets (content, dedupe_key, source, source_ref, scheduled_at)
       VALUES ($1, $2, $3, $4, COALESCE($5, NOW()))
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.content,
        input.dedupeKey,
        input.source ?? null,
        input.sourceRef ?? null,
        input.scheduledAt ?? null,
      ],
    )
    return result.rows[0] ? toTweet(result.rows[0]) : null
  }

  /**
   * Atomically takes the oldest due tweet.
   *
   * FOR UPDATE SKIP LOCKED means two concurrent x-poster processes cannot
   * claim the same row, with no coordination between them.
   */
  async claimNext(now: Date = new Date()): Promise<Tweet | null> {
    const result = await this.pool.query<TweetRow>(
      `UPDATE tweets
       SET status = 'sending', attempts = attempts + 1, updated_at = NOW()
       WHERE id = (
         SELECT id FROM tweets
         WHERE status = 'pending' AND scheduled_at <= $1
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${COLUMNS}`,
      [now],
    )
    return result.rows[0] ? toTweet(result.rows[0]) : null
  }

  async markPosted(id: number, url: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE tweets
       SET status = 'posted', posted_at = NOW(), posted_url = $2,
           last_error = NULL, updated_at = NOW()
       WHERE id = $1`,
      [id, url],
    )
  }

  async markFailed(id: number, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE tweets
       SET status = 'failed', last_error = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, error],
    )
  }

  /**
   * Terminal until a human intervenes. The tweet may already be live, so it
   * is never returned to pending — a missed tweet beats a duplicate one.
   */
  async markUncertain(id: number, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE tweets
       SET status = 'uncertain', last_error = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, error],
    )
  }

  /** Back to pending, but not before `retryAt`. `attempts` is left alone. */
  async releaseForRetry(id: number, error: string, retryAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE tweets
       SET status = 'pending', last_error = $2, scheduled_at = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [id, error, retryAt],
    )
  }

  async getById(id: number): Promise<Tweet | null> {
    const result = await this.pool.query<TweetRow>(
      `SELECT ${COLUMNS} FROM tweets WHERE id = $1`,
      [id],
    )
    return result.rows[0] ? toTweet(result.rows[0]) : null
  }

  /** What the rate limiter needs to know, read straight from the table. */
  async history(now: Date = new Date()): Promise<PostingHistory> {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const result = await this.pool.query<{ count: string; last: Date | null }>(
      `SELECT
         COUNT(*) FILTER (WHERE posted_at >= $1) AS count,
         MAX(posted_at) AS last
       FROM tweets
       WHERE status = 'posted'`,
      [startOfDay],
    )
    const row = result.rows[0]
    return {
      postedToday: Number(row?.count ?? 0),
      lastPostedAt: row?.last ?? null,
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter x-poster test
```

Expected: PASS, 67 tests total.

- [ ] **Step 5: Commit**

```bash
git add x-poster/src/queue/tweet-queue.ts x-poster/src/queue/tweet-queue.test.ts
git commit -m "feat(x-poster): add the tweet queue with atomic claiming

FOR UPDATE SKIP LOCKED means two concurrent processes cannot claim the same
row without coordinating. Duplicate enqueues are rejected by the unique
dedupe_key rather than by application logic, and uncertain rows are terminal
until a human resolves them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Chrome launcher

**Files:**
- Create: `x-poster/src/browser/launch-args.ts`
- Create: `x-poster/src/browser/launch-args.test.ts`
- Create: `x-poster/src/browser/chrome-launcher.ts`

**Interfaces:**
- Consumes: `XPosterConfig` from `../config.js`; `FatalError`, `RetryableError` from `../errors.js`; `createLogger` from `shared/logger`
- Produces:
  - `buildLaunchArgs(profileDir: string, debugPort: number): string[]`
  - `FORBIDDEN_ARGS: readonly string[]`
  - `isPortOpen(port: number, host?: string): Promise<boolean>`
  - `interface BrowserHandle { browser: Browser; page: Page; close(): Promise<void> }`
  - `connectOrLaunch(config: XPosterConfig, logger: winston.Logger): Promise<BrowserHandle>`

- [ ] **Step 1: Write the failing test for launch arguments**

Create `x-poster/src/browser/launch-args.test.ts`. This is the regression test that keeps the spec's argument list honest.

```ts
import { describe, expect, it } from 'vitest'
import { FORBIDDEN_ARGS, buildLaunchArgs } from './launch-args.js'

describe('buildLaunchArgs', () => {
  it('produces exactly the six arguments the design permits', () => {
    expect(buildLaunchArgs('/tmp/x-profile', 9333)).toEqual([
      '--user-data-dir=/tmp/x-profile',
      '--remote-debugging-port=9333',
      '--remote-debugging-address=127.0.0.1',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ])
  })

  it('binds the debugging port to loopback only', () => {
    // An open debugging port grants full control over every session in the
    // profile to whoever can reach it.
    expect(buildLaunchArgs('/tmp/x-profile', 9333)).toContain(
      '--remote-debugging-address=127.0.0.1',
    )
  })

  it('always passes an explicit user-data-dir', () => {
    // Chrome 136+ ignores --remote-debugging-port without one.
    const args = buildLaunchArgs('/tmp/x-profile', 9333)
    expect(args.some((a) => a.startsWith('--user-data-dir='))).toBe(true)
  })

  it('contains no automation tell', () => {
    const args = buildLaunchArgs('/tmp/x-profile', 9333)
    for (const forbidden of FORBIDDEN_ARGS) {
      expect(args.some((a) => a.startsWith(forbidden))).toBe(false)
    }
  })

  it('rejects an empty profile directory', () => {
    expect(() => buildLaunchArgs('', 9333)).toThrow(/profile directory/i)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter x-poster test
```

Expected: FAIL — cannot resolve `./launch-args.js`.

- [ ] **Step 3: Write the launch arguments**

Create `x-poster/src/browser/launch-args.ts`:

```ts
/**
 * Arguments that would give the automation away, kept here so the test can
 * assert their absence. `--disable-web-security` additionally strips
 * same-origin protection from a browser holding a live logged-in session.
 */
export const FORBIDDEN_ARGS: readonly string[] = [
  '--no-sandbox',
  '--disable-web-security',
  '--disable-features=VizDisplayCompositor',
  '--enable-automation',
  '--disable-blink-features',
  '--disable-popup-blocking',
  '--headless',
  '--remote-debugging-pipe',
]

/**
 * The complete argument set. Six arguments, no more.
 *
 * The three backgrounding switches defeat background-tab throttling, which
 * would otherwise stall X's lazy-loaded frontend whenever our tab is not
 * frontmost. They are pure scheduling switches: they alter no navigator
 * property and contribute nothing to a fingerprint.
 *
 * Everything else is left alone on purpose. This browser is a real Chrome
 * started by us rather than by Playwright, so navigator.webdriver is already
 * false, and canvas, WebGL, fonts and screen metrics are already genuine.
 * Adding a spoofing layer on top of that is how a fingerprint stops agreeing
 * with itself.
 */
export function buildLaunchArgs(profileDir: string, debugPort: number): string[] {
  if (!profileDir) {
    throw new Error('A dedicated profile directory is required')
  }
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter x-poster test
```

Expected: PASS, 72 tests total.

- [ ] **Step 5: Write the launcher**

Create `x-poster/src/browser/chrome-launcher.ts`. There is no unit test for this file — it is covered by the manual acceptance in Step 6.

```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { chromium, type Browser, type Page } from 'playwright'
import type winston from 'winston'
import type { XPosterConfig } from '../config.js'
import { FatalError } from '../errors.js'
import { buildLaunchArgs } from './launch-args.js'

export interface BrowserHandle {
  browser: Browser
  page: Page
  /** Closes our page. Kills Chrome only if we were the one who started it. */
  close(): Promise<void>
}

export function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    const settle = (open: boolean) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(1000)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

async function waitForPort(
  port: number,
  timeoutMs: number,
  logger: winston.Logger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  logger.error('Chrome did not open its debugging port in time', { port })
  throw new FatalError(
    `Chrome did not open a debugging port on 127.0.0.1:${port} within ${timeoutMs}ms`,
  )
}

function spawnChrome(config: XPosterConfig, logger: winston.Logger): ChildProcess {
  const args = buildLaunchArgs(config.profileDir, config.debugPort)
  logger.info('Starting Chrome', { path: config.chromePath, args })

  const child = spawn(config.chromePath, args, {
    detached: false,
    stdio: 'ignore',
  })
  child.on('error', (error) => {
    logger.error('Chrome failed to start', { error: error.message })
  })
  return child
}

/**
 * Attaches to a Chrome already listening on the debugging port, or starts one
 * if nothing is there.
 *
 * The distinction matters on shutdown: a browser the operator started is
 * theirs, and closing it out from under them would be rude. We only ever kill
 * a Chrome we spawned ourselves.
 */
export async function connectOrLaunch(
  config: XPosterConfig,
  logger: winston.Logger,
): Promise<BrowserHandle> {
  let child: ChildProcess | null = null

  if (await isPortOpen(config.debugPort)) {
    logger.info('Attaching to the Chrome already on the debugging port', {
      port: config.debugPort,
    })
  } else {
    child = spawnChrome(config, logger)
    await waitForPort(config.debugPort, 30_000, logger)
  }

  const browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${config.debugPort}`,
  )
  const context = browser.contexts()[0]
  if (!context) {
    throw new FatalError('Chrome exposed no browser context over CDP')
  }

  // Our own tab. Never brought to the front — the operator's focus is theirs.
  const page = await context.newPage()

  return {
    browser,
    page,
    async close() {
      await page.close().catch(() => {})
      if (child) {
        await browser.close().catch(() => {})
        child.kill('SIGTERM')
      } else {
        // Attached, not owned: disconnect without closing the browser.
        await browser.close().catch(() => {})
      }
    },
  }
}
```

- [ ] **Step 6: Manual acceptance — the spawn path**

Write a throwaway script at `x-poster/scratch-launch.ts`:

```ts
import { createLogger } from 'shared/logger'
import { loadConfig } from './src/config.js'
import { connectOrLaunch } from './src/browser/chrome-launcher.js'

const logger = createLogger('x-poster.log')
const handle = await connectOrLaunch(loadConfig(), logger)
await handle.page.goto('https://x.com/home')
logger.info('Navigated', { title: await handle.page.title() })
await new Promise((resolve) => setTimeout(resolve, 60_000))
await handle.close()
```

Then:

```bash
cd x-poster
cp .env.example .env
pnpm exec tsx scratch-launch.ts
```

Expected: a new Chrome window opens with an empty profile, navigates to X's logged-out home, and the log shows a title. **Log in to X manually in that window now** — the profile persists, so this is the only time it is needed. Wait for the script to exit.

- [ ] **Step 7: Manual acceptance — the attach path and session persistence**

Start Chrome yourself, then run the script again:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$PWD/chrome-profile" \
  --remote-debugging-port=9333 \
  --remote-debugging-address=127.0.0.1 \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling &
sleep 3
pnpm exec tsx scratch-launch.ts
```

Expected, all four:
1. The log says `Attaching to the Chrome already on the debugging port` — no second window opens.
2. A new tab appears in the existing window, already **logged in** to X.
3. Your everyday Chrome keeps working normally throughout.
4. When the script exits, the browser you started stays open.

Then quit that Chrome manually.

- [ ] **Step 8: Verify no automation tell in the live browser**

With the browser from Step 7 running and the script attached, open a fresh tab **manually** in that window, go to `https://bot.sannysoft.com/`, and check the `WebDriver` row.

Expected: `missing (passed)`. If it says `present (failed)`, stop — something is injecting `--enable-automation` and the whole anti-detection premise is broken.

- [ ] **Step 9: Remove the scratch script and commit**

```bash
rm x-poster/scratch-launch.ts
git add x-poster/src/browser/
git commit -m "feat(x-poster): attach to Chrome over CDP, or start one if absent

The launcher only kills a Chrome it spawned itself; a browser the operator
started is theirs, and closing it out from under them would be rude.

The argument list is asserted exhaustively by launch-args.test.ts, including
the absence of every flag that would give the automation away — that test is
the guard rail for the whole anti-detection premise.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: X selectors and session check

The `data-testid` values below are the ones X has used, but they are **not** to be trusted without checking. Step 1 is reconnaissance against the live site; the rest of the task uses whatever it finds.

**Files:**
- Create: `x-poster/src/x/selectors.ts`
- Create: `x-poster/src/x/session.ts`

**Interfaces:**
- Consumes: `FatalError` from `../errors.js`
- Produces:
  - `const selectors: { composeButton, editor, submitButton, tweetArticle, loginForm, timeline }` — all `string`
  - `assertLoggedIn(page: Page, timeoutMs?: number): Promise<void>` — throws `FatalError` when not logged in

- [ ] **Step 1: Reconnaissance — confirm the selectors against the live site**

Start the browser from Task 11 Step 7 and, in that logged-in window, open DevTools on `https://x.com/home`. In the console, run each of these and record what you find:

```js
[
  'SideNav_NewTweet_Button',
  'tweetTextarea_0',
  'tweetButton',
  'tweetButtonInline',
  'tweet',
  'primaryColumn',
  'loginButton',
].forEach((id) => {
  const n = document.querySelectorAll(`[data-testid="${id}"]`).length
  console.log(id, n)
})
```

Write down the count for each. Any that returns `0` must be replaced — find the real one by inspecting the element and reading its `data-testid`.

Note especially **which submit button** is present: `tweetButtonInline` belongs to the timeline's inline composer, `tweetButton` to the modal composer. The design calls for clicking the side-nav compose button, which opens the **modal**, so `tweetButton` is the expected one. Confirm this.

- [ ] **Step 2: Write the selectors file using what Step 1 found**

Create `x-poster/src/x/selectors.ts`, substituting any value that Step 1 showed to be wrong:

```ts
/**
 * Every X DOM selector, in one place.
 *
 * X ships frontend changes without notice, so this file is where that cost
 * is paid. It is deliberately the only module in the package that contains a
 * selector string.
 *
 * Verified against the live site on 2026-08-04. If a run fails with "all
 * selectors missing", re-run the reconnaissance in Task 12 Step 1 of the
 * implementation plan rather than guessing.
 */
export const selectors = {
  /** Side-nav compose button. Opens the modal composer. */
  composeButton: '[data-testid="SideNav_NewTweet_Button"]',
  /** The contenteditable body of the modal composer. */
  editor: '[data-testid="tweetTextarea_0"]',
  /** Submit inside the modal composer. */
  submitButton: '[data-testid="tweetButton"]',
  /** Any tweet in the timeline. Used to confirm the timeline rendered. */
  tweetArticle: 'article[data-testid="tweet"]',
  /** The main column. Its presence means the app shell has loaded. */
  timeline: '[data-testid="primaryColumn"]',
  /** Present only when logged out. */
  loginForm: '[data-testid="loginButton"]',
} as const
```

- [ ] **Step 3: Write the session check**

Create `x-poster/src/x/session.ts`:

```ts
import type { Page } from 'playwright'
import { FatalError } from '../errors.js'
import { selectors } from './selectors.js'

/**
 * Confirms the app shell rendered and we are logged in.
 *
 * Both failures are fatal rather than retryable: neither a logged-out session
 * nor a vanished app shell gets better by trying again, and repeatedly
 * hitting X with a challenged session only deepens the problem.
 */
export async function assertLoggedIn(
  page: Page,
  timeoutMs = 20_000,
): Promise<void> {
  const timeline = page.locator(selectors.timeline)
  const login = page.locator(selectors.loginForm)

  const outcome = await Promise.race([
    timeline
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => 'timeline' as const)
      .catch(() => null),
    login
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => 'login' as const)
      .catch(() => null),
  ])

  if (outcome === 'login') {
    throw new FatalError(
      'X is showing a logged-out page. Log in manually in the dedicated ' +
        'Chrome profile, then restart the service.',
    )
  }

  if (outcome !== 'timeline') {
    throw new FatalError(
      'Neither the timeline nor a login prompt appeared. X may be showing a ' +
        'verification challenge, or the selectors in src/x/selectors.ts are ' +
        'out of date.',
    )
  }
}
```

- [ ] **Step 4: Manual acceptance — logged in**

Recreate the scratch script as `x-poster/scratch-session.ts`:

```ts
import { createLogger } from 'shared/logger'
import { loadConfig } from './src/config.js'
import { connectOrLaunch } from './src/browser/chrome-launcher.js'
import { assertLoggedIn } from './src/x/session.js'

const logger = createLogger('x-poster.log')
const handle = await connectOrLaunch(loadConfig(), logger)
try {
  await handle.page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' })
  await assertLoggedIn(handle.page)
  logger.info('Session check passed')
} catch (error) {
  logger.error('Session check failed', { error: (error as Error).message })
} finally {
  await handle.close()
}
```

```bash
cd x-poster && pnpm exec tsx scratch-session.ts
```

Expected: `Session check passed`.

- [ ] **Step 5: Manual acceptance — logged out**

Temporarily point at a profile with no session:

```bash
X_PROFILE_DIR=./chrome-profile-empty X_DEBUG_PORT=9334 pnpm exec tsx scratch-session.ts
```

Expected: `Session check failed` with the "log in manually" message — not a timeout, and not a crash. Then clean up: `rm -rf chrome-profile-empty`.

- [ ] **Step 6: Remove the scratch script and commit**

```bash
rm x-poster/scratch-session.ts
git add x-poster/src/x/
git commit -m "feat(x-poster): centralise X selectors and add the session check

Every selector string in the package lives in selectors.ts, because X ships
frontend changes without notice and this is where that cost gets paid.

A logged-out session and a vanished app shell are both fatal rather than
retryable: neither improves by trying again, and repeatedly hitting X with a
challenged session only deepens the problem.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: The composer

**Files:**
- Create: `x-poster/src/x/composer.ts`

**Interfaces:**
- Consumes: `selectors`, `assertLoggedIn`, `humanDelay`, `sampleDelay`, `travelTo`, `elementCentre`, `Point`, `withClipboard`, `XPosterConfig`, `FatalError`, `UncertainError`
- Produces:
  - `interface PostResult { url: string | null; dryRun: boolean }`
  - `postTweet(page: Page, content: string, config: XPosterConfig, logger: winston.Logger): Promise<PostResult>`

- [ ] **Step 1: Write the composer**

Create `x-poster/src/x/composer.ts`:

```ts
import { mkdir } from 'node:fs/promises'
import type { Locator, Page } from 'playwright'
import type winston from 'winston'
import type { XPosterConfig } from '../config.js'
import { FatalError, UncertainError } from '../errors.js'
import { withClipboard } from '../human/clipboard.js'
import { humanDelay, sampleDelay } from '../human/delay.js'
import { elementCentre, travelTo, type Point } from '../human/mouse.js'
import { selectors } from './selectors.js'
import { assertLoggedIn } from './session.js'

export interface PostResult {
  url: string | null
  dryRun: boolean
}

/** Where the cursor starts each session. Somewhere unremarkable. */
const CURSOR_ORIGIN: Point = { x: 420, y: 300 }

async function boxOf(locator: Locator, what: string): Promise<Point> {
  const box = await locator.boundingBox()
  if (!box) {
    throw new FatalError(
      `${what} is present but has no layout box — the page may have changed`,
    )
  }
  return elementCentre(box)
}

/** Step 2 of the script: read the timeline the way a person would. */
async function browseTimeline(page: Page, logger: winston.Logger): Promise<void> {
  const scrolls = 3 + Math.floor(Math.random() * 4)
  logger.debug('Browsing the timeline', { scrolls })

  for (let i = 0; i < scrolls; i++) {
    await page.mouse.wheel(0, sampleDelay(280, 900))
    // Pausing to read is most of what browsing actually is.
    await humanDelay(800, 3500)

    // Occasionally glance back up at something.
    if (Math.random() < 0.25) {
      await page.mouse.wheel(0, -sampleDelay(80, 260))
      await humanDelay(500, 1600)
    }
  }
}

/**
 * The seven-step posting script. The only place that knows the whole flow.
 *
 * Never calls page.bringToFront(): CDP input events reach the tab's renderer
 * directly, so none of this steals the operator's cursor or focus.
 */
export async function postTweet(
  page: Page,
  content: string,
  config: XPosterConfig,
  logger: winston.Logger,
): Promise<PostResult> {
  // 1. Arrive.
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' })
  await assertLoggedIn(page)
  await humanDelay(900, 2600)

  // 2. Browse.
  await browseTimeline(page, logger)

  // 3. Travel to the compose button and click it.
  const compose = page.locator(selectors.composeButton).first()
  await compose.waitFor({ state: 'visible', timeout: 15_000 })
  let cursor = await travelTo(page, CURSOR_ORIGIN, await boxOf(compose, 'compose button'))
  await page.mouse.click(cursor.x, cursor.y)

  const editor = page.locator(selectors.editor).first()
  await editor.waitFor({ state: 'visible', timeout: 15_000 })
  await humanDelay(400, 1200)

  // 4. Focus the editor and paste.
  const editorPoint = await boxOf(editor, 'composer editor')
  cursor = await travelTo(page, cursor, editorPoint)
  await page.mouse.click(cursor.x, cursor.y)
  await humanDelay(200, 700)

  await withClipboard(content, async () => {
    await page.keyboard.press('Meta+V')
  })

  // Confirm the paste actually landed before going anywhere near submit.
  await humanDelay(300, 900)
  const typed = (await editor.innerText()).trim()
  if (!typed.includes(content.trim().slice(0, 20))) {
    throw new FatalError(
      'The pasted text did not appear in the composer. The clipboard paste ' +
        'may have been blocked, or the editor selector is out of date.',
    )
  }

  // 5. Re-read it, the way a person does before posting.
  await humanDelay(1500, 4000)

  // 6. Travel to submit.
  const submit = page.locator(selectors.submitButton).first()
  await submit.waitFor({ state: 'visible', timeout: 10_000 })
  const submitPoint = await boxOf(submit, 'submit button')
  cursor = await travelTo(page, cursor, submitPoint)

  if (config.dryRun) {
    await mkdir('screenshots', { recursive: true })
    const path = `screenshots/dry-run-${Date.now()}.png`
    await page.screenshot({ path })
    logger.info('Dry run: stopping before submit', { path, content })
    return { url: null, dryRun: true }
  }

  await page.mouse.click(cursor.x, cursor.y)

  // 7. Verify. From here on, failure is uncertainty rather than failure —
  //    the click already happened and the tweet may well be live.
  try {
    await editor.waitFor({ state: 'hidden', timeout: 20_000 })
  } catch (error) {
    throw new UncertainError(
      'Submit was clicked but the composer never closed. The tweet may or ' +
        'may not have been posted — check the account before requeueing.',
      { cause: error },
    )
  }

  await humanDelay(1500, 4000)
  logger.info('Posted', { length: content.length })

  // The permalink is not reliably reachable straight after posting, and
  // hunting for it risks turning a success into a false uncertainty.
  return { url: null, dryRun: false }
}
```

- [ ] **Step 2: Manual acceptance — dry run**

Create `x-poster/scratch-compose.ts`:

```ts
import { createLogger } from 'shared/logger'
import { loadConfig } from './src/config.js'
import { connectOrLaunch } from './src/browser/chrome-launcher.js'
import { postTweet } from './src/x/composer.js'

const logger = createLogger('x-poster.log')
const config = loadConfig()
const handle = await connectOrLaunch(config, logger)
try {
  const result = await postTweet(
    handle.page,
    'Testing a dry run of my posting setup. This should never be sent.',
    config,
    logger,
  )
  logger.info('Result', result)
} finally {
  await handle.close()
}
```

Confirm `X_DRY_RUN=true` in `x-poster/.env`, then:

```bash
cd x-poster && pnpm exec tsx scratch-compose.ts
```

**Watch the browser window while it runs** and confirm each of these:
1. The timeline scrolls in irregular steps with pauses, occasionally jumping back up.
2. The cursor travels in a visible **arc**, not a straight line, and sometimes slightly overshoots the compose button before settling.
3. The composer modal opens and the full text appears **at once** (a paste), not character by character.
4. There is a clear pause after the text appears, before the cursor moves to submit.
5. It stops with the cursor on the submit button and **never clicks it**.
6. `screenshots/dry-run-*.png` exists and shows the composed tweet.

If any of 1–4 does not happen, the corresponding `human/*` module is not wired in correctly — fix before continuing.

- [ ] **Step 3: Manual acceptance — a real post**

Set `X_DRY_RUN=false` in `x-poster/.env` and run the same script once.

Expected: the tweet posts, the modal closes, and the log shows `Posted`. Verify on your profile, then **delete the test tweet manually**.

Set `X_DRY_RUN=true` again afterwards, so the default state on disk is the safe one.

- [ ] **Step 4: Remove the scratch script and commit**

```bash
rm x-poster/scratch-compose.ts
git add x-poster/src/x/composer.ts
git commit -m "feat(x-poster): add the seven-step posting script

Browse, travel, paste, re-read, travel, submit, verify. The only module that
knows the whole flow, so changing the pacing touches human/* and changing X's
DOM touches selectors.ts, and neither touches the other.

Everything after the submit click raises UncertainError rather than a
failure: the click already happened, so a verification timeout means the
tweet may be live, and treating that as a retryable failure would double-post.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: The service loop

**Files:**
- Create: `x-poster/src/notifier.ts`
- Create: `x-poster/src/notifier.test.ts`
- Create: `x-poster/src/index.ts`

**Interfaces:**
- Consumes: everything built so far
- Produces:
  - `notifyCircuitBreak(webhookUrl: string | null, message: string, fetchImpl?: typeof fetch): Promise<void>`
  - `main(): Promise<void>` (the module's default behaviour when run)

- [ ] **Step 1: Write the failing test for the notifier**

Create `x-poster/src/notifier.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { notifyCircuitBreak } from './notifier.js'

describe('notifyCircuitBreak', () => {
  it('posts the message to the webhook', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    await notifyCircuitBreak('https://example.test/hook', 'session expired', fetchImpl as never)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://example.test/hook')
    expect(JSON.parse((init as RequestInit).body as string).content).toContain(
      'session expired',
    )
  })

  it('does nothing when no webhook is configured', async () => {
    const fetchImpl = vi.fn()
    await notifyCircuitBreak(null, 'session expired', fetchImpl as never)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('swallows a webhook failure', async () => {
    // A broken notification must not mask the failure it was reporting.
    const fetchImpl = vi.fn().mockRejectedValue(new Error('webhook down'))
    await expect(
      notifyCircuitBreak('https://example.test/hook', 'session expired', fetchImpl as never),
    ).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter x-poster test
```

Expected: FAIL — cannot resolve `./notifier.js`.

- [ ] **Step 3: Write the notifier**

Create `x-poster/src/notifier.ts`:

```ts
/**
 * Circuit-break notifications, sent through the Discord webhook the
 * workspace already has. A second notification channel is not warranted.
 */
export async function notifyCircuitBreak(
  webhookUrl: string | null,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!webhookUrl) return

  try {
    await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'x-poster',
        content: `🛑 **x-poster stopped**\n\`\`\`\n${message}\n\`\`\``,
      }),
    })
  } catch {
    // A broken notification must not mask the failure it was reporting.
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter x-poster test
```

Expected: PASS, 75 tests total.

- [ ] **Step 5: Write the service loop**

Create `x-poster/src/index.ts`:

```ts
import { createLogger } from 'shared/logger'
import { createPool } from 'shared/db'
import { connectOrLaunch, type BrowserHandle } from './browser/chrome-launcher.js'
import { loadConfig } from './config.js'
import {
  FatalError,
  RetryableError,
  UncertainError,
  classifyError,
} from './errors.js'
import { notifyCircuitBreak } from './notifier.js'
import { decide } from './queue/rate-limiter.js'
import { TweetQueue } from './queue/tweet-queue.js'
import { postTweet } from './x/composer.js'

const logger = createLogger('x-poster.log')
const config = loadConfig()
const pool = createPool()
const queue = new TweetQueue(pool)

let handle: BrowserHandle | null = null
let stopping = false

/** Sleeps, but wakes early on shutdown. */
async function sleep(ms: number): Promise<void> {
  const step = 1000
  let elapsed = 0
  while (elapsed < ms && !stopping) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - elapsed)))
    elapsed += step
  }
}

function backoffMs(attempts: number): number {
  return Math.min(30 * 60_000, 60_000 * 2 ** (attempts - 1))
}

async function tick(): Promise<void> {
  const now = new Date()
  const verdict = decide(now, await queue.history(now), config)

  if (!verdict.allowed) {
    const waitMs = Math.max(1000, (verdict.waitUntil!.getTime() - now.getTime()))
    logger.info('Holding off', {
      reason: verdict.reason,
      until: verdict.waitUntil!.toISOString(),
    })
    await sleep(waitMs)
    return
  }

  const tweet = await queue.claimNext(now)
  if (!tweet) {
    await sleep(60_000)
    return
  }

  logger.info('Claimed a tweet', { id: tweet.id, attempt: tweet.attempts })

  if (!handle) {
    handle = await connectOrLaunch(config, logger)
  }

  try {
    const result = await postTweet(handle.page, tweet.content, config, logger)

    if (result.dryRun) {
      // A dry run proves nothing about delivery, so the row stays claimable.
      await queue.releaseForRetry(tweet.id, 'dry run: not submitted', new Date())
      logger.info('Dry run complete, tweet returned to the queue', { id: tweet.id })
      await sleep(30_000)
      return
    }

    await queue.markPosted(tweet.id, result.url)
    logger.info('Posted', { id: tweet.id })
  } catch (raw) {
    const error = classifyError(raw)

    if (error instanceof UncertainError) {
      await queue.markUncertain(tweet.id, error.message)
      logger.error('Outcome unknown — not retrying', { id: tweet.id, error: error.message })
      throw new FatalError(
        `Tweet ${tweet.id} may or may not have been posted: ${error.message}`,
      )
    }

    if (error instanceof RetryableError) {
      if (tweet.attempts >= config.maxAttempts) {
        await queue.markFailed(tweet.id, error.message)
        logger.error('Giving up', { id: tweet.id, attempts: tweet.attempts })
        return
      }
      const retryAt = new Date(Date.now() + backoffMs(tweet.attempts))
      await queue.releaseForRetry(tweet.id, error.message, retryAt)
      logger.warn('Retrying later', { id: tweet.id, retryAt: retryAt.toISOString() })
      return
    }

    await queue.releaseForRetry(tweet.id, error.message, new Date())
    throw error
  }
}

async function shutdown(reason: string, code: number): Promise<void> {
  if (stopping) return
  stopping = true
  logger.info('Shutting down', { reason })
  await handle?.close().catch(() => {})
  await pool.end().catch(() => {})
  process.exit(code)
}

async function main(): Promise<void> {
  logger.info('Starting x-poster', {
    dryRun: config.dryRun,
    dailyCap: config.dailyCap,
    activeHours: config.activeHours,
  })

  process.on('SIGINT', () => void shutdown('SIGINT', 0))
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0))

  while (!stopping) {
    try {
      await tick()
    } catch (raw) {
      const error = classifyError(raw)
      if (error instanceof RetryableError) {
        logger.warn('Transient failure in the loop, backing off', {
          error: error.message,
        })
        await sleep(120_000)
        continue
      }

      // Circuit break. A dead session makes every subsequent attempt fail
      // too, and hammering a challenged account only deepens the problem.
      logger.error('Circuit break', { error: error.message })
      await notifyCircuitBreak(config.discordWebhookUrl, error.message)
      await shutdown('circuit break', 1)
    }
  }
}

main().catch(async (error) => {
  logger.error('Unrecoverable startup failure', { error: String(error) })
  await notifyCircuitBreak(config.discordWebhookUrl, String(error))
  await shutdown('startup failure', 1)
})
```

- [ ] **Step 6: Manual acceptance — a dry-run cycle**

Confirm `X_DRY_RUN=true`, enqueue a tweet, and run the service:

```bash
docker exec discord-postgres psql -U discord_user -d discord_monitor -c \
  "INSERT INTO tweets (content, dedupe_key, source) VALUES ('Testing my posting setup end to end.', 'manual:smoke-1', 'manual');"

cd x-poster && pnpm start
```

Expected: the log shows `Starting x-poster`, `Claimed a tweet`, the browser runs the full script, then `Dry run complete, tweet returned to the queue`. Stop with Ctrl+C and confirm it exits cleanly.

- [ ] **Step 7: Manual acceptance — the rate limiter holds**

Run again immediately:

```bash
pnpm start
```

Expected: since nothing was actually posted, the tweet is claimed again rather than held off. Now confirm the other direction — set `X_ACTIVE_HOURS` to a window that excludes the current time (e.g. `03:00-04:00`) and run again.

Expected: `Holding off` with `reason: 'outside-active-hours'` and a `until` timestamp, and **no browser opens**. Restore `X_ACTIVE_HOURS=09:00-23:00`.

- [ ] **Step 8: Manual acceptance — the circuit breaker**

Break the session check deliberately: set `X_PROFILE_DIR=./chrome-profile-empty` and `X_DEBUG_PORT=9334`, then run.

Expected: `Circuit break` in the log, a Discord notification if `DISCORD_WEBHOOK_URL` is set, and the process exits **non-zero**:

```bash
pnpm start; echo "exit=$?"
```

Expected: `exit=1`. Then clean up (`rm -rf chrome-profile-empty`) and restore the profile settings.

- [ ] **Step 9: Clean the test row and commit**

```bash
docker exec discord-postgres psql -U discord_user -d discord_monitor -c \
  "DELETE FROM tweets WHERE dedupe_key LIKE 'manual:%';"

git add x-poster/src/notifier.ts x-poster/src/notifier.test.ts x-poster/src/index.ts
git commit -m "feat(x-poster): add the service loop with circuit breaker

Retryable failures back off exponentially and return the row to pending.
Anything fatal stops the loop, notifies through the webhook the workspace
already has, and exits non-zero — a dead session makes every subsequent
attempt fail too.

An uncertain outcome marks the row and then breaks the circuit rather than
continuing, because the one thing worse than stopping is quietly posting the
next tweet while the previous one's fate is unknown.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 15: Remove the dangerous launch flags from `scraper`

Isolated deliberately: this changes how the existing Discord monitor launches its browser, and it needs its own live verification.

**Files:**
- Modify: `scraper/src/discord-monitor.ts:67-78`

**Interfaces:**
- Consumes: nothing
- Produces: nothing

- [ ] **Step 1: Record the current behaviour**

Start the monitor and confirm it captures messages **before** changing anything, so any regression is unambiguous:

```bash
cd /Users/hanlynn/Projects/my/multi-tab-listening
docker compose up -d
pnpm --filter scraper start
```

Let it run until the log shows at least one `New message from ...` line, or until `Created tab for channel:` appears for every configured channel. Note which. Stop with Ctrl+C.

- [ ] **Step 2: Remove the flags**

In `scraper/src/discord-monitor.ts`, replace:

```ts
      this.browser = await chromium.launch({
        headless: false, // Keep visible for debugging
        handleSIGINT: false, // Disable automatic browser close on Ctrl+C
        handleSIGTERM: false, // Disable automatic browser close on SIGTERM
        handleSIGHUP: false, // Disable automatic browser close on SIGHUP
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
        ],
      })
```

with:

```ts
      this.browser = await chromium.launch({
        headless: false, // Keep visible for debugging
        handleSIGINT: false, // Disable automatic browser close on Ctrl+C
        handleSIGTERM: false, // Disable automatic browser close on SIGTERM
        handleSIGHUP: false, // Disable automatic browser close on SIGHUP
        // --no-sandbox, --disable-web-security and
        // --disable-features=VizDisplayCompositor used to be here. All three
        // are automation tells, and the second strips same-origin protection
        // from a browser holding a live Discord session. Only the shared-memory
        // workaround is kept, which changes no observable browser behaviour.
        args: ['--disable-dev-shm-usage'],
      })
```

- [ ] **Step 3: Verify the monitor still works**

```bash
pnpm --filter scraper start
```

Expected: the same outcome recorded in Step 1 — every configured channel reaches `Created tab for channel:`, and message capture resumes. Watch for at least two minutes. If a channel fails to load, **stop and investigate before committing**; do not restore the flags without understanding which one was load-bearing.

- [ ] **Step 4: Confirm messages still reach the database**

```bash
docker exec discord-postgres psql -U discord_user -d discord_monitor -c \
  "SELECT COUNT(*), MAX(created_at) FROM messages;"
```

Expected: `max` is within the last few minutes.

- [ ] **Step 5: Commit**

```bash
git add scraper/src/discord-monitor.ts
git commit -m "refactor(scraper): drop three launch flags that gave the game away

--no-sandbox, --disable-web-security and --disable-features=VizDisplayCompositor
are prime automation tells, and the second strips same-origin protection from
a browser holding a live Discord session.

--disable-dev-shm-usage stays: it works around a container shared-memory limit
and changes no observable browser behaviour.

Verified by a live run — every channel tab loads and messages still reach the
database.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 16: Adopt the shared modules and update the docs

**Files:**
- Modify, logger: `scraper/src/discord-monitor.ts`, `scraper/src/database.ts`, `ai-assistant/src/scheduler/message-poller.ts`, `ai-assistant/src/discord/webhook-sender.ts`, `ai-assistant/src/database/queries.ts`, `ai-assistant/src/ai/fireworks-client.ts`, `ai-assistant/src/ai/message-analyzer.ts`
- Modify, pool: `scraper/src/database.ts:10`, `ai-assistant/src/database/queries.ts:11`, `scraper/src/setup-database.ts`
- Modify, `DbConfig`: `scraper/src/types.ts`, `ai-assistant/src/types.ts`, `scraper/src/config.ts`, `ai-assistant/src/config.ts`
- Modify: `README.md`
- No package.json changes: `shared` is already a dependency of both packages

**Interfaces:**
- Consumes: `createLogger` from `shared/logger`; `createPool`, `loadDbConfig`, `DbConfig` from `shared/db`
- Produces: nothing new

- [ ] **Step 1: Replace the logger construction in `scraper/src/discord-monitor.ts`**

Delete the `winston.createLogger({...})` block in the constructor (lines 34-53) and change `import winston from 'winston'` to `import type winston from 'winston'` — the `public logger: winston.Logger` field declaration still needs the type. Add:

```ts
import { createLogger } from 'shared/logger'
```

and in the constructor:

```ts
    this.logger = createLogger('discord-monitor.log')
```

- [ ] **Step 2: Replace the remaining six logger constructions**

The same substitution in each file below, keeping its existing log filename so nothing that tails these files breaks. In each: delete the `winston.createLogger({...})` block, add `import { createLogger } from 'shared/logger'`, and keep `import type winston from 'winston'` only if a field or parameter is still annotated `winston.Logger`.

| File | Replace with |
| --- | --- |
| `scraper/src/database.ts` | `createLogger('database.log')` |
| `ai-assistant/src/scheduler/message-poller.ts` | `createLogger('message-poller.log')` |
| `ai-assistant/src/discord/webhook-sender.ts` | `createLogger('discord-webhook.log')` |
| `ai-assistant/src/database/queries.ts` | `createLogger('ai-assistant.log')` |
| `ai-assistant/src/ai/fireworks-client.ts` | `createLogger('fireworks-ai.log')` |
| `ai-assistant/src/ai/message-analyzer.ts` | `createLogger('message-analyzer.log')` |

Verify none are left behind:

```bash
grep -rn "winston.createLogger" scraper/src ai-assistant/src x-poster/src
```

Expected: no output.

- [ ] **Step 3: Replace the duplicated `DbConfig` shape**

In `scraper/src/types.ts`, replace the inline `database` shape in `Config`:

```ts
import type { DbConfig } from 'shared/db'

export interface Config {
  channels: ChannelInfo[]
  storageStatePath?: string
  database: DbConfig
  filtering: {
    enabled: boolean
    trivialPhrases: string[]
    minLength: number
  }
}
```

In `ai-assistant/src/types.ts`, do the same for `AIConfig`:

```ts
import type { DbConfig } from 'shared/db'

export interface AIConfig {
  database: DbConfig
  // ...the rest unchanged
}
```

- [ ] **Step 4: Use the shared config loader and pool**

In `scraper/src/config.ts`, replace the inline `database: {...}` literal with `database: loadDbConfig()`, importing `loadDbConfig` from `shared/db`. Do the same in `ai-assistant/src/config.ts`.

In `scraper/src/database.ts` and `ai-assistant/src/database/queries.ts`, replace each hand-built `new Pool({...})` with `createPool()` from `shared/db`.

In `scraper/src/setup-database.ts`, replace the inline `new Client({...})` config object with `loadDbConfig()`.

- [ ] **Step 5: Verify both services still typecheck**

```bash
cd /Users/hanlynn/Projects/my/multi-tab-listening
pnpm install
pnpm --filter scraper exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Verify both services still run**

```bash
pnpm --filter scraper run setup-db
pnpm --filter scraper start   # Ctrl+C after tabs load and a message arrives
pnpm --filter ai-assistant start   # Ctrl+C after one polling cycle logs
```

Expected: both start, log through the shared logger, and reach the database.

- [ ] **Step 7: Update the README**

Make four edits to `README.md`:

1. In **Overview**, add a third bullet after the AI Assistant one:

```markdown
- **X Poster** — drains a queue of pending tweets from the database and posts each one through a real Chrome browser driven over CDP, pacing the interaction so it reads as human.
```

2. In the **Architecture** mermaid diagram, add the poster branch:

```
    C -->|poll| F["X Poster\n(real Chrome via CDP)"]
    F -->|post| G["x.com"]
```

3. In **Quick Start**, add a step after the AI assistant one:

```markdown
# 8. In a third terminal, start the X poster
#    First run only: it opens a Chrome window with a blank dedicated profile.
#    Log in to X manually there — the profile persists.
#    X_DRY_RUN defaults to true; it will run the full script without posting.
cp x-poster/.env.example x-poster/.env
pnpm --filter x-poster start
```

4. Add this table to **Configuration**, after the AI Assistant one:

```markdown
### X Poster (`x-poster/.env`)

| Variable | Description | Default |
|----------|-------------|---------|
| `X_PROFILE_DIR` | Dedicated Chrome user-data directory | required |
| `X_DEBUG_PORT` | CDP port, bound to `127.0.0.1` | `9333` |
| `X_CHROME_PATH` | Chrome binary path | macOS install path |
| `X_DRY_RUN` | Run the full script but never click submit | `false` |
| `X_MIN_INTERVAL_MINUTES` | Interval floor between tweets | `20` |
| `X_MAX_INTERVAL_MINUTES` | Interval ceiling between tweets | `60` |
| `X_DAILY_CAP` | Maximum tweets per day | `10` |
| `X_ACTIVE_HOURS` | Local-time posting window; must not wrap past midnight | `09:00-23:00` |
| `X_MAX_ATTEMPTS` | Retries for retryable errors | `3` |
| `DISCORD_WEBHOOK_URL` | Where circuit-break alerts are sent | optional |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | PostgreSQL connection | required |
```

plus this note underneath:

```markdown
> `X_PROFILE_DIR` must **not** point at your everyday Chrome profile. Chrome 136+
> ignores `--remote-debugging-port` unless a non-default `--user-data-dir` is
> given, and an open debugging port grants any local process full control over
> every session in that profile.
```

Also add `x-poster/` to the **Project Structure** tree, mirroring the layout in the design document.

- [ ] **Step 8: Run the whole test suite**

```bash
pnpm --filter shared test && pnpm --filter x-poster test
```

Expected: PASS, 9 tests in `shared` and 75 in `x-poster`.

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "refactor: adopt the shared logger, pool and DbConfig everywhere

Seven hand-built winston loggers, three hand-built pg configs and two copies
of the same database config shape now come from shared. Documents x-poster
in the README, including why its profile directory must not be the everyday
Chrome one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification Checklist

Run before opening a pull request.

- [ ] `pnpm --filter shared test` — 9 passing
- [ ] `pnpm --filter x-poster test` — 75 passing
- [ ] `pnpm --filter scraper exec tsc --noEmit` — clean
- [ ] `pnpm --filter x-poster exec tsc --noEmit` — clean
- [ ] `pnpm --filter scraper run setup-db` exits 0 and `\d tweets` shows the table
- [ ] `scraper` starts, loads every channel tab, and writes a message to the database
- [ ] `ai-assistant` starts and completes a polling cycle
- [ ] `x-poster` with `X_DRY_RUN=true` completes the full script and writes a screenshot
- [ ] `x-poster` circuit-breaks and exits non-zero when pointed at a logged-out profile
- [ ] `git grep -n "page.evaluate\|addInitScript" x-poster/src` returns nothing
- [ ] `git grep -n "no-sandbox\|disable-web-security" -- ':!docs'` returns nothing
- [ ] `x-poster/.env` and `x-poster/chrome-profile/` are untracked
