import { describe, expect, it } from 'vitest'
import {
  FatalError,
  RetryableError,
  UncertainError,
  classifyError,
} from './errors.js'

describe('classifyError', () => {
  it('passes an already-classified error straight through', () => {
    const original = new FatalError('session expired')
    expect(classifyError(original)).toBe(original)
  })

  it('treats a Playwright timeout as retryable', () => {
    const error = new Error('Timeout 30000ms exceeded.')
    error.name = 'TimeoutError'
    expect(classifyError(error)).toBeInstanceOf(RetryableError)
  })

  it('treats a connection refusal as retryable', () => {
    expect(
      classifyError(new Error('connect ECONNREFUSED 127.0.0.1:443')),
    ).toBeInstanceOf(RetryableError)
  })

  it('treats a navigation failure as retryable', () => {
    expect(
      classifyError(new Error('net::ERR_NAME_NOT_RESOLVED at https://x.com')),
    ).toBeInstanceOf(RetryableError)
  })

  /**
   * What `pg` throws when the database is not running: the refusals for both
   * addresses `localhost` resolves to, wrapped in an AggregateError whose own
   * message is empty. Classifying on `message` alone found no ECONNREFUSED
   * and broke the circuit on what is only the database being down.
   */
  it('treats a refusal buried in an AggregateError as retryable', () => {
    const error = Object.assign(
      new AggregateError(
        [
          new Error('connect ECONNREFUSED ::1:5432'),
          new Error('connect ECONNREFUSED 127.0.0.1:5432'),
        ],
        '',
      ),
      { code: 'ECONNREFUSED' },
    )
    expect(classifyError(error)).toBeInstanceOf(RetryableError)
  })

  it('carries the buried detail into the message it reports', () => {
    const error = Object.assign(new Error(''), { code: 'ETIMEDOUT' })
    expect(classifyError(error).message).toContain('ETIMEDOUT')
  })

  it('defaults an unrecognised error to fatal', () => {
    expect(
      classifyError(new Error('something nobody anticipated')),
    ).toBeInstanceOf(FatalError)
  })

  it('defaults a non-Error throw to fatal', () => {
    expect(classifyError('a bare string')).toBeInstanceOf(FatalError)
  })

  it('preserves the original as the cause', () => {
    const original = new Error('connect ECONNREFUSED 127.0.0.1:443')
    expect(classifyError(original).cause).toBe(original)
  })
})

describe('UncertainError', () => {
  it('is never produced by classification and must be thrown deliberately', () => {
    expect(classifyError(new Error('anything'))).not.toBeInstanceOf(
      UncertainError,
    )
    expect(new UncertainError('clicked but unverified')).toBeInstanceOf(Error)
  })
})
