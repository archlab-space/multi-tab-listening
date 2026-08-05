import { readFile } from 'node:fs/promises'
import { ARCHETYPES } from './archetypes.js'
import { MAX_WEIGHTED_LENGTH, weightedLength, type Draft } from './assemble.js'

export interface Violation {
  rule: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  /** Regenerate. */
  hard: Violation[]
  /** Passed to the critic as pointed questions. Never blocks on its own. */
  soft: Violation[]
}

export interface BannedPhrases {
  hard: string[]
  soft: string[]
}

export interface ValidationInput {
  draft: Draft
  /** The assembled tweet, exactly as it would be posted. */
  text: string
  /** title + summary + body + facts, joined. The number whitelist's scope. */
  sourceText: string
  /** Rules that already fired on the previous round. Feeds the loop guard. */
  repeatedRules: Set<string>
  banned: BannedPhrases
}

export const DEFAULT_BANNED_PHRASES: BannedPhrases = {
  hard: [
    'in the ever-evolving',
    "in today's fast-paced",
    'delve into',
    'paradigm shift',
    'harness the power',
    'unlock the (power|potential)',
    "it's worth noting",
    'buckle up',
    'let that sink in',
    'the AI landscape',
    'game.?changer',
  ],
  soft: [
    'seamless',
    'elevate',
    'unleash',
    'robust',
    'leverage',
    'supercharge',
    'revolutionize',
    'cutting.?edge',
  ],
}

/**
 * Rules the loop guard may downgrade to a warning after firing twice.
 *
 * Length, structure, and the number whitelist are deliberately absent. An
 * over-length tweet does not post at all, and a hallucinated number is the
 * one thing that must never reach the timeline — for those, a skipped post
 * is the correct outcome however many rounds it takes.
 */
const DOWNGRADABLE = ['banned-phrase:', 'hashtag', 'em-dash', 'thread-bait']

function isDowngradable(rule: string): boolean {
  return DOWNGRADABLE.some((prefix) => rule.startsWith(prefix))
}

/** Every field of a draft, as `[name, value]` pairs the budget map can key on. */
function fieldsOf(draft: Draft): Array<[string, string]> {
  switch (draft.archetype) {
    case 'digest':
      // Every highlight keys on the same budget name, which is what lets the
      // budget map hold one entry rather than three identical ones.
      return [
        ['hook', draft.hook],
        ...draft.highlights.map(
          (highlight) => ['highlight', highlight] as [string, string],
        ),
      ]
    case 'metric':
      return [
        ['metric', draft.metric],
        ['line', draft.line],
      ]
    default:
      return [['text', draft.text]]
  }
}

function checkStructure(draft: Draft): Violation[] {
  const violations: Violation[] = []

  if (draft.archetype === 'digest' && draft.highlights.length !== 3) {
    violations.push({
      rule: 'structure',
      message: `A digest needs exactly 3 highlights, got ${draft.highlights.length}.`,
    })
  }

  for (const [name, value] of fieldsOf(draft)) {
    if (value.trim() === '') {
      violations.push({ rule: 'structure', message: `The ${name} is empty.` })
    }
  }

  return violations
}

function checkBudgets(draft: Draft): Violation[] {
  const budgets = ARCHETYPES[draft.archetype].fields
  const violations: Violation[] = []

  for (const [name, value] of fieldsOf(draft)) {
    const budget = budgets[name]
    if (budget === undefined) continue
    const length = weightedLength(value.trim())
    if (length > budget) {
      violations.push({
        rule: 'field-budget',
        message: `The ${name} is ${length} characters; the budget is ${budget}. Shorten it.`,
      })
    }
  }

  return violations
}

/**
 * Numbers as written, with an optional unit: `87%`, `18.4k`, `4x`, `290`.
 *
 * Two things are deliberate. The unit must be adjacent — allowing whitespace
 * before it made "…16, but…" match as the token "16, b", which no source can
 * contain, so the draft was rejected for a number it never claimed. And every
 * separator must be followed by a digit, so a sentence-final "0.6.3." yields
 * "0.6.3" rather than dragging the full stop in with it.
 */
const NUMBER_PATTERN = /\d+(?:[.,]\d+)*(%|k|m|b|x)?/gi

function normalise(text: string): string {
  return text.toLowerCase().replace(/,/g, '').replace(/\s+/g, '')
}

