import { describe, expect, it } from 'vitest'
import { mulberry32 } from './delay.js'
import { buildTravelPath, elementCentre, type Point } from './mouse.js'

const FROM: Point = { x: 100, y: 100 }
const TO: Point = { x: 800, y: 400 }

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

describe('buildTravelPath', () => {
  it('starts exactly at the origin', () => {
    const path = buildTravelPath(FROM, TO, { rng: mulberry32(1) })
    expect(path[0]).toEqual(FROM)
  })

  it('lands near but not exactly on the target', () => {
    // Never a pixel-perfect hit on the element centre.
    let anyOffCentre = false
    for (let seed = 0; seed < 40; seed++) {
      const path = buildTravelPath(FROM, TO, {
        rng: mulberry32(seed),
        overshoot: false,
      })
      const last = path[path.length - 1]!
      expect(distance(last, TO)).toBeLessThanOrEqual(3)
      if (distance(last, TO) > 0) anyOffCentre = true
    }
    expect(anyOffCentre).toBe(true)
  })

  it('uses between 20 and 40 intermediate points when not overshooting', () => {
    for (let seed = 0; seed < 40; seed++) {
      const path = buildTravelPath(FROM, TO, {
        rng: mulberry32(seed),
        overshoot: false,
      })
      expect(path.length).toBeGreaterThanOrEqual(20)
      expect(path.length).toBeLessThanOrEqual(40)
    }
  })

  it('advances monotonically toward the target when not overshooting', () => {
    const path = buildTravelPath(FROM, TO, {
      rng: mulberry32(5),
      overshoot: false,
    })
    for (let i = 1; i < path.length; i++) {
      expect(distance(FROM, path[i]!)).toBeGreaterThan(
        distance(FROM, path[i - 1]!),
      )
    }
  })

  it('moves faster in the middle than at either end', () => {
    // Ease-in-out: a human accelerates, then decelerates onto the target.
    const path = buildTravelPath(FROM, TO, {
      rng: mulberry32(9),
      overshoot: false,
      steps: 30,
    })
    const step = (i: number) => distance(path[i]!, path[i + 1]!)
    const middle = step(Math.floor(path.length / 2))
    expect(middle).toBeGreaterThan(step(0))
    expect(middle).toBeGreaterThan(step(path.length - 2))
  })

  it('does not travel in a straight line', () => {
    // A straight line is the single most obvious synthetic-cursor tell.
    const path = buildTravelPath(FROM, TO, {
      rng: mulberry32(11),
      overshoot: false,
    })
    const maxDeviation = Math.max(
      ...path.map((p) => {
        const t =
          ((p.x - FROM.x) * (TO.x - FROM.x) + (p.y - FROM.y) * (TO.y - FROM.y)) /
          distance(FROM, TO) ** 2
        const onLine = {
          x: FROM.x + t * (TO.x - FROM.x),
          y: FROM.y + t * (TO.y - FROM.y),
        }
        return distance(p, onLine)
      }),
    )
    expect(maxDeviation).toBeGreaterThan(2)
  })

  it('overshoots the target on roughly a third of travels', () => {
    let overshot = 0
    const total = 400
    for (let seed = 0; seed < total; seed++) {
      const path = buildTravelPath(FROM, TO, { rng: mulberry32(seed) })
      const furthest = Math.max(...path.map((p) => distance(FROM, p)))
      if (furthest > distance(FROM, TO) + 1) overshot++
    }
    expect(overshot / total).toBeGreaterThan(0.15)
    expect(overshot / total).toBeLessThan(0.45)
  })

  it('always returns to the target after overshooting', () => {
    for (let seed = 0; seed < 100; seed++) {
      const path = buildTravelPath(FROM, TO, { rng: mulberry32(seed) })
      expect(distance(path[path.length - 1]!, TO)).toBeLessThanOrEqual(3)
    }
  })

  it('is deterministic for a given seed', () => {
    expect(buildTravelPath(FROM, TO, { rng: mulberry32(42) })).toEqual(
      buildTravelPath(FROM, TO, { rng: mulberry32(42) }),
    )
  })
})

describe('elementCentre', () => {
  it('picks a point inside the box but off its exact centre', () => {
    const box = { x: 200, y: 100, width: 80, height: 40 }
    let anyOffCentre = false
    for (let seed = 0; seed < 40; seed++) {
      const point = elementCentre(box, mulberry32(seed))
      expect(point.x).toBeGreaterThan(box.x)
      expect(point.x).toBeLessThan(box.x + box.width)
      expect(point.y).toBeGreaterThan(box.y)
      expect(point.y).toBeLessThan(box.y + box.height)
      if (point.x !== 240 || point.y !== 120) anyOffCentre = true
    }
    expect(anyOffCentre).toBe(true)
  })
})
