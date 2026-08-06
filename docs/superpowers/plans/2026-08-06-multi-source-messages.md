# Multi-Source Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the message tables hold a second message source without a rewrite, while Discord stays the only source that exists.

**Architecture:** A `source` discriminator column on `messages`, `channels` and `threads`, with the global `UNIQUE(id)` constraints replaced by `UNIQUE(source, id)`. Separately, `guild_id`/`guild_name` become `space_id`/`space_name` — but only at the storage layer; `discord-monitor` keeps saying "guild" internally and maps at the point of writing.

**Tech Stack:** Drizzle ORM 0.45.2, drizzle-kit 0.31.10, PostgreSQL 15 (pgvector image), Vitest 3.2.7, pnpm workspaces.

## Global Constraints

- The schema in `shared/src/schema.ts` is the single source of truth. Change a column there and run `pnpm db:generate`; never hand-write DDL to define schema. Hand-editing a *generated* migration to add a backfill is expected and is not the same thing.
- Migrations are named meaningfully, not by drizzle-kit's random tag. Rename the generated file and update the matching `tag` in `db/migrations/meta/_journal.json`.
- Timestamps omit `mode` so they infer as `Date`.
- `source` values are `'discord'` only. The enum is the list of supported sources.
- Tests run against the live local Postgres (`docker compose up -d`, then `pnpm db:migrate`). They are not mocked.
- `x-poster`'s `tweet-queue.test.ts` fails intermittently when the machine is loaded. This predates this work and is unrelated to it — do not chase it. Verify x-poster by running it alone.

## Prerequisite

The working tree carries an uncommitted change (migration `0001_message_columns_not_null` plus the `NOT NULL` schema edit and its fallout). Commit or stash it before starting — Task 1 generates migration `0002` and needs a clean base.

## Deviation From The Spec

The spec says `discord-monitor/src/types.ts` has its `guildId`/`guildName` "renamed with the rest". Do not do this. `discord-monitor` is the Discord adapter: its config format is `guild_id/channel_id` (`config.ts:13`), it validates guild IDs as numeric (`config.ts:73`), and it scrapes the guild name from Discord's DOM (`discord-monitor.ts:213`). "Guild" is the correct word inside that boundary, and renaming it would change a user-facing env var format for no benefit.

The rename stops at the storage layer: `shared/src/schema.ts`, `shared/src/types.ts`, and the lines in `discord-monitor/src/database.ts` that map a scraped field onto a column. Task 2 updates the spec to say this.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `shared/src/schema.ts` | Column definitions, composite unique constraints | 1, 2 |
| `shared/src/types.ts` | Row types derived from the schema | 1, 2 |
| `db/migrations/0002_*.sql` | Backfill then constrain | 1 |
| `db/migrations/0003_*.sql` | Column rename | 2 |
| `discord-monitor/src/database.ts` | The only writer; stamps `source: 'discord'` and maps guild → space | 1, 2 |
| `discord-monitor/src/database.test.ts` | Writer behaviour, including cross-source uniqueness | 1, 2 |
| `ai-assistant/src/database/queries.ts` | Reader; selects the renamed column | 2 |
| `ai-assistant/src/discord/webhook-sender.ts` | Builds the Discord permalink from the space id | 2 |

---

### Task 1: The `source` discriminator and composite uniqueness

