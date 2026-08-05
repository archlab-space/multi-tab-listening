import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { orderKinds, type QuotaUsage } from './quota.js'

const config = loadConfig({
  LLM_MODEL: 'pinned',
  TIMEZONE: 'Asia/Shanghai',
} as NodeJS.ProcessEnv)

/** Nothing posted yet today. */
const fresh: QuotaUsage = {
  used: {
    lab_article: 0,
    gh_project: 0,
    x_digest: 0,
    hn_story: 0,
    youtube_video: 0,
  },
  total: 0,
}

function usage(partial: Partial<QuotaUsage['used']>): QuotaUsage {
  const used = { ...fresh.used, ...partial }
  return {
    used,
    total: Object.values(used).reduce((sum, n) => sum + n, 0),
  }
}

/** 14:00 Shanghai — well past the digest anchor, mid-afternoon. */
const afternoon = new Date('2026-08-05T06:00:00.000Z')
/** 07:00 Shanghai — before today's digest exists. */
const earlyMorning = new Date('2026-08-04T23:00:00.000Z')

/**
 * The digest is never chosen by the ratio rule — it is either excluded
 * (before 09:00) or anchored to the front (after). So the ratio tests below
 * start from a day whose digest has already gone out, which is also the
 * realistic state for every cycle after the first.
 */
const digestSpent = { x_digest: 1 }

describe('orderKinds', () => {
  it('breaks an all-equal tie by priority', () => {
    expect(orderKinds(afternoon, usage(digestSpent), config)[0]).toBe(
      'lab_article',
    )
  })

  it('interleaves rather than draining one source at a time', () => {
    // Strict priority would produce four Labs posts, then three Projects,
    // then the rest — a monotone, visibly automated timeline.
    expect(
      orderKinds(afternoon, usage({ ...digestSpent, lab_article: 1 }), config)[0],
    ).toBe('gh_project')
    expect(
      orderKinds(
        afternoon,
        usage({ ...digestSpent, lab_article: 1, gh_project: 1 }),
        config,
      )[0],
    ).toBe('hn_story')
    expect(
      orderKinds(
        afternoon,
        usage({ ...digestSpent, lab_article: 1, gh_project: 1, hn_story: 1 }),
        config,
      )[0],
    ).toBe('youtube_video')
  })

  it('never lets the ratio rule pick the digest', () => {
    // Either excluded or anchored, never in between. Pinning this down
    // because it is the one kind whose position does not follow the ratio.
    const beforeAnchor = orderKinds(earlyMorning, fresh, config)
    expect(beforeAnchor).not.toContain('x_digest')

    const afterAnchor = orderKinds(afternoon, fresh, config)
    expect(afterAnchor[0]).toBe('x_digest')
  })

  it('lists every kind with quota left, so the caller can fall through', () => {
    const order = orderKinds(afternoon, fresh, config)
    expect(order).toHaveLength(5)
    expect([...order].sort()).toEqual([
      'gh_project',
      'hn_story',
      'lab_article',
      'x_digest',
      'youtube_video',
    ])
  })

  it('drops a kind whose quota is spent', () => {
    const order = orderKinds(afternoon, usage({ x_digest: 1 }), config)
    expect(order).not.toContain('x_digest')
  })

  it('returns nothing once the daily cap is reached', () => {
    const capped = usage({ lab_article: 4, gh_project: 3, hn_story: 1 })
    // Cap is 10; quota total is also 10, so spending 8 still leaves room.
    expect(orderKinds(afternoon, capped, config).length).toBeGreaterThan(0)

    const full = usage({
      lab_article: 4,
      gh_project: 3,
      x_digest: 1,
      hn_story: 1,
      youtube_video: 1,
    })
    expect(orderKinds(afternoon, full, config)).toEqual([])
  })

  it('respects a daily cap lower than the quota total', () => {
    const tight = loadConfig({
      LLM_MODEL: 'pinned',
      DAILY_CAP: '3',
      QUOTA_LAB: '1',
      QUOTA_PROJECT: '1',
      QUOTA_DIGEST: '1',
      QUOTA_HN: '0',
      QUOTA_YOUTUBE: '0',
    } as NodeJS.ProcessEnv)

    expect(
      orderKinds(
        afternoon,
        usage({ lab_article: 1, gh_project: 1, x_digest: 1 }),
        tight,
      ),
    ).toEqual([])
  })

  it('gives the digest first refusal at or after 09:00 local', () => {
    // The digest lands at 09:05 Shanghai and is worthless tomorrow, so it
    // must not wait for the ratio picker to reach it in the afternoon.
    const nineOClock = new Date('2026-08-05T01:00:00.000Z')
    expect(orderKinds(nineOClock, fresh, config)[0]).toBe('x_digest')
  })

  it('keeps the anchor until the digest is actually used', () => {
    const noon = new Date('2026-08-05T04:00:00.000Z')
    expect(orderKinds(noon, usage({ lab_article: 2 }), config)[0]).toBe(
      'x_digest',
    )
    expect(
      orderKinds(noon, usage({ lab_article: 2, x_digest: 1 }), config)[0],
    ).not.toBe('x_digest')
  })

  it("excludes the digest before 09:00, when today's does not exist yet", () => {
    expect(orderKinds(earlyMorning, fresh, config)).not.toContain('x_digest')
  })

  it('leaves the rest of the order intact behind an anchored digest', () => {
    const nine = new Date('2026-08-05T01:00:00.000Z')
    expect(orderKinds(nine, fresh, config)).toEqual([
      'x_digest',
      'lab_article',
      'gh_project',
      'hn_story',
      'youtube_video',
    ])
  })
})
