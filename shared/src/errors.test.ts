import { describe, expect, it } from 'vitest'
import { formatError } from './errors.js'

describe('formatError', () => {
  it('returns the message of an ordinary error', () => {
    expect(formatError(new Error('boom'))).toBe('boom')
  })

  it('stringifies a value that is not an error', () => {
    expect(formatError('boom')).toBe('boom')
    expect(formatError(undefined)).toBe('undefined')
    expect(formatError({ a: 1 })).toBe('[object Object]')
  })

  it('falls back to the name when the message is empty', () => {
    const error = new Error('')
    error.name = 'WeirdError'
    expect(formatError(error)).toBe('WeirdError')
  })

  it('appends a code the message does not already carry', () => {
    const error = Object.assign(new Error('connect failed'), {
      code: 'ECONNREFUSED',
    })
    expect(formatError(error)).toBe('connect failed (ECONNREFUSED)')
  })

  it('does not repeat a code the message already names', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED ::1:5432'), {
      code: 'ECONNREFUSED',
    })
    expect(formatError(error)).toBe('connect ECONNREFUSED ::1:5432')
  })

  /**
   * The case that started this: `pg` fails over both addresses `localhost`
   * resolves to, and the AggregateError wrapping the two refusals has an
   * empty `message`. Logging `error.message` produced "".
   */
  it('unfolds an AggregateError whose own message is empty', () => {
    const error = Object.assign(
      new AggregateError(
        [
          Object.assign(new Error('connect ECONNREFUSED ::1:5432'), {
            code: 'ECONNREFUSED',
          }),
          Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
            code: 'ECONNREFUSED',
          }),
        ],
        '',
      ),
      { code: 'ECONNREFUSED' },
    )

    expect(formatError(error)).toBe(
      'AggregateError (ECONNREFUSED): connect ECONNREFUSED ::1:5432; ' +
        'connect ECONNREFUSED 127.0.0.1:5432',
    )
  })

  it('keeps the message of an AggregateError that has one', () => {
    const error = new AggregateError([new Error('inner')], 'outer')
    expect(formatError(error)).toBe('outer: inner')
  })

  it('appends a cause that adds something the message does not say', () => {
    const error = new Error('render failed', {
      cause: new Error('spawn ENOENT'),
    })
    expect(formatError(error)).toBe('render failed: caused by spawn ENOENT')
  })

  it('drops a cause already quoted in the message', () => {
    const inner = new Error('spawn ENOENT')
    const error = new Error(`render failed: ${inner.message}`, { cause: inner })
    expect(formatError(error)).toBe('render failed: spawn ENOENT')
  })

  it('terminates rather than following a cause cycle forever', () => {
    const outer = new Error('')
    const inner = new Error('')
    outer.name = 'Outer'
    inner.name = 'Inner'
    Object.assign(outer, { cause: inner })
    Object.assign(inner, { cause: outer })

    const text = formatError(outer)
    expect(text.startsWith('Outer: caused by Inner')).toBe(true)
    // Bounded: the depth cap stops the walk well before the line is unusable.
    expect(text.split('caused by').length - 1).toBeLessThanOrEqual(4)
  })
})
