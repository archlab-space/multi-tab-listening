import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  max,
  sql,
} from 'drizzle-orm'
import type { Pool } from 'pg'
import type { TweetArchetype } from 'shared'
import { createDb } from 'shared/db'
import { generationAttempts, tweets } from 'shared/schema'
import { TIER_OF_KIND, type SourceKind, type Tier } from './config.js'
import type { QuotaUsage } from './select/quota.js'

function emptyUsage(): QuotaUsage['used'] {
  return { project: 0, hot: 0, labs: 0 }
}

export interface EnqueueInput {
  content: string
  dedupeKey: string
  source?: SourceKind
  sourceRef?: string
  archetype?: TweetArchetype
  mediaPath?: string
  tier?: Tier
  entities?: string[]
}

/**
 * Every statement this service issues. Collected here so the columns the
 * generator depends on are visible at a glance rather than scattered across
 * the modules that happen to need them.
 */
export class GeneratorStore {
  private readonly db: ReturnType<typeof createDb>

  constructor(pool: Pool) {
    this.db = createDb(pool)
  }

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
    const [row] = await this.db
      .insert(tweets)
      .values({
        content: input.content,
        dedupeKey: input.dedupeKey,
        source: input.source ?? null,
        sourceRef: input.sourceRef ?? null,
        archetype: input.archetype ?? null,
        mediaPath: input.mediaPath ?? null,
        tier: input.tier ?? null,
        entities: input.entities ?? null,
      })
      .onConflictDoNothing({ target: tweets.dedupeKey })
      .returning({ id: tweets.id })

    return row?.id ?? null
  }

  /**
   * Counts every row created since `dayStart`, whatever its status.
   *
   * Quota is spent when the generator commits to a slot, not when x-poster
   * succeeds: counting only 'posted' would let a failed tweet be silently
   * replaced, quietly exceeding the daily cap.
   */
  async usageSince(dayStart: Date): Promise<QuotaUsage> {
    // Drizzle's count() comes back a number; the old code read COUNT(*) as a
    // string and cast it. Same query, one less conversion.
    const rows = await this.db
      .select({ source: tweets.source, count: count() })
      .from(tweets)
      .where(and(gte(tweets.createdAt, dayStart), isNotNull(tweets.source)))
      .groupBy(tweets.source)

    const used = emptyUsage()
    let total = 0
    for (const row of rows) {
      total += row.count
      const tier = TIER_OF_KIND[row.source as SourceKind] as Tier | undefined
      // A row whose source predates the tier split, or names the retired
      // youtube kind, still counts toward the daily cap but belongs to no
      // tier's allowance.
      if (tier) used[tier] += row.count
    }
    return { used, total }
  }

  /**
   * How many tweets are still waiting for x-poster to take one.
   *
   * This is the generator's set point, so only 'pending' counts as stock. A
   * 'sending' row has already been claimed and is on its way out; 'posted',
   * 'failed' and 'uncertain' are terminal. Counting any of them would let a
   * row that is never coming back masquerade as inventory, and the buffer
   * would starve while reading as full.
   */
  async pendingCount(): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(tweets)
      .where(eq(tweets.status, 'pending'))

    return row?.count ?? 0
  }

  async knownDedupeKeys(keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set()
    const rows = await this.db
      .select({ dedupeKey: tweets.dedupeKey })
      .from(tweets)
      .where(inArray(tweets.dedupeKey, keys))

    return new Set(rows.map((row) => row.dedupeKey))
  }

  /** Backs the "never the same archetype twice in a row" rule. */
  async lastArchetype(): Promise<TweetArchetype | null> {
    const [row] = await this.db
      .select({ archetype: tweets.archetype })
      .from(tweets)
      .where(isNotNull(tweets.archetype))
      .orderBy(desc(tweets.createdAt))
      .limit(1)

    return row?.archetype ?? null
  }

  /** The watchdog's input: when the queue last gained a row. */
  async lastEnqueuedAt(): Promise<Date | null> {
    // max(), not a raw sql expression: sql<T> asserts a type without
    // converting the value, so a hand-written MAX() arrives as a string.
    const [row] = await this.db
      .select({ at: max(tweets.createdAt) })
      .from(tweets)

    return row?.at ?? null
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
}
