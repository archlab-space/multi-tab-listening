import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config.js'
import { selectCandidate, type PoolDeps } from './pool.js'
import type {
  BlogDetail,
  BlogListItem,
} from '../sources/agentlens.js'

const config = loadConfig({
  LLM_MODEL: 'pinned',
  TIMEZONE: 'Asia/Shanghai',
} as NodeJS.ProcessEnv)

/** 14:00 Shanghai. */
const now = new Date('2026-08-05T06:00:00.000Z')

function blogItem(overrides: Partial<BlogListItem> = {}): BlogListItem {
  return {
    id: 'b1',
    title: 'A new inference engine',
    summary: 'It is faster.',
    job_type: 'lab_article',
    source_id: 'lab:openai',
    occurred_at: null,
    generated_at: '2026-08-05T05:00:00.000Z',
    signal: null,
    ...overrides,
  }
}

function blogDetail(item: BlogListItem): BlogDetail {
  return { ...item, body_markdown: '## Body\n\nText.', references: [] }
}

function deps(overrides: Partial<PoolDeps> = {}): PoolDeps {
  return {
    listBlogs: vi.fn().mockResolvedValue([blogItem()]),
    getBlog: vi.fn(async (id: string) => blogDetail(blogItem({ id }))),
    getProject: vi.fn().mockResolvedValue(null),
    knownDedupeKeys: vi.fn().mockResolvedValue(new Set<string>()),
    failureCounts: vi.fn().mockResolvedValue(new Map<string, number>()),
    ...overrides,
  }
}

describe('selectCandidate', () => {
  it('ranks the more searchable item above a vague one', async () => {
    // Newest-first is gone: within a tier the pool orders by entity
    // salience and heat, so the fresher but unsearchable item no longer
    // wins.
    const vague = blogItem({
      id: 'vague',
      title: 'Why Tiny JPEGs Look Different in Chrome',
      generated_at: '2026-08-05T05:00:00.000Z',
    })
    const dense = blogItem({
      id: 'dense',
      title: 'Anthropic ships a new Claude endpoint',
      generated_at: '2026-08-05T01:00:00.000Z',
    })

    const candidate = await selectCandidate(
      'labs',
      now,
      config,
      deps({ listBlogs: vi.fn().mockResolvedValue([vague, dense]) }),
    )

    expect(candidate!.externalId).toBe('dense')
  })

  it('skips items already in the queue, promoting the runner-up', async () => {
    // This is what makes "an item that lost an earlier cycle resurfaces
    // later" work with no extra machinery.
    const older = blogItem({
      id: 'old',
      generated_at: '2026-08-05T01:00:00.000Z',
    })
    const newer = blogItem({
      id: 'new',
      generated_at: '2026-08-05T05:00:00.000Z',
    })

    const candidate = await selectCandidate(
      'labs',
      now,
      config,
      deps({
        listBlogs: vi.fn().mockResolvedValue([older, newer]),
        knownDedupeKeys: vi
          .fn()
          .mockResolvedValue(new Set(['agentlens:blog:new'])),
      }),
    )

    expect(candidate!.externalId).toBe('old')
  })

  it('skips items outside the freshness window', async () => {
    const stale = blogItem({ generated_at: '2026-07-01T00:00:00.000Z' })
    const candidate = await selectCandidate(
      'labs',
      now,
      config,
      deps({ listBlogs: vi.fn().mockResolvedValue([stale]) }),
    )
    expect(candidate).toBeNull()
  })

  it('skips items the niche gate rejects', async () => {
    const crypto = blogItem({ title: 'AI × Crypto Roundup: agent payments' })
    const candidate = await selectCandidate(
      'labs',
      now,
      config,
      deps({ listBlogs: vi.fn().mockResolvedValue([crypto]) }),
    )
    expect(candidate).toBeNull()
  })

  it('skips a candidate that has failed three times', async () => {
    const candidate = await selectCandidate(
      'labs',
      now,
      config,
      deps({
        failureCounts: vi.fn().mockResolvedValue(new Map([['b1', 3]])),
      }),
    )
    expect(candidate).toBeNull()
  })

  it('keeps a candidate that has failed twice', async () => {
    const candidate = await selectCandidate(
      'labs',
      now,
      config,
      deps({
        failureCounts: vi.fn().mockResolvedValue(new Map([['b1', 2]])),
      }),
    )
    expect(candidate).not.toBeNull()
  })

  it('fetches the body only for the item it selects', async () => {
    // Bodies are one request each. Fetching the whole pool to pick one would
    // multiply the request count by the pool size for no benefit.
    const getBlog = vi.fn(async (id: string) => blogDetail(blogItem({ id })))
    await selectCandidate(
      'labs',
      now,
      config,
      deps({
        listBlogs: vi
          .fn()
          .mockResolvedValue([blogItem({ id: 'a' }), blogItem({ id: 'b' })]),
        getBlog,
      }),
    )
    expect(getBlog).toHaveBeenCalledTimes(1)
  })
})

