import type { Pool } from 'pg'
import type { TweetArchetype } from 'shared'
import { SOURCE_PRIORITY, type SourceKind } from './config.js'
import type { QuotaUsage } from './select/quota.js'

function emptyUsage(): QuotaUsage['used'] {
  return {
    lab_article: 0,
    gh_project: 0,
    x_digest: 0,
    hn_story: 0,
    youtube_video: 0,
  }
}

export interface EnqueueInput {
  content: string
  dedupeKey: string
  source?: SourceKind
  sourceRef?: string
  archetype?: TweetArchetype
  mediaPath?: string
}

/**
 * Every statement this service issues. Collected here so the columns the
 * generator depends on are visible at a glance rather than scattered across
 * the modules that happen to need them.
 */
export class GeneratorStore {
  constructor(private readonly pool: Pool) {}

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
    const result = await this.pool.query<{ id: number }>(
      `INSERT INTO tweets
         (content, dedupe_key, source, source_ref, archetype, media_path)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [
        input.content,
        input.dedupeKey,
        input.source ?? null,
        input.sourceRef ?? null,
        input.archetype ?? null,
        input.mediaPath ?? null,
      ],
    )
    return result.rows[0]?.id ?? null
  }

  /**
   * Counts every row created since `dayStart`, whatever its status.
   *
   * Quota is spent when the generator commits to a slot, not when x-poster
   * succeeds: counting only 'posted' would let a failed tweet be silently
   * replaced, quietly exceeding the daily cap.
   */
  async usageSince(dayStart: Date): Promise<QuotaUsage> {
    const result = await this.pool.query<{ source: string; count: string }>(
      `SELECT source, COUNT(*) AS count
       FROM tweets
       WHERE created_at >= $1 AND source IS NOT NULL
       GROUP BY source`,
      [dayStart],
    )

    const used = emptyUsage()
    let total = 0
    for (const row of result.rows) {
      const count = Number(row.count)
      total += count
      if ((SOURCE_PRIORITY as readonly string[]).includes(row.source)) {
        used[row.source as SourceKind] = count
      }
    }
    return { used, total }
  }

  async knownDedupeKeys(keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set()
    const result = await this.pool.query<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM tweets WHERE dedupe_key = ANY($1)`,
      [keys],
    )
    return new Set(result.rows.map((row) => row.dedupe_key))
  }

  /** Backs the "never the same archetype twice in a row" rule. */
  async lastArchetype(): Promise<TweetArchetype | null> {
    const result = await this.pool.query<{ archetype: TweetArchetype | null }>(
      `SELECT archetype FROM tweets
       WHERE archetype IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    return result.rows[0]?.archetype ?? null
  }

  /** The watchdog's input: when the queue last gained a row. */
  async lastEnqueuedAt(): Promise<Date | null> {
    const result = await this.pool.query<{ at: Date | null }>(
      `SELECT MAX(created_at) AS at FROM tweets`,
    )
    return result.rows[0]?.at ?? null
  }

  async projectPostedSince(sourceRef: string, since: Date): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM tweets
         WHERE source_ref = $1 AND posted_at IS NOT NULL AND posted_at >= $2
       ) AS exists`,
      [sourceRef, since],
    )
    return result.rows[0]?.exists ?? false
  }

  async failureCounts(externalIds: string[]): Promise<Map<string, number>> {
    if (externalIds.length === 0) return new Map()
    const result = await this.pool.query<{
      external_id: string
      attempts: number
    }>(
      `SELECT external_id, attempts FROM generation_attempts
       WHERE external_id = ANY($1)`,
      [externalIds],
    )
    return new Map(result.rows.map((row) => [row.external_id, row.attempts]))
  }

  async recordFailure(externalId: string, error: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO generation_attempts (external_id, attempts, last_error)
       VALUES ($1, 1, $2)
       ON CONFLICT (external_id) DO UPDATE
         SET attempts = generation_attempts.attempts + 1,
             last_error = EXCLUDED.last_error,
             updated_at = NOW()`,
      [externalId, error],
    )
  }

  async expiredMedia(before: Date): Promise<string[]> {
    const result = await this.pool.query<{ media_path: string }>(
      `SELECT media_path FROM tweets
       WHERE media_path IS NOT NULL
         AND posted_at IS NOT NULL
         AND posted_at < $1`,
      [before],
    )
    return result.rows.map((row) => row.media_path)
  }
}
