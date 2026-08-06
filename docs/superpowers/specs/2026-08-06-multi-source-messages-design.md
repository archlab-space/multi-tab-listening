# Multi-Source Messages — Design

- **Date:** 2026-08-06
- **Status:** Approved, ready for implementation planning

## Goal

Make the message tables able to hold a second message source without a
rewrite, while Discord remains the only source that exists.

## Problem

The schema was written when Discord was the only conceivable source, and it
encodes that assumption in three places. None of them is a naming problem.

**Every row is implicitly Discord.** No column records where a message came
from. A second source's rows would be indistinguishable from Discord's, and
every query would have to infer the source from the shape of an ID.

**The uniqueness constraints span all sources at once.** `messages.message_id`,
`channels.channel_id` and `threads.thread_id` are each globally `UNIQUE`. Two
sources have two ID spaces, so the constraint that actually holds is
`(source, id)`. As written, a second source whose ID collides with a Discord
ID is rejected by Postgres as a duplicate — silently, through
`onConflictDoNothing`, which is how the monitor inserts.

**`guild_id` is Discord's word.** Slack calls the same layer a workspace,
Telegram has no such layer at all. The column is `NOT NULL` on `messages`,
so a source without that layer cannot be inserted.

By contrast, the table names — `messages`, `channels`, `threads` — hold up.
Slack has all three. Telegram has messages and chats (which it also calls
channels) and forum topics. Only a feed-shaped source with no container at
all, such as an X timeline, would strain `channels`, and no such source is
planned. Renaming the tables was considered and rejected: it is the cheapest
change available and resolves none of the three problems above.

## Non-Goals

- Adding a second source. This makes room for one; it does not build one.
- Renaming `messages`, `channels` or `threads`. Revisit when a second source
  exists and the shared shape can be observed rather than guessed.
- Renaming the `DiscordMessage` / `DiscordRawData` types. What the sources have
  in common is not yet knowable from one sample.
- Touching `tweets` or `generation_attempts`. They are the outbound queue and
  have no relationship to where a message came from.
- A per-source permalink abstraction. With one source in the enum, a branch on
  source is dead code. `webhook-sender.ts` keeps building its Discord URL
  inline; that line is the obvious seam when a second source lands.

## Decision

### A `source` discriminator on the three message tables

```ts
source: varchar('source', { length: 20, enum: ['discord'] }).notNull()
```

Added to `messages`, `channels` and `threads`. The varchar-plus-enum form
matches `tweets.status` and `tweets.archetype`, which is the house style.

**No default.** A default would let a writer omit the column and be silently
labelled Discord. Without one, Drizzle's insert type requires `source` at
every call site, so an omission is a compile error. The migration backfills
existing rows with `'discord'` — the only value they can have.

**An enum rather than free text.** Adding a source becomes a deliberate schema
change, and the enum is the list of sources the system claims to support.

### Uniqueness becomes composite

| Now | After |
| --- | --- |
| `UNIQUE(message_id)` | `UNIQUE(source, message_id)` |
| `UNIQUE(channel_id)` | `UNIQUE(source, channel_id)` |
| `UNIQUE(thread_id)` | `UNIQUE(source, thread_id)` |

The three `onConflict` targets in `discord-monitor/src/database.ts` — lines
30, 68 and 84 — change to the composite targets. These are the constraints
the upserts name, so leaving them behind would not fail to compile in every
case; they are called out here because they are the part most easily missed.

### `guild_*` becomes `space_*`, staying `NOT NULL`

`guild_id` → `space_id` and `guild_name` → `space_name`, on both `messages`
and `channels`. The index `idx_messages_guild_id` is renamed to match.

`space` over `workspace` (Slack's word, the same parochialism in the other
direction) and over `server` (Discord's UI word, and it suggests
infrastructure). Matrix, Google Chat and Confluence all use `space` for this
layer.

**`messages.space_id` stays `NOT NULL`.** A source with no such layer writes
`''`. This follows the convention set in `0001_message_columns_not_null`,
where an unreadable author is `'unknown'` and an attachment-only message is
`''` — the writer substitutes rather than omits. The alternative, making the
column nullable, states "not applicable" more honestly, but it puts a
`string | null` back into `webhook-sender.ts:108`, which builds a Discord
permalink out of the value. The sentinel is the acknowledged cost.

`channels.space_id` is already nullable and stays that way.

## Consequences

- Every insert into `messages`, `channels` or `threads` must name its source.
  There are three such call sites, all in `discord-monitor/src/database.ts`.
- `shared/src/types.ts` gains `source` in `DiscordMessage`, and `guildId` /
  `guildName` become `spaceId` / `spaceName` there and in the two services that
  read them: `discord-monitor` (42 references, most of them page-scraping and
  status reporting) and `ai-assistant` (9). `tweet-generator` and `x-poster`
  have none — they never touch a message.
- `discord-monitor` keeps its own `guildId` / `guildName` throughout. It is the
  Discord adapter: its config format is `guild_id/channel_id`, it validates
  guild IDs as numeric, and it scrapes the guild name from Discord's DOM.
  "Guild" is the right word inside that boundary. The rename stops at the
  storage layer, and `database.ts` maps one onto the other as it writes.
- One migration, `0002`, containing the backfill and the constraint changes in
  that order. Column renames use `ALTER TABLE ... RENAME COLUMN`, which
  preserves data; drizzle-kit prompts to distinguish a rename from a
  drop-and-add, and the generated file must be checked for this.

## Testing

The existing characterization tests in `ai-assistant/src/database/queries.test.ts`
and `discord-monitor/src/database.test.ts` cover the query behaviour and must
keep passing unchanged except for the renamed fields — this change alters no
query semantics.

Two new tests earn their place:

- Inserting the same `message_id` under a different source succeeds, where
  today it is swallowed by `onConflictDoNothing`. This is the constraint
  change's whole purpose and nothing else demonstrates it. Writing a second
  source needs no test-only enum member: the enum constrains TypeScript, while
  the column is a plain `varchar(20)` in Postgres, so the test seeds its second
  source through `pool.query` — which is already how both test files insert
  their fixtures.
- A message written with `space_id = ''` round-trips, confirming the sentinel
  is storable and readable.

## Migration Risk

`ALTER TABLE ... RENAME COLUMN` is not backward compatible: a running service
reading `guild_id` breaks the moment the migration lands. All four services are
started by hand and none runs during development, so a coordinated restart is
the whole mitigation. Worth stating because it is the first migration in this
repo that can break a running process.
