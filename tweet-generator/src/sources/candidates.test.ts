import { describe, expect, it } from 'vitest'
import {
  blogToCandidate,
  formatCount,
  projectToCandidate,
} from './candidates.js'
import {
  blogDetailResponse,
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
})

describe('projectToCandidate', () => {
  it('formats every hard metric as a quotable string', () => {
    const candidate = projectToCandidate(project)

    expect(candidate.facts).toContain('18.4k stars')
    expect(candidate.facts).toContain('+443 stars/day')
    expect(candidate.facts).toContain('TypeScript')
    expect(candidate.facts).toContain('MIT')
    expect(candidate.facts).toContain('diegosouzapw/OmniRoute')
  })

  it('keys on the star bucket, not on the project alone', () => {
    // A project sits on the leaderboard for weeks. A permanent key would
    // allow one post per repo, ever.
    expect(projectToCandidate(project).dedupeKey).toBe(
      'agentlens:project:ghp:diegosouzapw/OmniRoute:stars-10k',
    )
  })

  it('uses the explainer as the body and the repo as the source link', () => {
    const candidate = projectToCandidate(project)
    expect(candidate.body).toContain('290 providers')
    expect(candidate.sourceUrl).toBe('https://github.com/diegosouzapw/OmniRoute')
  })

  it('omits a missing language and licence rather than emitting "null"', () => {
    const bare: ProjectDetail = { ...project, language: null, license: null }
    const facts = projectToCandidate(bare).facts
    expect(facts.some((f) => f.includes('null'))).toBe(false)
  })
})
