import { describe, expect, it } from 'vitest'
import { scoreEntities } from './entities.js'

describe('scoreEntities', () => {
  it('scores a vendor name', () => {
    const result = scoreEntities('Anthropic ships a new endpoint')
    expect(result.entities).toContain('Anthropic')
    expect(result.score).toBeGreaterThan(0)
  })

  it('catches a model name that no lexicon could have contained', () => {
    // Released the day this was written. The pattern layer is its only way in.
    const result = scoreEntities("LFM2.5-VL-3B release notes / what's new")
    expect(result.entities).toContain('LFM2.5-VL-3B')
  })

  it('catches versioned model names', () => {
    expect(scoreEntities('Grok 4.6 is out').entities).toContain('Grok 4.6')
    expect(scoreEntities('Qwen 3.8-Max weights').entities).toContain(
      'Qwen 3.8-Max',
    )
  })

  it('scores benchmarks', () => {
    const result = scoreEntities('82.9% on Terminal-Bench 2.1')
    expect(result.entities).toContain('Terminal-Bench')
  })

  it('gives non-AI material a score of zero', () => {
    expect(scoreEntities('Hand-Etched Holograms Created with a Pen Plotter')
      .score).toBe(0)
    expect(scoreEntities('Why Tiny JPEGs Look Different in Chrome').score)
      .toBe(0)
  })

  it('ranks an entity-dense digest far above a hot but entity-free story', () => {
    // The whole point of this module: the Tailscale story scored 803 on HN
    // and the Grok roundup carries no signal at all, yet the roundup is the
    // one this account exists to post.
    const tailscale = scoreEntities(
      'Tailscale SQLite WAL-Reset Bug Investigation and Fix ' +
        'Tailscale traced months of control-plane outages to a 16-year-old ' +
        'SQLite WAL-Reset data-race bug, and deployed a fix in SQLite ' +
        '3.52.0 (later 3.51.3).',
    )
    const grok = scoreEntities(
      'AI & Frontier Tech Roundup - Grok 4.6/4.7, Open-Weight Model Surge ' +
        'Grok 4.6/4.7 is delivering faster, cheaper performance, while a ' +
        'flood of open-weight models (DeepSeek V4 Pro, Qwen 3.8-Max, ' +
        'Nemotron 3.5 Lightning) accelerate the shift to autonomous agents.',
    )
    expect(grok.score).toBeGreaterThan(tailscale.score * 2)
  })

  it('counts each entity once however often it appears', () => {
    const once = scoreEntities('Gemini')
    const thrice = scoreEntities('Gemini and Gemini and gemini')
    expect(thrice.score).toBe(once.score)
    expect(thrice.entities).toHaveLength(1)
  })

  it('is case-insensitive but reports the original spelling', () => {
    expect(scoreEntities('deepseek ships').entities).toEqual(['deepseek'])
  })

  it('has no entities in empty text', () => {
    expect(scoreEntities('')).toEqual({ score: 0, entities: [] })
  })
})
