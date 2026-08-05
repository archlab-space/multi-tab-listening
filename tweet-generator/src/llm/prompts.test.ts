import { describe, expect, it } from 'vitest'
import type { Candidate } from '../sources/candidates.js'
import type { Draft } from './assemble.js'
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
    expect(prompt).toContain('at most 90 characters')
    expect(prompt).toContain('at most 55 characters')
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

  it('does not offer a licence or a language as an example highlight', () => {
    // The old wording named both, and the model obliged: "Licensed
    // Apache-2.0, written in Python" as one of three highlights. Naming a
    // shape of filler in a prompt is how you get that filler.
    const prompt = buildGeneratePrompt(candidate, 'digest')
    expect(prompt).not.toMatch(/a licence, a language/i)
  })

  it('keeps popularity out of the subject for every shape but metric', () => {
    // A project candidate arrives with stars, forks and growth in facts[]
    // and the real explanation in the body. Left alone the model writes all
    // three posts off the list, so digest, take and question say the same
    // thing: this repo has a lot of stars.
    for (const archetype of ['digest', 'take', 'question'] as const) {
      expect(buildGeneratePrompt(candidate, archetype)).toMatch(
        /context, never the subject/i,
      )
    }
    // A hard number is the whole point of a metric post.
    expect(buildGeneratePrompt(candidate, 'metric')).not.toMatch(
      /context, never the subject/i,
    )
  })

  it('tells the model the facts list is a spelling whitelist', () => {
    expect(buildGeneratePrompt(candidate, 'digest')).toMatch(
      /not a list of things to write about/i,
    )
  })

  it('asks a question post to name what it is about', () => {
    // "How did GPT-5.6 Sol reuse a GitHub token during the July 28
    // incident?" passes every hard rule and is still unreadable alone.
    expect(buildGeneratePrompt(candidate, 'question')).toMatch(
      /has not seen the source/i,
    )
  })

  it('asks a digest for three different points', () => {
    expect(buildGeneratePrompt(candidate, 'digest')).toMatch(
      /not one point rephrased/i,
    )
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

  it('shows the critic the figures the draft is entitled to quote', () => {
    // Without them the critic sees "+443 stars/day" in a draft, cannot find
    // it in the title or summary, and calls it unsupported — sending a
    // correct draft into a rewrite round it never needed.
    const prompt = buildCritiquePrompt(candidate, 'Growing +443 stars/day.', [])
    expect(prompt).toContain('+443 stars/day')
  })

  it('omits the figures section for a dispatch that has none', () => {
    const factless: Candidate = { ...candidate, facts: [] }
    expect(buildCritiquePrompt(factless, 'A draft.', [])).not.toContain(
      'entitled to quote',
    )
  })
})

describe('buildRewritePrompt', () => {
  const previous: Draft = {
    archetype: 'digest',
    hook: 'One endpoint, 290 providers.',
    highlights: ['18.4k stars', '+443 stars/day', 'MIT'],
  }

  it('lists every issue', () => {
    const prompt = buildRewritePrompt(candidate, 'digest', previous, [
      'too long',
      'no numbers',
    ])
    expect(prompt).toContain('too long')
    expect(prompt).toContain('no numbers')
  })

  it('restates the JSON schema instead of referring back to it', () => {
    // Every chat call is a fresh [system, user] pair, so "the shape you
    // produced before" points at nothing the model can see. Without the
    // schema the model invents one, and the draft parses to empty fields.
    const prompt = buildRewritePrompt(candidate, 'digest', previous, ['x'])
    expect(prompt).toContain('"hook"')
    expect(prompt).toContain('"highlights"')
    expect(prompt).toContain('exactly 3')
  })

  it('hands back the previous attempt as JSON, not as assembled prose', () => {
    const prompt = buildRewritePrompt(candidate, 'digest', previous, ['x'])
    expect(prompt).toContain('"hook": "One endpoint, 290 providers."')
    expect(prompt).toContain('"18.4k stars"')
    // The arrow separator only exists in the assembled tweet.
    expect(prompt).not.toContain('→')
  })

  it('does not show the archetype, which is not a field to fill in', () => {
    const prompt = buildRewritePrompt(candidate, 'digest', previous, ['x'])
    expect(prompt).not.toContain('"archetype"')
  })

  it('carries the source material forward', () => {
    // A rewrite that loses the material has nothing to rewrite against. One
    // real run drifted onto an unrelated project this way.
    const prompt = buildRewritePrompt(candidate, 'digest', previous, ['x'])
    expect(prompt).toContain('One endpoint for 290 providers')
    for (const fact of candidate.facts) expect(prompt).toContain(fact)
  })

  it('keeps the schema aligned with the archetype being rewritten', () => {
    const metric: Draft = {
      archetype: 'metric',
      metric: '290 providers',
      line: 'One endpoint in front of all of them.',
    }
    const prompt = buildRewritePrompt(candidate, 'metric', metric, ['x'])
    expect(prompt).toContain('"metric"')
    expect(prompt).toContain('"line"')
    expect(prompt).not.toContain('"highlights"')
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
