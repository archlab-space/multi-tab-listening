# Drizzle Query Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite every runtime query against Drizzle so the hand-written
snake_case-to-camelCase mappers disappear and the row types are derived from
`shared/src/schema.ts` rather than restated by hand.

**Architecture:** `shared/db.ts` gains `createDb(pool)`, one place that binds
Drizzle to the pool the services already create. Each of the four query files
is rewritten in turn, its own test suite green before the next begins. The
hand-written interfaces in `shared/src/types.ts` are replaced by inferred types
only at the end, once nothing consumes the old shapes.

**Tech Stack:** TypeScript, pnpm workspace, `pg`, drizzle-orm 0.45, vitest,
Postgres 15 + pgvector.

**Spec:** `docs/superpowers/specs/2026-08-05-drizzle-schema-and-migrations-design.md`

**Depends on:** `docs/superpowers/plans/2026-08-05-drizzle-schema-and-migrations.md`,
which must be complete. `shared/src/schema.ts` and `db/migrations/` exist; every
field name used below comes from that schema.

## Global Constraints

- **Behaviour does not change.** This is a rewrite of how queries are
  expressed. Every existing test must pass unchanged, and every
  characterization test written in Tasks 1-2 must pass both before and after
  the file it covers is rewritten.
- **Run tests sequentially**: `pnpm -r --workspace-concurrency=1 --if-present test`.
  All packages share one database; the default parallel run makes them delete
  each other's rows.
- **Tests clean up after themselves** using a `test:` prefix on keys, matching
  what `tweet-generator/src/store.test.ts` and `x-poster`'s queue tests already
  do. Never truncate a table — the same database serves every package.
- **Verified Drizzle forms** (typechecked against drizzle-orm 0.45 before this
  plan was written; do not substitute alternatives):
  - `.for('update', { skipLocked: true })` — **not** `.skipLocked()`, which
    does not exist
  - `.onConflictDoNothing({ target: table.column })`
  - `.onConflictDoUpdate({ target, set })`, with `` sql`excluded.column` ``
  - `` .where(eq(table.id, sql`(${subquery})`)) `` for a subquery in WHERE
  - `` sql`count(*) filter (where ...)` `` inside `.select({ ... })`
- **Do not add `.notNull()`** to `messages.authorId`, `authorName`, `content`
  or `timestamp`. They are nullable in the database. Task 8 resolves the gap in
  the types, not in the schema.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

## File Structure

**Created:**
- `ai-assistant/vitest.config.ts`, `ai-assistant/src/database/queries.test.ts`
- `discord-monitor/vitest.config.ts`, `discord-monitor/src/database.test.ts`

**Modified:**
- `shared/src/db.ts` — add `createDb()`
- `shared/src/types.ts` — hand-written interfaces replaced by inferred ones (Task 8)
- `x-poster/src/queue/tweet-queue.ts` — rewritten (Task 4)
- `tweet-generator/src/store.ts` — rewritten (Task 5)
- `discord-monitor/src/database.ts` — rewritten (Task 6)
- `ai-assistant/src/database/queries.ts` — rewritten (Task 7)
- `ai-assistant/package.json`, `discord-monitor/package.json` — test scripts

---

## Task 1: Give `shared` a Drizzle handle

Every rewrite needs a `db` object. Binding it once here keeps four services
from each inventing their own.

**Files:**
- Modify: `shared/src/db.ts`
- Test: `shared/src/db.test.ts`

**Interfaces:**
- Consumes: `createPool()` from `shared/db`, `shared/src/schema.ts`
- Produces: `createDb(pool: Pool): NodePgDatabase<typeof schema>` — the handle
  every later task builds its queries on

- [ ] **Step 1: Write the failing test**

Append to `shared/src/db.test.ts`:

```typescript
describe('createDb', () => {
  it('runs a Drizzle query against the real database', async () => {
    const pool = createPool({
      user: 'app_user',
      host: 'localhost',
      database: 'multi_tab_listening',
      password: 'defaultpassword123',
      port: 5432,
    })
    try {
      const db = createDb(pool)
      // `tweets` is empty of test rows here; the point is that a Drizzle
      // query compiles to SQL Postgres accepts and returns rows shaped by
      // the schema rather than by the column names.
      const rows = await db.select().from(tweets).limit(0)
      expect(rows).toEqual([])
    } finally {
      await pool.end()
    }
  })
})
```

Add to the imports at the top of the file:

```typescript
import { createDb, createPool, loadDbConfig } from './db.js'
import { tweets } from './schema.js'
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter shared test -- src/db.test.ts
```

Expected: FAIL — `createDb is not a function`.

- [ ] **Step 3: Implement `createDb`**

Append to `shared/src/db.ts`:

```typescript
/**
 * The Drizzle handle, bound to a pool the caller already owns.
 *
 * Drizzle does not replace `pg` here — it wraps the same pool, so connection
 * limits, timeouts and shutdown stay in one place. Passing the schema is what
 * makes query results come back keyed by the schema's field names instead of
 * the database's column names, which is the whole reason the hand-written
 * row mappers can go away.
 */
export function createDb(pool: Pool): NodePgDatabase<typeof schema> {
  return drizzle({ client: pool, schema })
}
```

And to its imports:

```typescript
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from './schema.js'
```

- [ ] **Step 4: Run it to verify it passes**

```bash
pnpm --filter shared test -- src/db.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/src/db.ts shared/src/db.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): add the Drizzle handle

createDb wraps the pool the caller already owns rather than opening its
own, so connection limits and shutdown keep having one owner. Passing
the schema is what makes rows come back keyed by field name instead of
column name — the reason the hand-written mappers can go.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Characterization tests for `discord-monitor/src/database.ts`

This file has no tests. It is rewritten in Task 6, and these exist so that
rewrite has something to answer to. They record what the code *does*, not what
it ought to do.

**Files:**
- Create: `discord-monitor/vitest.config.ts`
- Create: `discord-monitor/src/database.test.ts`
- Modify: `discord-monitor/package.json`

**Interfaces:**
- Consumes: `Database` from `discord-monitor/src/database.js`
- Produces: a suite that must pass identically before and after Task 6

- [ ] **Step 1: Add the test harness**

Create `discord-monitor/vitest.config.ts`, matching what `shared` uses:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // One database serves every package, so tests inside a file must not
    // race each other either.
    fileParallelism: false,
  },
})
```

Add to `discord-monitor/package.json` scripts:

```json
"test": "vitest run"
```

and to its devDependencies:

```json
"vitest": "catalog:"
```

Then:

```bash
pnpm install
```

- [ ] **Step 2: Write the characterization tests**

Create `discord-monitor/src/database.test.ts`:

