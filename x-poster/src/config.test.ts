import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const required = {
  X_PROFILE_DIR: '/tmp/x-profile',
  TIMEZONE: 'Asia/Shanghai',
  X_WINDOWS: '09:00-23:00x10',
} as NodeJS.ProcessEnv

describe('loadConfig', () => {
  it('requires a profile directory', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/X_PROFILE_DIR/)
  })

  it('requires a timezone', () => {
    // Without one the daily cap resets on the host's midnight, which is not
    // the midnight tweet-generator counts its own cap against. Built
    // literally rather than from `required`, which now supplies the key.
    expect(() =>
      loadConfig({ X_PROFILE_DIR: '/tmp/x-profile' } as NodeJS.ProcessEnv),
    ).toThrow(/TIMEZONE/)
  })

  it('applies documented defaults', () => {
    const config = loadConfig({ ...required })
    expect(config.debugPort).toBe(9333)
    expect(config.dryRun).toBe(false)
    expect(config.minIntervalMinutes).toBe(20)
    expect(config.dailyCap).toBe(10)
    expect(config.maxAttempts).toBe(3)
    expect(config.discordWebhookUrl).toBeNull()
    expect(config.windows).toEqual([
      { startMinute: 540, endMinute: 1380, quota: 10 },
    ])
    expect(config.intervalJitter).toBe(0.25)
  })

  it('parses windows with their quotas', () => {
    const config = loadConfig({
      ...required,
      X_WINDOWS: '06:00-08:00x4,17:00-23:00x6',
    })
    expect(config.windows).toEqual([
      { startMinute: 360, endMinute: 480, quota: 4 },
      { startMinute: 1020, endMinute: 1380, quota: 6 },
    ])
  })

  it('rejects window quotas that exceed the daily cap', () => {
    // Quota that cannot be spent is a window that silently never fires.
    expect(() =>
      loadConfig({
        ...required,
        X_WINDOWS: '06:00-08:00x6,17:00-23:00x6',
        X_DAILY_CAP: '10',
      }),
    ).toThrow(/exceed X_DAILY_CAP/)
  })

  it('requires X_WINDOWS', () => {
    const { X_WINDOWS: _omitted, ...withoutWindows } = required
    expect(() => loadConfig(withoutWindows)).toThrow(/X_WINDOWS is required/)
  })

  it('names the replacement when only the old X_ACTIVE_HOURS is set', () => {
    // A silent fall back to the old single window is the one outcome worse
    // than refusing to start.
    const { X_WINDOWS: _omitted, ...withoutWindows } = required
    expect(() =>
      loadConfig({ ...withoutWindows, X_ACTIVE_HOURS: '09:00-23:00' }),
    ).toThrow(/X_ACTIVE_HOURS has been replaced by X_WINDOWS/)
  })

  it('defaults the interval jitter and rejects one outside [0, 1)', () => {
    expect(loadConfig(required).intervalJitter).toBe(0.25)
    expect(loadConfig({ ...required, X_INTERVAL_JITTER: '0' }).intervalJitter).toBe(
      0,
    )
    expect(() => loadConfig({ ...required, X_INTERVAL_JITTER: '1' })).toThrow(
      /X_INTERVAL_JITTER/,
    )
    expect(() => loadConfig({ ...required, X_INTERVAL_JITTER: '-0.1' })).toThrow(
      /X_INTERVAL_JITTER/,
    )
  })

  it('treats X_DRY_RUN=true as enabled and anything else as disabled', () => {
    expect(loadConfig({ ...required, X_DRY_RUN: 'true' }).dryRun).toBe(true)
    expect(loadConfig({ ...required, X_DRY_RUN: 'TRUE' }).dryRun).toBe(true)
    expect(loadConfig({ ...required, X_DRY_RUN: 'yes' }).dryRun).toBe(false)
    expect(loadConfig({ ...required, X_DRY_RUN: '' }).dryRun).toBe(false)
  })

  it('keeps an empty webhook url as null rather than an empty string', () => {
    expect(
      loadConfig({ ...required, DISCORD_WEBHOOK_URL: '' }).discordWebhookUrl,
    ).toBeNull()
    expect(
      loadConfig({
        ...required,
        DISCORD_WEBHOOK_URL: 'https://example.test/hook',
      }).discordWebhookUrl,
    ).toBe('https://example.test/hook')
  })
})
