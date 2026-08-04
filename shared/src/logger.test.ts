import { describe, expect, it } from 'vitest'
import { createLogger } from './logger.js'

describe('createLogger', () => {
  it('writes to the named file and to the console', () => {
    const logger = createLogger('example.log')

    const filenames = logger.transports
      .map((t) => (t as { filename?: string }).filename)
      .filter((name): name is string => typeof name === 'string')

    expect(filenames).toEqual(['example.log'])
    expect(logger.transports).toHaveLength(2)
  })

  it('defaults to the info level', () => {
    expect(createLogger('example.log').level).toBe('info')
  })

  it('honours an explicit level', () => {
    expect(createLogger('example.log', 'debug').level).toBe('debug')
  })

  it('reads the level from LOG_LEVEL when none is given', () => {
    const previous = process.env.LOG_LEVEL
    process.env.LOG_LEVEL = 'warn'
    try {
      expect(createLogger('example.log').level).toBe('warn')
    } finally {
      if (previous === undefined) delete process.env.LOG_LEVEL
      else process.env.LOG_LEVEL = previous
    }
  })
})
