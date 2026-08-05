/**
 * Type-level assertions, not runtime tests. They exist to prove the Drizzle
 * schema reproduces the interfaces `types.ts` has been hand-maintaining, so
 * that replacing one with the other is invisible to every consumer.
 *
 * Assignability in both directions is structural equality: a missing field
 * fails one direction, an extra field fails the other.
 */
import type { messages, tweets } from './schema.js'
import type { DiscordMessage, Tweet } from './types.js'

type SelectedTweet = typeof tweets.$inferSelect
type SelectedMessage = typeof messages.$inferSelect

// `Tweet` and the inferred row type must be interchangeable.
const _tweetIsAssignableToInterface: Tweet = {} as SelectedTweet
const _interfaceIsAssignableToTweet: SelectedTweet = {} as Tweet

/**
 * `DiscordMessage` gets a names-only check, not a bidirectional one, for two
 * reasons.
 *
 * It is deliberately narrower than the table: it omits the columns only
 * ai-assistant writes (`processed`, `is_question`, `embedding` and friends).
 *
 * And it is optimistic about nullability. `author_id`, `author_name`,
 * `content` and `timestamp` are all nullable in the database, while the
 * interface declares them required — so the row type is not assignable to it.
 * That gap is a real finding, not a schema error: the schema describes what
 * Postgres will actually hand back. Do not "fix" it by adding `.notNull()` to
 * columns that are nullable in the live database; the migration would then
 * disagree with the data. Resolving it belongs to the plan that replaces these
 * interfaces with inferred types.
 */
type MessageKeysExist = keyof DiscordMessage extends keyof SelectedMessage
  ? true
  : never
const _messageKeysExist: MessageKeysExist = true

// Referenced so the compiler does not report them as unused.
export type _Assertions = [
  typeof _tweetIsAssignableToInterface,
  typeof _interfaceIsAssignableToTweet,
  typeof _messageKeysExist,
]