```typescript
/**
 * Characterization tests: they record what this code does today, so the
 * Drizzle rewrite has something to answer to. Where the current behaviour is
 * surprising, the test says so rather than asserting the behaviour we would
 * prefer — changing it is not this work.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool } from 'shared/db'
import { Database } from './database.js'

const pool = createPool()
const db = new Database()

/** Everything this suite writes is prefixed, so cleanup cannot touch real rows. */
const P = 'test-dbm:'

async function clean(): Promise<void> {
  await pool.query('DELETE FROM messages WHERE message_id LIKE $1', [`${P}%`])
  await pool.query('DELETE FROM threads WHERE thread_id LIKE $1', [`${P}%`])
  await pool.query('DELETE FROM channels WHERE channel_id LIKE $1', [`${P}%`])
}

beforeEach(clean)

afterAll(async () => {
  await clean()
  await db.close()
  await pool.end()
})

function aMessage(overrides: Record<string, unknown> = {}) {
  return {
    messageId: `${P}m1`,
    channelId: `${P}c1`,
    guildId: `${P}g1`,
    authorId: 'author-1',
    authorName: 'Author One',
    content: 'hello world',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    replyToMessageId: undefined,
    threadId: undefined,
    rawData: { a: 1 },
    ...overrides,
  } as never
}

describe('insertChannel', () => {
  it('inserts a channel', async () => {
    await db.insertChannel({
      channelId: `${P}c1`,
      channelName: 'general',
      guildId: `${P}g1`,
      guildName: 'Guild',
    } as never)

    const { rows } = await pool.query(
      'SELECT channel_name, guild_name FROM channels WHERE channel_id = $1',
      [`${P}c1`],
    )
    expect(rows[0]).toEqual({ channel_name: 'general', guild_name: 'Guild' })
  })

  it('updates the names when the channel already exists', async () => {
    const base = {
      channelId: `${P}c1`,
      channelName: 'general',
      guildId: `${P}g1`,
      guildName: 'Guild',
    }
    await db.insertChannel(base as never)
    await db.insertChannel({ ...base, channelName: 'renamed' } as never)

    const { rows } = await pool.query(
      'SELECT channel_name FROM channels WHERE channel_id = $1',
      [`${P}c1`],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].channel_name).toBe('renamed')
  })
})

describe('insertMessage', () => {
  it('stores a message with its raw data as JSON', async () => {
    await db.insertMessage(aMessage())

    const { rows } = await pool.query(
      'SELECT content, raw_data, is_filtered FROM messages WHERE message_id = $1',
      [`${P}m1`],
    )
    expect(rows[0].content).toBe('hello world')
    expect(rows[0].raw_data).toEqual({ a: 1 })
    expect(rows[0].is_filtered).toBe(false)
  })

  it('honours the isFiltered flag', async () => {
    await db.insertMessage(aMessage(), true)

    const { rows } = await pool.query(
      'SELECT is_filtered FROM messages WHERE message_id = $1',
      [`${P}m1`],
    )
    expect(rows[0].is_filtered).toBe(true)
  })

  it('ignores a second insert of the same message id', async () => {
    await db.insertMessage(aMessage())
    await db.insertMessage(aMessage({ content: 'different' }))

    const { rows } = await pool.query(
      'SELECT content FROM messages WHERE message_id = $1',
      [`${P}m1`],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('hello world')
  })
})

describe('insertThread', () => {
  it('ignores a second insert of the same thread id', async () => {
    const thread = {
      threadId: `${P}t1`,
      originalMessageId: `${P}m1`,
      channelId: `${P}c1`,
    }
    await db.insertThread(thread as never)
    await db.insertThread({ ...thread, channelId: `${P}c2` } as never)

    const { rows } = await pool.query(
      'SELECT channel_id FROM threads WHERE thread_id = $1',
      [`${P}t1`],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].channel_id).toBe(`${P}c1`)
  })
})

describe('getMessagesByChannel', () => {
  it('returns newest first and maps every column to camelCase', async () => {
    await db.insertMessage(
      aMessage({
        messageId: `${P}old`,
        timestamp: new Date('2026-01-01T00:00:00Z'),
      }),
    )
    await db.insertMessage(
      aMessage({
        messageId: `${P}new`,
        timestamp: new Date('2026-01-02T00:00:00Z'),
        replyToMessageId: `${P}old`,
        threadId: `${P}t1`,
      }),
    )

    const found = await db.getMessagesByChannel(`${P}c1`)

    expect(found.map((m) => m.messageId)).toEqual([`${P}new`, `${P}old`])
    expect(found[0]).toEqual({
      messageId: `${P}new`,
      channelId: `${P}c1`,
      guildId: `${P}g1`,
      authorId: 'author-1',
      authorName: 'Author One',
      content: 'hello world',
      timestamp: new Date('2026-01-02T00:00:00Z'),
      replyToMessageId: `${P}old`,
      threadId: `${P}t1`,
      rawData: { a: 1 },
    })
  })

  it('respects the limit', async () => {
    for (const n of [1, 2, 3]) {
      await db.insertMessage(
        aMessage({
          messageId: `${P}m${n}`,
          timestamp: new Date(`2026-01-0${n}T00:00:00Z`),
        }),
      )
    }

    const found = await db.getMessagesByChannel(`${P}c1`, 2)
    expect(found).toHaveLength(2)
  })
})

describe('getThreadMessages', () => {
  it('returns oldest first, and includes replies to the thread origin', async () => {
    await db.insertThread({
      threadId: `${P}t1`,
      originalMessageId: `${P}origin`,
      channelId: `${P}c1`,
    } as never)

    // In the thread by thread_id.
    await db.insertMessage(
      aMessage({
        messageId: `${P}in-thread`,
        threadId: `${P}t1`,
        timestamp: new Date('2026-01-02T00:00:00Z'),
      }),
    )
    // In by virtue of replying to the thread's original message.
    await db.insertMessage(
      aMessage({
        messageId: `${P}reply`,
        replyToMessageId: `${P}origin`,
        timestamp: new Date('2026-01-01T00:00:00Z'),
      }),
    )
    // Not in the thread at all.
    await db.insertMessage(
      aMessage({
        messageId: `${P}unrelated`,
        timestamp: new Date('2026-01-03T00:00:00Z'),
      }),
    )

    const found = await db.getThreadMessages(`${P}t1`)

    expect(found.map((m) => m.messageId)).toEqual([`${P}reply`, `${P}in-thread`])
  })
})
```

- [ ] **Step 3: Run them against the current implementation**

```bash
pnpm --filter discord-monitor test
```

Expected: PASS. These describe code that already exists — a failure here means
the test is wrong, not the code. Fix the test until it reflects reality, and
note what surprised you in the commit message.

- [ ] **Step 4: Commit**

