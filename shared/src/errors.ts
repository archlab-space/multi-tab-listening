/**
 * Turning a thrown value into something a log line can carry.
 *
 * `error.message` alone is not enough. Node puts the part you need outside
 * the message often enough that the habit is unsafe: a failed connection to
 * `localhost` becomes an `AggregateError` over the addresses it resolves to
 * — one per address family — and that wrapper's own message is the empty
 * string. Logging it produced `{"error":""}`, which reads as "something
 * failed and we have no idea what", when the answer (ECONNREFUSED, the
 * database is not running) was sitting one field away.
 */

interface ErrorFields {
  code?: unknown
  cause?: unknown
  errors?: unknown
}

/** Guards against a cause chain that loops back on itself. */
const MAX_DEPTH = 4

export function formatError(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error)

  const fields = error as Error & ErrorFields
  let text = error.message.trim() || error.name || 'Error'

  // Codes live beside the message, not in it, on exactly the errors whose
  // message is least informative.
  if (typeof fields.code === 'string' && !text.includes(fields.code)) {
    text += ` (${fields.code})`
  }

  if (depth >= MAX_DEPTH) return text

  // An AggregateError is a container; on its own it says nothing at all.
  if (Array.isArray(fields.errors) && fields.errors.length > 0) {
    const inner = fields.errors
      .map((each) => formatError(each, depth + 1))
      .filter((each) => !text.includes(each))
    if (inner.length > 0) return `${text}: ${inner.join('; ')}`
    return text
  }

  if (fields.cause !== undefined && fields.cause !== null) {
    const cause = formatError(fields.cause, depth + 1)
    // Rethrowing with context usually quotes the cause already; saying it
    // twice makes the line harder to read, not more complete.
    if (!text.includes(cause)) return `${text}: caused by ${cause}`
  }

  return text
}
