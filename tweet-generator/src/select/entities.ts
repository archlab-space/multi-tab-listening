/**
 * How much of a title is made of things a reader already searches for.
 *
 * The account's problem was never that its posts were wrong — it was that
 * nobody had heard of what they were about. A dispatch naming Grok and
 * DeepSeek reaches people who are already looking; one naming OlmoEarth
 * reaches nobody, however sound the finding.
 *
 * Three layers, because one is not enough on its own. The lexicon knows the
 * incumbents. The pattern layer catches models released after this file was
 * last edited — `LFM2.5-VL-3B` cannot be in any lexicon on the day it ships,
 * and that day is exactly when it is worth posting about. Benchmarks are
 * separate because they are what makes two models comparable.
 *
 * There is deliberately no penalty list. Material about pen plotters scores
 * zero and sinks on its own; enumerating everything that is not AI is a list
 * with no end.
 */

const VENDOR_WEIGHT = 3
const MODEL_WEIGHT = 2
const BENCHMARK_WEIGHT = 2

/** Labs, products, and the tools this audience already uses daily. */
const VENDORS = [
  'OpenAI', 'Anthropic', 'Claude', 'ChatGPT', 'GPT', 'Codex', 'Sora',
  'Whisper', 'Google DeepMind', 'DeepMind', 'Gemini', 'Gemma',
  'DeepSeek', 'Qwen', 'Alibaba', 'Llama', 'Mistral', 'Grok', 'xAI',
  'Nvidia', 'Nemotron', 'Cohere', 'Perplexity', 'Cursor', 'Copilot',
  'Hugging Face', 'HuggingFace', 'Groq', 'Fireworks', 'Replicate',
  'Stability AI', 'Midjourney', 'Kimi', 'MiniMax', 'Liquid AI', 'LFM',
  'Phi', 'GLM', 'vLLM', 'Ollama', 'LangChain', 'LlamaIndex', 'MCP',
]

/** What makes two models comparable, and therefore what a versus post needs. */
const BENCHMARKS = [
  'SWE-bench', 'Terminal-Bench', 'MMLU', 'MMMU', 'HumanEval', 'ARC-AGI',
  'GPQA', 'AIME', 'LiveCodeBench', 'HellaSwag', 'BIG-bench',
]

/**
 * A capitalised name with a version: `Grok 4.6`, `Qwen 3.8-Max`,
 * `LFM2.5-VL-3B`, `LFM2.5-2.6B`.
 *
 * Two branches, because a separated version and a glued one accept
 * different shapes. `Grok 4.6` is name, separator, number. `LFM2.5-VL-3B`
 * has the number welded to the name and must carry a second digit
 * somewhere in its tail — that requirement is exactly what keeps
 * `ComfyUI-H3-Motion-Context` out: it starts like a glued version and never
 * shows a digit again, so no lexicon will ever need to name it.
 */
const MODEL_PATTERN =
  /\b(?:[A-Z][A-Za-z]*[ -]\d+(?:[.-][A-Za-z0-9]+)*|[A-Z][A-Za-z]*\d+(?=[.-][^\s]*\d)[.-][A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)\b/g

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function lexiconPattern(terms: string[]): RegExp {
  const alternation = terms
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')
  return new RegExp(`(?<![\\w-])(?:${alternation})(?![\\w-])`, 'gi')
}

const VENDOR_PATTERN = lexiconPattern(VENDORS)
const BENCHMARK_PATTERN = lexiconPattern(BENCHMARKS)

export interface EntityScore {
  /** Weighted count of distinct entities. Zero means nothing recognisable. */
  score: number
  /**
   * Distinct entities in first-seen spelling. Persisted on the tweet row:
   * finding a comparison partner later means asking what we have already
   * written about, and that question needs the names, not the score.
   */
  entities: string[]
}

export function scoreEntities(text: string): EntityScore {
  const seen = new Map<string, string>()
  let score = 0

  const collect = (pattern: RegExp, weight: number): void => {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0]
      const key = raw.toLowerCase()
      if (seen.has(key)) continue
      seen.set(key, raw)
      score += weight
    }
  }

  collect(VENDOR_PATTERN, VENDOR_WEIGHT)
  collect(BENCHMARK_PATTERN, BENCHMARK_WEIGHT)
  collect(MODEL_PATTERN, MODEL_WEIGHT)

  return { score, entities: [...seen.values()] }
}