```bash
git add discord-monitor/vitest.config.ts discord-monitor/src/database.test.ts discord-monitor/package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
test(discord-monitor): characterize the database layer

This file had no tests and is about to be rewritten against Drizzle.
These record what it does today — including that getThreadMessages
pulls in replies to the thread's original message, not only rows
carrying the thread id — so the rewrite has something to answer to.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Characterization tests for `ai-assistant/src/database/queries.ts`

The largest file in the rewrite, 439 lines, with no tests and the hardest query
to convert. Same discipline as Task 2.

**Files:**
- Create: `ai-assistant/vitest.config.ts`
- Create: `ai-assistant/src/database/queries.test.ts`
- Modify: `ai-assistant/package.json`

**Interfaces:**
- Consumes: `DatabaseQueries` from `ai-assistant/src/database/queries.js`
- Produces: a suite that must pass identically before and after Task 7

- [ ] **Step 1: Add the test harness**

Create `ai-assistant/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    fileParallelism: false,
  },
})
```

Add to `ai-assistant/package.json` scripts:

```json
"test": "vitest run"
```

and to its devDependencies:

```json
"vitest": "catalog:"
```

Then:

```bash
pnpm install
```

- [ ] **Step 2: Write the characterization tests**

Create `ai-assistant/src/database/queries.test.ts`:

```typescript
/**
 * Characterization tests: what this code does today, recorded before the
 * Drizzle rewrite. The full-text search path in particular cannot be verified
 * as equivalent by reading it, which is the reason this file exists.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool } from 'shared/db'
import { DatabaseQueries } from './queries.js'

const pool = createPool()
const queries = new DatabaseQueries()

const P = 'test-aia:'

async function clean(): Promise<void> {
  await pool.query('DELETE FROM messages WHERE message_id LIKE $1', [`${P}%`])
  await pool.query('DELETE FROM channels WHERE channel_id LIKE $1', [`${P}%`])
}

interface SeedMessage {
  id: string
  content: string
  processed?: boolean
  isQuestion?: boolean | null
  timestamp?: Date
  threadId?: string | null
  replyTo?: string | null
}

async function seed(message: SeedMessage): Promise<void> {
  await pool.query(
    `INSERT INTO messages
       (message_id, channel_id, guild_id, author_id, author_name, content,
        timestamp, reply_to_message_id, thread_id, raw_data, processed,
        is_question)
     VALUES ($1, $2, $3, 'a1', 'Author', $4, $5, $6, $7, '{}'::jsonb, $8, $9)`,
    [
      message.id,
      `${P}c1`,
      `${P}g1`,
      message.content,
      message.timestamp ?? new Date(),
      message.replyTo ?? null,
      message.threadId ?? null,
      message.processed ?? false,
      message.isQuestion ?? null,
    ],
  )
}

beforeEach(clean)

afterAll(async () => {
  await clean()
  await queries.close()
  await pool.end()
})

describe('getUnprocessedMessages', () => {
  it('returns unprocessed messages oldest first, joined to their channel', async () => {
    await pool.query(
      `INSERT INTO channels (channel_id, channel_name, guild_id, guild_name)
       VALUES ($1, 'general', $2, 'Guild')`,
      [`${P}c1`, `${P}g1`],
    )
    await seed({
      id: `${P}b`,
      content: 'second',
      timestamp: new Date('2026-01-02T00:00:00Z'),
    })
    await seed({
      id: `${P}a`,
      content: 'first',
      timestamp: new Date('2026-01-01T00:00:00Z'),
    })

    const found = await queries.getUnprocessedMessages(50)
    const ours = found.filter((m) => m.messageId.startsWith(P))

    expect(ours.map((m) => m.messageId)).toEqual([`${P}a`, `${P}b`])
    expect(ours[0].channelName).toBe('general')
    expect(ours[0].guildName).toBe('Guild')
  })

  it('skips messages that are processed, null, or empty', async () => {
    await seed({ id: `${P}done`, content: 'x', processed: true })
    await seed({ id: `${P}empty`, content: '' })

    const found = await queries.getUnprocessedMessages(50)
    const ours = found.filter((m) => m.messageId.startsWith(P))

    expect(ours).toEqual([])
  })
})

describe('markMessageAsProcessed', () => {
  it('sets processed on exactly the named message', async () => {
    await seed({ id: `${P}a`, content: 'a' })
    await seed({ id: `${P}b`, content: 'b' })

    await queries.markMessageAsProcessed(`${P}a`)

    const { rows } = await pool.query(
      'SELECT message_id, processed FROM messages WHERE message_id LIKE $1 ORDER BY message_id',
      [`${P}%`],
    )
    expect(rows).toEqual([
      { message_id: `${P}a`, processed: true },
      { message_id: `${P}b`, processed: false },
    ])
  })
})

describe('markMultipleMessagesAsProcessed', () => {
  it('marks every id given', async () => {
    await seed({ id: `${P}a`, content: 'a' })
    await seed({ id: `${P}b`, content: 'b' })

    await queries.markMultipleMessagesAsProcessed([`${P}a`, `${P}b`])

    const { rows } = await pool.query(
      'SELECT COUNT(*) AS n FROM messages WHERE message_id LIKE $1 AND processed',
      [`${P}%`],
    )
    expect(Number(rows[0].n)).toBe(2)
  })

  it('is a no-op on an empty list', async () => {
    await expect(
      queries.markMultipleMessagesAsProcessed([]),
    ).resolves.toBeUndefined()
  })
})

describe('updateMessageQuestionAnalysis', () => {
  it('writes all three analysis columns', async () => {
    await seed({ id: `${P}a`, content: 'a' })

    await queries.updateMessageQuestionAnalysis(`${P}a`, true, 87, 'howto')

    const { rows } = await pool.query(
      'SELECT is_question, question_confidence, question_type FROM messages WHERE message_id = $1',
      [`${P}a`],
    )
    expect(rows[0]).toEqual({
      is_question: true,
      question_confidence: 87,
      question_type: 'howto',
    })
  })

  it('writes NULL for an omitted question type', async () => {
    await seed({ id: `${P}a`, content: 'a' })

    await queries.updateMessageQuestionAnalysis(`${P}a`, false, 12)

    const { rows } = await pool.query(
      'SELECT question_type FROM messages WHERE message_id = $1',
      [`${P}a`],
    )
    expect(rows[0].question_type).toBeNull()
  })
})

describe('getQuestionMessages', () => {
  it('returns only questions, newest first', async () => {
    await seed({
      id: `${P}q1`,
      content: 'why',
      isQuestion: true,
      timestamp: new Date('2026-01-01T00:00:00Z'),
    })
    await seed({
      id: `${P}q2`,
      content: 'how',
      isQuestion: true,
      timestamp: new Date('2026-01-02T00:00:00Z'),
    })
    await seed({ id: `${P}n1`, content: 'statement', isQuestion: false })

    const found = await queries.getQuestionMessages(`${P}c1`)

    expect(found.map((m) => m.messageId)).toEqual([`${P}q2`, `${P}q1`])
  })

  it('searches every channel when none is given', async () => {
    await seed({ id: `${P}q1`, content: 'why', isQuestion: true })

    const found = await queries.getQuestionMessages(undefined, 50)
    const ours = found.filter((m) => m.messageId.startsWith(P))

    expect(ours.map((m) => m.messageId)).toEqual([`${P}q1`])
  })
})

describe('getRelatedMessages', () => {
  /**
   * The full-text path. `processed = TRUE` and "not a question" are both
   * required, and the recency window is config-driven — a message outside it
   * is invisible however well it matches.
   */
  it('finds processed non-question messages matching the question keywords', async () => {
    await seed({
      id: `${P}match`,
      content: 'the deployment pipeline uses kubernetes for orchestration',
      processed: true,
      isQuestion: false,
      timestamp: new Date(),
    })
    await seed({
      id: `${P}unprocessed`,
      content: 'kubernetes orchestration notes',
      processed: false,
      isQuestion: false,
      timestamp: new Date(),
    })
    await seed({
      id: `${P}question`,
      content: 'kubernetes orchestration question',
      processed: true,
      isQuestion: true,
      timestamp: new Date(),
    })

    const found = await queries.getRelatedMessages(
      `${P}c1`,
      'how does kubernetes orchestration work here',
    )
    const ours = found.filter((m) => m.messageId.startsWith(P))

    expect(ours.map((m) => m.messageId)).toEqual([`${P}match`])
  })

  it('puts thread context ahead of keyword matches', async () => {
    await seed({
      id: `${P}thread`,
      content: 'unrelated words entirely',
      processed: true,
      isQuestion: false,
      threadId: `${P}t1`,
      timestamp: new Date(),
    })
    await seed({
      id: `${P}keyword`,
      content: 'kubernetes orchestration deployment',
      processed: true,
      isQuestion: false,
      timestamp: new Date(),
    })

    const found = await queries.getRelatedMessages(
      `${P}c1`,
      'kubernetes orchestration',
      {
        messageId: `${P}asking`,
        channelId: `${P}c1`,
        threadId: `${P}t1`,
      } as never,
    )
    const ours = found.filter((m) => m.messageId.startsWith(P))

    expect(ours[0].messageId).toBe(`${P}thread`)
  })

  it('falls back to recent messages when the question yields no keywords', async () => {
    await seed({
      id: `${P}recent`,
      content: 'anything at all',
      processed: true,
      isQuestion: false,
      timestamp: new Date(),
    })

    // Every word is under four characters, so extractKeywords returns none.
    const found = await queries.getRelatedMessages(`${P}c1`, 'is it up yet')
    const ours = found.filter((m) => m.messageId.startsWith(P))

    expect(ours.map((m) => m.messageId)).toEqual([`${P}recent`])
  })
})
```

- [ ] **Step 3: Run them against the current implementation**

```bash
pnpm --filter ai-assistant test
```

Expected: PASS. If one fails, the test is wrong about what the code does —
correct the test, not the code. Two are worth watching: full-text matching
depends on the `english` dictionary stemming your chosen words, and the
recency windows come from `config.context.*`, so a seeded `timestamp` must be
inside them.

- [ ] **Step 4: Commit**

```bash
git add ai-assistant/vitest.config.ts ai-assistant/src/database/queries.test.ts ai-assistant/package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
test(ai-assistant): characterize the query layer

