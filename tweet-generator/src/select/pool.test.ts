import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config.js'
import { selectCandidate, type PoolDeps } from './pool.js'
import type {
  BlogDetail,
  BlogListItem,
  ProjectDetail,
  ProjectListItem,
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
    listProjects: vi.fn().mockResolvedValue([] as ProjectListItem[]),
    getProject: vi.fn() as unknown as (id: string) => Promise<ProjectDetail>,
    knownDedupeKeys: vi.fn().mockResolvedValue(new Set<string>()),
    failureCounts: vi.fn().mockResolvedValue(new Map<string, number>()),
    projectPostedSince: vi.fn().mockResolvedValue(false),
    ...overrides,
  }
}

describe('selectCandidate', () => {
  it('returns the freshest eligible blog', async () => {
    const older = blogItem({
      id: 'old',
      generated_at: '2026-08-05T01:00:00.000Z',
    })
    const newer = blogItem({
      id: 'new',
      generated_at: '2026-08-05T05:00:00.000Z',
    })

    const candidate = await selectCandidate(
      'lab_article',
      now,
      config,
      deps({ listBlogs: vi.fn().mockResolvedValue([older, newer]) }),
    )

    expect(candidate!.externalId).toBe('new')
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
      'lab_article',
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
      'lab_article',
      now,
      config,
      deps({ listBlogs: vi.fn().mockResolvedValue([stale]) }),
    )
    expect(candidate).toBeNull()
  })

  it('skips items the niche gate rejects', async () => {
    const crypto = blogItem({ title: 'AI × Crypto Roundup: agent payments' })
    const candidate = await selectCandidate(
      'lab_article',
      now,
      config,
      deps({ listBlogs: vi.fn().mockResolvedValue([crypto]) }),
    )
    expect(candidate).toBeNull()
  })

  it('skips a candidate that has failed three times', async () => {
    const candidate = await selectCandidate(
      'lab_article',
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
      'lab_article',
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
      'lab_article',
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
      'x_digest',
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
      'x_digest',
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

describe('selectCandidate for gh_project', () => {
  function project(overrides: Partial<ProjectListItem> = {}): ProjectListItem {
    return {
      id: 'ghp:a/b',
      full_name: 'a/b',
      description: 'A thing',
      summary: 'A thing that does things.',
      language: 'Rust',
      topics: [],
      tags: [],
      license: 'MIT',
      stars: 12_000,
      forks: 400,
      star_velocity_7d: 700,
      star_velocity_per_day: 100,
      momentum_score: 700,
      pushed_at: '2026-08-05T02:00:00.000Z',
      ...overrides,
    }
  }

  const detail = (item: ProjectListItem): ProjectDetail => ({
    ...item,
    explainer_md: '## What it is\n\nA thing.',
    html_url: `https://github.com/${item.full_name}`,
  })

  it('rejects a project below the momentum floor', async () => {
    const candidate = await selectCandidate(
      'gh_project',
      now,
      config,
      deps({
        listProjects: vi
          .fn()
          .mockResolvedValue([project({ star_velocity_per_day: 3 })]),
        getProject: vi.fn(async () => detail(project())),
      }),
    )
    expect(candidate).toBeNull()
  })

  it('rejects a project inside its cooldown', async () => {
    const candidate = await selectCandidate(
      'gh_project',
      now,
      config,
      deps({
        listProjects: vi.fn().mockResolvedValue([project()]),
        getProject: vi.fn(async () => detail(project())),
        projectPostedSince: vi.fn().mockResolvedValue(true),
      }),
    )
    expect(candidate).toBeNull()
  })

  it('accepts a project that clears both gates', async () => {
    const candidate = await selectCandidate(
      'gh_project',
      now,
      config,
      deps({
        listProjects: vi.fn().mockResolvedValue([project()]),
        getProject: vi.fn(async () => detail(project())),
      }),
    )
    expect(candidate!.dedupeKey).toBe('agentlens:project:ghp:a/b:stars-10k')
  })
})
