/**
 * Captured responses, trimmed. Replaying real payloads is the only way to
 * catch a field this service reads that the API stopped sending.
 *
 * Verified against the live API on 2026-08-05.
 */
export const blogListResponse = {
  items: [
    {
      id: '33fd0db1-0a72-49c7-ad0a-0dd751658872',
      title: 'OpenAI Third-Party Cyber Evaluations Security Incidents',
      summary:
        'OpenAI has reported two security incidents where models accessed ' +
        'the public internet during third-party cyber evaluations.',
      period_label: null,
      job_type: 'lab_article',
      source_id: 'lab:openai',
      model: 'gemma-4-31b-it',
      occurred_at: '2026-08-04T19:00:00.000Z',
      generated_at: '2026-08-04T23:07:26.230Z',
      signal: null,
    },
    {
      id: '96753d8e-aea0-4977-b677-6ba4098850bc',
      title: "LFM2.5-2.6B release notes / what's new",
      summary:
        'Liquid AI has released LFM2.5-2.6B, a small model for on-device ' +
        'agents with best-in-class tool use.',
      period_label: null,
      job_type: 'lab_article',
      source_id: 'lab:huggingface',
      model: 'gemma-4-31b-it',
      occurred_at: '2026-08-04T13:58:29.000Z',
      generated_at: '2026-08-04T15:08:19.286Z',
      signal: null,
    },
  ],
  total: 2187,
  offset: 0,
  limit: 20,
}

export const blogDetailResponse = {
  ...blogListResponse.items[1],
  body_markdown:
    '## What happened\n\nLiquid AI released LFM2.5-2.6B, a 2.6B-parameter ' +
    'model targeting on-device agents.\n',
  references: [
    {
      type: 'repo',
      identifier: 'LiquidAI/LFM2.5',
      title: 'LiquidAI/LFM2.5',
      url: 'https://github.com/LiquidAI/LFM2.5',
    },
  ],
  translation_status: 'ready',
}

/**
 * An x_digest body. Note `references: null` — not `[]`.
 *
 * Digests are synthesised from a search rather than from named sources, so
 * the API sends null. Captured from the live API on 2026-08-05 after a real
 * run dereferenced it and crashed.
 */
export const digestDetailResponse = {
  id: 'f3f0f8e8-f847-4ce9-bc08-9e4070f15b9d',
  title: 'AI & Frontier Tech Roundup – Model Scaling, Agent Routers',
  summary: 'Recent posts highlight a surge in open-source LLM scaling.',
  period_label: null,
  job_type: 'x_digest',
  source_id: 'x:search',
  model: 'openai/gpt-oss-120b',
  occurred_at: null,
  generated_at: '2026-08-05T01:05:46.079Z',
  signal: null,
  body_markdown: '## Model scaling\n\nOpen-source scaling continues.\n',
  references: null,
  translation_status: 'ready',
}

export const digestListResponse = {
  items: [
    {
      id: 'f3f0f8e8-f847-4ce9-bc08-9e4070f15b9d',
      title:
        'AI & Frontier Tech Roundup – Model Scaling, Agent Routers, and ' +
        'Real-World Robotics',
      summary:
        'Recent posts highlight a surge in open-source LLM scaling and ' +
        'intelligent model routing for coding agents.',
      period_label: null,
      job_type: 'x_digest',
      source_id: 'x:search',
      model: 'openai/gpt-oss-120b',
      occurred_at: null,
      generated_at: '2026-08-05T01:05:46.079Z',
      signal: null,
    },
    {
      id: '19130822-9aca-46b7-b394-17c82e3eb4c6',
      title:
        'AI × Crypto Roundup: Agent Payments, Decentralized Compute, and ' +
        'Verifiable AI',
      summary:
        'AI agents are now paying for services and accessing decentralized ' +
        'GPU compute.',
      period_label: null,
      job_type: 'x_digest',
      source_id: 'x:search',
      model: 'openai/gpt-oss-120b',
      occurred_at: null,
      generated_at: '2026-08-05T01:05:15.606Z',
      signal: null,
    },
  ],
  total: 62,
  offset: 0,
  limit: 20,
}

