import type { SourceKind } from '../config.js'
import { starBucket } from '../select/dedupe.js'
import type { BlogDetail, ProjectDetail } from './agentlens.js'

/**
 * The one shape everything downstream sees. Five sources with five different
 * payloads converge here, so selection, generation, and rendering each know
 * about exactly one type.
 */
export interface Candidate {
  kind: SourceKind
  externalId: string
  title: string
  summary: string
  /** `body_markdown` for blogs, `explainer_md` for projects. */
  body: string
  /**
   * Hard metrics, pre-formatted as strings the model is told to quote
   * verbatim. Formatting here rather than in the prompt is what lets the
   * validator do an exact substring check instead of trying to decide
   * whether "31k" is a faithful rendering of 31420.
   */
  facts: string[]
  /** Goes on the card image only. No tweet body ever carries a URL. */
  sourceUrl: string | null
  freshness: Date
  dedupeKey: string
}

/** `18420` → `18.4k`. Past 100k the decimal is noise, so it is dropped. */
export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

export function blogToCandidate(blog: BlogDetail): Candidate {
  const reference = blog.references?.[0]
  return {
    kind: blog.job_type,
    externalId: blog.id,
    title: blog.title,
    summary: blog.summary,
    body: blog.body_markdown,
    // Dispatches carry no structured metrics, so the whitelist is empty and
    // the validator falls back to the title, summary, and body — which is
    // the correct scope anyway: the check exists to catch invented numbers,
    // not quoted ones.
    facts: [],
    sourceUrl: reference?.html_url ?? reference?.url ?? null,
    freshness: new Date(blog.generated_at),
    dedupeKey: `agentlens:blog:${blog.id}`,
  }
}

export function projectToCandidate(project: ProjectDetail): Candidate {
  const facts = [
    project.full_name,
    `${formatCount(project.stars)} stars`,
    `+${Math.round(project.star_velocity_per_day)} stars/day`,
    `${formatCount(project.forks)} forks`,
  ]
  if (project.language) facts.push(project.language)
  if (project.license) facts.push(project.license)

  return {
    kind: 'gh_project',
    externalId: project.id,
    title: project.full_name,
    summary: project.summary,
    body: project.explainer_md,
    facts,
    sourceUrl: project.html_url,
    freshness: new Date(project.pushed_at),
    dedupeKey: `agentlens:project:${project.id}:${starBucket(project.stars)}`,
  }
}
