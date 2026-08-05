/**
 * The hand-written interfaces are gone; `types.ts` derives them. What is
 * still worth proving is that the derived shapes carry the fields the
 * services actually read, so a column renamed in the schema fails here rather
 * than at whichever call site notices first.
 */
import type { DiscordMessage, Tweet, TweetArchetype } from './types.js'

const _tweetHasWhatTheQueueReads: Pick<
  Tweet,
  'id' | 'content' | 'status' | 'dedupeKey' | 'attempts' | 'scheduledAt'
> = {} as Tweet

const _messageHasWhatTheAssistantReads: Pick<
  DiscordMessage,
  'messageId' | 'channelId' | 'content' | 'timestamp'
> = {} as DiscordMessage

// The archetype union must stay closed: adding a value to the schema without
// teaching ARCHETYPES about it should not compile.
const _archetypes: Record<TweetArchetype, true> = {
  digest: true,
  metric: true,
  take: true,
  question: true,
}

export type _Assertions = [
  typeof _tweetHasWhatTheQueueReads,
  typeof _messageHasWhatTheAssistantReads,
  typeof _archetypes,
]
