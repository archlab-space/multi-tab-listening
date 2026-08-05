# Drizzle Schema and Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the database schema out of `discord-monitor` into a Drizzle
definition under versioned migrations, and reduce a new machine's database
setup to `pnpm install && pnpm db:up`.

**Architecture:** The schema is defined once in `shared/src/schema.ts` as
Drizzle `pgTable` calls, because it is the contract between four services that
never call each other and only meet in Postgres. A new `db` package holds the
tooling — drizzle-kit, the generated migrations, the Studio entry point — and
no service depends on it at runtime. Root `package.json` scripts wrap Docker
and the migrator so `pnpm` stays the only entry point.

**Tech Stack:** TypeScript, pnpm workspace, `pg`, drizzle-orm, drizzle-kit,
Docker Compose, pgvector, vitest.

**Spec:** `docs/superpowers/specs/2026-08-05-drizzle-schema-and-migrations-design.md`

## Global Constraints

- **This plan changes no query.** Every one of the 313 currently passing tests
  must still pass, unchanged, at the end of every task. Rewriting queries
  against Drizzle is a separate plan.
- **Postgres image is `pgvector/pgvector:pg15`.** The `messages.embedding`
  column is `VECTOR(1536)` and needs the `vector` extension.
- **Database defaults** come from `shared/src/db.ts` `loadDbConfig()`: user
  `app_user`, host `localhost`, database `multi_tab_listening`, port `5432`.
  Password comes from `DB_PASSWORD` with no default.
- **The container binds `127.0.0.1` only.** Never change it to `0.0.0.0` — the
  password is committed to a public repo.
- **Timestamp types are not interchangeable.** `channels`, `messages` and
  `threads` use `TIMESTAMP` (no zone); `tweets` and `generation_attempts` use
  `TIMESTAMPTZ`, deliberately, because every one of their time columns feeds a
  scheduling decision. Reproduce each exactly.
- **Run tests sequentially**: `pnpm -r --workspace-concurrency=1 --if-present test`.
  All packages share one database, so the default parallel run makes
  x-poster and tweet-generator delete each other's rows.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

## File Structure

**Created:**
- `db/package.json` — drizzle-kit scripts; not a runtime dependency of anything
- `db/drizzle.config.ts` — points drizzle-kit at `shared/src/schema.ts`
- `db/migrations/` — generated SQL, committed
- `shared/src/schema.ts` — the `pgTable` definitions; the source of truth
- `shared/src/schema.test-d.ts` — type-level assertions that the schema
  reproduces the existing hand-written interfaces exactly
- `shared/tsconfig.json` — so `shared` can be type-checked on its own

**Modified:**
- `shared/package.json` — export `./schema`, add `typecheck` script, add
  `drizzle-orm` dependency
- `docker-compose.yml` — add healthcheck, drop the obsolete `version` key
- `package.json` (root) — add `db:*` scripts
- `discord-monitor/src/index.ts:24` — remove the `setupDatabase()` call
- `discord-monitor/package.json` — remove the `setup-db` script
- `README.md`, `discord-monitor/README.md` — document `pnpm db:up`

**Deleted:**
- `discord-monitor/src/setup-database.ts`

---

## Task 1: Scaffold the `db` package

Creates the tooling package and proves drizzle-kit can reach the database.
Nothing generates yet — this task exists so the next one starts from a known
connection, rather than debugging credentials and schema authoring at once.

**Files:**
- Create: `db/package.json`
- Create: `db/drizzle.config.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `shared/package.json`

**Interfaces:**
- Consumes: `loadDbConfig()` from `shared/db` — returns
  `{ user, host, database, password, port }`
- Produces: `db/drizzle.config.ts` default export, consumed by every
  `drizzle-kit` invocation in later tasks

- [ ] **Step 1: Add `db` to the workspace**

In `pnpm-workspace.yaml`, add `db` to the `packages` list and add the two new
dependencies to the catalog so their versions are pinned in one place:

```yaml
packages:
  - shared
  - discord-monitor
  - ai-assistant
  - x-poster
  - tweet-generator
  - db

