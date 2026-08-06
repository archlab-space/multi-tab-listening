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
    expect(ours[0]).toMatchObject({ channelName: 'general', guildName: 'Guild' })
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
      'kubernetes orchestration',
    )
    const ours = found.filter((m) => m.messageId.startsWith(P))

    expect(ours.map((m) => m.messageId)).toEqual([`${P}match`])
  })

  /**
   * A message matching one keyword is context; the query used to discard it.
   * The keywords were joined into a single ' | '-separated string and handed
   * to plainto_tsquery, which parses its argument as plain text — operators
   * and all — and ANDs every term it finds:
   *
   *   plainto_tsquery('english', 'kubernetes | orchestration')
   *     => 'kubernet' & 'orchestr'
   *
   * Each keyword now gets its own plainto_tsquery and the results are ORed
   * with the tsquery `||` operator, so the OR is real. Ranking still favours
   * the message that matches more of them.
   */
  it('accepts a message matching any keyword, best match first', async () => {
    await seed({
      id: `${P}both`,
      content: 'kubernetes and orchestration together',
      processed: true,
      isQuestion: false,
      timestamp: new Date(),
    })
    await seed({
      id: `${P}one`,
      content: 'kubernetes on its own',
      processed: true,
      isQuestion: false,
      timestamp: new Date(),
    })

    const found = await queries.getRelatedMessages(
      `${P}c1`,
      'kubernetes orchestration',
    )
    const ours = found.filter((m) => m.messageId.startsWith(P))

    expect(ours.map((m) => m.messageId)).toEqual([`${P}both`, `${P}one`])
  })

  /**
   * Composing the query per keyword keeps every term inside plainto_tsquery,
   * which treats operators as text. to_tsquery over a hand-built string would
   * have to escape them or throw on the malformed ones.
   */
  it('treats tsquery operators in the question as text', async () => {
    await seed({
      id: `${P}op`,
      content: 'kubernetes notes',
      processed: true,
      isQuestion: false,
      timestamp: new Date(),
    })

    const found = await queries.getRelatedMessages(
      `${P}c1`,
      'kubernetes & !(orchestration <-> :*',
    )
    const ours = found.filter((m) => m.messageId.startsWith(P))

    expect(ours.map((m) => m.messageId)).toEqual([`${P}op`])
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

    expect(ours[0]).toMatchObject({ messageId: `${P}thread` })
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