**Files:**
- Modify: `shared/src/schema.ts` (`channels` 40-47, `messages` 49-96, `threads` 98-104)
- Modify: `shared/src/types.ts` (the `DiscordMessage` Pick, ~44-56)
- Modify: `discord-monitor/src/database.ts:20-90` (three insert sites)
- Create: `db/migrations/0002_message_source.sql`
- Modify: `db/migrations/meta/_journal.json`
- Test: `discord-monitor/src/database.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `messages.source`, `channels.source`, `threads.source`, each `varchar(20) NOT NULL` typed as the literal `'discord'`. `DiscordMessage` gains `source: 'discord'`. `Database.insertMessage`, `insertChannel` and `insertThread` take their argument *without* a `source` field and supply `'discord'` themselves — signature `insertMessage(message: Omit<DiscordMessage, 'source'>, isFiltered?: boolean)`.

- [ ] **Step 1: Write the failing test**

Add to `discord-monitor/src/database.test.ts`, inside the `describe('insertMessage', ...)` block:

```ts
  /**
   * The point of the source column. `message_id` alone used to be UNIQUE, so a
   * second source reusing an id Discord had already taken was swallowed by
   * `onConflictDoNothing` — no row, no error. The constraint is now
   * (source, message_id).
   *
   * The second source is written through `pool.query` rather than the writer:
   * the enum constrains TypeScript, while the column is a plain varchar in
   * Postgres, so no test-only enum member is needed.
   */
  it('keeps two sources that share a message id apart', async () => {
    await db.insertMessage(aMessage({ content: 'from discord' }))

    await pool.query(
      `INSERT INTO messages
         (source, message_id, channel_id, space_id, author_id, author_name,
          content, timestamp, raw_data)
       VALUES ('slack', $1, $2, $3, 'author-1', 'Author One',
               'from slack', now(), '{}'::jsonb)`,
      [`${P}m1`, `${P}c1`, `${P}g1`],
    )

    const { rows } = await pool.query(
      'SELECT source, content FROM messages WHERE message_id = $1 ORDER BY source',
      [`${P}m1`],
    )
    expect(rows).toEqual([
      { source: 'discord', content: 'from discord' },
      { source: 'slack', content: 'from slack' },
    ])
  })
```

The raw insert names `guild_id` because that is still the column's name at this
point. Task 2 renames it, and Task 2 Step 8 changes this line with it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd discord-monitor && npx vitest run src/database.test.ts -t "share a message id"`
Expected: FAIL — `column "source" of relation "messages" does not exist`.

- [ ] **Step 3: Add `source` to the schema and make the uniques composite**

In `shared/src/schema.ts`, add `unique` to the `drizzle-orm/pg-core` import list.

`channels` — add the column and a table-level unique (the table currently has no second argument, so add one):

```ts
export const channels = pgTable(
  'channels',
  {
    id: serial('id').primaryKey(),
    /** Which message source this row came from. See `messages.source`. */
    source: varchar('source', { length: 20, enum: ['discord'] }).notNull(),
    channelId: varchar('channel_id', { length: 255 }).notNull(),
    channelName: varchar('channel_name', { length: 255 }),
    guildId: varchar('guild_id', { length: 255 }),
    guildName: varchar('guild_name', { length: 255 }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => [
    unique('channels_source_channel_id_unique').on(table.source, table.channelId),
  ],
)
```

`messages` — add the column, drop `.unique()` from `messageId`, add the composite:

```ts
    id: serial('id').primaryKey(),
    /**
     * Which message source wrote this row. Every id below is unique only
     * within its source — two sources have two id spaces — so the uniqueness
     * constraints are composite. The enum is the list of sources the system
     * supports; adding one is deliberately a schema change.
     *
     * No default: a default would let a writer omit the column and be quietly
     * labelled Discord. Without one, omitting it is a compile error.
     */
    source: varchar('source', { length: 20, enum: ['discord'] }).notNull(),
    messageId: varchar('message_id', { length: 255 }).notNull(),
```

and in the index array:

```ts
    unique('messages_source_message_id_unique').on(table.source, table.messageId),
```

`threads` — same treatment:

```ts
export const threads = pgTable(
  'threads',
  {
    id: serial('id').primaryKey(),
    /** Which message source this row came from. See `messages.source`. */
    source: varchar('source', { length: 20, enum: ['discord'] }).notNull(),
    threadId: varchar('thread_id', { length: 255 }).notNull(),
    originalMessageId: varchar('original_message_id', { length: 255 }).notNull(),
    channelId: varchar('channel_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => [
    unique('threads_source_thread_id_unique').on(table.source, table.threadId),
  ],
)
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`