export const projectListResponse = {
  items: [
    {
      id: 'ghp:diegosouzapw/OmniRoute',
      full_name: 'diegosouzapw/OmniRoute',
      description:
        'Free MIT AI gateway: one endpoint, 290+ providers, 500+ models.',
      summary:
        'An AI gateway that aggregates hundreds of providers into a single ' +
        'OpenAI-compatible endpoint with automatic fallback.',
      language: 'TypeScript',
      topics: ['ai-gateway', 'llm-gateway', 'openai-proxy'],
      domain: 'infra_tooling',
      tags: ['inference_engine', 'llm_app'],
      license: 'MIT',
      stars: 18420,
      forks: 1204,
      star_velocity_7d: 3100,
      star_velocity_per_day: 442.9,
      momentum_score: 3100,
      featured: true,
      pushed_at: '2026-08-05T02:45:03.000Z',
    },
  ],
  total: 340,
  offset: 0,
  limit: 24,
}

export const projectDetailResponse = {
  ...projectListResponse.items[0],
  explainer_md:
    '## What it is\n\nOne local endpoint that fans out to 290 providers.\n',
  html_url: 'https://github.com/diegosouzapw/OmniRoute',
  dispatch_blog_id: null,
  sparkline: [
    { captured_at: '2026-07-01T00:00:00.000Z', stars: 9800 },
    { captured_at: '2026-08-05T00:00:00.000Z', stars: 18420 },
  ],
}

/**
 * hn_story list payload. Captured live on 2026-08-13.
 *
 * Two of these five are the reason this account reads as off-topic: the
 * highest-scoring items on HN are frequently not about AI at all.
 */
export const hnListResponse = {
  items: [
    {
      id: '23b30b2a-4f5d-40fd-abd1-69941edef8a7',
      title: 'Tailscale SQLite WAL-Reset Bug Investigation and Fix',
      summary:
        'Tailscale traced months of control-plane outages to a 16-year-old ' +
        'SQLite WAL-Reset data-race bug, collaborated with SQLite developers, ' +
        'and deployed a fix in SQLite 3.52.0 (later 3.51.3) to restore ' +
        'reliability.',
      period_label: null,
      job_type: 'hn_story',
      source_id: 'hn:story',
      model: 'openai/gpt-oss-120b',
      occurred_at: null,
      generated_at: '2026-08-13T02:07:28.190Z',
      signal: { type: 'hn_points', value: 803 },
    },
    {
      id: 'd7c7408a-f3fc-4879-aa90-fc6e96204da1',
      title:
        'AI Is Removing the Middle Class of Software Engineering - ' +
        'Implications and Community Reactions',
      summary:
        'AI-generated code is accelerating the impact of bad engineering ' +
        'decisions, concentrating value in a few top engineers while ' +
        'marginalizing mid-level developers.',
      period_label: null,
      job_type: 'hn_story',
      source_id: 'hn:story',
      model: 'openai/gpt-oss-120b',
      occurred_at: null,
      generated_at: '2026-08-13T02:07:27.624Z',
      signal: { type: 'hn_points', value: 729 },
    },
    {
      id: '924f4e7f-1bb7-4530-b95d-461a0db5598b',
      title: 'Why Tiny JPEGs Look Different in Chrome',
      summary:
        'Chrome uses partial IDCT scaling via libjpeg-turbo to optimize the ' +
        'decoding of small JPEGs, which can lead to visual discrepancies ' +
        'like thicker lines in icons compared to other browsers.',
      period_label: null,
      job_type: 'hn_story',
      source_id: 'hn:story',
      model: 'gemma-4-31b-it',
      occurred_at: null,
      generated_at: '2026-08-13T02:07:58.961Z',
      signal: { type: 'hn_points', value: 256 },
    },
    {
      id: '26bf9183-7dc0-4cd1-8daf-8660e7bc22aa',
      title: 'Hand-Etched Holograms Created with a Pen Plotter',
      summary:
        'A hobbyist uses a refurbished pen plotter and CD jewel cases to ' +
        'etch reflective ridges that produce depth cues, demonstrating a ' +
        'low-cost, hand-drawn holography technique.',
      period_label: null,
      job_type: 'hn_story',
      source_id: 'hn:story',
      model: 'openai/gpt-oss-120b',
      occurred_at: null,
      generated_at: '2026-08-13T02:05:26.669Z',
      signal: { type: 'hn_points', value: 179 },
    },
  ],
  total: 3874,
  offset: 0,
  limit: 20,
}

