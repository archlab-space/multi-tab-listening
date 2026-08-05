import { describe, expect, it } from 'vitest'
import { WINDOW_HOURS, windowStart } from './windows.js'

const now = new Date('2026-08-05T12:00:00.000Z')

describe('windowStart', () => {
  it('gives HN a day, because front-page news is stale by then', () => {
    expect(windowStart('hn_story', now)).toEqual(
      new Date('2026-08-04T12:00:00.000Z'),
    )
  })

  it('gives lab articles three days', () => {
    expect(windowStart('lab_article', now)).toEqual(
      new Date('2026-08-02T12:00:00.000Z'),
    )
  })

  it('gives YouTube a week', () => {
    // Supply is bursty — zero one day, eleven the next — and a deep-dive
    // keeps for a week. A 24h window would leave the pool empty most days.
    expect(windowStart('youtube_video', now)).toEqual(
      new Date('2026-07-29T12:00:00.000Z'),
    )
  })

  it('has a window for every source kind', () => {
    expect(Object.keys(WINDOW_HOURS).sort()).toEqual([
      'gh_project',
      'hn_story',
      'lab_article',
      'x_digest',
      'youtube_video',
    ])
  })
})