- [ ] **Step 5: Rewrite the generated migration to backfill first**

drizzle-kit emits `ADD COLUMN "source" varchar(20) NOT NULL`, which fails against any table that already has rows — a `NOT NULL` column with no default cannot be added to a non-empty table. Replace the generated file's contents with the three-phase form below, then rename it.

Rename: `db/migrations/0002_<random>.sql` → `db/migrations/0002_message_source.sql`, and set the matching `"tag"` in `db/migrations/meta/_journal.json` to `"0002_message_source"`.

```sql
-- Add the column nullable, fill it, then constrain. drizzle-kit generates a
-- single NOT NULL ADD COLUMN, which Postgres rejects on a non-empty table
-- when there is no default — and a default is exactly what this column must
-- not have, so that omitting it is a compile error rather than a silent
-- mislabelling.
ALTER TABLE "messages" ADD COLUMN "source" varchar(20);--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "source" varchar(20);--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "source" varchar(20);--> statement-breakpoint
-- Every row that predates this column came from the only source there was.
UPDATE "messages" SET "source" = 'discord' WHERE "source" IS NULL;--> statement-breakpoint
UPDATE "channels" SET "source" = 'discord' WHERE "source" IS NULL;--> statement-breakpoint
UPDATE "threads" SET "source" = 'discord' WHERE "source" IS NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "source" SET NOT NULL;--> statement-breakpoint
-- The old constraints span all sources at once, which is the bug.
ALTER TABLE "messages" DROP CONSTRAINT "messages_message_id_unique";--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_channel_id_unique";--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT "threads_thread_id_unique";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_source_message_id_unique" UNIQUE("source","message_id");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_source_channel_id_unique" UNIQUE("source","channel_id");--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_source_thread_id_unique" UNIQUE("source","thread_id");
```

- [ ] **Step 6: Apply the migration and verify the constraints**

Run: `pnpm db:migrate`

Then verify:

```bash
docker exec multi-tab-postgres psql -U app_user -d multi_tab_listening -c "
SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid)
FROM pg_constraint WHERE contype='u'
AND conrelid::regclass::text IN ('messages','channels','threads') ORDER BY 1;"
```

Expected: three rows, each `UNIQUE (source, <id>)`. No `*_message_id_unique` / `*_channel_id_unique` / `*_thread_id_unique` remaining.

- [ ] **Step 7: Add `source` to the shared row type**

In `shared/src/types.ts`, add `'source'` as the first entry of the `DiscordMessage` Pick list, and extend the doc comment:

```ts
export type DiscordMessage = Pick<
  typeof messages.$inferSelect,
  | 'source'
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
```

- [ ] **Step 8: Make the writer stamp its own source**

In `discord-monitor/src/database.ts`, the adapter declares what it is rather than accepting it from a caller — one place, so it cannot be forgotten. Change the three signatures and add `source` to each set of values.

`insertChannel`:

```ts
  async insertChannel(channel: Channel): Promise<void> {
    try {
      await this.db
        .insert(channels)
        .values({
          source: 'discord',
          channelId: channel.channelId,
          channelName: channel.channelName,
          guildId: channel.guildId,
          guildName: channel.guildName,
        })
        .onConflictDoUpdate({
          target: [channels.source, channels.channelId],
          set: {
            channelName: channel.channelName,
            guildId: channel.guildId,
            guildName: channel.guildName,
          },
        })
```

`insertMessage` — note the `Omit` in the signature:

```ts
  async insertMessage(
    message: Omit<DiscordMessage, 'source'>,
    isFiltered: boolean = false,
  ): Promise<void> {
    try {
      await this.db
        .insert(messages)
        .values({
          source: 'discord',
          messageId: message.messageId,
          ...
        })
        .onConflictDoNothing({ target: [messages.source, messages.messageId] })
```

`insertThread`:

```ts
        .insert(threads)
        .values({
          source: 'discord',
          threadId: thread.threadId,
          originalMessageId: thread.originalMessageId,
          channelId: thread.channelId,
        })
        .onConflictDoNothing({ target: [threads.source, threads.threadId] })
```

Both `getMessagesByChannel` and `getThreadMessages` return `DiscordMessage[]`, which now includes `source`. Add `source: messages.source,` to both select objects (lines ~97 and ~131).

- [ ] **Step 9: Update the test helper**

`aMessage()` in `discord-monitor/src/database.test.ts` builds a `DiscordMessage`. Its return type becomes the writer's input type:

```ts
function aMessage(
  overrides: Partial<Omit<DiscordMessage, 'source'>> = {},
): Omit<DiscordMessage, 'source'> {
```

The `as DiscordMessage` cast at the end of the function body becomes `as Omit<DiscordMessage, 'source'>`.

- [ ] **Step 10: Run the test to verify it passes**

Run: `cd discord-monitor && npx vitest run src/database.test.ts`
Expected: PASS, 10 tests (9 existing plus the new one).

- [ ] **Step 11: Verify nothing else broke**

```bash
for p in shared ai-assistant discord-monitor tweet-generator; do
  (cd $p && npx tsc --noEmit -p tsconfig.json && npx vitest run 2>&1 | grep -E "Tests +[0-9]+")
done
```

Expected: no typecheck output, and `28 / 14 / 10 / 210` tests passing. Run `x-poster` separately (`cd x-poster && npx vitest run`) — see Global Constraints.

- [ ] **Step 12: Commit**

```bash
git add shared/src/schema.ts shared/src/types.ts \
        discord-monitor/src/database.ts discord-monitor/src/database.test.ts \
        db/migrations/0002_message_source.sql db/migrations/meta/
git commit -m "feat(shared): record which source a message came from"
```

---

### Task 2: `guild_*` becomes `space_*` at the storage layer

**Files:**
- Modify: `shared/src/schema.ts` (`channels`, `messages`, the `idx_messages_guild_id` index)
- Modify: `shared/src/types.ts` (the Pick list, `DiscordMessageWithChannel`)
- Create: `db/migrations/0003_space_columns.sql`
- Modify: `db/migrations/meta/_journal.json`
- Modify: `discord-monitor/src/database.ts` (the mapping lines only)
- Modify: `discord-monitor/src/database.test.ts` (raw SQL column names)
- Modify: `ai-assistant/src/database/queries.ts:30,65`
- Modify: `ai-assistant/src/discord/webhook-sender.ts:108,146`
- Modify: `docs/superpowers/specs/2026-08-06-multi-source-messages-design.md`

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces: `messages.spaceId` (`space_id`, `NOT NULL`), `channels.spaceId` / `channels.spaceName` (`space_id` / `space_name`, both nullable). `DiscordMessage.spaceId` replaces `.guildId`; `DiscordMessageWithChannel.spaceName` replaces `.guildName`. `discord-monitor`'s own `Channel`, `ChannelInfo` and `ChannelHealthStatus` types keep `guildId` / `guildName` unchanged.

This task is mostly a rename, and a rename has no behaviour to test-drive: the deliverable is that every package typechecks and every existing test passes with the new names. One thing here *is* new behaviour, though — the `''` sentinel — and Step 0 drives it.

- [ ] **Step 0: Write the failing test for the sentinel**

The whole reason `space_id` stays `NOT NULL` is that a source without that layer writes `''` instead of null. Nothing today proves `''` survives a round trip, and if it did not, the design decision would be wrong. Add to `discord-monitor/src/database.test.ts`, in the `describe('insertMessage', ...)` block:

```ts
  /**
   * `space_id` is NOT NULL, so a source with no such layer — Telegram has no
   * guild or workspace — says so with an empty string rather than a null.
   * The sentinel is only worth having if it round-trips.
   */
  it('stores a message whose source has no space', async () => {
    await db.insertMessage(aMessage({ spaceId: '' }))

    const { rows } = await pool.query(
      'SELECT space_id FROM messages WHERE message_id = $1',
      [`${P}m1`],
    )
    expect(rows[0]).toEqual({ space_id: '' })
  })
```

