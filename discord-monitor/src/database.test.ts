/**
 * Characterization tests: they record what this code does today, so the
 * Drizzle rewrite has something to answer to. Where the current behaviour is
 * surprising, the test says so rather than asserting the behaviour we would
 * prefer — changing it is not this work.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool } from 'shared/db'
import { Database } from './database.js'
import type { DiscordMessage } from './types.js'

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

function aMessage(
  overrides: Partial<Omit<DiscordMessage, 'source'>> = {},
): Omit<DiscordMessage, 'source'> {
  return {
    messageId: `${P}m1`,
    channelId: `${P}c1`,
    spaceId: `${P}g1`,
    authorId: 'author-1',
    authorName: 'Author One',
    content: 'hello world',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    rawData: { a: 1 },
    ...overrides,
  } as Omit<DiscordMessage, 'source'>
}

describe('insertChannel', () => {
  it('inserts a channel', async () => {
    await db.insertChannel({
      channelId: `${P}c1`,
      channelName: 'general',
      guildId: `${P}g1`,
      guildName: 'Guild',
    })

    const { rows } = await pool.query(
      'SELECT channel_name, space_name FROM channels WHERE channel_id = $1',
      [`${P}c1`],
    )
    expect(rows[0]).toEqual({ channel_name: 'general', space_name: 'Guild' })
  })

  it('updates the names when the channel already exists', async () => {
    const base = {
      channelId: `${P}c1`,
      channelName: 'general',
      guildId: `${P}g1`,
      guildName: 'Guild',
    }
    await db.insertChannel(base)
    await db.insertChannel({ ...base, channelName: 'renamed' })

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
})

describe('insertThread', () => {
  it('ignores a second insert of the same thread id', async () => {
    const thread = {
      threadId: `${P}t1`,
      originalMessageId: `${P}m1`,
      channelId: `${P}c1`,
    }
    await db.insertThread(thread)
    await db.insertThread({ ...thread, channelId: `${P}c2` })

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
      source: 'discord',
      messageId: `${P}new`,
      channelId: `${P}c1`,
      spaceId: `${P}g1`,
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
    })

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
