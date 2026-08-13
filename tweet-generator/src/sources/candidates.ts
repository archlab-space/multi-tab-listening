import type { SourceKind } from '../config.js'
import { scoreEntities } from '../select/entities.js'
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
  /**
   * The searchable names in this dispatch. Persisted on the tweet row so a
   * later post can ask what we have already written about and build a
   * comparison out of it.
   */
  entities: string[]
}

/** `18420` → `18.4k`. Past 100k the decimal is noise, so it is dropped. */
export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

/**
 * `project` is the `/projects` record for a gh_project dispatch, or null.
 *
 * A blog carries no stars, forks, or licence, and `facts` is the validator's
 * whitelist of figures the model is allowed to quote. Without hydration
 * every post about a repository loses the ability to state a single number.
 * Null is the ordinary case for a repo that has since left the leaderboard,
 * and it costs the post its metrics, not its existence.
 */
export function blogToCandidate(
  blog: BlogDetail,
  project?: ProjectDetail | null,
): Candidate {
  const reference = blog.references?.[0]
  const facts: string[] = []

  if (project) {
    facts.push(
      project.full_name,
      `${formatCount(project.stars)} stars`,
      `+${Math.round(project.star_velocity_per_day)} stars/day`,
      `${formatCount(project.forks)} forks`,
    )
    if (project.language) facts.push(project.language)
    if (project.license) facts.push(project.license)
  }

  return {
    kind: blog.job_type,
    externalId: blog.id,
    title: blog.title,
    summary: blog.summary,
    body: blog.body_markdown,
    facts,
    sourceUrl: reference?.html_url ?? reference?.url ?? null,
    freshness: new Date(blog.generated_at),
    dedupeKey: `agentlens:blog:${blog.id}`,
    entities: scoreEntities(`${blog.title} ${blog.summary}`).entities,
  }
}
