import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { orderTiers, type QuotaUsage } from './quota.js'

const config = loadConfig({
  LLM_MODEL: 'pinned',
  TIMEZONE: 'Asia/Shanghai',
} as NodeJS.ProcessEnv)

/** Nothing posted yet today. */
const fresh: QuotaUsage = {
  used: { hot: 0, project: 0, labs: 0 },
  total: 0,
}

function usage(partial: Partial<QuotaUsage['used']>): QuotaUsage {
  const used = { ...fresh.used, ...partial }
  return {
    used,
    total: Object.values(used).reduce((sum, n) => sum + n, 0),
  }
}

/** 08:30 Shanghai — before the digest anchor. */
const beforeAnchor = new Date('2026-08-13T00:30:00.000Z')
/** 10:00 Shanghai — after it. */
const afterAnchor = new Date('2026-08-13T02:00:00.000Z')

describe('orderTiers', () => {
  it('offers nothing once the daily cap is spent', () => {
    expect(orderTiers(afterAnchor, usage({ hot: 5, project: 3, labs: 2 }), config))
      .toEqual([])
  })

  it('drops a tier whose own quota is spent', () => {
    expect(orderTiers(afterAnchor, usage({ hot: 5 }), config))
      .not.toContain('hot')
  })

  it('orders by remaining headroom, not by a fixed priority', () => {
    // hot has burned most of its share; labs has burned none.
    expect(orderTiers(beforeAnchor, usage({ hot: 4, project: 1 }), config)[0])
      .toBe('labs')
  })

  it('puts hot first after the digest anchor, whatever the ratios say', () => {
    // The digest lands at 09:05 and is worthless tomorrow. It cannot wait
    // for the ratio picker to reach its tier in the afternoon.
    expect(orderTiers(afterAnchor, usage({ hot: 4, project: 1 }), config)[0])
      .toBe('hot')
  })

  it('offers every tier when nothing has gone out yet', () => {
    expect(orderTiers(beforeAnchor, fresh, config)).toHaveLength(3)
  })
})
