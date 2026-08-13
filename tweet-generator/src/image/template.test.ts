import { describe, expect, it } from 'vitest'
import { mulberry32 } from 'shared/rng'
import type { Candidate } from '../sources/candidates.js'
import { pickVariant, renderTemplate, VARIANTS, WATERMARK } from './template.js'

const candidate: Candidate = {
  kind: 'gh_project',
  externalId: 'ghp:a/b',
  title: 'a/b',
  summary: 'A gateway.',
  body: 'One endpoint.',
  facts: ['a/b', '18.4k stars', '+443 stars/day', 'MIT'],
  sourceUrl: 'https://github.com/a/b',
  freshness: new Date('2026-08-05T02:00:00.000Z'),
  dedupeKey: 'agentlens:project:ghp:a/b:stars-10k',
  entities: [],
}

describe('pickVariant', () => {
  it('never repeats the previous variant when there is a choice', () => {
    const rng = mulberry32(5)
    for (let i = 0; i < 200; i++) {
      expect(pickVariant('digest', VARIANTS.digest[0]!, rng)).not.toBe(
        VARIANTS.digest[0],
      )
    }
  })

  it('returns the only variant when an archetype has just one', () => {
    // metric ships a single card, so "never twice in a row" cannot apply to
    // it — enforcing it there would make the picker unsatisfiable.
    expect(VARIANTS.metric).toHaveLength(1)
    expect(pickVariant('metric', VARIANTS.metric[0]!)).toBe(VARIANTS.metric[0])
  })

  it('can return either digest variant with no history', () => {
    const rng = mulberry32(4)
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(pickVariant('digest', null, rng))
    expect(seen.size).toBe(2)
  })
})

describe('renderTemplate', () => {
  const html = renderTemplate({
    draft: {
      archetype: 'digest',
      hook: 'One endpoint, 290 providers.',
      highlights: ['18.4k stars', '+443 stars/day', 'MIT'],
    },
    candidate,
    variant: VARIANTS.digest[0]!,
  })

  it('carries the hook and every highlight', () => {
    expect(html).toContain('One endpoint, 290 providers.')
    expect(html).toContain('18.4k stars')
    expect(html).toContain('+443 stars/day')
    expect(html).toContain('MIT')
  })

  it('carries the watermark', () => {
    expect(html).toContain(WATERMARK)
  })

  it('names the source on the card', () => {
    // With no link in the tweet body, the card is the only attribution.
    expect(html).toContain('a/b')
  })

  it('embeds both fonts rather than referencing a family by name', () => {
    expect(html).toContain('@font-face')
    expect(html.match(/data:font\/woff2;base64,/g)).toHaveLength(2)
  })

  it('makes no external request', () => {
    // The renderer runs offline and a missing asset silently changes the
    // layout rather than failing.
    expect(html).not.toMatch(/https?:\/\//)
  })

  it('escapes HTML in model output', () => {
    const escaped = renderTemplate({
      draft: {
        archetype: 'digest',
        hook: '<script>alert(1)</script>',
        highlights: ['a & b', '"quoted"', "it's"],
      },
      candidate,
      variant: VARIANTS.digest[0]!,
    })
    expect(escaped).not.toContain('<script>')
    expect(escaped).toContain('&lt;script&gt;')
    expect(escaped).toContain('a &amp; b')
  })

  it('escapes the candidate title too, not only the model output', () => {
    // The title comes from the API, which is no more trusted than the model.
    const escaped = renderTemplate({
      draft: { archetype: 'metric', metric: 'MIT', line: 'A gateway.' },
      candidate: { ...candidate, title: '<img onerror=alert(1)>' },
      variant: VARIANTS.metric[0]!,
    })
    expect(escaped).not.toContain('<img')
    expect(escaped).toContain('&lt;img')
  })

  it('refuses to render an archetype that has no card', () => {
    expect(() =>
      renderTemplate({
        draft: { archetype: 'take', text: 'no card for this one' },
        candidate,
        variant: VARIANTS.digest[0]!,
      }),
    ).toThrow(/do not have a card/)
  })

  it('renders a metric card from a metric draft', () => {
    const metric = renderTemplate({
      draft: {
        archetype: 'metric',
        metric: '+443 stars/day',
        line: 'A gateway.',
      },
      candidate,
      variant: VARIANTS.metric[0]!,
    })
    expect(metric).toContain('+443 stars/day')
    expect(metric).toContain('A gateway.')
  })

  it('produces a stable string for the same input', () => {
    // Snapshot stability is what makes this testable at all — comparing
    // screenshots would be brittle for no benefit.
    const again = renderTemplate({
      draft: {
        archetype: 'digest',
        hook: 'One endpoint, 290 providers.',
        highlights: ['18.4k stars', '+443 stars/day', 'MIT'],
      },
      candidate,
      variant: VARIANTS.digest[0]!,
    })
    expect(again).toBe(html)
  })
})
