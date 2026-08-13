import type { Rng } from 'shared/rng'
import type { Draft } from '../llm/assemble.js'
import type { Candidate } from '../sources/candidates.js'
import { interWoff2, monoWoff2 } from './fonts.js'

export const WATERMARK = 'Data via <span class="wm-domain">agentlenshq.com</span>'

/**
 * Visual variants per archetype.
 *
 * More than one exists for the same reason there is more than one archetype:
 * an identically styled card on every post is a trivially learnable
 * fingerprint. `metric` has one because its layout is a single number and
 * there is no second honest way to lay that out.
 */
export const VARIANTS = {
  digest: ['slate', 'paper'],
  metric: ['slate'],
} as const

export function pickVariant(
  archetype: 'digest' | 'metric',
  last: string | null,
  rng: Rng = Math.random,
): string {
  const all = VARIANTS[archetype]
  const eligible = all.filter((variant) => variant !== last)
  const pool = eligible.length > 0 ? eligible : all
  return pool[Math.floor(rng() * pool.length)]!
}

export interface CardInput {
  draft: Draft
  candidate: Candidate
  variant: string
}

/**
 * Everything reaching the markup is escaped without exception. Model output
 * is obviously untrusted, and the candidate title comes from an API, which
 * is no more trusted than the model.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface Palette {
  background: string
  foreground: string
  muted: string
  accent: string
  rule: string
}

const PALETTES: Record<string, Palette> = {
  slate: {
    background: '#0d1117',
    foreground: '#e6edf3',
    muted: '#7d8590',
    accent: '#4ec9b0',
    rule: '#21262d',
  },
  paper: {
    background: '#fbf9f4',
    foreground: '#1c1917',
    muted: '#78716c',
    accent: '#b4530a',
    rule: '#e7e2d8',
  },
}

function shell(palette: Palette, source: string, body: string): string {
  return `<style>
@font-face {
  font-family: 'Card';
  src: url(data:font/woff2;base64,${interWoff2}) format('woff2');
  font-weight: 600;
}
@font-face {
  font-family: 'CardMono';
  src: url(data:font/woff2;base64,${monoWoff2}) format('woff2');
  font-weight: 500;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  width: 1600px; height: 900px;
  background: ${palette.background};
  color: ${palette.foreground};
  font-family: 'Card', sans-serif;
  display: flex; flex-direction: column;
  padding: 88px 96px;
}
.source {
  font-family: 'CardMono', monospace;
  font-size: 30px; color: ${palette.accent};
  letter-spacing: 0.02em;
}
.credit {
  margin-bottom: 14px;
  font-family: 'CardMono', monospace;
  font-size: 24px; letter-spacing: 0.03em; color: ${palette.muted};
}
.credit .wm-domain { color: ${palette.accent}; }
.spacer { flex: 1; }
.hook { font-size: 76px; line-height: 1.15; letter-spacing: -0.02em; }
.rows { margin-top: 56px; display: flex; flex-direction: column; gap: 26px; }
.row {
  font-family: 'CardMono', monospace;
  font-size: 38px; color: ${palette.foreground};
  display: flex; gap: 24px; align-items: baseline;
}
.row::before { content: '—'; color: ${palette.accent}; }
.big {
  font-family: 'CardMono', monospace;
  font-size: 168px; line-height: 1; letter-spacing: -0.03em;
  color: ${palette.accent};
}
.line { margin-top: 48px; font-size: 46px; line-height: 1.3; color: ${palette.foreground}; }
</style>
<div class="credit">${WATERMARK}</div>
<div class="source">${escapeHtml(source)}</div>
<div class="spacer"></div>
${body}`
}

export function renderTemplate(input: CardInput): string {
  const palette = PALETTES[input.variant] ?? PALETTES.slate!
  const source = input.candidate.title

  if (input.draft.archetype === 'metric') {
    return shell(
      palette,
      source,
      `<div class="big">${escapeHtml(input.draft.metric)}</div>
<div class="line">${escapeHtml(input.draft.line)}</div>`,
    )
  }

  if (input.draft.archetype === 'digest') {
    const rows = input.draft.highlights
      .map((highlight) => `  <div class="row">${escapeHtml(highlight)}</div>`)
      .join('\n')
    return shell(
      palette,
      source,
      `<div class="hook">${escapeHtml(input.draft.hook)}</div>
<div class="rows">
${rows}
</div>`,
    )
  }

  // take and question never render a card; callers check `hasImage` first.
  throw new Error(`${input.draft.archetype} posts do not have a card`)
}
