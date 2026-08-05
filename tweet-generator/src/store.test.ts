import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool } from 'shared/db'
import { GeneratorStore } from './store.js'

const pool = createPool({
  user: 'app_user',
  host: 'localhost',
  database: 'multi_tab_listening',
  password: 'defaultpassword123',
  port: 5432,
})
const store = new GeneratorStore(pool)

async function clean(): Promise<void> {
  await pool.query("DELETE FROM tweets WHERE dedupe_key LIKE 'test:%'")
  await pool.query(
    "DELETE FROM generation_attempts WHERE external_id LIKE 'test:%'",
  )
}

/** Simulates x-poster having posted a row, which this service never does. */
async function markPosted(dedupeKey: string): Promise<void> {
  await pool.query(
    `UPDATE tweets SET status = 'posted', posted_at = NOW()
     WHERE dedupe_key = $1`,
    [dedupeKey],
  )
}

beforeEach(clean)

afterAll(async () => {
  await clean()
  await pool.end()
})

/** Rows the usage query must see have to be inside the day it is given. */
const dayStart = new Date(Date.now() - 60 * 60 * 1000)

describe('enqueue', () => {
  it('returns the new row id', async () => {
    const id = await store.enqueue({
      content: 'hello',
      dedupeKey: 'test:e1',
      source: 'lab_article',
      sourceRef: 'abc',
      archetype: 'digest',
      mediaPath: './media/abc.png',
    })
    expect(id).not.toBeNull()
  })

  it('returns null rather than throwing on a duplicate key', async () => {
    // The UNIQUE constraint is the whole deduplication mechanism for blogs,
    // so losing this race must be ordinary control flow, not an exception.
    await store.enqueue({ content: 'a', dedupeKey: 'test:e2' })
    expect(await store.enqueue({ content: 'b', dedupeKey: 'test:e2' })).toBeNull()
  })

  it('writes a row x-poster can claim', async () => {
    await store.enqueue({ content: 'a', dedupeKey: 'test:e3' })
    const row = await pool.query(
      `SELECT status, attempts, scheduled_at FROM tweets WHERE dedupe_key = 'test:e3'`,
    )
    expect(row.rows[0].status).toBe('pending')
    expect(row.rows[0].attempts).toBe(0)
    expect(row.rows[0].scheduled_at).toBeInstanceOf(Date)
  })
})

describe('usageSince', () => {
  it('counts nothing on an empty day', async () => {
    const usage = await store.usageSince(new Date(Date.now() + 60_000))
    expect(usage.total).toBe(0)
    expect(usage.used.lab_article).toBe(0)
  })

  // usageSince counts the whole day by design, so these assert deltas. An
  // absolute count would pass only while the table happens to hold nothing
  // but test rows, and fail forever after the first real tweet is queued.
  it('counts rows per source and in total', async () => {
    const before = await store.usageSince(dayStart)

    await store.enqueue({
      content: 'a',
      dedupeKey: 'test:u1',
      source: 'lab_article',
    })
    await store.enqueue({
      content: 'b',
      dedupeKey: 'test:u2',
      source: 'lab_article',
    })
    await store.enqueue({
      content: 'c',
      dedupeKey: 'test:u3',
      source: 'hn_story',
    })

    const after = await store.usageSince(dayStart)
    expect(after.used.lab_article - before.used.lab_article).toBe(2)
    expect(after.used.hn_story - before.used.hn_story).toBe(1)
    expect(after.used.gh_project - before.used.gh_project).toBe(0)
    expect(after.total - before.total).toBe(3)
  })

  it('counts every row regardless of status', async () => {
    // Quota is spent when the generator commits to a slot, not when x-poster
    // succeeds. Counting only 'posted' would let a failed tweet be silently
    // replaced, quietly exceeding the daily cap.
    const before = await store.usageSince(dayStart)

    await store.enqueue({
      content: 'a',
      dedupeKey: 'test:u4',
      source: 'lab_article',
    })
    await pool.query(
      `UPDATE tweets SET status = 'failed' WHERE dedupe_key = 'test:u4'`,
    )

    const after = await store.usageSince(dayStart)
    expect(after.used.lab_article - before.used.lab_article).toBe(1)
  })
})

describe('knownDedupeKeys', () => {
  it('returns only the keys that already exist', async () => {
    await store.enqueue({ content: 'a', dedupeKey: 'test:k1' })

    const known = await store.knownDedupeKeys(['test:k1', 'test:k2'])
    expect(known.has('test:k1')).toBe(true)
    expect(known.has('test:k2')).toBe(false)
  })

  it('handles an empty list without issuing a query', async () => {
    expect((await store.knownDedupeKeys([])).size).toBe(0)
  })
})

/**
 * `lastArchetype` and `lastEnqueuedAt` read the whole table by design — the
 * rules they back are about the account's timeline, not about test rows. So
 * neither is asserted against an empty table: that assertion would pass only
 * until the first real row lands and then fail forever. Their cold-start
 * paths are a plain `?? null`; what is worth testing is the ordering.
 */
describe('lastArchetype', () => {
  it('returns the most recently created archetype', async () => {
    await store.enqueue({
      content: 'a',
      dedupeKey: 'test:a1',
      archetype: 'digest',
    })
    await store.enqueue({
      content: 'b',
      dedupeKey: 'test:a2',
      archetype: 'take',
    })

    expect(await store.lastArchetype()).toBe('take')
  })
})

describe('lastEnqueuedAt', () => {
  it('returns a recent timestamp after an enqueue', async () => {
    await store.enqueue({ content: 'a', dedupeKey: 'test:t1' })
    const at = await store.lastEnqueuedAt()
    expect(at).not.toBeNull()
    expect(Date.now() - at!.getTime()).toBeLessThan(60_000)
  })
})

describe('projectPostedSince', () => {
  it('is false when the project has never been posted', async () => {
    expect(await store.projectPostedSince('ghp:a/b', new Date(0))).toBe(false)
  })

  it('is true within the cooldown and false outside it', async () => {
    await store.enqueue({
      content: 'a',
      dedupeKey: 'test:p1',
      source: 'gh_project',
      sourceRef: 'test:ghp:a/b',
    })
    await markPosted('test:p1')

    expect(await store.projectPostedSince('test:ghp:a/b', dayStart)).toBe(true)
    expect(
      await store.projectPostedSince(
        'test:ghp:a/b',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(false)
  })
})

describe('failureCounts and recordFailure', () => {
  it('starts at zero and increments', async () => {
    expect(
      (await store.failureCounts(['test:c1'])).get('test:c1'),
    ).toBeUndefined()

    await store.recordFailure('test:c1', 'validator gave up')
    await store.recordFailure('test:c1', 'validator gave up again')

    expect((await store.failureCounts(['test:c1'])).get('test:c1')).toBe(2)
  })

  it('handles an empty list', async () => {
    expect((await store.failureCounts([])).size).toBe(0)
  })
})

describe('expiredMedia', () => {
  it('returns paths for tweets posted before the cutoff', async () => {
    await store.enqueue({
      content: 'a',
      dedupeKey: 'test:m1',
      mediaPath: './media/old.png',
    })
    await markPosted('test:m1')

    expect(await store.expiredMedia(new Date(Date.now() + 60_000))).toContain(
      './media/old.png',
    )
    expect(await store.expiredMedia(dayStart)).not.toContain('./media/old.png')
  })
})