439 lines with no tests, holding the hardest query in the rewrite. These
record today's behaviour — that the keyword path requires processed and
not-a-question, that thread context outranks keyword matches, and that a
question of short words falls through to recent messages — so the
Drizzle rewrite can be checked rather than eyeballed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Rewrite `x-poster/src/queue/tweet-queue.ts`

First, because it has the best test coverage (17 tests against a real
database) and contains the two hardest forms — the atomic claim and the
filtered aggregate. Once these work, the rest is mechanical.

**Files:**
- Modify: `x-poster/src/queue/tweet-queue.ts`

**Interfaces:**
- Consumes: `createDb()` (Task 1), `tweets` from `shared/schema`
- Produces: `TweetQueue` with an unchanged public surface — `enqueue`,
  `claimNext`, `markPosted`, `markFailed`, `markUncertain`, `releaseForRetry`,
  `getById`, `history`. Its constructor still takes a `Pool`.

- [ ] **Step 1: Confirm the existing tests pass before touching anything**

```bash
pnpm --filter x-poster test
```

Expected: 76 passed. This is the baseline the rewrite must reproduce.

- [ ] **Step 2: Rewrite the file**

Replace `x-poster/src/queue/tweet-queue.ts` entirely:

```typescript
import { and, eq, lte, sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { createDb } from 'shared/db'
import { tweets } from 'shared/schema'
import type { Tweet } from 'shared'
import type { PostingHistory } from './rate-limiter.js'

export interface EnqueueInput {
  content: string
  dedupeKey: string
  source?: string
  sourceRef?: string
  mediaPath?: string
  archetype?: Tweet['archetype']
  scheduledAt?: Date
}

export class TweetQueue {
  private readonly db: ReturnType<typeof createDb>

  constructor(pool: Pool) {
    this.db = createDb(pool)
  }

  /** Returns null when the dedupe key is already taken. */
  async enqueue(input: EnqueueInput): Promise<Tweet | null> {
    const [row] = await this.db
      .insert(tweets)
      .values({
        content: input.content,
        dedupeKey: input.dedupeKey,
        source: input.source ?? null,
        sourceRef: input.sourceRef ?? null,
        mediaPath: input.mediaPath ?? null,
        archetype: input.archetype ?? null,
        // Omitted rather than coalesced: leaving the key out lets the
        // column's DEFAULT NOW() apply, which is what COALESCE($7, NOW())
        // was spelling out by hand.
        ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
      })
      .onConflictDoNothing({ target: tweets.dedupeKey })
      .returning()

    return row ?? null
  }

  /**
   * Atomically takes the oldest due tweet.
   *
   * FOR UPDATE SKIP LOCKED means two concurrent x-poster processes cannot
   * claim the same row, with no coordination between them.
   */
  async claimNext(now: Date = new Date()): Promise<Tweet | null> {
    const claimable = this.db
      .select({ id: tweets.id })
      .from(tweets)
      .where(and(eq(tweets.status, 'pending'), lte(tweets.scheduledAt, now)))
      .orderBy(tweets.createdAt)
      .limit(1)
      .for('update', { skipLocked: true })

    const [row] = await this.db
      .update(tweets)
      .set({
        status: 'sending',
        attempts: sql`${tweets.attempts} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(tweets.id, sql`(${claimable})`))
      .returning()

    return row ?? null
  }

  async markPosted(id: number, url: string | null): Promise<void> {
    await this.db
      .update(tweets)
      .set({
        status: 'posted',
        postedAt: sql`now()`,
        postedUrl: url,
        lastError: null,
        updatedAt: sql`now()`,
      })
      .where(eq(tweets.id, id))
  }

  async markFailed(id: number, error: string): Promise<void> {
    await this.db
      .update(tweets)
      .set({ status: 'failed', lastError: error, updatedAt: sql`now()` })
      .where(eq(tweets.id, id))
  }

  /**
   * Terminal until a human intervenes. The tweet may already be live, so it
   * is never returned to pending — a missed tweet beats a duplicate one.
   */
  async markUncertain(id: number, error: string): Promise<void> {
    await this.db
      .update(tweets)
      .set({ status: 'uncertain', lastError: error, updatedAt: sql`now()` })
      .where(eq(tweets.id, id))
  }

  /** Back to pending, but not before `retryAt`. `attempts` is left alone. */
  async releaseForRetry(
    id: number,
    error: string,
    retryAt: Date,
  ): Promise<void> {
    await this.db
      .update(tweets)
      .set({
        status: 'pending',
        lastError: error,
        scheduledAt: retryAt,
        updatedAt: sql`now()`,
      })
      .where(eq(tweets.id, id))
  }

  async getById(id: number): Promise<Tweet | null> {
    const [row] = await this.db
      .select()
      .from(tweets)
      .where(eq(tweets.id, id))
      .limit(1)

    return row ?? null
  }

  /** What the rate limiter needs to know, read straight from the table. */
  async history(now: Date = new Date()): Promise<PostingHistory> {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    const [row] = await this.db
      .select({
        count: sql<string>`count(*) filter (where ${tweets.postedAt} >= ${startOfDay})`,
        last: sql<Date | null>`max(${tweets.postedAt})`,
      })
      .from(tweets)
      .where(eq(tweets.status, 'posted'))

    return {
      postedToday: Number(row?.count ?? 0),
      lastPostedAt: row?.last ?? null,
    }
  }
}
```

Note what disappeared: the `TweetRow` interface, `toTweet()`, and the `COLUMNS`
constant. Three restatements of the same column list, replaced by the schema.

- [ ] **Step 3: Run the tests to verify behaviour is unchanged**

```bash
pnpm --filter x-poster test
```

Expected: 76 passed — the same count as Step 1, with no test edited.

If `claimNext` fails, print the generated SQL to compare with the original:
`console.log(this.db.update(...)....toSQL())`. The subquery must land inside
parentheses in the WHERE, and must carry `for update skip locked`.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter x-poster run build && rm -rf x-poster/dist
```

Expected: silent.

- [ ] **Step 5: Commit**