# Shared across the packages — bump here, not in each package.json.
catalog:
  pg: ^8.22.0
  winston: ^3.19.0
  '@types/pg': ^8.20.0
  vitest: ^3.2.4
  playwright: ^1.62.1
  dotenv: ^17.4.2
  drizzle-orm: ^0.44.0
  drizzle-kit: ^0.31.0
```

- [ ] **Step 2: Create `db/package.json`**

```json
{
  "name": "db",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "generate": "drizzle-kit generate",
    "migrate": "drizzle-kit migrate",
    "pull": "drizzle-kit pull",
    "studio": "drizzle-kit studio"
  },
  "dependencies": {
    "shared": "workspace:*",
    "dotenv": "catalog:"
  },
  "devDependencies": {
    "@types/node": "^24.13.3",
    "drizzle-kit": "catalog:",
    "tsx": "^4.23.1",
    "typescript": "^6.0.0"
  }
}
```

- [ ] **Step 3: Create `db/drizzle.config.ts`**

`dbCredentials` accepts discrete connection parameters, which is exactly the
shape `loadDbConfig()` already returns — so there is no second place where
database credentials are described.

```typescript
import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'
import { loadDbConfig } from 'shared/db'

const config = loadDbConfig()

export default defineConfig({
  dialect: 'postgresql',
  // The schema lives in `shared` because it is the contract between the
  // services, not a private detail of this tooling package.
  schema: '../shared/src/schema.ts',
  out: './migrations',
  dbCredentials: {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: false,
  },
})
```

- [ ] **Step 4: Add `drizzle-orm` to `shared`**

The schema file imports its column builders from `drizzle-orm/pg-core`, so the
dependency belongs to `shared`. In `shared/package.json`, add to
`"dependencies"`:

```json
"drizzle-orm": "catalog:"
```

- [ ] **Step 5: Install and verify the connection**

```bash
pnpm install
```

Then, with the existing container still running:

```bash
cd db && pnpm exec drizzle-kit pull --config drizzle.config.ts 2>&1 | head -20
```

Expected: it connects and reports pulling tables. It will fail afterwards
because `../shared/src/schema.ts` does not exist yet — that is fine and
expected at this step. A connection error (`ECONNREFUSED`, `password
authentication failed`) is a real failure: fix `DB_PASSWORD` before continuing.

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml db/package.json db/drizzle.config.ts shared/package.json
git commit -m "$(cat <<'EOF'
chore(db): scaffold the migration tooling package

drizzle.config.ts reads loadDbConfig() rather than restating the
connection, so credentials keep having exactly one definition.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Define the schema and prove it matches the existing types

The schema is written to reproduce the live database exactly. The test is
type-level: the types Drizzle infers must be structurally identical to the
interfaces `shared/src/types.ts` has been hand-maintaining. That assertion is
the whole safety net for this task — if it passes, no consumer of `Tweet` or
`DiscordMessage` can observe the difference.

**Files:**
- Create: `shared/src/schema.ts`
- Create: `shared/src/schema.test-d.ts`
- Create: `shared/tsconfig.json`
- Modify: `shared/package.json`

**Interfaces:**
- Consumes: `db/drizzle.config.ts` (Task 1)
- Produces: `shared/src/schema.ts` exporting `channels`, `messages`, `threads`,
  `tweets`, `generationAttempts`. Their inferred types
  (`typeof tweets.$inferSelect`) are what the query-rewrite plan builds on.

- [ ] **Step 1: Pull the live schema as a starting point**

The running database is the authority on what the schema is —
`setup-database.ts` has drifted from it before.

```bash
cd db && pnpm run pull
```

This writes a schema file plus a snapshot into `db/migrations/`. Read the
generated schema, then **discard the generated files** (`git clean -fd db/` or
delete `db/migrations/`): it is a reference for Step 2, not the deliverable.
Its value is telling you what actually exists, including anything
`setup-database.ts` no longer reflects.

- [ ] **Step 2: Write the failing type assertions**

Create `shared/src/schema.test-d.ts`. Bidirectional assignability is
structural equality: each pair passes only if the inferred type and the
hand-written interface have exactly the same fields with the same types.

```typescript
/**
 * Type-level assertions, not runtime tests. They exist to prove the Drizzle
 * schema reproduces the interfaces `types.ts` has been hand-maintaining, so
 * that replacing one with the other is invisible to every consumer.
 *
 * Assignability in both directions is structural equality: a missing field
 * fails one direction, an extra field fails the other.
 */
