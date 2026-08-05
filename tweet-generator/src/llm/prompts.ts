import type { TweetArchetype } from 'shared'
import type { Candidate } from '../sources/candidates.js'
import { ARCHETYPES } from './archetypes.js'
import type { Violation } from './validate.js'

export interface Critique {
  verdict: 'pass' | 'revise'
  issues: string[]
}

/**
 * The persona.
 *
 * Note what is absent: any list of forbidden phrases. Naming a cliché in a
 * prompt puts it in context and makes it more likely, not less — the ban
 * belongs in the validator, which sees the finished text.
 */
export const SYSTEM_PROMPT = `You are an AI engineer who ships code, writing short posts for other engineers.

Your readers are peers. They already know what an LLM is, what a GPU costs, and why latency matters. Never explain the obvious.

How you write:
- One idea per post. Nothing else.
- The first word is already the point. No preamble, no throat-clearing.
- Concrete over abstract: numbers, model sizes, throughput, VRAM, licences, languages.
- Flat and dry. Never enthusiastic, never promotional.
- Short sentences. Ordinary words.
- You are not selling anything and you are not writing for recruiters or investors.

You always reply with a single JSON object and nothing else.`

/** Enough of a dispatch to write from. The first section carries the news. */
const BODY_LIMIT = 4000

/** Everything the number whitelist checks a draft against. */
export function sourceTextOf(candidate: Candidate): string {
  return [
    candidate.title,
    candidate.summary,
    candidate.body,
    ...candidate.facts,
  ].join('\n')
}

function shapeInstruction(archetype: TweetArchetype): string {
  const fields = ARCHETYPES[archetype].fields
  switch (archetype) {
    case 'digest':
      return `Reply with: {"hook": string, "highlights": string[]}

- "hook": the single most interesting thing here, at most ${fields.hook} characters.
- "highlights": exactly 3 strings, at most ${fields.highlight} characters each. Each one must carry a concrete number or a hard specific (a licence, a language, a model size).`
    case 'metric':
      return `Reply with: {"metric": string, "line": string}

- "metric": one hard number and its unit, at most ${fields.metric} characters. Nothing else — no sentence around it.
- "line": one sentence saying what the thing is and why that number matters, at most ${fields.line} characters.`
    case 'take':
      return `Reply with: {"text": string}

- "text": one opinionated sentence, at most ${fields.text} characters. State a judgement a peer might disagree with. Not a summary.`
    default:
      return `Reply with: {"text": string}

- "text": one pointed question for other engineers, at most ${fields.text} characters. It must come out of the material below and be answerable from experience. Never generic engagement bait.`
  }
}

export function buildGeneratePrompt(
  candidate: Candidate,
  archetype: TweetArchetype,
): string {
  const facts = candidate.facts.length
    ? candidate.facts.map((fact) => `- ${fact}`).join('\n')
    : '(none supplied — take every figure from the material below, verbatim)'

  return `${shapeInstruction(archetype)}

Hard rules:
- Every number you write must appear verbatim in the material below. Invent nothing.
- No links, no hashtags, no emoji.
- Write in English.

Figures you may quote, exactly as written here:
${facts}

Material:
---
TITLE: ${candidate.title}
SUMMARY: ${candidate.summary}

${candidate.body.slice(0, BODY_LIMIT)}
---`
}

export function buildCritiquePrompt(
  candidate: Candidate,
  text: string,
  soft: Violation[],
): string {
  const questions = soft.length
    ? `\nSpecific things to judge:\n${soft.map((v) => `- ${v.message}`).join('\n')}\n`
    : ''

  return `Judge this draft post as an engineer would when it appears in their timeline.

Draft:
---
${text}
---

Source material:
---
${candidate.title}
${candidate.summary}
---
${questions}
Reject it if: it reads like marketing, it says something a peer already knows, the hook does not land, a claim is not supported by the source, or any sentence could be deleted without loss.

Reply with: {"verdict": "pass" | "revise", "issues": string[]}

"issues" must be empty when the verdict is "pass". Otherwise each issue names one concrete thing to change. Be specific — "the hook is vague" is useless, "the hook says 'faster' without saying faster than what" is useful.`
}

export function buildRewritePrompt(text: string, issues: string[]): string {
  return `Rewrite this draft. Keep the same JSON shape you produced before.

Draft:
---
${text}
---

Fix every one of these, and change nothing else:
${issues.map((issue) => `- ${issue}`).join('\n')}`
}