```bash
git add x-poster/src/queue/tweet-queue.ts
git commit -m "$(cat <<'EOF'
refactor(x-poster): express the queue in Drizzle

Deletes TweetRow, toTweet() and the COLUMNS constant — three
restatements of the same column list, one of which could silently omit
a field. The schema is now the only place the columns are named.

COALESCE($7, NOW()) is gone rather than translated: omitting the key
lets the column default apply, which is what the coalesce was spelling
out by hand.

All 17 queue tests pass unedited, including the concurrent-claim ones —
FOR UPDATE SKIP LOCKED survives as .for('update', { skipLocked: true }).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Rewrite `tweet-generator/src/store.ts`

**Files:**
- Modify: `tweet-generator/src/store.ts`

**Interfaces:**
- Consumes: `createDb()` (Task 1), `tweets` and `generationAttempts` from
  `shared/schema`
- Produces: `GeneratorStore` with an unchanged public surface — `enqueue`,
  `usageSince`, `knownDedupeKeys`, `lastArchetype`, `lastEnqueuedAt`,
  `projectPostedSince`, `failureCounts`, `recordFailure`, `expiredMedia`

- [ ] **Step 1: Confirm the existing tests pass**

```bash
pnpm --filter tweet-generator test
```

Expected: 210 passed.

- [ ] **Step 2: Rewrite the query methods**

In `tweet-generator/src/store.ts`, replace the imports:

```typescript
import { and, count, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { createDb } from 'shared/db'
import { generationAttempts, tweets } from 'shared/schema'
import type { TweetArchetype } from 'shared'
import { SOURCE_PRIORITY, type SourceKind } from './config.js'
import type { QuotaUsage } from './select/quota.js'
```

Replace the constructor:

```typescript
export class GeneratorStore {
  private readonly db: ReturnType<typeof createDb>

  constructor(pool: Pool) {
    this.db = createDb(pool)
  }
```

Then each method body, keeping every existing doc comment above it unchanged:

```typescript
  async enqueue(input: EnqueueInput): Promise<number | null> {
    const [row] = await this.db
      .insert(tweets)
      .values({
        content: input.content,
        dedupeKey: input.dedupeKey,
        source: input.source ?? null,
        sourceRef: input.sourceRef ?? null,
        archetype: input.archetype ?? null,
        mediaPath: input.mediaPath ?? null,
      })
      .onConflictDoNothing({ target: tweets.dedupeKey })
      .returning({ id: tweets.id })

    return row?.id ?? null
  }

  async usageSince(dayStart: Date): Promise<QuotaUsage> {
    const rows = await this.db
      .select({ source: tweets.source, count: count() })
      .from(tweets)
      .where(and(gte(tweets.createdAt, dayStart), isNotNull(tweets.source)))
      .groupBy(tweets.source)

    const used = emptyUsage()
    let total = 0
    for (const row of rows) {
      total += row.count
      if ((SOURCE_PRIORITY as readonly string[]).includes(row.source ?? '')) {
        used[row.source as SourceKind] = row.count
      }
    }
    return { used, total }
  }

  async knownDedupeKeys(keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set()
    const rows = await this.db
      .select({ dedupeKey: tweets.dedupeKey })
      .from(tweets)
      .where(inArray(tweets.dedupeKey, keys))

    return new Set(rows.map((row) => row.dedupeKey))
  }

  async lastArchetype(): Promise<TweetArchetype | null> {
    const [row] = await this.db
      .select({ archetype: tweets.archetype })
      .from(tweets)
      .where(isNotNull(tweets.archetype))
      .orderBy(desc(tweets.createdAt))
      .limit(1)

    return row?.archetype ?? null
  }

  async lastEnqueuedAt(): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: sql<Date | null>`max(${tweets.createdAt})` })
      .from(tweets)

    return row?.at ?? null
  }

  async projectPostedSince(sourceRef: string, since: Date): Promise<boolean> {
    const [row] = await this.db
      .select({ id: tweets.id })
      .from(tweets)
      .where(
        and(
          eq(tweets.sourceRef, sourceRef),
          isNotNull(tweets.postedAt),
          gte(tweets.postedAt, since),
        ),
      )
      .limit(1)

    return row !== undefined
  }

  async failureCounts(externalIds: string[]): Promise<Map<string, number>> {
    if (externalIds.length === 0) return new Map()
    const rows = await this.db
      .select({
        externalId: generationAttempts.externalId,
        attempts: generationAttempts.attempts,
      })
      .from(generationAttempts)
      .where(inArray(generationAttempts.externalId, externalIds))

    return new Map(rows.map((row) => [row.externalId, row.attempts]))
  }

  async recordFailure(externalId: string, error: string): Promise<void> {
    await this.db
      .insert(generationAttempts)
      .values({ externalId, attempts: 1, lastError: error })
      .onConflictDoUpdate({
        target: generationAttempts.externalId,
        set: {
          attempts: sql`${generationAttempts.attempts} + 1`,
          lastError: sql`excluded.last_error`,
          updatedAt: sql`now()`,
        },
      })
  }

  async expiredMedia(before: Date): Promise<string[]> {
    const rows = await this.db
      .select({ mediaPath: tweets.mediaPath })
      .from(tweets)
      .where(
        and(
          isNotNull(tweets.mediaPath),
          isNotNull(tweets.postedAt),
          lt(tweets.postedAt, before),
        ),
      )

    return rows.map((row) => row.mediaPath as string)
  }
```

Two deliberate shape changes, both behaviour-preserving:

- `usageSince` uses Drizzle's `count()`, which returns a `number`. The old code
  read `COUNT(*)` as a string and called `Number()` on it. The arithmetic is
  identical; the cast is gone.
- `projectPostedSince` selects one row and tests for its existence rather than
  asking Postgres for `EXISTS(...)`. Same result, same index, one less
  construct — and `LIMIT 1` stops the scan just as `EXISTS` does.

- [ ] **Step 3: Run the tests**

```bash
pnpm --filter tweet-generator test
```

Expected: 210 passed, no test edited.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter tweet-generator run build && rm -rf tweet-generator/dist
```

Expected: silent.

- [ ] **Step 5: Commit**

```bash
git add tweet-generator/src/store.ts
git commit -m "$(cat <<'EOF'
refactor(tweet-generator): express the store in Drizzle

Every row shape here was read column-by-column off an untyped result —
row.dedupe_key, row.external_id, row.media_path — with nothing checking
the names against the table. They come from the schema now.

usageSince drops the Number() cast around COUNT(*), and
projectPostedSince selects one row instead of asking Postgres for
EXISTS. Both are the same query with one less construct.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Rewrite `discord-monitor/src/database.ts`

**Files:**
- Modify: `discord-monitor/src/database.ts`

**Interfaces:**
- Consumes: `createDb()` (Task 1), `channels`, `messages`, `threads` from
  `shared/schema`; the suite from Task 2
- Produces: `Database` with an unchanged public surface — `insertChannel`,
  `insertMessage`, `insertThread`, `getMessagesByChannel`, `getThreadMessages`,
  `close`

- [ ] **Step 1: Confirm the characterization tests pass**

```bash
pnpm --filter discord-monitor test
```

Expected: PASS — the same suite written in Task 2, unedited.

- [ ] **Step 2: Rewrite the file**

Replace `discord-monitor/src/database.ts` entirely:

```typescript
import { asc, desc, eq, inArray, or } from 'drizzle-orm'
import type { Pool } from 'pg'
import type winston from 'winston'
import { createDb, createPool } from 'shared/db'
import { createLogger } from 'shared/logger'
import { channels, messages, threads } from 'shared/schema'
import type { Channel, DiscordMessage, Thread } from './types.js'

export class Database {
  private pool: Pool
  private db: ReturnType<typeof createDb>
  private logger: winston.Logger

  constructor() {
    this.pool = createPool()
    this.db = createDb(this.pool)
    this.logger = createLogger('database.log')
  }