import type { DiscordMessage, Tweet } from './types.js'
import type { messages, tweets } from './schema.js'

type SelectedTweet = typeof tweets.$inferSelect
type SelectedMessage = typeof messages.$inferSelect

// `Tweet` and the inferred row type must be interchangeable.
const _tweetIsAssignableToInterface: Tweet = {} as SelectedTweet
const _interfaceIsAssignableToTweet: SelectedTweet = {} as Tweet

/**
 * `DiscordMessage` gets a names-only check, not a bidirectional one, for two
 * reasons.
 *
 * It is deliberately narrower than the table: it omits the columns only
 * ai-assistant writes (`processed`, `is_question`, `embedding` and friends).
 *
 * And it is optimistic about nullability. `author_id`, `author_name`,
 * `content` and `timestamp` are all nullable in the database, while the
 * interface declares them required — so the row type is not assignable to it.
 * That gap is a real finding, not a schema error: the schema describes what
 * Postgres will actually hand back. Do not "fix" it by adding `.notNull()`
 * to columns that are nullable in the live database; the migration would then
 * disagree with the data. Resolving it belongs to the plan that replaces these
 * interfaces with inferred types.
 */
type MessageKeysExist = keyof DiscordMessage extends keyof SelectedMessage
  ? true
  : never
const _messageKeysExist: MessageKeysExist = true

// Referenced so the compiler does not report them as unused.
export type _Assertions = [
  typeof _tweetIsAssignableToInterface,
  typeof _interfaceIsAssignableToTweet,
  typeof _messageKeysExist,
]
```

- [ ] **Step 3: Add a tsconfig and typecheck script to `shared`**

`shared` has neither today, so nothing type-checks it on its own. Create
`shared/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["ES2022"],
    "noEmit": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

Add to `shared/package.json` scripts:

```json
"typecheck": "tsc --noEmit"
```

- [ ] **Step 4: Run the assertions to verify they fail**

```bash
pnpm --filter shared run typecheck
```

Expected: FAIL — `Cannot find module './schema.js'`.

- [ ] **Step 5: Write the schema**

Create `shared/src/schema.ts`. The explanatory comments are carried over from
`setup-database.ts`; they are the reason several of these choices are not
arbitrary, and they do not survive anywhere else once that file is deleted.

