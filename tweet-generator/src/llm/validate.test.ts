import { describe, expect, it } from 'vitest'
import type { Draft } from './assemble.js'
import { assemble } from './assemble.js'
import {
  DEFAULT_BANNED_PHRASES,
  validate,
  type ValidationInput,
} from './validate.js'

const source =
  'OmniRoute is a free AI gateway. diegosouzapw/OmniRoute. 18.4k stars. ' +
  '+443 stars/day. TypeScript. MIT. It routes across 290 providers and ' +
  '500 models with automatic fallback.'

const cleanDigest: Draft = {
  archetype: 'digest',
  hook: 'OmniRoute puts 290 providers behind one local endpoint.',
  highlights: ['18.4k stars', '+443 stars/day', 'MIT, TypeScript'],
}

function input(overrides: Partial<ValidationInput> = {}): ValidationInput {
  const draft = overrides.draft ?? cleanDigest
  return {
    draft,
    text: overrides.text ?? assemble(draft),
    sourceText: source,
    repeatedRules: new Set<string>(),
    banned: DEFAULT_BANNED_PHRASES,
    ...overrides,
  }
}

describe('validate — the happy path', () => {
  it('accepts a clean draft', () => {
    const result = validate(input())
    expect(result.hard).toEqual([])
    expect(result.ok).toBe(true)
  })
})

describe('validate — length and structure', () => {
  it('rejects a tweet over 280 weighted characters', () => {
    const draft: Draft = { archetype: 'take', text: 'x'.repeat(300) }
    const result = validate(input({ draft }))
    expect(result.ok).toBe(false)
    expect(result.hard.map((v) => v.rule)).toContain('length')
  })

  it('rejects a field over its own budget', () => {
    // The take budget is 240, well inside the 280 total, so this fails the
    // field rule without tripping the length rule.
    const draft: Draft = { archetype: 'take', text: 'x'.repeat(250) }
    const result = validate(input({ draft }))
    expect(result.hard.map((v) => v.rule)).toContain('field-budget')
    expect(result.hard.map((v) => v.rule)).not.toContain('length')
  })

  it('rejects a digest without exactly three highlights', () => {
    const two: Draft = { ...cleanDigest, highlights: ['a', 'b'] }
    expect(validate(input({ draft: two })).hard.map((v) => v.rule)).toContain(
      'structure',
    )

    const four: Draft = { ...cleanDigest, highlights: ['a', 'b', 'c', 'd'] }
    expect(validate(input({ draft: four })).hard.map((v) => v.rule)).toContain(
      'structure',
    )
  })

  it('rejects an empty field', () => {
    const draft: Draft = { ...cleanDigest, hook: '   ' }
    expect(validate(input({ draft })).hard.map((v) => v.rule)).toContain(
      'structure',
    )
  })
})

describe('validate — the number whitelist', () => {
  it('rejects a number that appears nowhere in the source', () => {
    const draft: Draft = {
      archetype: 'take',
      text: 'It cuts latency by 87% on a single GPU.',
    }
    const result = validate(input({ draft }))
    expect(result.ok).toBe(false)
    expect(result.hard.map((v) => v.rule)).toContain('numbers')
    expect(result.hard[0]!.message).toContain('87%')
  })

  it('accepts numbers quoted from the source', () => {
    const draft: Draft = {
      archetype: 'take',
      text: 'One endpoint, 290 providers, 500 models.',
    }
    expect(validate(input({ draft })).ok).toBe(true)
  })

  it('accepts an abbreviated count the facts already formatted', () => {
    const draft: Draft = {
      archetype: 'take',
      text: 'OmniRoute is at 18.4k stars.',
    }
    expect(validate(input({ draft })).ok).toBe(true)
  })

  it('allows small bare numbers, which are prose rather than claims', () => {
    // "one of three", "v2", "GPT-5.6" — rejecting these would be absurd, and
    // the rule exists to catch invented figures, not ordinary counting.
    const draft: Draft = {
      archetype: 'take',
      text: 'The 3 numbers that matter are in the readme.',
    }
    expect(validate(input({ draft })).ok).toBe(true)
  })

  it('still checks a small number carrying a unit', () => {
    const draft: Draft = {
      archetype: 'take',
      text: 'It is 4x faster than the previous release.',
    }
    expect(validate(input({ draft })).hard.map((v) => v.rule)).toContain(
      'numbers',
    )
  })

  it('checks against the whole source, not only the facts list', () => {
    // Scoping this to facts[] would reject model names and version strings —
    // LFM2.5-2.6B, GPT-5.6, v2 — which are quoted, not invented.
    const draft: Draft = {
      archetype: 'take',
      text: 'LFM2.5-2.6B fits on a phone.',
    }
    const result = validate(
      input({
        draft,
        sourceText: 'Liquid AI released LFM2.5-2.6B for on-device agents.',
      }),
    )
    expect(result.ok).toBe(true)
  })
})

