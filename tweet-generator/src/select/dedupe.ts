/**
 * Star-count boundaries a project must cross before it may be posted again.
 *
 * A project is a long-lived entity — a repo sits on the leaderboard for
 * weeks — so a permanent dedupe key would allow one post per repo, ever.
 * Bucketing makes a repost require something new to say, rather than an
 * arbitrary timer expiring.
 */
const BUCKETS = [
  1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 50_000, 100_000, 200_000,
  500_000,
] as const

/** `18420` → `stars-10k`. Used as the last segment of a project dedupe key. */
export function starBucket(stars: number): string {
  let bucket = 0
  for (const boundary of BUCKETS) {
    if (stars >= boundary) bucket = boundary
  }
  if (bucket === 0) return 'stars-0'
  return `stars-${bucket / 1000}k`
}
