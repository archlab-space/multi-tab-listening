import { describe, expect, it } from 'vitest'
import type { Candidate } from '../sources/candidates.js'
import {
  buildCritiquePrompt,
  buildGeneratePrompt,
  buildRewritePrompt,
  sourceTextOf,
  SYSTEM_PROMPT,
} from './prompts.js'

const candidate: Candidate = {
  kind: 'gh_project',
  externalId: 'ghp:a/b',
  title: 'a/b',
  summary: 'A gateway.',
  body: '## What it is\n\nOne endpoint for 290 providers.',
  facts: ['a/b', '18.4k stars', '+443 stars/day', 'TypeScript', 'MIT'],
  sourceUrl: 'https://github.com/a/b',
  freshness: new Date('2026-08-05T02:00:00.000Z'),
  dedupeKey: 'agentlens:project:ghp:a/b:stars-10k',
}

describe('SYSTEM_PROMPT', () => {
  it('names the audience as peers, not recruiters', () => {
    expect(SYSTEM_PROMPT).toMatch(/peers/i)
  })

  it('does not itself contain the clichés it bans', () => {
    // A prompt that says "avoid 'delve into'" puts the phrase in context and
    // makes it more likely, not less. The ban is enforced by the validator.
    expect(SYSTEM_PROMPT).not.toMatch(/delve into/i)
    expect(SYSTEM_PROMPT).not.toMatch(/paradigm shift/i)
    expect(SYSTEM_PROMPT).not.toMatch(/game.?changer/i)
  })
})

describe('buildGeneratePrompt', () => {
  it('states the exact JSON fields for the archetype', () => {
    const prompt = buildGeneratePrompt(candidate, 'digest')
    expect(prompt).toContain('"hook"')
    expect(prompt).toContain('"highlights"')
    expect(prompt).toContain('exactly 3')
  })

  it('states the per-field budgets', () => {
    const prompt = buildGeneratePrompt(candidate, 'digest')
    expect(prompt).toContain('90')
    expect(prompt).toContain('55')
  })

  it('asks for different fields for a metric post', () => {
    const prompt = buildGeneratePrompt(candidate, 'metric')
    expect(prompt).toContain('"metric"')
    expect(prompt).toContain('"line"')
    expect(prompt).not.toContain('"highlights"')
  })

  it('lists every fact verbatim', () => {
    const prompt = buildGeneratePrompt(candidate, 'digest')
    for (const fact of candidate.facts) expect(prompt).toContain(fact)
  })

  it('includes the source material', () => {
    const prompt = buildGeneratePrompt(candidate, 'take')
    expect(prompt).toContain('One endpoint for 290 providers')
  })

  it('tells a factless dispatch to take figures from the body', () => {
    // Blog dispatches carry no structured metrics, so an empty list must not
    // read as "there are no numbers you may use".
    const factless: Candidate = { ...candidate, facts: [] }
    expect(buildGeneratePrompt(factless, 'digest')).toMatch(
      /material below/i,
    )
  })

  it('truncates a very long body', () => {
    // Whole dispatch bodies run to thousands of words. Sending all of it
    // costs latency and buys nothing: the first section carries the news.
    const long: Candidate = { ...candidate, body: 'x'.repeat(20_000) }
    expect(buildGeneratePrompt(long, 'take').length).toBeLessThan(8000)
  })
})

describe('buildCritiquePrompt', () => {
  it('carries the draft and asks for a verdict', () => {
    const prompt = buildCritiquePrompt(candidate, 'The draft text.', [])
    expect(prompt).toContain('The draft text.')
    expect(prompt).toContain('"verdict"')
    expect(prompt).toContain('"issues"')
  })

  it('turns each soft flag into a pointed question', () => {
    const prompt = buildCritiquePrompt(candidate, 'Failover is seamless.', [
      {
        rule: 'banned-phrase:seamless',
        message: 'The draft uses "seamless". Is it doing real semantic work?',
      },
    ])
    expect(prompt).toContain('seamless')
    expect(prompt).toContain('real semantic work')
  })
})

describe('buildRewritePrompt', () => {
  it('lists every issue', () => {
    const prompt = buildRewritePrompt('The draft.', ['too long', 'no numbers'])
    expect(prompt).toContain('too long')
    expect(prompt).toContain('no numbers')
    expect(prompt).toContain('The draft.')
  })
})

describe('sourceTextOf', () => {
  it('joins everything the number whitelist checks against', () => {
    const text = sourceTextOf(candidate)
    expect(text).toContain('a/b')
    expect(text).toContain('A gateway.')
    expect(text).toContain('290 providers')
    expect(text).toContain('18.4k stars')
  })
})
