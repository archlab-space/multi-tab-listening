import { nextDayStartIn } from 'shared/clock'

/**
 * What a cycle actually accomplished.
 *
 * Returning is not the same as restocking, and the difference is the whole
 * reason this type exists: a cycle that found every pool empty, or gave up on
 * every candidate it had, comes back looking exactly like one that queued a
 * tweet. Treating them alike would send the loop straight round again, and
 * every trip costs an AgentLens call.
 */
export type CycleOutcome = 'enqueued' | 'capped' | 'idle'

export interface PaceConfig {
  timezone: string
  queuePollMinutes: number
  emptyPoolMinutes: number
}

/**
 * Whether the buffer is short.
 *
 * `<` rather than `<=`: the target is the amount to hold, so reaching it is
 * the reason to stop rather than the reason to add one more.
 */
export function shouldReplenish(pending: number, target: number): boolean {
  return pending < target
}

/** How long to leave the queue alone before looking at it again. */
export function waitAfterMs(
  outcome: CycleOutcome,
  at: Date,
  config: PaceConfig,
): number {
  switch (outcome) {
    // The buffer may still be short of target, and finding out is one COUNT.
    case 'enqueued':
      return 0

    // Nothing left to spend, and nothing can change that before the day does.
    // Polling in between only re-derives an answer that is already known.
    case 'capped':
      return nextDayStartIn(config.timezone, at).getTime() - at.getTime()

    // Every pool was empty, or every candidate was refused. Both are sourcing
    // problems that do not clear in minutes, and each retry spends an
    // AgentLens call to learn the same thing.
    case 'idle':
      return config.emptyPoolMinutes * 60_000
  }
}
