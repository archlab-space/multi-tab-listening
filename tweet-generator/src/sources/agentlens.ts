import type { SourceKind } from '../config.js'

/**
 * Any failure reaching AgentLens. The service loop treats all of them the
 * same way — skip the cycle, write nothing, try again in two hours — so one
 * class is enough.
 */
export class AgentLensError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AgentLensError'
  }
}

export interface BlogListItem {
  id: string
  title: string
  summary: string
  job_type: SourceKind
  source_id: string
  occurred_at: string | null
  generated_at: string
}

export interface BlogReference {
  type: string
  title: string
  url?: string
  html_url?: string
}

export interface BlogDetail extends BlogListItem {
  body_markdown: string
  references: BlogReference[]
}

export interface ProjectListItem {
  id: string
  full_name: string
  description: string | null
  summary: string
  language: string | null
  topics: string[]
  tags: string[]
  license: string | null
  stars: number
  forks: number
  star_velocity_7d: number
  star_velocity_per_day: number
  momentum_score: number
  pushed_at: string
}

export interface ProjectDetail extends ProjectListItem {
  explainer_md: string
  html_url: string
}

interface Listing<T> {
  items: T[]
  total: number
}

/** The API clamps `limit` here itself; sending more just wastes the round trip. */
const MAX_LIMIT = 100

/**
 * The AgentLens wire shapes live in this file and nowhere else, so an API
 * change touches one module. Normalisation is `candidates.ts`'s job.
 *
 * `/query` is deliberately not implemented: its quota is 100 calls per 30
 * days, which cannot sustain a service running every two hours.
 */
export class AgentLensClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  private async get<T>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const url = new URL(path, this.baseUrl)
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }

    let response: Response
    try {
      response = await this.fetchImpl(url.toString(), {
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new AgentLensError(`GET ${url.pathname} failed`, { cause })
    }

    if (!response.ok) {
      throw new AgentLensError(`GET ${url.pathname} returned ${response.status}`)
    }

    return (await response.json()) as T
  }

  async listBlogs(jobType: SourceKind, limit = 100): Promise<BlogListItem[]> {
    const listing = await this.get<Listing<BlogListItem>>('/blogs', {
      job_type: jobType,
      limit: String(Math.min(limit, MAX_LIMIT)),
    })
    return listing.items
  }

  async getBlog(id: string): Promise<BlogDetail> {
    return this.get<BlogDetail>(`/blogs/${encodeURIComponent(id)}`)
  }

  async listProjects(limit = 100): Promise<ProjectListItem[]> {
    const listing = await this.get<Listing<ProjectListItem>>('/projects', {
      sort: 'momentum',
      limit: String(Math.min(limit, MAX_LIMIT)),
    })
    return listing.items
  }

  async getProject(id: string): Promise<ProjectDetail> {
    return this.get<ProjectDetail>(`/projects/${encodeURIComponent(id)}`)
  }
}
