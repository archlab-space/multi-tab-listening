import { describe, expect, it } from 'vitest'
import { assemble, MAX_WEIGHTED_LENGTH, weightedLength } from './assemble.js'

describe('weightedLength', () => {
  it('counts plain ASCII as one each', () => {
    expect(weightedLength('hello')).toBe(5)
  })

  it('counts an emoji as two', () => {
    // X's weighted-length config gives everything outside a few Latin and
    // punctuation ranges a weight of 2.
    expect(weightedLength('🚀')).toBe(2)
  })

  it('counts an em dash as one', () => {
    // U+2014 sits inside the 8208–8223 range, which X weights at 1.
    expect(weightedLength('—')).toBe(1)
  })

  it('counts an arrow as two', () => {
    // U+2192 is outside every weight-1 range, so the separator this project
    // uses costs two characters each. Three of them is six of the budget.
    expect(weightedLength('→')).toBe(2)
  })

  it('counts a newline as one', () => {
    expect(weightedLength('a\nb')).toBe(3)
  })

  it('does not split a surrogate pair into two code units', () => {
    expect(weightedLength('👍')).toBe(2)
  })
})

describe('assemble', () => {
  it('renders a digest as a hook and three arrows', () => {
    const text = assemble({
      archetype: 'digest',
      hook: 'vLLM ships speculative decoding v2.',
      highlights: ['2.1x throughput', '18.4k stars', 'Apache-2.0'],
    })

    expect(text).toBe(
      'vLLM ships speculative decoding v2.\n\n' +
        '→ 2.1x throughput\n→ 18.4k stars\n→ Apache-2.0',
    )
  })

  it('renders a metric as a number line then a body', () => {
    const text = assemble({
      archetype: 'metric',
      metric: '+443 stars/day',
      line: 'OmniRoute puts 290 providers behind one local endpoint.',
    })

    expect(text).toBe(
      '+443 stars/day\n\nOmniRoute puts 290 providers behind one local endpoint.',
    )
  })

  it('renders take and question as bare prose', () => {
    expect(assemble({ archetype: 'take', text: 'It fits on a phone.' })).toBe(
      'It fits on a phone.',
    )
    expect(
      assemble({ archetype: 'question', text: 'What is your eval harness?' }),
    ).toBe('What is your eval harness?')
  })

  it('trims stray whitespace from every field', () => {
    // Models pad fields with newlines. Trimming here rather than asking the
    // prompt to stop is one fewer thing that can fail the length check for
    // no reason.
    expect(
      assemble({
        archetype: 'digest',
        hook: '  Hook.  ',
        highlights: [' a ', 'b\n', '\tc'],
      }),
    ).toBe('Hook.\n\n→ a\n→ b\n→ c')
  })

  it('stays inside the limit at every field budget', () => {
    // 90 + 2 + 3 * (3 + 55) + 2 = 268.
    const text = assemble({
      archetype: 'digest',
      hook: 'x'.repeat(90),
      highlights: ['y'.repeat(55), 'y'.repeat(55), 'y'.repeat(55)],
    })
    expect(weightedLength(text)).toBeLessThanOrEqual(MAX_WEIGHTED_LENGTH)
    expect(weightedLength(text)).toBe(268)
  })

  it('leaves the metric budget inside the limit too', () => {
    const text = assemble({
      archetype: 'metric',
      metric: 'x'.repeat(40),
      line: 'y'.repeat(200),
    })
    expect(weightedLength(text)).toBeLessThanOrEqual(MAX_WEIGHTED_LENGTH)
  })
})
