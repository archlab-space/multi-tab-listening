import { describe, expect, it, vi } from 'vitest'
import { AgentLensClient, AgentLensError } from './agentlens.js'
import {
  blogDetailResponse,
  blogListResponse,
  projectDetailResponse,
  projectListResponse,
} from './agentlens.fixtures.js'

function stubFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
}

const BASE = 'https://api.example.test'

describe('AgentLensClient', () => {
  it('requests blogs filtered by job type', async () => {
    const fetchImpl = stubFetch(blogListResponse)
    const client = new AgentLensClient(BASE, fetchImpl as never)

    const items = await client.listBlogs('lab_article', 50)

    const url = new URL(fetchImpl.mock.calls[0]![0] as string)
    expect(url.pathname).toBe('/blogs')
    expect(url.searchParams.get('job_type')).toBe('lab_article')
    expect(url.searchParams.get('limit')).toBe('50')
    expect(items).toHaveLength(2)
    expect(items[0]!.id).toBe('33fd0db1-0a72-49c7-ad0a-0dd751658872')
  })

  it('clamps the limit to the API maximum of 100', async () => {
    const fetchImpl = stubFetch(blogListResponse)
    const client = new AgentLensClient(BASE, fetchImpl as never)

    await client.listBlogs('hn_story', 500)

    const url = new URL(fetchImpl.mock.calls[0]![0] as string)
    expect(url.searchParams.get('limit')).toBe('100')
  })

  it('fetches a blog body', async () => {
    const fetchImpl = stubFetch(blogDetailResponse)
    const client = new AgentLensClient(BASE, fetchImpl as never)

    const blog = await client.getBlog('96753d8e-aea0-4977-b677-6ba4098850bc')

    const url = new URL(fetchImpl.mock.calls[0]![0] as string)
    expect(url.pathname).toBe('/blogs/96753d8e-aea0-4977-b677-6ba4098850bc')
    expect(blog.body_markdown).toContain('2.6B-parameter')
    expect(blog.references[0]!.url).toBe('https://github.com/LiquidAI/LFM2.5')
  })

  it('requests projects sorted by momentum', async () => {
    const fetchImpl = stubFetch(projectListResponse)
    const client = new AgentLensClient(BASE, fetchImpl as never)

    const items = await client.listProjects(24)

    const url = new URL(fetchImpl.mock.calls[0]![0] as string)
    expect(url.pathname).toBe('/projects')
    expect(url.searchParams.get('sort')).toBe('momentum')
    expect(items[0]!.star_velocity_per_day).toBe(442.9)
  })

  it('fetches a project explainer', async () => {
    const fetchImpl = stubFetch(projectDetailResponse)
    const client = new AgentLensClient(BASE, fetchImpl as never)

    const project = await client.getProject('ghp:diegosouzapw/OmniRoute')

    expect(project.explainer_md).toContain('290 providers')
    expect(project.html_url).toBe('https://github.com/diegosouzapw/OmniRoute')
  })

  it('escapes an id containing a slash', async () => {
    // Project ids look like `ghp:owner/repo`. An unescaped slash would make
    // the request hit /projects/ghp:owner/repo — a different route.
    const fetchImpl = stubFetch(projectDetailResponse)
    const client = new AgentLensClient(BASE, fetchImpl as never)

    await client.getProject('ghp:diegosouzapw/OmniRoute')

    expect(fetchImpl.mock.calls[0]![0]).toContain(
      'ghp%3Adiegosouzapw%2FOmniRoute',
    )
  })

  it('throws AgentLensError on a non-200', async () => {
    const fetchImpl = stubFetch({ error: 'not_found' }, 404)
    const client = new AgentLensClient(BASE, fetchImpl as never)

    await expect(client.getBlog('nope')).rejects.toThrow(AgentLensError)
  })

  it('throws AgentLensError when the transport fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const client = new AgentLensClient(BASE, fetchImpl as never)

    await expect(client.listBlogs('lab_article')).rejects.toThrow(AgentLensError)
  })
})
