import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

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
    expect(config.quota).toEqual({
      lab_article: 4,
      gh_project: 3,
      x_digest: 1,
      hn_story: 1,
      youtube_video: 1,
    })
    expect(config.projectCooldownDays).toBe(7)
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
      loadConfig({ ...minimal, QUOTA_LAB: '9' } as NodeJS.ProcessEnv),
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
      QUOTA_LAB: '2',
      QUOTA_PROJECT: '2',
      QUOTA_DIGEST: '1',
      QUOTA_HN: '1',
      QUOTA_YOUTUBE: '0',
      DAILY_CAP: '6',
      TIMEZONE: 'UTC',
    } as NodeJS.ProcessEnv)

    expect(config.quota.youtube_video).toBe(0)
    expect(config.dailyCap).toBe(6)
    expect(config.timezone).toBe('UTC')
  })
})