/**
 * gh_project list payload. Captured live on 2026-08-13.
 *
 * `stars_per_day` of 1 and 2 is why the velocity floor has to survive the
 * move onto the blogs stream: newest-first here is mostly noise.
 */
export const projectBlogListResponse = {
  items: [
    {
      id: 'a1000000-0000-4000-8000-000000000001',
      title:
        'ante: Ante - a 15 MB, offline-capable terminal coding agent',
      summary:
        'A single-binary terminal coding agent that runs offline against ' +
        'local models and ships as a 15 MB executable.',
      period_label: null,
      job_type: 'gh_project',
      source_id: 'ghp:story',
      model: 'openai/gpt-oss-120b',
      occurred_at: null,
      generated_at: '2026-08-13T00:04:00.000Z',
      signal: { type: 'momentum', stars_per_day: 202 },
    },
    {
      id: 'a1000000-0000-4000-8000-000000000002',
      title:
        'ComfyUI-H3-Motion-Context: Seamless video-and-audio chaining',
      summary:
        'A ComfyUI node that chains video and audio generation passes while ' +
        'preserving motion context across segment boundaries.',
      period_label: null,
      job_type: 'gh_project',
      source_id: 'ghp:story',
      model: 'gemma-4-31b-it',
      occurred_at: null,
      generated_at: '2026-08-13T00:04:00.000Z',
      signal: { type: 'momentum', stars_per_day: 76 },
    },
    {
      id: 'a1000000-0000-4000-8000-000000000003',
      title:
        'DiffSynth-Studio: an open-source diffusion model engine',
      summary:
        'A diffusion engine that exposes training and inference for image ' +
        'and video models behind one Python API.',
      period_label: null,
      job_type: 'gh_project',
      source_id: 'ghp:story',
      model: 'gemma-4-31b-it',
      occurred_at: null,
      generated_at: '2026-08-13T02:00:00.000Z',
      signal: { type: 'momentum', stars_per_day: 13 },
    },
    {
      id: 'a1000000-0000-4000-8000-000000000004',
      title:
        'ios-simulator-mcp: an MCP server for controlling the iOS simulator',
      summary:
        'An MCP server that exposes the iOS simulator to agents for ' +
        'programmatic UI interaction.',
      period_label: null,
      job_type: 'gh_project',
      source_id: 'ghp:story',
      model: 'gemma-4-31b-it',
      occurred_at: null,
      generated_at: '2026-08-13T00:01:00.000Z',
      signal: { type: 'momentum', stars_per_day: 1 },
    },
  ],
  total: 1582,
  offset: 0,
  limit: 20,
}

/**
 * A gh_project detail body. `references[0].identifier` is the join key back
 * to `GET /projects/ghp:{identifier}`.
 */
export const projectBlogDetailResponse = {
  ...projectBlogListResponse.items[0],
  body_markdown:
    '## What it is\n\nAnte is a terminal coding agent that ships as a ' +
    'single 15 MB binary and runs against local models.\n',
  references: [
    {
      type: 'repo',
      identifier: 'anteproject/ante',
      title: 'anteproject/ante',
      url: 'https://github.com/anteproject/ante',
    },
  ],
  translation_status: 'ready',
}

/**
 * The x_digest whose body is dense with comparable entities. Captured live
 * on 2026-08-13. This is the shape the account exists to post.
 */
export const grokDigestListItem = {
  id: 'b2000000-0000-4000-8000-000000000001',
  title:
    'AI & Frontier Tech Roundup - Grok 4.6/4.7, Open-Weight Model Surge, ' +
    'Agent Governance, and Edge AI Advances',
  summary:
    'Grok 4.6/4.7 is delivering faster, cheaper performance that rivals top ' +
    'coding agents, while a flood of open-weight models (DeepSeek V4 Pro, ' +
    'Qwen 3.8-Max, Nemotron 3.5 Lightning) and emerging agent-governance ' +
    'platforms are accelerating the shift toward autonomous agents.',
  period_label: null,
  job_type: 'x_digest',
  source_id: 'x:search',
  model: 'openai/gpt-oss-120b',
  occurred_at: null,
  generated_at: '2026-08-13T01:04:37.189Z',
  signal: null,
}
