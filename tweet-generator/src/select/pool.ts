import type { GeneratorConfig, SourceKind } from '../config.js'
import type {
  BlogDetail,
  BlogListItem,
  ProjectDetail,
  ProjectListItem,
} from '../sources/agentlens.js'
import {
  blogToCandidate,
  projectToCandidate,
  type Candidate,
} from '../sources/candidates.js'
import { starBucket } from './dedupe.js'
import { passesNicheGate } from './niche.js'
import { windowStart } from './windows.js'

/**
 * The I/O this module needs, as plain functions rather than the client and
 * store objects. Selection is the part with the silent bugs, so it is worth
 * being able to test every rule against literals.
 */
export interface PoolDeps {
  listBlogs(jobType: SourceKind, limit?: number): Promise<BlogListItem[]>
  getBlog(id: string): Promise<BlogDetail>
  listProjects(limit?: number): Promise<ProjectListItem[]>
  getProject(id: string): Promise<ProjectDetail>
  knownDedupeKeys(keys: string[]): Promise<Set<string>>
  failureCounts(externalIds: string[]): Promise<Map<string, number>>
  projectPostedSince(sourceRef: string, since: Date): Promise<boolean>
}

const MAX_FAILURES = 3
const MS_PER_DAY = 86_400_000

async function selectBlog(
  kind: SourceKind,
  now: Date,
  deps: PoolDeps,
): Promise<Candidate | null> {
  const since = windowStart(kind, now)

  const items = (await deps.listBlogs(kind))
    .filter((item) => new Date(item.generated_at) >= since)
    .filter((item) => passesNicheGate(`${item.title} ${item.summary}`))
    .sort(
      (a, b) =>
        new Date(b.generated_at).getTime() - new Date(a.generated_at).getTime(),
    )

  if (items.length === 0) return null

  const known = await deps.knownDedupeKeys(
    items.map((item) => `agentlens:blog:${item.id}`),
  )
  const failures = await deps.failureCounts(items.map((item) => item.id))

  const winner = items.find(
    (item) =>
      !known.has(`agentlens:blog:${item.id}`) &&
      (failures.get(item.id) ?? 0) < MAX_FAILURES,
  )
  if (!winner) return null

  // Bodies cost one request each, so only the selected item is fetched.
  return blogToCandidate(await deps.getBlog(winner.id))
}

async function selectProject(
  now: Date,
  config: GeneratorConfig,
  deps: PoolDeps,
): Promise<Candidate | null> {
  const items = (await deps.listProjects())
    .filter(
      (item) => item.star_velocity_per_day >= config.projectMinVelocityPerDay,
    )
    .filter((item) =>
      passesNicheGate(
        `${item.full_name} ${item.description ?? ''} ${item.summary}`,
      ),
    )
    .sort((a, b) => b.momentum_score - a.momentum_score)

  if (items.length === 0) return null

  const known = await deps.knownDedupeKeys(
    items.map((item) => `agentlens:project:${item.id}:${starBucket(item.stars)}`),
  )
  const failures = await deps.failureCounts(items.map((item) => item.id))
  const cooldownStart = new Date(
    now.getTime() - config.projectCooldownDays * MS_PER_DAY,
  )

  for (const item of items) {
    const key = `agentlens:project:${item.id}:${starBucket(item.stars)}`
    if (known.has(key)) continue
    if ((failures.get(item.id) ?? 0) >= MAX_FAILURES) continue
    // A project can straddle a bucket boundary; the cooldown is what stops
    // it posting twice in a week on the strength of that alone.
    if (await deps.projectPostedSince(item.id, cooldownStart)) continue

    return projectToCandidate(await deps.getProject(item.id))
  }

  return null
}

export function selectCandidate(
  kind: SourceKind,
  now: Date,
  config: GeneratorConfig,
  deps: PoolDeps,
): Promise<Candidate | null> {
  return kind === 'gh_project'
    ? selectProject(now, config, deps)
    : selectBlog(kind, now, deps)
}