```typescript
/**
 * The database schema — the actual contract between the four services, which
 * never call each other and only meet in Postgres.
 *
 * This file is the single source of truth. `types.ts` derives its row types
 * from it, and `db/migrations/` is generated from it. Change a column here and
 * run `pnpm db:generate`; never write DDL by hand elsewhere.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
  vector,
} from 'drizzle-orm/pg-core'

export const channels = pgTable('channels', {
  id: serial('id').primaryKey(),
  channelId: varchar('channel_id', { length: 255 }).notNull().unique(),
  channelName: varchar('channel_name', { length: 255 }),
  guildId: varchar('guild_id', { length: 255 }),
  guildName: varchar('guild_name', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow(),
})

export const messages = pgTable(
  'messages',
  {
    id: serial('id').primaryKey(),
    messageId: varchar('message_id', { length: 255 }).notNull().unique(),
    channelId: varchar('channel_id', { length: 255 }).notNull(),
    guildId: varchar('guild_id', { length: 255 }).notNull(),
    authorId: varchar('author_id', { length: 255 }),
    authorName: varchar('author_name', { length: 255 }),
    content: text('content'),
    timestamp: timestamp('timestamp'),
    replyToMessageId: varchar('reply_to_message_id', { length: 255 }),
    threadId: varchar('thread_id', { length: 255 }),
    isFiltered: boolean('is_filtered').default(false),
    rawData: jsonb('raw_data'),
    embedding: vector('embedding', { dimensions: 1536 }),
    processed: boolean('processed').default(false),
    isQuestion: boolean('is_question'),
    questionConfidence: integer('question_confidence'),
    questionType: varchar('question_type', { length: 50 }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => [
    index('idx_messages_channel_id').on(table.channelId),
    index('idx_messages_timestamp').on(table.timestamp),
    index('idx_messages_processed').on(table.processed, table.timestamp),
    index('idx_messages_is_question').on(table.isQuestion),
    index('idx_messages_author_id').on(table.authorId),
    index('idx_messages_thread_id').on(table.threadId),
    index('idx_messages_reply_to').on(table.replyToMessageId),
    index('idx_messages_channel_timestamp').on(table.channelId, table.timestamp),
    index('idx_messages_context_search').on(
      table.channelId,
      table.isQuestion,
      table.timestamp,
    ),
    index('idx_messages_guild_id').on(table.guildId),
    // Full-text search over message content. An expression index, so it is
    // written as raw SQL rather than a column list.
    index('idx_messages_content_fts').using(
      'gin',
      sql`to_tsvector('english', ${table.content})`,
    ),
  ],
)

export const threads = pgTable('threads', {
  id: serial('id').primaryKey(),
  threadId: varchar('thread_id', { length: 255 }).notNull().unique(),
  originalMessageId: varchar('original_message_id', { length: 255 }).notNull(),
  channelId: varchar('channel_id', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
})

/**
 * The queue the x-poster drains and the tweet-generator fills.
 *
 * Time columns are TIMESTAMPTZ, unlike the tables above, because every one of
 * them feeds a scheduling decision — active-hours window, minimum interval,
 * daily cap — where a naive timestamp is a correctness bug.
 */
export const tweets = pgTable(
  'tweets',
  {
    id: serial('id').primaryKey(),
    content: text('content').notNull(),
    /**
     * `uncertain` is not a flavour of failure. It means submit was clicked but
     * the outcome could not be confirmed — the tweet may well be live. Such
     * rows are never retried: the queue prefers a missed tweet to a duplicate.
     */
    status: varchar('status', {
      length: 20,
      enum: ['pending', 'sending', 'posted', 'failed', 'uncertain'],
    })
      .notNull()
      .default('pending'),
    /**
     * Idempotency key supplied by whoever enqueued the tweet. UNIQUE, so
     * enqueueing the same logical tweet twice is rejected by Postgres rather
     * than by application logic.
     */
    dedupeKey: varchar('dedupe_key', { length: 255 }).notNull().unique(),
    source: varchar('source', { length: 50 }),
    sourceRef: varchar('source_ref', { length: 255 }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedUrl: text('posted_url'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Path to the card image, if this tweet has one. */
    mediaPath: text('media_path'),
    /**
     * The shape the post takes. Stored rather than held in memory because the
     * "never the same archetype twice in a row" rule has to survive a restart.
     */
    archetype: varchar('archetype', {
      length: 20,
      enum: ['digest', 'metric', 'take', 'question'],
    }),
  },
  (table) => [
    index('idx_tweets_claim').on(table.status, table.scheduledAt),
    index('idx_tweets_posted_at').on(table.postedAt),
  ],
)

/**
 * One row per candidate the tweet-generator has tried and failed to write up.
 * Without it, a candidate the model cannot handle sits at the top of its pool
 * and consumes every slot that source has, every cycle, until it ages out of
 * the freshness window.
 */
export const generationAttempts = pgTable('generation_attempts', {
  externalId: varchar('external_id', { length: 255 }).primaryKey(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})
```

- [ ] **Step 6: Export the schema from `shared`**

In `shared/package.json`, add to `"exports"`:

```json
"./schema": "./src/schema.ts",
```

- [ ] **Step 7: Run the assertions to verify they pass**

```bash
pnpm --filter shared run typecheck
```