  async insertChannel(channel: Channel): Promise<void> {
    try {
      await this.db
        .insert(channels)
        .values({
          channelId: channel.channelId,
          channelName: channel.channelName,
          guildId: channel.guildId,
          guildName: channel.guildName,
        })
        .onConflictDoUpdate({
          target: channels.channelId,
          set: {
            channelName: channel.channelName,
            guildId: channel.guildId,
            guildName: channel.guildName,
          },
        })
    } catch (error) {
      this.logger.error('Error inserting channel:', error)
      throw error
    }
  }

  async insertMessage(
    message: DiscordMessage,
    isFiltered: boolean = false,
  ): Promise<void> {
    try {
      await this.db
        .insert(messages)
        .values({
          messageId: message.messageId,
          channelId: message.channelId,
          guildId: message.guildId,
          authorId: message.authorId,
          authorName: message.authorName,
          content: message.content,
          timestamp: message.timestamp,
          replyToMessageId: message.replyToMessageId,
          threadId: message.threadId,
          isFiltered,
          // jsonb takes the value, not a string: Drizzle serialises it. The
          // old code called JSON.stringify itself, which `pg` then handed to
          // Postgres to parse — the same result by a different route, but
          // keeping the stringify here would encode it twice.
          rawData: message.rawData,
        })
        .onConflictDoNothing({ target: messages.messageId })
    } catch (error) {
      this.logger.error('Error inserting message:', error)
      throw error
    }
  }

  async insertThread(thread: Thread): Promise<void> {
    try {
      await this.db
        .insert(threads)
        .values({
          threadId: thread.threadId,
          originalMessageId: thread.originalMessageId,
          channelId: thread.channelId,
        })
        .onConflictDoNothing({ target: threads.threadId })
    } catch (error) {
      this.logger.error('Error inserting thread:', error)
      throw error
    }
  }

  async getMessagesByChannel(
    channelId: string,
    limit: number = 100,
  ): Promise<DiscordMessage[]> {
    try {
      const rows = await this.db
        .select({
          messageId: messages.messageId,
          channelId: messages.channelId,
          guildId: messages.guildId,
          authorId: messages.authorId,
          authorName: messages.authorName,
          content: messages.content,
          timestamp: messages.timestamp,
          replyToMessageId: messages.replyToMessageId,
          threadId: messages.threadId,
          rawData: messages.rawData,
        })
        .from(messages)
        .where(eq(messages.channelId, channelId))
        .orderBy(desc(messages.timestamp))
        .limit(limit)

      return rows as DiscordMessage[]
    } catch (error) {
      this.logger.error('Error fetching messages:', error)
      throw error
    }
  }

