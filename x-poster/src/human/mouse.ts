import type { Page } from 'playwright'
import { humanDelay, sampleDelay, type Rng } from './delay.js'

export interface Point {
  x: number
  y: number
}

export interface TravelOptions {
  steps?: number
  overshoot?: boolean
  rng?: Rng
}

const MIN_STEPS = 20
const MAX_STEPS = 40
const OVERSHOOT_PROBABILITY = 0.3
const ENDPOINT_JITTER_PX = 2

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Cubic Bézier at parameter t. */
function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t
  const w0 = u * u * u
  const w1 = 3 * u * u * t
  const w2 = 3 * u * t * t
  const w3 = t * t * t
  return {
    x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
    y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
  }
}

/** Ease-in-out: slow at both ends, fast through the middle. */
function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

/**
 * Control points pushed perpendicular to the straight line, by a fraction of
 * its length. A straight cursor path is the single most obvious synthetic
 * tell; this makes the travel bow the way a hand does.
 */
function controlPoints(from: Point, to: Point, rng: Rng): [Point, Point] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy) || 1
  const nx = -dy / length
  const ny = dx / length

  const bow = (0.08 + rng() * 0.12) * length * (rng() < 0.5 ? -1 : 1)

  return [
    {
      x: lerp(from.x, to.x, 0.3) + nx * bow,
      y: lerp(from.y, to.y, 0.3) + ny * bow,
    },
    {
      x: lerp(from.x, to.x, 0.7) + nx * bow * 0.6,
      y: lerp(from.y, to.y, 0.7) + ny * bow * 0.6,
    },
  ]
}

function jitter(point: Point, rng: Rng): Point {
  return {
    x: Math.round(point.x + (rng() * 2 - 1) * ENDPOINT_JITTER_PX),
    y: Math.round(point.y + (rng() * 2 - 1) * ENDPOINT_JITTER_PX),
  }
}

function curve(from: Point, to: Point, steps: number, rng: Rng): Point[] {
  const [c1, c2] = controlPoints(from, to, rng)
  const points: Point[] = []
  for (let i = 1; i <= steps; i++) {
    points.push(bezier(from, c1, c2, to, ease(i / steps)))
  }
  return points
}

/**
 * The sequence of cursor positions for one travel, from origin to target.
 *
 * Roughly a third of travels overshoot the target and come back — the single
 * most characteristic trait of a real hand on a mouse, and the reason this
 * returns a path rather than interpolating inline.
 */
export function buildTravelPath(
  from: Point,
  to: Point,
  options: TravelOptions = {},
): Point[] {
  const rng = options.rng ?? Math.random
  const steps =
    options.steps ?? MIN_STEPS + Math.floor(rng() * (MAX_STEPS - MIN_STEPS + 1))

  const willOvershoot = options.overshoot ?? rng() < OVERSHOOT_PROBABILITY
  const landing = jitter(to, rng)

  if (!willOvershoot) {
    return [from, ...curve(from, landing, steps - 1, rng)]
  }

  const dx = landing.x - from.x
  const dy = landing.y - from.y
  const beyond: Point = {
    x: Math.round(landing.x + dx * (0.04 + rng() * 0.06)),
    y: Math.round(landing.y + dy * (0.04 + rng() * 0.06)),
  }
  const correctionSteps = 4 + Math.floor(rng() * 4)

  return [
    from,
    ...curve(from, beyond, steps - 1, rng),
    ...curve(beyond, landing, correctionSteps, rng),
  ]
}

/** A point inside the element's box, deliberately not its exact centre. */
export function elementCentre(
  box: { x: number; y: number; width: number; height: number },
  rng: Rng = Math.random,
): Point {
  const inset = 0.3
  return {
    x: Math.round(box.x + box.width * (inset + rng() * (1 - inset * 2))),
    y: Math.round(box.y + box.height * (inset + rng() * (1 - inset * 2))),
  }
}

/** Walks the cursor along a generated path. Returns where it ended up. */
export async function travelTo(
  page: Page,
  from: Point,
  to: Point,
  options: TravelOptions = {},
): Promise<Point> {
  const rng = options.rng ?? Math.random
  const path = buildTravelPath(from, to, options)

  for (const point of path) {
    await page.mouse.move(point.x, point.y)
    await new Promise((resolve) => setTimeout(resolve, sampleDelay(4, 18, rng)))
  }

  // A hand settles on a target before it clicks.
  await humanDelay(90, 320, rng)
  return path[path.length - 1]!
}