Expected: PASS, no output.

If `Tweet` and `$inferSelect` do not match, the message names the offending
field. For `tweets`, the schema is wrong and not the interface — `types.ts`
describes what the services already rely on, and every `tweets` column's
nullability is known to agree with it. Common causes: a missing `.notNull()`
(making the inferred type `T | null`), or `timestamp()` without
`{ withTimezone: true }`.

If instead the failure is in the `index(...).using('gin', sql\`...\`)` call —
drizzle-kit's expression-index API is the least stable part of this file —
delete that one index from `schema.ts` and add it by hand to the migration in
Task 3, Step 2, which already covers that case. Do not spend time fighting it:
the index is one line of SQL and the schema file is not where it has to live.

- [ ] **Step 8: Verify nothing else broke**

```bash
pnpm -r --workspace-concurrency=1 --if-present test
pnpm --filter x-poster run build && pnpm --filter tweet-generator run build
rm -rf x-poster/dist tweet-generator/dist
```

Expected: 313 passed; both builds silent.

- [ ] **Step 9: Commit**

```bash
git add shared/src/schema.ts shared/src/schema.test-d.ts shared/tsconfig.json shared/package.json
git commit -m "$(cat <<'EOF'
feat(shared): define the schema in Drizzle

Written against what the live database actually contains, pulled rather
than transcribed from setup-database.ts, which has drifted from it
before.

schema.test-d.ts asserts assignability in both directions between the
inferred row types and the interfaces types.ts has been maintaining by
hand. That is the whole safety net for this change: if it holds, no
consumer of Tweet or DiscordMessage can tell the two apart.

The comments explaining why tweets uses TIMESTAMPTZ while messages does
not, and what `uncertain` means, move here from setup-database.ts —
this becomes the only place they would survive.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Generate the baseline migration and rebuild from empty

**Files:**
- Create: `db/migrations/0000_*.sql` (name generated)
- Create: `db/migrations/meta/` (generated)

**Interfaces:**
- Consumes: `shared/src/schema.ts` (Task 2), `db/drizzle.config.ts` (Task 1)
- Produces: a `db/migrations/` directory that builds the full schema from an
  empty database

- [ ] **Step 1: Generate the baseline**

```bash
cd db && pnpm run generate --name=initial
```

Expected: `db/migrations/0000_initial.sql` plus a `meta/` snapshot.

- [ ] **Step 2: Read the generated SQL and check three things**

Open `db/migrations/0000_initial.sql` and confirm:

1. `"embedding" vector(1536)` appears on the `messages` table.
2. The full-text index is present, as
   `CREATE INDEX "idx_messages_content_fts" ON "messages" USING gin (to_tsvector('english', "content"));`
3. `tweets` time columns say `timestamp with time zone`, and `messages` /
   `channels` / `threads` say plain `timestamp`.

If the expression index is missing or mangled, append it by hand to the
migration file exactly as written above. drizzle-kit's expression-index
support is the one part of this schema most likely to need help, which is why
it is checked here rather than discovered later.

- [ ] **Step 3: Add the extension to the migration**

drizzle-kit does not emit `CREATE EXTENSION`, so a migration run against a
fresh database would fail on `vector(1536)` — the type would not exist. Add
this as the **first line** of `0000_initial.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
```

`--> statement-breakpoint` is drizzle-kit's statement separator; the generated
file already uses it between statements.

- [ ] **Step 4: Rebuild from an empty database**

This destroys the local data, which the design accepted.

```bash
docker compose down -v
docker compose up -d
# Wait until it accepts connections (the healthcheck arrives in Task 4).
until docker compose exec -T postgres pg_isready -U app_user -d multi_tab_listening; do sleep 1; done
cd db && pnpm run migrate
```

Expected: drizzle-kit reports applying one migration.

- [ ] **Step 5: Verify the rebuilt schema**

```bash
docker compose exec -T postgres psql -U app_user -d multi_tab_listening -c '\d messages' -c '\d tweets' -c '\di idx_messages_content_fts'
```

Expected: `embedding` is `vector(1536)`; `tweets.scheduled_at` is
`timestamp with time zone`; `messages.created_at` is
`timestamp without time zone`; `idx_messages_content_fts` exists.

- [ ] **Step 6: Verify the tests pass against the rebuilt database**

This is the real check — the schema built from migrations alone must serve
every existing test.

```bash
pnpm -r --workspace-concurrency=1 --if-present test
```

Expected: 313 passed.

- [ ] **Step 7: Commit**

```bash
git add db/migrations
git commit -m "$(cat <<'EOF'
feat(db): add the baseline migration

