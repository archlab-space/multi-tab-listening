export const MAX_WEIGHTED_LENGTH = 280

export interface DigestDraft {
  archetype: 'digest'
  hook: string
  highlights: string[]
}

export interface MetricDraft {
  archetype: 'metric'
  metric: string
  line: string
}

export interface ProseDraft {
  archetype: 'take' | 'question'
  text: string
}

export type Draft = DigestDraft | MetricDraft | ProseDraft

/**
 * X's weighted-length ranges. Everything inside them counts 1; everything
 * else counts 2.
 *
 * This matters more than it looks: the `→` separator this project uses is
 * U+2192, outside every range, so each one costs two characters. Three of
 * them plus their spaces is nine of the 280.
 */
const WEIGHT_ONE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
]

export function weightedLength(text: string): number {
  let total = 0
  // Iterating the string yields code points, not code units, so a surrogate
  // pair counts once rather than twice.
  for (const character of text) {
    const point = character.codePointAt(0)!
    const light = WEIGHT_ONE_RANGES.some(
      ([low, high]) => point >= low && point <= high,
    )
    total += light ? 1 : 2
  }
  return total
}

/**
 * Fields in, finished tweet out.
 *
 * The model never returns a finished string. Code assembling and counting is
 * what makes 280 a property of construction rather than something the model
 * is asked to achieve — and models cannot count characters, because
 * tokenisation hides character boundaries from them.
 */
export function assemble(draft: Draft): string {
  switch (draft.archetype) {
    case 'digest': {
      const hook = draft.hook.trim()
      const lines = draft.highlights
        .map((highlight) => `→ ${highlight.trim()}`)
        .join('\n')
      return `${hook}\n\n${lines}`
    }
    case 'metric':
      return `${draft.metric.trim()}\n\n${draft.line.trim()}`
    default:
      return draft.text.trim()
  }
}
