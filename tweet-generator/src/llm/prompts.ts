import type { TweetArchetype } from 'shared'
import type { Candidate } from '../sources/candidates.js'
import { ARCHETYPES } from './archetypes.js'
import type { Draft } from './assemble.js'
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

/**
 * What separates the shape of a post from its subject.
 *
 * Every archetype except `metric` gets this, because a project candidate
 * arrives with a `facts[]` list of stars, forks, and growth and a body that
 * actually explains the thing — and left alone the model writes all three
 * posts off the list. The first real run produced a digest, a take and a
 * question that each said only "this repo has a lot of stars", which is one
 * post's worth of information stretched over three.
 *
 * `metric` is exempt: a hard number is the whole point of that shape, and
 * for a project the honest number often is the star count.
 */
const SUBSTANCE_RULE =
  'Star counts, forks, growth rates and licences are context, never the subject. Write about what the thing does, finds, or gets wrong.'

function shapeInstruction(archetype: TweetArchetype): string {
  const fields = ARCHETYPES[archetype].fields
  switch (archetype) {
    case 'digest':
      return `Reply with: {"hook": string, "highlights": string[]}

- "hook": the single most interesting thing here, at most ${fields.hook} characters. ${SUBSTANCE_RULE}
- "highlights": exactly 3 strings, at most ${fields.highlight} characters each. Three different points, not one point rephrased. Each must carry a concrete number or a hard specific, and at least two must come from what the thing does — its design, its findings, its limits — rather than from its repository metadata.`
    case 'metric':
      return `Reply with: {"metric": string, "line": string}

- "metric": one hard number and its unit, at most ${fields.metric} characters. Nothing else — no sentence around it.
- "line": one sentence saying what the thing is and why that number matters, at most ${fields.line} characters. Say what it is, not what it signals or proves.`
    case 'take':
      return `Reply with: {"text": string}

- "text": one opinionated sentence, at most ${fields.text} characters. State a judgement a peer might disagree with. Not a summary. ${SUBSTANCE_RULE}`
    default:
      return `Reply with: {"text": string}

- "text": one pointed question for other engineers, at most ${fields.text} characters. It must come out of one specific technical detail in the material below and be answerable from experience. Name what it is about: a reader who has not seen the source must still know what is being asked. Never generic engagement bait. ${SUBSTANCE_RULE}`
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

Figures you may quote, exactly as written here. This is a spelling whitelist, not a list of things to write about:
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

  // The facts belong here for the same reason they belong in the generate
  // prompt: without them the critic judges a quoted figure it cannot see the
  // provenance of, and rejects "+443 stars/day" as unsupported — sending a
  // correct draft into a rewrite round it did not need.
  const facts = candidate.facts.length
    ? `\nFigures the draft is entitled to quote:\n${candidate.facts
        .map((fact) => `- ${fact}`)
        .join('\n')}\n`
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
${facts}${questions}
Reject it if: it reads like marketing, it says something a peer already knows, the hook does not land, a claim is not supported by the source, or any sentence could be deleted without loss.

Reply with: {"verdict": "pass" | "revise", "issues": string[]}

"issues" must be empty when the verdict is "pass". Otherwise each issue names one concrete thing to change. Be specific — "the hook is vague" is useless, "the hook says 'faster' without saying faster than what" is useful.`
}

/**
 * Every chat call is a fresh `[system, user]` pair, so "keep the shape you
 * produced before" points at nothing the model can see. A rewrite therefore
 * has to restate the whole brief — schema, rules, figures, material — and
 * hand back the previous attempt as JSON rather than as assembled prose.
 *
 * Handing over the prose instead is what broke the first real run: the model
 * invented a new schema every round ({"content"}, {"hook","digest","body"}),
 * every one of which parsed to a draft with empty required fields, so no
 * candidate that needed a second round could ever pass. Worse, once a draft
 * came back empty the next rewrite had no material at all and wrote about an
 * unrelated project.
 */
export function buildRewritePrompt(
  candidate: Candidate,
  archetype: TweetArchetype,
  previous: Draft,
  issues: string[],
): string {
  // `archetype` is our bookkeeping, not one of the fields the model is asked
  // for. Showing it would invite the model to echo it back.
  const { archetype: _internal, ...fields } = previous

  return `${buildGeneratePrompt(candidate, archetype)}

Your previous attempt was:
${JSON.stringify(fields, null, 2)}

Fix every one of these, and change nothing else:
${issues.map((issue) => `- ${issue}`).join('\n')}`
}
