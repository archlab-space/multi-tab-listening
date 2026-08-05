import type { SourceKind } from '../config.js'

/**
 * How far back each source's pool reaches.
 *
 * Set by how fast the content goes stale, not by how much of it there is.
 * Front-page news is worthless the next day; a video explaining inference
 * optimisation is fine a week later. Measured supply on 2026-08-05, per 24h:
 * hn_story 68, gh_project 88, lab_article 4, x_digest 2, youtube_video 0.
 *
 * gh_project's window is generous but unused in practice: the leaderboard is
 * always populated, and eligibility there is decided by the star bucket, the
 * cooldown, and the momentum floor instead.
 */
export const WINDOW_HOURS: Record<SourceKind, number> = {
  x_digest: 24,
  hn_story: 24,
  lab_article: 72,
  youtube_video: 168,
  gh_project: 168,
}

const MS_PER_HOUR = 3_600_000

export function windowStart(kind: SourceKind, now: Date): Date {
  return new Date(now.getTime() - WINDOW_HOURS[kind] * MS_PER_HOUR)
}
