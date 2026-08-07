import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const required = {
  X_PROFILE_DIR: '/tmp/x-profile',
  TIMEZONE: 'Asia/Shanghai',
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
    expect(config.maxIntervalMinutes).toBe(60)
    expect(config.dailyCap).toBe(10)
    expect(config.maxAttempts).toBe(3)
    expect(config.discordWebhookUrl).toBeNull()
    expect(config.activeHours).toEqual({ startMinute: 540, endMinute: 1380 })
  })

  it('parses an active-hours window into minutes from midnight', () => {
    expect(
      loadConfig({ ...required, X_ACTIVE_HOURS: '07:30-21:15' }).activeHours,
    ).toEqual({ startMinute: 450, endMinute: 1275 })
  })

  it('rejects an active-hours window that wraps past midnight', () => {
    expect(() =>
      loadConfig({ ...required, X_ACTIVE_HOURS: '22:00-02:00' }),
    ).toThrow(/must not wrap past midnight/)
  })

  it('rejects a malformed active-hours window', () => {
    expect(() => loadConfig({ ...required, X_ACTIVE_HOURS: '9-5' })).toThrow(
      /X_ACTIVE_HOURS/,
    )
  })

  it('rejects an interval floor above its ceiling', () => {
    expect(() =>
      loadConfig({
        ...required,
        X_MIN_INTERVAL_MINUTES: '90',
        X_MAX_INTERVAL_MINUTES: '30',
      }),
    ).toThrow(/X_MIN_INTERVAL_MINUTES/)
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