Run: `cd discord-monitor && npx vitest run src/database.test.ts -t "no space"`
Expected: FAIL — `column "space_id" does not exist`, and `spaceId` is not a known property. Both are fixed by the steps below.

- [ ] **Step 1: Rename the columns in the schema**

In `shared/src/schema.ts`:

```ts
// channels
    spaceId: varchar('space_id', { length: 255 }),
    spaceName: varchar('space_name', { length: 255 }),
```

```ts
// messages — the doc comment explains the sentinel
    /**
     * The container the channel belongs to: a Discord guild, a Slack
     * workspace. `''` for a source that has no such layer, such as Telegram,
     * following the convention of the columns above — the writer substitutes
     * rather than omits.
     */
    spaceId: varchar('space_id', { length: 255 }).notNull(),
```

and the index:

```ts
    index('idx_messages_space_id').on(table.spaceId),
```

- [ ] **Step 2: Generate the migration and confirm drizzle-kit saw a rename**

Run: `pnpm db:generate`

drizzle-kit cannot tell a rename from a drop-plus-add and will prompt. Answer that `guild_id` was **renamed** to `space_id` (and `guild_name` to `space_name`), not created. Then open the generated file and confirm it contains `RENAME COLUMN` and **no** `DROP COLUMN`:

```bash
grep -E "RENAME|DROP COLUMN" db/migrations/0003_*.sql
```

Expected: three `RENAME COLUMN` lines, zero `DROP COLUMN`. A `DROP COLUMN` here destroys data — if one appears, discard the file, re-run `pnpm db:generate` and answer the prompt correctly.

- [ ] **Step 3: Rename the migration file**

`db/migrations/0003_<random>.sql` → `db/migrations/0003_space_columns.sql`, and set the matching `"tag"` in `db/migrations/meta/_journal.json` to `"0003_space_columns"`.

The file should read:

```sql
ALTER TABLE "messages" RENAME COLUMN "guild_id" TO "space_id";--> statement-breakpoint
ALTER TABLE "channels" RENAME COLUMN "guild_id" TO "space_id";--> statement-breakpoint
ALTER TABLE "channels" RENAME COLUMN "guild_name" TO "space_name";--> statement-breakpoint
ALTER INDEX "idx_messages_guild_id" RENAME TO "idx_messages_space_id";
```

If drizzle-kit emitted `DROP INDEX` / `CREATE INDEX` for the index instead of `ALTER INDEX ... RENAME`, leave its version alone — the effect is the same and an index carries no data.

- [ ] **Step 4: Apply and verify**

Run: `pnpm db:migrate`

```bash
docker exec multi-tab-postgres psql -U app_user -d multi_tab_listening -c "
SELECT table_name, column_name, is_nullable FROM information_schema.columns
WHERE column_name LIKE 'space%' OR column_name LIKE 'guild%' ORDER BY 1,2;"
```

Expected: `channels.space_id` (YES), `channels.space_name` (YES), `messages.space_id` (NO). No `guild_*` rows.

- [ ] **Step 5: Rename in the shared row types**

`shared/src/types.ts` — in the `DiscordMessage` Pick, `'guildId'` becomes `'spaceId'`. In `DiscordMessageWithChannel`, `guildName: string | null` becomes `spaceName: string | null`, and its doc comment's reference to `guild_name` becomes `space_name`.

- [ ] **Step 6: Map at the writer, keep "guild" inside the adapter**

`discord-monitor/src/database.ts` only. The right-hand sides keep saying `guild` — that is the adapter's vocabulary — while the column names change:

```ts
// insertChannel .values and .set
          spaceId: channel.guildId,
          spaceName: channel.guildName,
```

```ts
// insertMessage .values
          spaceId: message.spaceId,
```

```ts
// getMessagesByChannel and getThreadMessages select objects
          spaceId: messages.spaceId,
```

