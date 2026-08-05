import type { TweetArchetype } from 'shared'
import type { Candidate } from '../sources/candidates.js'
import { assemble, type Draft } from './assemble.js'
import { extractJson, LlmError, type ChatMessage } from './client.js'
import {
  buildCritiquePrompt,
  buildGeneratePrompt,
  buildRewritePrompt,
  sourceTextOf,
  SYSTEM_PROMPT,
  type Critique,
} from './prompts.js'
import { validate, type BannedPhrases, type Violation } from './validate.js'

export interface PipelineDeps {
  chat(messages: ChatMessage[]): Promise<string>
  banned: BannedPhrases
  maxRounds: number
}

export interface PipelineResult {
  text: string
  draft: Draft
  rounds: number
}

/** Every round used up without a draft that passed. The cycle skips. */
export class GenerationGaveUp extends Error {
  constructor(
    message: string,
    readonly violations: string[],
  ) {
    super(message)
    this.name = 'GenerationGaveUp'
  }
}

/** The model returns loose fields; this pins them to the archetype's shape. */
function toDraft(
  archetype: TweetArchetype,
  parsed: Record<string, unknown>,
): Draft {
  switch (archetype) {
    case 'digest':
      return {
        archetype,
        hook: String(parsed.hook ?? ''),
        highlights: Array.isArray(parsed.highlights)
          ? parsed.highlights.map(String)
          : [],
      }
    case 'metric':
      return {
        archetype,
        metric: String(parsed.metric ?? ''),
        line: String(parsed.line ?? ''),
      }
    default:
      return { archetype, text: String(parsed.text ?? '') }
  }
}

/**
 * A critic that replies with something unparseable is treated as a pass.
 *
 * The draft has already cleared the deterministic gate, so it is
 * publishable. Discarding it because the critic answered badly trades a good
 * post for nothing at all.
 */
async function runCritique(
  candidate: Candidate,
  text: string,
  soft: Violation[],
  deps: PipelineDeps,
  system: ChatMessage,
): Promise<Critique> {
  try {
    const reply = await deps.chat([
      system,
      { role: 'user', content: buildCritiquePrompt(candidate, text, soft) },
    ])
    const parsed = extractJson<Partial<Critique>>(reply)
    return {
      verdict: parsed.verdict === 'revise' ? 'revise' : 'pass',
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
    }
  } catch (error) {
    if (!(error instanceof LlmError)) throw error
    return { verdict: 'pass', issues: [] }
  }
}

/**
 * Generate → validate → critique → rewrite.
 *
 * Validation runs before the critique because it is free: a critique call
 * should never be spent on a draft that is already mechanically broken.
 *
 * Rules that fired on the previous round are carried forward so the
 * validator's loop guard can downgrade a stylistic rule the model has now
 * failed twice — a rule the model cannot satisfy is a broken rule.
 */
export async function generateTweet(
  candidate: Candidate,
  archetype: TweetArchetype,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const sourceText = sourceTextOf(candidate)
  const system: ChatMessage = { role: 'system', content: SYSTEM_PROMPT }

  let prompt = buildGeneratePrompt(candidate, archetype)
  let previousRules = new Set<string>()
  let lastViolations: string[] = ['no draft was produced']

  for (let round = 1; round <= deps.maxRounds; round++) {
    let draft: Draft
    let text: string
    try {
      const reply = await deps.chat([system, { role: 'user', content: prompt }])
      draft = toDraft(archetype, extractJson<Record<string, unknown>>(reply))
      text = assemble(draft)
    } catch (error) {
      if (!(error instanceof LlmError)) throw error
      // A reply we could not parse is a failed round, not a crash. The next
      // round re-asks from scratch.
      lastViolations = [error.message]
      prompt = buildGeneratePrompt(candidate, archetype)
      previousRules = new Set()
      continue
    }

    const result = validate({
      draft,
      text,
      sourceText,
      repeatedRules: previousRules,
      banned: deps.banned,
    })

    if (!result.ok) {
      lastViolations = result.hard.map((violation) => violation.message)
      previousRules = new Set(result.hard.map((violation) => violation.rule))
      prompt = buildRewritePrompt(text, lastViolations)
      continue
    }

    const critique = await runCritique(
      candidate,
      text,
      result.soft,
      deps,
      system,
    )
    if (critique.verdict === 'pass' || critique.issues.length === 0) {
      return { text, draft, rounds: round }
    }

    lastViolations = critique.issues
    previousRules = new Set()
    prompt = buildRewritePrompt(text, critique.issues)
  }

  throw new GenerationGaveUp(
    `Gave up after ${deps.maxRounds} rounds`,
    lastViolations,
  )
}