  async getThreadMessages(threadId: string): Promise<DiscordMessage[]> {
    try {
      // A message belongs to the thread if it carries the thread id, or if it
      // replies to the message the thread grew out of.
      const threadOrigins = this.db
        .select({ originalMessageId: threads.originalMessageId })
        .from(threads)
        .where(eq(threads.threadId, threadId))

      const rows = await this.db
        .select({
          messageId: messages.messageId,
          channelId: messages.channelId,
          guildId: messages.guildId,
          authorId: messages.authorId,
          authorName: messages.authorName,
          content: messages.content,
          timestamp: messages.timestamp,
          replyToMessageId: messages.replyToMessageId,
          threadId: messages.threadId,
          rawData: messages.rawData,
        })
        .from(messages)
        .where(
          or(
            eq(messages.threadId, threadId),
            inArray(messages.replyToMessageId, threadOrigins),
          ),
        )
        .orderBy(asc(messages.timestamp))

      return rows as DiscordMessage[]
    } catch (error) {
      this.logger.error('Error fetching thread messages:', error)
      throw error
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
```

The `as DiscordMessage[]` casts are temporary. They exist because
`DiscordMessage` declares four columns non-null that the database allows to be
null; Task 8 removes both the casts and the mismatch. Do not resolve it here by
changing the schema.

- [ ] **Step 3: Run the characterization tests**

```bash
pnpm --filter discord-monitor test
```

Expected: PASS, unedited.

If the `raw_data` assertion fails, that is the `JSON.stringify` note above:
the old code stored a JSON string inside a jsonb column. Check what the
existing rows look like before deciding the new behaviour is wrong — the test
from Task 2 records what the old code did, and if it passed there and fails
here, the two encodings differ and the test is telling you so.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter discord-monitor run build && rm -rf discord-monitor/dist
```

Expected: silent.

- [ ] **Step 5: Commit**

```bash
git add discord-monitor/src/database.ts
git commit -m "$(cat <<'EOF'
refactor(discord-monitor): express the database layer in Drizzle

Deletes two copies of the same ten-field row mapper.

getThreadMessages keeps its shape — thread id, or a reply to the message
the thread grew from — expressed as a subquery rather than an IN with a
nested SELECT written out by hand.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Rewrite `ai-assistant/src/database/queries.ts`

The largest file, left until last on purpose: by now the forms are settled and
the only new problem is the full-text search.

**Files:**
- Modify: `ai-assistant/src/database/queries.ts`

**Interfaces:**
- Consumes: `createDb()` (Task 1), `channels` and `messages` from
  `shared/schema`; the suite from Task 3
- Produces: `DatabaseQueries` with an unchanged public surface. The private
  helpers `extractKeywords`, `calculateKeywordScore` and
  `combineAndRankMessages` are pure functions and are **not touched**.

- [ ] **Step 1: Confirm the characterization tests pass**

```bash
pnpm --filter ai-assistant test
```

Expected: PASS, from Task 3.

- [ ] **Step 2: Replace the imports and constructor**

```typescript
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import type { Pool } from 'pg'
import type winston from 'winston'
import { createDb, createPool } from 'shared/db'
import { createLogger } from 'shared/logger'
import { channels, messages } from 'shared/schema'
import type { DiscordMessage, DiscordMessageRow } from '../types.js'
import { config } from '../config.js'

/** The columns every context query returns. Selected as a shared shape so the
 *  four strategies cannot drift from one another. */
const MESSAGE_FIELDS = {
  messageId: messages.messageId,
  channelId: messages.channelId,
  guildId: messages.guildId,
  authorId: messages.authorId,
  authorName: messages.authorName,
  content: messages.content,
  timestamp: messages.timestamp,
  replyToMessageId: messages.replyToMessageId,
  threadId: messages.threadId,
  rawData: messages.rawData,
} as const

export class DatabaseQueries {
  private pool: Pool
  private db: ReturnType<typeof createDb>
  private logger: winston.Logger

  constructor() {
    this.pool = createPool(config.database)
    this.db = createDb(this.pool)
    this.logger = createLogger('ai-assistant.log')
  }
```

- [ ] **Step 3: Rewrite the four public methods**

Keep every existing doc comment. Replace the bodies:

```typescript
  async getUnprocessedMessages(limit: number = 50): Promise<DiscordMessage[]> {
    try {
      const rows = await this.db
        .select({
          ...MESSAGE_FIELDS,
          channelName: channels.channelName,
          guildName: channels.guildName,
        })
        .from(messages)
        .leftJoin(channels, eq(messages.channelId, channels.channelId))
        .where(
          and(
            eq(messages.processed, false),
            isNotNull(messages.content),
            ne(messages.content, ''),
          ),
        )
        .orderBy(asc(messages.timestamp))
        .limit(limit)

      return rows as DiscordMessage[]
    } catch (error) {
      this.logger.error('Error fetching unprocessed messages:', error)
      throw error
    }
  }

  async markMessageAsProcessed(messageId: string): Promise<void> {
    try {
      await this.db
        .update(messages)
        .set({ processed: true })
        .where(eq(messages.messageId, messageId))
    } catch (error) {
      this.logger.error('Error marking message as processed:', {
        messageId,
        error,
      })
      throw error
    }
  }

  async markMultipleMessagesAsProcessed(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return

    try {
      await this.db
        .update(messages)
        .set({ processed: true })
        .where(inArray(messages.messageId, messageIds))
      this.logger.info(`Marked ${messageIds.length} messages as processed`)
    } catch (error) {
      this.logger.error('Error marking messages as processed:', {
        count: messageIds.length,
        error,
      })
      throw error
    }
  }

  async updateMessageQuestionAnalysis(
    messageId: string,
    isQuestion: boolean,
    confidence: number,
    questionType?: string,
  ): Promise<void> {
    try {
      await this.db
        .update(messages)
        .set({
          isQuestion,
          questionConfidence: confidence,
          questionType: questionType ?? null,
        })
        .where(eq(messages.messageId, messageId))
    } catch (error) {
      this.logger.error('Error updating question analysis:', {
        messageId,
        error,
      })
      throw error
    }
  }

  async getQuestionMessages(
    channelId?: string,
    limit: number = 50,
  ): Promise<DiscordMessageRow[]> {
    try {
      // The old code appended ` AND channel_id = $1` to the SQL string and
      // renumbered the placeholders by counting them. A condition list says
      // the same thing without the arithmetic.
      const rows = await this.db
        .select(MESSAGE_FIELDS)
        .from(messages)
        .where(
          and(
            eq(messages.isQuestion, true),
            isNotNull(messages.content),
            ne(messages.content, ''),
            channelId ? eq(messages.channelId, channelId) : undefined,
          ),
        )
        .orderBy(desc(messages.timestamp))
        .limit(limit)

      return rows as DiscordMessageRow[]
    } catch (error) {
      this.logger.error('Error fetching question messages:', {
        channelId,
        error,
      })
      throw error
    }
  }
```

`and()` ignores `undefined` members, which is why the optional channel filter
can sit in the list rather than branching the query.

`getRelatedMessages` itself contains no SQL — it orchestrates the private
strategies — so it is left exactly as it is.

- [ ] **Step 4: Rewrite the three private strategy methods**

```typescript
  private async getThreadContextMessages(
    channelId: string,
    targetMessage: DiscordMessage,
  ): Promise<DiscordMessageRow[]> {
    const anchor = targetMessage.replyToMessageId || targetMessage.messageId

    const rows = await this.db
      .select(MESSAGE_FIELDS)
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          or(
            targetMessage.threadId
              ? eq(messages.threadId, targetMessage.threadId)
              : undefined,
            eq(messages.messageId, anchor),
            eq(messages.replyToMessageId, anchor),
          ),
          isNotNull(messages.content),
          ne(messages.content, ''),
          eq(messages.processed, true),
        ),
      )
      .orderBy(asc(messages.timestamp))

    return rows as DiscordMessageRow[]
  }

  private async getKeywordRelevantMessages(
    channelId: string,
    keywords: string[],
    limit: number,
  ): Promise<DiscordMessageRow[]> {
    if (keywords.length === 0) {
      return this.getRecentMessages(channelId, limit)
    }

    const keywordPattern = keywords.join(' | ')
    const relevance = sql<number>`ts_rank(to_tsvector('english', ${messages.content}), plainto_tsquery('english', ${keywordPattern}))`

    try {
      const rows = await this.db
        .select({ ...MESSAGE_FIELDS, relevanceScore: relevance })
        .from(messages)
        .where(
          and(
            eq(messages.channelId, channelId),
            isNotNull(messages.content),
            ne(messages.content, ''),
            eq(messages.processed, true),
            or(isNull(messages.isQuestion), eq(messages.isQuestion, false)),
            gt(
              messages.timestamp,
              sql`now() - ${sql.raw(`interval '${config.context.keywordSearchDays} days'`)}`,
            ),
            sql`to_tsvector('english', ${messages.content}) @@ plainto_tsquery('english', ${keywordPattern})`,
          ),
        )
        .orderBy(desc(relevance), desc(messages.timestamp))
        .limit(limit)

      return rows as DiscordMessageRow[]
    } catch (error) {
      // Fallback to simple keyword matching if full-text search fails
      this.logger.warn('Full-text search failed, using simple keyword matching')
      return this.getSimpleKeywordMessages(channelId, keywords, limit)
    }
  }

  private async getSimpleKeywordMessages(
    channelId: string,
    keywords: string[],
    limit: number,
  ): Promise<DiscordMessageRow[]> {
    if (keywords.length === 0) {
      return this.getRecentMessages(channelId, limit)
    }

    const rows = await this.db
      .select(MESSAGE_FIELDS)
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          or(...keywords.map((k) => ilike(messages.content, `%${k}%`))),
          isNotNull(messages.content),
          ne(messages.content, ''),
          eq(messages.processed, true),
          or(isNull(messages.isQuestion), eq(messages.isQuestion, false)),
          gt(
            messages.timestamp,
            sql`now() - ${sql.raw(`interval '${config.context.keywordSearchDays} days'`)}`,
          ),
        ),
      )
      .orderBy(desc(messages.timestamp))
      .limit(limit)

    return rows as DiscordMessageRow[]
  }

  private async getRecentMessages(
    channelId: string,
    limit: number,
  ): Promise<DiscordMessageRow[]> {
    const rows = await this.db
      .select(MESSAGE_FIELDS)
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          isNotNull(messages.content),
          ne(messages.content, ''),
          eq(messages.processed, true),
          gt(
            messages.timestamp,
            sql`now() - ${sql.raw(`interval '${config.context.fallbackSearchDays} days'`)}`,
          ),
        ),
      )
      .orderBy(desc(messages.timestamp))
      .limit(limit)

    return rows as DiscordMessageRow[]
  }
```

Two notes on the interval. `sql.raw` is used because Postgres will not accept
an interval as a bound parameter, and the value is a number from the config
file — not user input. It was already interpolated into the SQL string the same
way; this is not a new exposure, and it is the one place in the rewrite worth
being deliberate about.

`ts_rank` appears once, bound to a name, and is referenced again in the
ORDER BY. The old code repeated the expression as a string alias, so the two
could disagree.

- [ ] **Step 5: Delete the row mapper**

Remove `mapRowToMessage` entirely — every query now selects by field name. Its
last reference disappears with the strategies rewritten in Step 4.

- [ ] **Step 6: Run the characterization tests**

```bash
pnpm --filter ai-assistant test
```

Expected: PASS, unedited from Task 3.

- [ ] **Step 7: Run the whole suite and typecheck**

```bash
pnpm -r --workspace-concurrency=1 --if-present test
pnpm --filter shared run typecheck
```

Expected: every package green.

- [ ] **Step 8: Commit**

```bash
git add ai-assistant/src/database/queries.ts
git commit -m "$(cat <<'EOF'
refactor(ai-assistant): express the query layer in Drizzle

The largest of the four files and the last, so the forms were settled
before reaching the full-text search.

getQuestionMessages stops appending SQL to a string and renumbering its
placeholders by counting them; and() drops undefined members, so the
optional channel filter is a list entry rather than a branch.

ts_rank is bound once and referenced in the ORDER BY, instead of being
written out twice as a string and an alias that could disagree.

The interval stays interpolated, deliberately: Postgres will not take an
interval as a bound parameter, and the value comes from the config file.
mapRowToMessage is gone — every query selects by field name now.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Derive the row types from the schema

Last, because until now every service consumed the hand-written shapes.

