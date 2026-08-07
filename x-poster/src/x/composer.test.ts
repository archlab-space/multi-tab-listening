import { describe, expect, it } from 'vitest'
import { pasteLanded } from './composer.js'

/**
 * What X's composer gives back from `innerText`.
 *
 * Draft.js renders every paragraph as its own block element, so the blank
 * line the source spells as `\n\n` comes back as a single `\n` between two
 * blocks. These fixtures are that transformation, applied to real assembled
 * drafts.
 */
function asRenderedByX(assembled: string): string {
  return assembled.replace(/\n{2,}/g, '\n')
}

describe('pasteLanded', () => {
  it('accepts a single-line draft', () => {
    // take/question assemble to one line, and these are the only posts that
    // have ever made it out of the queue.
    const content =
      "OpenAI builds AI safeguards on developmental science and clinical " +
      "expertise. What's your most effective safety measure for adolescent users?"

    expect(pasteLanded(asRenderedByX(content), content)).toBe(true)
  })

  it('accepts a metric draft, whose first 20 characters straddle the break', () => {
    // The bug in full: `metric` has a 40-character budget and is usually much
    // shorter, so a literal 20-character prefix of the source always contains
    // the `\n\n` that the editor does not reproduce.
    const content = '$1.14 per task\n\nQwen 3.8-Max scores 56 on the Intelligence Index, ten points up on its predecessor and double the price.'

    expect(pasteLanded(asRenderedByX(content), content)).toBe(true)
  })

  it('accepts a digest draft with its arrow list', () => {
    const content =
      'Three things worth knowing about LeRobot this week\n\n' +
      '→ World model policies cost nothing extra at inference\n' +
      '→ Autoregressive video-action models want 24–32 GB of VRAM'

    expect(pasteLanded(asRenderedByX(content), content)).toBe(true)
  })

  it('accepts a digest draft with a short hook', () => {
    // `digest` only breaks when the hook is under 20 characters, which is why
    // it went out sometimes and `metric` never did.
    const content =
      'LeRobot, this week\n\n' +
      '→ World model policies cost nothing extra at inference\n' +
      '→ Autoregressive video-action models want 24–32 GB of VRAM'

    expect(pasteLanded(asRenderedByX(content), content)).toBe(true)
  })

  it('rejects an empty composer', () => {
    // The check exists for this: a blocked paste or a stale editor selector
    // must never reach the submit button.
    expect(pasteLanded('', 'A tweet that never arrived')).toBe(false)
  })

  it('rejects text that is not what we pasted', () => {
    expect(pasteLanded('Someone else draft', 'A tweet that never arrived')).toBe(
      false,
    )
  })

  it('rejects a composer holding only whitespace', () => {
    expect(pasteLanded('   \n  ', 'A tweet that never arrived')).toBe(false)
  })
})
