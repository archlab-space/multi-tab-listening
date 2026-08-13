import type { GeneratorConfig, SourceKind, Tier } from '../config.js'
import { KINDS_OF_TIER } from '../config.js'
import type {
  BlogDetail,
  BlogListItem,
  ProjectDetail,
} from '../sources/agentlens.js'
import { heatOf } from '../sources/agentlens.js'
import { blogToCandidate, type Candidate } from '../sources/candidates.js'
import { passesNicheGate } from './niche.js'
import { rankWithinTier } from './rank.js'
import { windowStart } from './windows.js'

/**
 * The I/O this module needs, as plain functions rather than the client and
 * store objects. Selection is the part with the silent bugs, so it is worth
 * being able to test every rule against literals.
 */
export interface PoolDeps {
  listBlogs(jobType: SourceKind, limit?: number): Promise<BlogListItem[]>
  getBlog(id: string): Promise<BlogDetail>
  /** Null when the repo has left the leaderboard; /projects 404s for those. */
  getProject(id: string): Promise<ProjectDetail | null>
  knownDedupeKeys(keys: string[]): Promise<Set<string>>
  failureCounts(externalIds: string[]): Promise<Map<string, number>>
}

const MAX_FAILURES = 3

/**
 * The star-velocity floor, rebuilt on the blogs stream.
 *
 * It used to live on the /projects path, where the leaderboard had already
 * sorted by momentum. Newest-first on /blogs has not: a live sample ran
 * 13, 2, 76, 202, 1 stars per day. Dropping this check when the streams
 * merged would have made selection worse than the thing it replaced.
 */
function passesVelocityFloor(
  item: BlogListItem,
  config: GeneratorConfig,
): boolean {
  if (item.job_type !== 'gh_project') return true
  const velocity = heatOf(item.signal)
  return velocity !== null && velocity >= config.projectMinVelocityPerDay
}

export async function selectCandidate(
  tier: Tier,
  now: Date,
  config: GeneratorConfig,
  deps: PoolDeps,
): Promise<Candidate | null> {
  const batches = await Promise.all(
    KINDS_OF_TIER[tier].map(async (kind) => {
      const since = windowStart(kind, now)
      return (await deps.listBlogs(kind)).filter(
        (item) => new Date(item.generated_at) >= since,
      )
    }),
  )

  const items = batches
    .flat()
    .filter((item) => passesNicheGate(`${item.title} ${item.summary}`))
    .filter((item) => passesVelocityFloor(item, config))

  if (items.length === 0) return null

  // Ranked as one batch because they are one tier: normalising per tier is
  // what keeps a project's 1200 stars/day from being compared against an
  // HN story's 803 points, two numbers that share no scale.
  const ranked = rankWithinTier(items, config.entityWeight)

  const known = await deps.knownDedupeKeys(
    ranked.map((entry) => `agentlens:blog:${entry.item.id}`),
  )
  const failures = await deps.failureCounts(
    ranked.map((entry) => entry.item.id),
  )

  const winner = ranked.find(
    (entry) =>
      !known.has(`agentlens:blog:${entry.item.id}`) &&
      (failures.get(entry.item.id) ?? 0) < MAX_FAILURES,
  )
  if (!winner) return null

  // Bodies cost one request each, so only the selected item is fetched.
  const blog = await deps.getBlog(winner.item.id)
  const identifier = blog.references?.[0]?.identifier
  const project =
    blog.job_type === 'gh_project' && identifier
      ? await deps.getProject(`ghp:${identifier}`)
      : null

  return blogToCandidate(blog, project)
}
