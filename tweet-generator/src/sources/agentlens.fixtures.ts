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