**Files:**
- Modify: `shared/src/types.ts`
- Modify: `shared/src/schema.test-d.ts`
- Modify: `discord-monitor/src/database.ts`, `ai-assistant/src/database/queries.ts`
  (remove the temporary casts)

**Interfaces:**
- Consumes: `shared/src/schema.ts`
- Produces: `Tweet`, `TweetStatus`, `TweetArchetype`, `DiscordMessage`,
  `DiscordMessageWithChannel` — same names, now derived

- [ ] **Step 1: Rewrite `shared/src/types.ts`**

```typescript
/**
 * Row types, derived from `schema.ts` rather than restated. The schema is the
 * contract between the services — they never call each other, they only meet
 * in Postgres — so anything that can be read off it should be.
 *
 * What is left hand-written is what no table describes: the shape of a join,
 * and the columns a given consumer actually depends on.
 */
import type { messages, tweets } from './schema.js'

/** One row of the `tweets` table. */
export type Tweet = typeof tweets.$inferSelect

/**
 * Where a queued tweet is in its lifecycle.
 *
 * `uncertain` is not a flavour of failure. It means the submit button was
 * clicked but the outcome could not be confirmed — the tweet may well be
 * live. Rows in this state are never retried automatically, because the
 * queue prefers a missed tweet over a duplicate one.
 */
export type TweetStatus = Tweet['status']

/**
 * The shape a tweet takes.
 *
 * Chosen by the generator and stored, because the "never the same archetype
 * twice in a row" rule has to survive a process restart — it cannot be held
 * in memory.
 */
export type TweetArchetype = NonNullable<Tweet['archetype']>

/**
 * The columns of `messages` the discord-monitor writes and the ai-assistant
 * reads. Narrower than the table on purpose: the analysis columns
 * (`processed`, `is_question`, `embedding`) belong to one consumer, and a
 * shared type that named them would invite the other to use them.
 *
 * Four of these are nullable in the database and were declared required here
 * for a long time. They are not required. Code that assumed otherwise was
 * relying on the monitor never writing a null, which nothing enforces.
 */
export type DiscordMessage = Pick<
  typeof messages.$inferSelect,
  | 'messageId'
  | 'channelId'
  | 'guildId'
  | 'authorId'
  | 'authorName'
  | 'content'
  | 'timestamp'
  | 'replyToMessageId'
  | 'threadId'
  | 'rawData'
>

/**
 * A message joined with its channel.
 *
 * `channel_name` and `guild_name` live on the `channels` table, not on
 * `messages`, so they are only available when the two are joined — and the
 * join is a LEFT JOIN, hence `undefined` rather than optional: a caller that
 * asked for the enriched shape must acknowledge the name may be missing.
 */
export interface DiscordMessageWithChannel extends DiscordMessage {
  channelName: string | null
  guildName: string | null
}
```

`channelName` and `guildName` become `| null` rather than `| undefined`: a
LEFT JOIN with no match yields SQL NULL, which `pg` and Drizzle both surface
as `null`. The old type said `undefined`, which no query ever produced.

- [ ] **Step 2: Replace the schema assertions with a narrower one**

`schema.test-d.ts` existed to prove the hand-written types matched the schema.
With them derived, that assertion is a tautology. Replace the file's body with
the one thing still worth asserting — that the consumers' expectations survive:

```typescript
/**
 * The hand-written interfaces are gone; `types.ts` derives them. What is
 * still worth proving is that the derived shapes carry the fields the
 * services actually read, so a column renamed in the schema fails here rather
 * than at whichever call site notices first.
 */
import type { DiscordMessage, Tweet, TweetArchetype } from './types.js'

const _tweetHasWhatTheQueueReads: Pick<
  Tweet,
  'id' | 'content' | 'status' | 'dedupeKey' | 'attempts' | 'scheduledAt'
> = {} as Tweet

const _messageHasWhatTheAssistantReads: Pick<
  DiscordMessage,
  'messageId' | 'channelId' | 'content' | 'timestamp'
> = {} as DiscordMessage

// The archetype union must stay closed: adding a value to the schema without
// teaching ARCHETYPES about it should not compile.
const _archetypes: Record<TweetArchetype, true> = {
  digest: true,
  metric: true,
  take: true,
  question: true,
}

export type _Assertions = [
  typeof _tweetHasWhatTheQueueReads,
  typeof _messageHasWhatTheAssistantReads,
  typeof _archetypes,
]
```

- [ ] **Step 3: Give `raw_data` a type**

`jsonb()` infers as `unknown`, while the old `DiscordMessage.rawData` was
`any` — so every call site that reaches into it stops compiling, for a reason
that has nothing to do with this work. Annotate the column in
`shared/src/schema.ts`:

```typescript
    rawData: jsonb('raw_data').$type<Record<string, unknown>>(),
```

`$type` is a TypeScript annotation only; the SQL type stays `jsonb`. Confirm
it produced no schema change:

```bash
pnpm db:generate
```

Expected: "No schema changes, nothing to migrate". If a migration file appears,
delete it and investigate — `$type` must not alter the generated DDL.

- [ ] **Step 4: Remove the temporary casts**

Delete every `as DiscordMessage[]` and `as DiscordMessageRow[]` added in
Tasks 6 and 7. With `DiscordMessage` derived from the same columns the queries
select, the shapes now match without help.

- [ ] **Step 5: Typecheck everything**

```bash
pnpm --filter shared run typecheck
for p in discord-monitor x-poster tweet-generator; do pnpm --filter $p run build || break; done
rm -rf discord-monitor/dist x-poster/dist tweet-generator/dist
```

Expected: silent.

This step is where nullability lands. Any call site that assumed
`message.content` is non-null now fails to compile. **Fix it at the call
site** — a `?? ''`, a guard, whichever the code means. Do not restore the old
lie by widening the type back.

- [ ] **Step 6: Run everything**

```bash
pnpm -r --workspace-concurrency=1 --if-present test
```

Expected: every package green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(shared): derive the row types from the schema

Tweet, TweetStatus, TweetArchetype and DiscordMessage were a hand-kept
copy of the schema, as this file's first paragraph used to admit. They
are read off it now.

Deriving them exposed what the copy had been hiding: author_id,
author_name, content and timestamp are nullable in the database and were
declared required. The call sites that assumed otherwise were relying on
the monitor never writing a null, which nothing enforces; they now say
what they mean.

DiscordMessageWithChannel's join columns become `| null` rather than
`| undefined` — a LEFT JOIN with no match yields NULL, which is what
every driver hands back, and never undefined.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Done when

- No file in the repo maps a snake_case column onto a camelCase field by hand.
- `shared/src/types.ts` declares no row shape the schema already describes.
- `ai-assistant` and `discord-monitor` have test suites; every package runs
  under `pnpm -r --if-present test`.
- Every characterization test written in Tasks 2-3 passes against the rewritten
  code, unedited from when it was written against the old code.
- All 313 pre-existing tests pass unchanged.
- `pnpm --filter shared run typecheck` and every package's `tsc` are silent.

## Not in this plan

- Changing any query's behaviour, including the two places the old code looks
  wrong: `getSimpleKeywordMessages` builds its placeholder numbering by hand,
  and `getRelatedMessages` swallows every error into a recent-messages
  fallback. Both are reproduced faithfully. Fixing them is separate work with
  its own tests, and mixing it in would make a behaviour-preserving rewrite
  impossible to verify.
- Making the services use Drizzle's relational query API (`db.query.*`).
  The select-builder is enough for these queries and closer to the SQL being
  replaced, which is what makes the rewrite reviewable.