describe('selectCandidate for x_digest', () => {
  const digestAt = (
    id: string,
    title: string,
    generated: string,
  ): BlogListItem =>
    blogItem({ id, title, job_type: 'x_digest', generated_at: generated })

  it("takes today's non-crypto digest", async () => {
    const candidate = await selectCandidate(
      'hot',
      now,
      config,
      deps({
        listBlogs: vi
          .fn()
          .mockResolvedValue([
            digestAt(
              'd1',
              'AI & Frontier Tech Roundup',
              '2026-08-05T01:05:46.079Z',
            ),
            digestAt('d2', 'AI × Crypto Roundup', '2026-08-05T01:05:15.606Z'),
          ]),
      }),
    )
    expect(candidate!.externalId).toBe('d1')
  })

  it("ignores yesterday's digest entirely", async () => {
    // A digest is worthless the next morning. Nothing anchors the window to
    // 09:00 to achieve that: the day's digests land at 09:05, so yesterday's
    // is already out of the 24h window whenever the digest is offered at all.
    const candidate = await selectCandidate(
      'hot',
      now,
      config,
      deps({
        listBlogs: vi
          .fn()
          .mockResolvedValue([
            digestAt(
              'd0',
              'AI & Frontier Tech Roundup',
              '2026-08-04T01:05:00.000Z',
            ),
          ]),
      }),
    )
    expect(candidate).toBeNull()
  })
})

import { projectBlogListResponse } from '../sources/agentlens.fixtures.js'

describe('selectCandidate for the project tier', () => {
  const projectDeps = deps({
    listBlogs: vi
      .fn()
      .mockResolvedValue(projectBlogListResponse.items as BlogListItem[]),
    getBlog: vi.fn(async (id: string) =>
      blogDetail(
        projectBlogListResponse.items.find(
          (item) => item.id === id,
        ) as BlogListItem,
      ),
    ),
  })

  /** 2026-08-13 10:00 Shanghai — inside the gh_project window for all four. */
  const then = new Date('2026-08-13T02:00:00.000Z')

  it('rejects the projects nobody is starring', async () => {
    // stars_per_day of 1, 2 and 13 are all below the floor of 20. Losing
    // this check is how the blogs stream becomes worse than what it replaced.
    const candidate = await selectCandidate('project', then, config, projectDeps)
    expect(candidate!.title).toContain('ante') // the 202 stars/day one
  })

  it('finds nothing when every project is below the floor', async () => {
    const strict = loadConfig({
      LLM_MODEL: 'pinned',
      TIMEZONE: 'Asia/Shanghai',
      PROJECT_MIN_VELOCITY_PER_DAY: '500',
    } as NodeJS.ProcessEnv)
    expect(
      await selectCandidate('project', then, strict, projectDeps),
    ).toBeNull()
  })
})
