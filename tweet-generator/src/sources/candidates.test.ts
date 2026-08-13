import { describe, expect, it } from 'vitest'
import {
  blogToCandidate,
  formatCount,
} from './candidates.js'
import {
  blogDetailResponse,
  digestDetailResponse,
  projectBlogDetailResponse,
  projectDetailResponse,
} from './agentlens.fixtures.js'
import type { BlogDetail, ProjectDetail } from './agentlens.js'

const blog = blogDetailResponse as unknown as BlogDetail
const project = projectDetailResponse as unknown as ProjectDetail

describe('formatCount', () => {
  it('leaves small numbers alone', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
  })

  it('abbreviates thousands to one decimal', () => {
    expect(formatCount(1000)).toBe('1.0k')
    expect(formatCount(18420)).toBe('18.4k')
  })

  it('drops the decimal past 100k, where it is noise', () => {
    expect(formatCount(142000)).toBe('142k')
  })
})

describe('blogToCandidate', () => {
  it('carries the identity and the body across', () => {
    const candidate = blogToCandidate(blog)

    expect(candidate.kind).toBe('lab_article')
    expect(candidate.externalId).toBe('96753d8e-aea0-4977-b677-6ba4098850bc')
    expect(candidate.title).toBe("LFM2.5-2.6B release notes / what's new")
    expect(candidate.body).toContain('2.6B-parameter')
    expect(candidate.freshness).toEqual(new Date('2026-08-04T15:08:19.286Z'))
  })

  it('builds a permanent dedupe key from the blog id', () => {
    expect(blogToCandidate(blog).dedupeKey).toBe(
      'agentlens:blog:96753d8e-aea0-4977-b677-6ba4098850bc',
    )
  })

  it('prefers html_url over url for the source link', () => {
    const withBoth: BlogDetail = {
      ...blog,
      references: [
        {
          type: 'hn_story',
          title: 'x',
          url: 'https://example.test/plain',
          html_url: 'https://example.test/discussion',
        },
      ],
    }
    expect(blogToCandidate(withBoth).sourceUrl).toBe(
      'https://example.test/discussion',
    )
  })

  it('leaves the source link null when there are no references', () => {
    expect(blogToCandidate({ ...blog, references: [] }).sourceUrl).toBeNull()
  })

  it('survives a null references field', () => {
    // x_digest dispatches are synthesised from a search rather than from
    // named sources, so the API sends `references: null` — not `[]`. A real
    // run crashed on `null[0]` here before this case existed.
    const digest = digestDetailResponse as unknown as BlogDetail
    const candidate = blogToCandidate(digest)
    expect(candidate.sourceUrl).toBeNull()
    expect(candidate.kind).toBe('x_digest')
  })
})

describe('blogToCandidate with a hydrated project', () => {
  it('carries the entities it found, for the comparison finder', () => {
    const candidate = blogToCandidate(blogDetailResponse as BlogDetail)
    expect(candidate.entities).toContain('LFM2.5-2.6B')
  })

  it('hydrates a project dispatch with the numbers a blog does not carry', () => {
    const candidate = blogToCandidate(
      projectBlogDetailResponse as BlogDetail,
      projectDetailResponse as ProjectDetail,
    )
    expect(candidate.facts).toContain('18.4k stars')
    expect(candidate.facts).toContain('+443 stars/day')
  })

  it('still produces a candidate when the project has left the leaderboard', () => {
    // /projects 404s for anything no longer relevant+active. That is a
    // dispatch with no metrics, not a dispatch that cannot be posted.
    const candidate = blogToCandidate(
      projectBlogDetailResponse as BlogDetail,
      null,
    )
    expect(candidate.facts).toEqual([])
    expect(candidate.title).toContain('ante')
  })

  it('keys a project dispatch on the dispatch, not on a star bucket', () => {
    // Bucketing existed to let one repo be posted again after it grew. On
    // the blogs stream each dispatch is already a distinct event.
    const candidate = blogToCandidate(
      projectBlogDetailResponse as BlogDetail,
      projectDetailResponse as ProjectDetail,
    )
    expect(candidate.dedupeKey).toBe(
      `agentlens:blog:${projectBlogDetailResponse.id}`,
    )
  })
})