Generated from shared/src/schema.ts, with CREATE EXTENSION vector added
by hand at the top — drizzle-kit does not emit it, and vector(1536)
cannot be created without it, so a migration run against a fresh
database would fail on the first table.

Verified by dropping the volume and rebuilding: the schema built from
this migration alone serves all 313 existing tests.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: One command to start the database

**Files:**
- Modify: `docker-compose.yml`
- Modify: `package.json` (root)

**Interfaces:**
- Consumes: `db/package.json` scripts (Task 1), `db/migrations/` (Task 3)
- Produces: `pnpm db:up`, `pnpm db:migrate`, `pnpm db:studio`, `pnpm db:reset`,
  `pnpm db:down` — referenced by the READMEs in Task 5

- [ ] **Step 1: Add the healthcheck and drop the obsolete `version` key**

Replace the top of `docker-compose.yml` — the `version: '3.8'` line goes away
entirely, because current Docker warns on every invocation that it is ignored:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg15
    container_name: multi-tab-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: multi_tab_listening
      POSTGRES_USER: app_user
      POSTGRES_PASSWORD: ${DB_PASSWORD:-defaultpassword123}  # local dev default — set DB_PASSWORD env var in production
    ports:
      # Loopback only. Docker's default "5432:5432" binds 0.0.0.0, which put
      # this database — with a password committed to a public repo — on the
      # local network for anyone on the same WiFi.
      - "127.0.0.1:5432:5432"
    # `docker compose up --wait` blocks on this, so `pnpm db:up` can run
    # migrations immediately after instead of guessing with sleep.
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app_user -d multi_tab_listening"]
      interval: 2s
      timeout: 3s
      retries: 15
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - app-network
```

Leave `networks:` and `volumes:` at the bottom of the file unchanged.

- [ ] **Step 2: Verify the healthcheck reports healthy**

```bash
docker compose up -d --wait
docker compose ps
```

Expected: `docker compose up --wait` exits 0 only once healthy, and `ps` shows
`Up (healthy)`. No `version is obsolete` warning appears.

- [ ] **Step 3: Add the root scripts**

Replace `package.json` at the repo root:

```json
{
  "private": true,
  "packageManager": "pnpm@10.32.1",
  "scripts": {
    "db:up": "docker compose up -d --wait && pnpm --filter db run migrate",
    "db:migrate": "pnpm --filter db run migrate",
    "db:generate": "pnpm --filter db run generate",
    "db:studio": "pnpm --filter db run studio",
    "db:reset": "docker compose down -v && pnpm run db:up",
    "db:down": "docker compose down"
  }
}
```

`db:studio` stays a local-only convenience. Drizzle Studio connects with full
credentials and has no authentication or permission layer, by its own
documentation — it binds localhost by default, and that is not to be changed.

- [ ] **Step 4: Verify the whole cycle from nothing**

```bash
pnpm run db:reset
```

Expected: the volume is destroyed, the container comes back, the healthcheck
passes, and the migration applies — with no manual waiting anywhere.

```bash
pnpm -r --workspace-concurrency=1 --if-present test
```

Expected: 313 passed.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml package.json
git commit -m "$(cat <<'EOF'
feat: start the database with one command

`docker compose up --wait` blocks on a declared healthcheck, so db:up
can run migrations straight after rather than racing the container or
guessing with sleep.

Drops the version key, which current Docker ignores while warning about
it on every invocation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Take the schema away from discord-monitor

The last step, deliberately: until the migrations work, `setup-database.ts` is
the only thing that can build a database.

**Files:**
- Delete: `discord-monitor/src/setup-database.ts`
- Modify: `discord-monitor/src/index.ts:3,22-24`
- Modify: `discord-monitor/package.json`
- Modify: `shared/src/types.ts:1-7`
- Modify: `README.md:49,61-68`
- Modify: `discord-monitor/README.md:49,134,146`

**Interfaces:**
- Consumes: `pnpm db:up` (Task 4)
- Produces: nothing new; this task only removes

- [ ] **Step 1: Remove the startup call**

In `discord-monitor/src/index.ts`, delete the import on line 3:

```typescript
import { setupDatabase } from './setup-database.js'
```

and delete these three lines from `main()`:

```typescript
    // Setup database if needed
    console.log('🗄️  Setting up database...')
    await setupDatabase()