describe('validate — banned phrases', () => {
  it('hard-fails a tier-1 phrase', () => {
    const draft: Draft = {
      archetype: 'take',
      text: 'A real paradigm shift for local inference.',
    }
    const result = validate(input({ draft }))
    expect(result.ok).toBe(false)
    expect(result.hard.some((v) => v.rule.startsWith('banned-phrase:'))).toBe(
      true,
    )
  })

  it('exempts a phrase quoted verbatim from the source', () => {
    // A project actually named "Unleash" must not convict the model of
    // saying its name.
    const draft: Draft = {
      archetype: 'take',
      text: 'Unleash ships a new flag evaluator.',
    }
    const result = validate(
      input({
        draft,
        sourceText: 'Unleash is an open-source feature flag service.',
      }),
    )
    expect(result.soft).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('soft-flags a tier-2 word without failing', () => {
    // seamless failover and elevated privileges are standard terms. A regex
    // cannot see which sense is meant; the critic can.
    const draft: Draft = {
      archetype: 'take',
      text: 'Failover is seamless across providers.',
    }
    const result = validate(input({ draft }))
    expect(result.ok).toBe(true)
    expect(result.hard).toEqual([])
    expect(result.soft.map((v) => v.rule)).toContain('banned-phrase:seamless')
  })

  it('is case-insensitive', () => {
    const draft: Draft = { archetype: 'take', text: 'Buckle Up for this one.' }
    expect(validate(input({ draft })).ok).toBe(false)
  })
})

describe('validate — style rules', () => {
  it('rejects a hashtag', () => {
    const draft: Draft = { archetype: 'take', text: 'Local models. #AI' }
    expect(validate(input({ draft })).hard.map((v) => v.rule)).toContain(
      'hashtag',
    )
  })

  it('rejects a URL', () => {
    const draft: Draft = {
      archetype: 'take',
      text: 'See https://example.test for the numbers.',
    }
    expect(validate(input({ draft })).hard.map((v) => v.rule)).toContain('url')
  })

  it('allows one em dash and rejects two', () => {
    const one: Draft = {
      archetype: 'take',
      text: 'It runs locally — that is the whole point.',
    }
    expect(validate(input({ draft: one })).ok).toBe(true)

    const two: Draft = {
      archetype: 'take',
      text: 'It runs locally — on device — with no network.',
    }
    expect(validate(input({ draft: two })).hard.map((v) => v.rule)).toContain(
      'em-dash',
    )
  })

  it('rejects thread bait', () => {
    const leading: Draft = { archetype: 'take', text: '🔥 Local models win.' }
    expect(validate(input({ draft: leading })).hard.map((v) => v.rule)).toContain(
      'thread-bait',
    )

    const numbered: Draft = { archetype: 'take', text: '1/ Local models win.' }
    expect(
      validate(input({ draft: numbered })).hard.map((v) => v.rule),
    ).toContain('thread-bait')

    const needle: Draft = { archetype: 'take', text: 'Local models win 🧵' }
    expect(validate(input({ draft: needle })).hard.map((v) => v.rule)).toContain(
      'thread-bait',
    )
  })
})

describe('validate — the loop guard', () => {
  it('downgrades a stylistic rule that fired last round', () => {
    // A rule the model cannot satisfy is a broken rule, and a tweet
    // containing "buckle up" beats a tweet that never shipped.
    const draft: Draft = { archetype: 'take', text: 'Buckle up, this is fast.' }
    const first = validate(input({ draft }))
    expect(first.ok).toBe(false)

    const rules = new Set(first.hard.map((v) => v.rule))
    const second = validate(input({ draft, repeatedRules: rules }))
    expect(second.ok).toBe(true)
    expect(second.soft.map((v) => v.rule)).toEqual([...rules])
  })

  it('never downgrades the length rule', () => {
    // An over-length tweet does not post at all, so letting it through
    // would trade a skipped post for a guaranteed failure.
    const draft: Draft = { archetype: 'take', text: 'x'.repeat(300) }
    const result = validate(
      input({ draft, repeatedRules: new Set(['length', 'field-budget']) }),
    )
    expect(result.ok).toBe(false)
    expect(result.hard.map((v) => v.rule)).toContain('length')
  })

  it('never downgrades the number whitelist', () => {
    const draft: Draft = {
      archetype: 'take',
      text: 'It cuts latency by 87% on a single GPU.',
    }
    const result = validate(
      input({ draft, repeatedRules: new Set(['numbers']) }),
    )
    expect(result.ok).toBe(false)
    expect(result.hard.map((v) => v.rule)).toContain('numbers')
  })

  it('never downgrades structure', () => {
    const draft: Draft = { ...cleanDigest, highlights: ['a', 'b'] }
    const result = validate(
      input({ draft, repeatedRules: new Set(['structure']) }),
    )
    expect(result.ok).toBe(false)
  })
})
