import { describe, expect, it } from 'vitest'
import {
  grokDigestListItem,
  hnListResponse,
  projectBlogListResponse,
} from '../sources/agentlens.fixtures.js'
import { rankWithinTier, type Rankable } from './rank.js'

const WEIGHT = 0.7

function titles(items: { item: Rankable }[]): string[] {
  return items.map((ranked) => ranked.item.title)
}

describe('rankWithinTier', () => {
  it('puts the entity-dense digest above the loudest entity-free story', () => {
    const ranked = rankWithinTier(
      [...(hnListResponse.items as Rankable[]), grokDigestListItem],
      WEIGHT,
    )
    expect(titles(ranked)[0]).toContain('Grok 4.6/4.7')
  })

  it('sinks the two non-AI stories despite their HN scores', () => {
    const ranked = rankWithinTier(
      [...(hnListResponse.items as Rankable[]), grokDigestListItem],
      WEIGHT,
    )
    const bottom = titles(ranked).slice(-2).join(' | ')
    expect(bottom).toContain('Holograms')
    expect(bottom).toContain('Tiny JPEGs')
  })

  it('reports the entities it found, for persistence', () => {
    const [top] = rankWithinTier([grokDigestListItem], WEIGHT)
    expect(top!.entities).toContain('DeepSeek')
  })

  it('falls back to pure entity score when nothing in the batch has heat', () => {
    // Every x_digest and lab_article arrives with signal: null.
    const ranked = rankWithinTier(
      [
        { title: 'Pen plotter holography', summary: '', signal: null },
        grokDigestListItem,
      ],
      WEIGHT,
    )
    expect(titles(ranked)[0]).toContain('Grok 4.6/4.7')
  })

  it('does not divide by zero when every item has the same heat', () => {
    const same = [
      { title: 'Claude ships', summary: '', signal: { type: 'hn_points', value: 100 } },
      { title: 'Gemini ships', summary: '', signal: { type: 'hn_points', value: 100 } },
    ]
    const ranked = rankWithinTier(same, WEIGHT)
    expect(ranked.every((r) => Number.isFinite(r.rank))).toBe(true)
  })

  it('ranks an empty batch to an empty result', () => {
    expect(rankWithinTier([], WEIGHT)).toEqual([])
  })

  it('is stable enough that a 1200 stars/day project does not swamp an 803-point story — they are never compared', () => {
    // Guard against a future refactor merging the tiers: this function is
    // only ever handed one tier's items, and normalising per batch is what
    // makes that safe.
    const project = rankWithinTier(
      projectBlogListResponse.items as Rankable[],
      WEIGHT,
    )
    expect(project.every((r) => r.rank >= 0 && r.rank <= 1)).toBe(true)
  })
})