```

A service must not alter the schema on startup — least of all three other
services' tables.

- [ ] **Step 2: Delete the file and its script**

```bash
git rm discord-monitor/src/setup-database.ts
```

In `discord-monitor/package.json`, remove the line:

```json
"setup-db": "tsx src/setup-database.ts",
```

- [ ] **Step 3: Repoint the types.ts header**

`shared/src/types.ts` opens by naming a file that no longer exists. Replace
lines 1-7 with:

```typescript
/**
 * Types shared between the services. These mirror `schema.ts`, which is the
 * actual contract between them — they never call each other, they only meet
 * in Postgres.
 *
 * Deriving these from the schema instead of restating them is the next plan;
 * `schema.test-d.ts` asserts they match in the meantime.
 */
```

- [ ] **Step 4: Update both READMEs**

In `README.md`, replace steps 3 and 5 of Quick Start:

```bash
# 3. Start PostgreSQL and apply migrations
pnpm db:up
```

and delete the now-redundant step:

```bash
# 5. Initialise the database schema
pnpm --filter discord-monitor run setup-db
```

Renumber the remaining steps. In the `Prerequisites` line (`README.md:49`)
leave Docker listed — it is still required.

In `discord-monitor/README.md`, remove the `pnpm run setup-db` line at :49,
the `- pnpm run setup-db: Initialize database` bullet at :134, and the
`└── setup-database.ts   # Database initialization` entry at :146.

- [ ] **Step 5: Verify discord-monitor still builds and the suite passes**

```bash
pnpm --filter discord-monitor run build && rm -rf discord-monitor/dist
pnpm --filter shared run typecheck
pnpm -r --workspace-concurrency=1 --if-present test
```

Expected: build silent, typecheck silent, 313 passed.

- [ ] **Step 6: Verify a new machine's path end to end**

```bash
pnpm run db:reset
pnpm -r --workspace-concurrency=1 --if-present test
```

Expected: an empty database becomes a working one with a single command, and
every test passes against it — with `setup-database.ts` no longer in the repo.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: take the schema away from discord-monitor

setup-database.ts created every table in the workspace, including the
two it does not use, and index.ts called it on every startup — so
running the tweet generator meant first invoking a script belonging to
a service that opens browser tabs onto Discord.

The schema now belongs to nobody in particular, which is what it always
was: a contract four services meet in, owned by the migrations rather
than by whichever service happened to be written first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Done when

- `pnpm install && pnpm db:up` takes a machine with no container to a migrated
  database, with no manual waiting and no service-specific script.
- `discord-monitor/src/setup-database.ts` no longer exists, and no service
  touches the schema at startup.
- `shared/src/schema.ts` is the only description of the schema in the repo.
- `pnpm --filter shared run typecheck` proves the inferred row types match the
  interfaces the services already use.
- All 313 existing tests pass against a database built only from
  `db/migrations/`.

## Not in this plan

Rewriting queries against Drizzle, deleting the row-mapping functions, and
replacing the hand-written interfaces in `shared/src/types.ts` with inferred
ones. Those are the second plan, written once `shared/src/schema.ts` is
settled — every line of that work names fields from this file, and writing it
before the schema exists would be guessing at them.
