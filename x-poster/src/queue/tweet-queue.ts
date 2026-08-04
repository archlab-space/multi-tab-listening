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
  async releaseForRetry(
    id: number,
    error: string,
    retryAt: Date,
  ): Promise<void> {
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