/**
 * Every number in the output must already appear in the source material.
 *
 * The scope is the whole source rather than just `facts[]`: model names and
 * version strings (LFM2.5-2.6B, GPT-5.6, v2) are quoted, not invented, and
 * the rule exists to catch invention.
 *
 * Bare numbers below 10 are exempt. "the 3 numbers that matter" is prose,
 * not a claim, and rejecting it would be absurd — a unit suffix is what
 * turns a digit into an assertion.
 */
function checkNumbers(text: string, sourceText: string): Violation[] {
  const haystack = normalise(sourceText)
  const violations: Violation[] = []

  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const token = match[0]
    const unit = match[1]
    const value = Number(token.replace(/[^\d.]/g, ''))

    if (!unit && Number.isFinite(value) && value < 10) continue
    if (haystack.includes(normalise(token))) continue

    violations.push({
      rule: 'numbers',
      message:
        `"${token.trim()}" does not appear in the source material. Use only ` +
        `figures quoted from it, or drop the claim.`,
    })
  }

  return violations
}

function checkPhrases(
  text: string,
  sourceText: string,
  banned: BannedPhrases,
): { hard: Violation[]; soft: Violation[] } {
  const hard: Violation[] = []
  const soft: Violation[] = []

  const scan = (patterns: string[], target: Violation[], tier: string): void => {
    for (const source of patterns) {
      const match = new RegExp(source, 'i').exec(text)
      if (!match) continue

      // Quotation exemption. Skipping anything the source already says stops
      // the phrase list fighting the instruction to quote facts verbatim —
      // a fight the model cannot win, because accuracy forces the hit.
      if (new RegExp(source, 'i').test(sourceText)) continue

      target.push({
        rule: `banned-phrase:${source}`,
        message:
          tier === 'hard'
            ? `"${match[0]}" is filler. Rewrite the line without it.`
            : `The draft uses "${match[0]}". Is it doing real semantic work here, or is it filler? If filler, rewrite that line.`,
      })
    }
  }

  scan(banned.hard, hard, 'hard')
  scan(banned.soft, soft, 'soft')
  return { hard, soft }
}

function checkStyle(text: string): Violation[] {
  const violations: Violation[] = []

  if (/#\w/.test(text)) {
    violations.push({ rule: 'hashtag', message: 'No hashtags. Remove it.' })
  }

  if (/https?:\/\/|\bwww\./i.test(text)) {
    violations.push({
      rule: 'url',
      message: 'No links. Attribution rides on the card image.',
    })
  }

  const emDashes = (text.match(/—/g) ?? []).length
  if (emDashes > 1) {
    violations.push({
      rule: 'em-dash',
      message: `${emDashes} em dashes. Use at most one.`,
    })
  }

  if (
    /^\s*\d+\s*\//.test(text) ||
    /🧵/u.test(text) ||
    /^\s*\p{Extended_Pictographic}/u.test(text)
  ) {
    violations.push({
      rule: 'thread-bait',
      message:
        'No leading emoji, no "1/", no thread emoji. Open with the point.',
    })
  }

  return violations
}

export function validate(input: ValidationInput): ValidationResult {
  const phrases = checkPhrases(input.text, input.sourceText, input.banned)

  const raw: Violation[] = [
    ...checkStructure(input.draft),
    ...checkBudgets(input.draft),
    ...checkNumbers(input.text, input.sourceText),
    ...phrases.hard,
    ...checkStyle(input.text),
  ]

  if (weightedLength(input.text) > MAX_WEIGHTED_LENGTH) {
    raw.unshift({
      rule: 'length',
      message: `The tweet is ${weightedLength(input.text)} weighted characters; the limit is ${MAX_WEIGHTED_LENGTH}.`,
    })
  }

  const hard: Violation[] = []
  const soft: Violation[] = [...phrases.soft]

  for (const violation of raw) {
    if (
      input.repeatedRules.has(violation.rule) &&
      isDowngradable(violation.rule)
    ) {
      soft.push(violation)
    } else {
      hard.push(violation)
    }
  }

  return { ok: hard.length === 0, hard, soft }
}

/**
 * Loads the phrase list from disk, falling back to the built-in one.
 *
 * A missing file is not an error: new clichés will need adding and editing
 * config is faster than editing code, but the service must still start on a
 * fresh checkout.
 */
export async function loadBannedPhrases(path: string): Promise<BannedPhrases> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as BannedPhrases
    return {
      hard: parsed.hard ?? DEFAULT_BANNED_PHRASES.hard,
      soft: parsed.soft ?? DEFAULT_BANNED_PHRASES.soft,
    }
  } catch {
    return DEFAULT_BANNED_PHRASES
  }
}
