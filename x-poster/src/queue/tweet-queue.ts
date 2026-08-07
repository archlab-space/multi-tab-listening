import { and, eq, lte, max, sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import type { Tweet } from 'shared'
import { startOfDayIn } from 'shared/clock'
import { createDb } from 'shared/db'
import { tweets } from 'shared/schema'
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

  /**
   * Back to pending, but not before `retryAt`. `attempts` is left alone.
   *
   * `refundAttempt` gives back the increment `claimNext` charged, for a claim
   * that never got as far as trying to post. Waiting out an expired login is
   * not one of the tweet's retries: without the refund, three login outages
   * would exhaust `maxAttempts` and the next ordinary network blip would
   * declare a perfectly healthy tweet failed.
   */
  async releaseForRetry(
    id: number,
    error: string,
    retryAt: Date,
    options: { refundAttempt?: boolean } = {},
  ): Promise<void> {
    await this.db
      .update(tweets)
      .set({
        status: 'pending',
        lastError: error,
        scheduledAt: retryAt,
        updatedAt: sql`now()`,
        ...(options.refundAttempt
          ? { attempts: sql`greatest(${tweets.attempts} - 1, 0)` }
          : {}),
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

  /**
   * What the rate limiter needs to know, read straight from the table.
   *
   * `timezone` is a parameter rather than a host-clock read: this count is
   * what the daily cap is checked against, and it has to mean the same day
   * tweet-generator counts its own cap against.
   */
  async history(
    timezone: string,
    now: Date = new Date(),
  ): Promise<PostingHistory> {
    const dayStart = startOfDayIn(timezone, now)

    const [row] = await this.db
      .select({
        count: sql<string>`count(*) filter (where ${tweets.postedAt} >= ${dayStart})`,
        // `max()` rather than a raw sql expression: the `sql<T>` annotation is
        // a claim to the compiler, not a conversion, so a hand-written
        // max(posted_at) arrives as the driver's string. The aggregate helper
        // knows the column and hands back a Date.
        last: max(tweets.postedAt),
      })
      .from(tweets)
      .where(eq(tweets.status, 'posted'))

    return {
      postedToday: Number(row?.count ?? 0),
      lastPostedAt: row?.last ?? null,
    }
  }
}
