// The PRNG now lives in `shared`, since a second service needs it too. It is
// re-exported here so the existing `from '../human/delay.js'` imports across
// this package keep working.
import type { Rng } from 'shared/rng'

export { mulberry32, type Rng } from 'shared/rng'

/** Box-Muller transform: two uniforms in, one standard normal out. */
function standardNormal(rng: Rng): number {
  const u1 = Math.max(rng(), Number.EPSILON)
  const u2 = rng()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

const SIGMA = 0.45
/** Where the median sits inside the range, as a fraction of its width. */
const MEDIAN_POSITION = 0.25

/**
 * A delay drawn from a log-normal distribution, clamped to [minMs, maxMs].
 *
 * Uniformly distributed delays are themselves an anomaly: human intervals
 * between actions are mostly short with an occasional long tail, and that
 * shape is what this reproduces.
 */
export function sampleDelay(
  minMs: number,
  maxMs: number,
  rng: Rng = Math.random,
): number {
  if (maxMs <= minMs) return Math.round(minMs)

  const span = maxMs - minMs
  const median = span * MEDIAN_POSITION
  const value = minMs + Math.exp(Math.log(median) + SIGMA * standardNormal(rng))

  return Math.round(Math.min(maxMs, Math.max(minMs, value)))
}

export function humanDelay(
  minMs: number,
  maxMs: number,
  rng: Rng = Math.random,
): Promise<void> {
  const ms = sampleDelay(minMs, maxMs, rng)
  return new Promise((resolve) => setTimeout(resolve, ms))
}