Do **not** touch `discord-monitor/src/types.ts`, `config.ts`, `discord-monitor.ts` or `status-reporter.ts`. `Channel.guildId`, `ChannelInfo.guildId` and `ChannelHealthStatus.guildName` stay as they are.

One line does need changing, because it assigns to the shared row type: `discord-monitor.ts:114`, currently `messageData.guildId = channel.guildId`, becomes:

```ts
          // The scraper speaks Discord; the row speaks storage.
          messageData.spaceId = channel.guildId
```

- [ ] **Step 7: Rename in the reader**

`ai-assistant/src/database/queries.ts`: line 30 `guildId: messages.guildId,` → `spaceId: messages.spaceId,`; line 65 `guildName: channels.guildName,` → `spaceName: channels.spaceName,`.

`ai-assistant/src/discord/webhook-sender.ts`: line 108 uses the value to build a Discord permalink, which is correct — this service only ever formats Discord messages:

```ts
    const messageUrl = `https://discord.com/channels/${message.spaceId}/${message.channelId}/${message.messageId}`
```

line 146: `Guild name: ${message.guildName}` → `Guild name: ${message.spaceName}`. The user-facing label stays "Guild name" — the reader is looking at a Discord message.

- [ ] **Step 8: Update the raw SQL in the tests**

`discord-monitor/src/database.test.ts`: in the cross-source test added in Task 1, change the raw insert's column list from `guild_id` to `space_id`. Also line 56's `'SELECT channel_name, guild_name FROM channels WHERE channel_id = $1'` becomes `space_name`, and line 59's expectation `{ channel_name: 'general', guild_name: 'Guild' }` becomes `{ channel_name: 'general', space_name: 'Guild' }`.

The `guildId:`/`guildName:` keys inside `aMessage()` and the `insertChannel` calls are `Channel` fields, which keep their names — except `aMessage()`, whose return type is the shared row type: its `guildId: \`${P}g1\`` becomes `spaceId: \`${P}g1\``.

- [ ] **Step 9: Verify the whole workspace**

```bash
for p in shared ai-assistant discord-monitor tweet-generator; do
  (cd $p && npx tsc --noEmit -p tsconfig.json && npx vitest run 2>&1 | grep -E "Tests +[0-9]+")
done
grep -rn "guildId\|guild_id\|guildName\|guild_name" shared/src ai-assistant/src | grep -v node_modules
```

Expected: no typecheck output; `28 / 14 / 11 / 210` passing (discord-monitor gains the sentinel test from Step 0); the grep returns nothing — `shared` and `ai-assistant` no longer mention guild at all, while `discord-monitor` still does, which is the point.

- [ ] **Step 10: Correct the spec**

In `docs/superpowers/specs/2026-08-06-multi-source-messages-design.md`, replace the Consequences bullet that begins "`discord-monitor/src/types.ts` carries its own `guildId` / `guildName` fields" with:

```markdown
- `discord-monitor` keeps its own `guildId` / `guildName` throughout. It is the
  Discord adapter: its config format is `guild_id/channel_id`, it validates
  guild IDs as numeric, and it scrapes the guild name from Discord's DOM.
  "Guild" is the right word inside that boundary. The rename stops at the
  storage layer, and `database.ts` maps one onto the other as it writes.
```

- [ ] **Step 11: Commit**

```bash
git add shared/src ai-assistant/src discord-monitor/src \
        db/migrations/0003_space_columns.sql db/migrations/meta/ \
        docs/superpowers/specs/2026-08-06-multi-source-messages-design.md
git commit -m "refactor(shared): generalise the guild columns to space"
```

---

## Migration Risk

`ALTER TABLE ... RENAME COLUMN` is not backward compatible: a running service reading `guild_id` breaks the moment Task 2's migration lands. All four services start by hand and none runs during development, so a coordinated restart is the whole mitigation — but this is the first migration in the repo that can break a live process, so do not apply it against anything that is running.
