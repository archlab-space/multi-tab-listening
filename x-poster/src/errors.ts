/**
 * Every failure path in this service maps to exactly one of three categories.
 * The category, not the message, decides what happens next.
 */

import { formatError } from 'shared/errors'

/** Transient. Back off and try again, up to the configured attempt limit. */
export class RetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RetryableError'
  }
}

/**
 * Unrecoverable without a human: session expired, verification challenge,
 * every selector missing. Breaks the circuit rather than advancing to the
 * next row, because a dead session makes every subsequent attempt fail too —
 * and hammering a challenged account only deepens the problem.
 */
export class FatalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'FatalError'
  }
}

/**
 * Submit was clicked but the outcome could not be confirmed. The tweet may
 * be live. Never retried — the queue prefers a missed tweet over a duplicate
 * one. Thrown deliberately by the composer; never produced by classification.
 */
export class UncertainError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'UncertainError'
  }
}

const RETRYABLE_PATTERNS = [
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /net::ERR_/,
  /Timeout \d+ms exceeded/,
  /Navigation timeout/i,
]

/**
 * Anything unrecognised is fatal, not retryable. An unknown failure while
 * driving a logged-in browser is more likely a changed page or a challenged
 * session than a blip, and retrying into that makes things worse.
 */
export function classifyError(
  error: unknown,
): RetryableError | FatalError | UncertainError {
  if (
    error instanceof RetryableError ||
    error instanceof FatalError ||
    error instanceof UncertainError
  ) {
    return error
  }

  // `formatError`, not `error.message`: the patterns below match on text, and
  // the errors that matter most here keep their code outside the message. A
  // database that is not running arrives as an AggregateError with an empty
  // message, which matched nothing and was classified fatal — breaking the
  // circuit over something that only needed the next attempt.
  const message = formatError(error)
  const name = error instanceof Error ? error.name : ''

  if (
    name === 'TimeoutError' ||
    RETRYABLE_PATTERNS.some((pattern) => pattern.test(message))
  ) {
    return new RetryableError(message, { cause: error })
  }

  return new FatalError(message, { cause: error })
}
