import { describe, expect, it } from 'vitest'
import { loadConfig, TIER_OF_KIND, TIER_PRIORITY } from './config.js'

const minimal = { LLM_MODEL: 'some-model' } as NodeJS.ProcessEnv

describe('loadConfig', () => {
  it('fills in every default', () => {
    const config = loadConfig(minimal)

    expect(config.agentlensBaseUrl).toBe('https://api.agentlenshq.com')
    expect(config.llm.baseUrl).toBe('http://localhost:20128/v1')
    expect(config.llm.model).toBe('some-model')
    expect(config.queueTarget).toBe(2)
    expect(config.queuePollMinutes).toBe(5)
    expect(config.emptyPoolMinutes).toBe(30)
    expect(config.dailyCap).toBe(10)
    expect(config.quota).toEqual({ hot: 5, project: 3, labs: 2 })
    expect(config.entityWeight).toBe(0.7)
    expect(config.agentlensApiKey).toBeNull()
    expect(config.projectMinVelocityPerDay).toBe(20)
    expect(config.timezone).toBe('Asia/Shanghai')
    expect(config.maxRounds).toBe(3)
    expect(config.mediaDir).toBe('./media')
    expect(config.mediaRetentionDays).toBe(7)
    expect(config.discordWebhookUrl).toBeNull()
  })

  it('requires a pinned model', () => {
    // OmniRoute's "auto" falls back across provider tiers, so the model that
    // serves a request varies day to day. Posts go out unattended under a
    // personal brand; the router's quality floor becomes the brand's.
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/LLM_MODEL/)
  })

  it('rejects the auto model explicitly', () => {
    expect(() => loadConfig({ LLM_MODEL: 'auto' } as NodeJS.ProcessEnv)).toThrow(
      /pinned/,
    )
  })

  it('rejects a quota total above the daily cap', () => {
    expect(() =>
      loadConfig({ ...minimal, QUOTA_HOT: '9' } as NodeJS.ProcessEnv),
    ).toThrow(/exceeds DAILY_CAP/)
  })

  it('rejects a non-integer queue target', () => {
    expect(() =>
      loadConfig({ ...minimal, QUEUE_TARGET: 'lots' } as NodeJS.ProcessEnv),
    ).toThrow(/QUEUE_TARGET/)
  })

  it('rejects a queue target of zero', () => {
    // A target of zero never restocks, so the queue only ever drains. The
    // service would look alive and post nothing after the last row went out.
    expect(() =>
      loadConfig({ ...minimal, QUEUE_TARGET: '0' } as NodeJS.ProcessEnv),
    ).toThrow(/QUEUE_TARGET/)
  })

  it('reads overrides', () => {
    const config = loadConfig({
      ...minimal,
      QUOTA_HOT: '2',
      QUOTA_PROJECT: '1',
      QUOTA_LABS: '1',
      ENTITY_WEIGHT: '0.9',
      DAILY_CAP: '6',
      TIMEZONE: 'UTC',
    } as NodeJS.ProcessEnv)

    expect(config.quota.hot).toBe(2)
    expect(config.quota.labs).toBe(1)
    expect(config.entityWeight).toBe(0.9)
    expect(config.dailyCap).toBe(6)
    expect(config.timezone).toBe('UTC')
  })
})

describe('tiers', () => {
  it('maps every source kind to a tier', () => {
    expect(TIER_OF_KIND).toEqual({
      gh_project: 'project',
      hn_story: 'hot',
      x_digest: 'hot',
      lab_article: 'labs',
    })
  })

  it('no longer knows about youtube', () => {
    expect(Object.keys(TIER_OF_KIND)).not.toContain('youtube_video')
  })

  it('lists every tier exactly once', () => {
    expect([...TIER_PRIORITY].sort()).toEqual(['hot', 'labs', 'project'])
  })
})

describe('quota defaults', () => {
  it('gives the hot tier the largest share, since it is the only tier with both a heat signal and comparison material', () => {
    const config = loadConfig(minimal)
    expect(config.quota.hot).toBeGreaterThan(config.quota.labs)
    expect(config.quota.hot + config.quota.project + config.quota.labs)
      .toBeLessThanOrEqual(config.dailyCap)
  })

  it('weights entity salience above raw discussion volume', () => {
    // A story can be the loudest thing on HN and still be about a plotter.
    expect(loadConfig(minimal).entityWeight).toBeGreaterThan(0.5)
  })

  it('reads the API key when one is set', () => {
    const config = loadConfig({ ...minimal, AGENTLENS_API_KEY: 'k' } as NodeJS.ProcessEnv)
    expect(config.agentlensApiKey).toBe('k')
  })
})
