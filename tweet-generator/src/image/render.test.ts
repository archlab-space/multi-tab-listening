import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanupMedia, mediaPathFor, renderCard } from './render.js'
import { renderTemplate, VARIANTS } from './template.js'
import type { Candidate } from '../sources/candidates.js'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tweet-generator-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('mediaPathFor', () => {
  it('is deterministic, so a retry overwrites its own file', () => {
    expect(mediaPathFor('./media', 'agentlens:blog:abc')).toBe(
      mediaPathFor('./media', 'agentlens:blog:abc'),
    )
  })

  it('differs per dedupe key', () => {
    expect(mediaPathFor('./media', 'a')).not.toBe(mediaPathFor('./media', 'b'))
  })

  it('produces a filesystem-safe name from a key full of colons and slashes', () => {
    const path = mediaPathFor('./media', 'agentlens:project:ghp:a/b:stars-10k')
    expect(path.startsWith('media/')).toBe(true)
    expect(path.slice('media/'.length)).toMatch(/^[0-9a-f]{16}\.png$/)
  })
})

describe('renderCard', () => {
  it('writes a PNG of the expected dimensions', async () => {
    const candidate = {
      kind: 'gh_project',
      externalId: 'ghp:a/b',
      title: 'a/b',
      summary: 'A gateway.',
      body: '',
      facts: [],
      sourceUrl: null,
      freshness: new Date(),
      dedupeKey: 'k',
      entities: [],
    } as Candidate

    const html = renderTemplate({
      draft: {
        archetype: 'digest',
        hook: 'One endpoint, 290 providers.',
        highlights: ['18.4k stars', '+443 stars/day', 'MIT'],
      },
      candidate,
      variant: VARIANTS.digest[0]!,
    })

    const out = join(dir, 'card.png')
    await renderCard(html, out)

    const bytes = await readFile(out)
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
    // PNG stores width and height as big-endian uint32 at offsets 16 and 20.
    // deviceScaleFactor 2 doubles the 1600x900 viewport.
    expect(bytes.readUInt32BE(16)).toBe(3200)
    expect(bytes.readUInt32BE(20)).toBe(1800)
  }, 120_000)
})

describe('cleanupMedia', () => {
  it('deletes the files it is given and counts them', async () => {
    const path = join(dir, 'old.png')
    await writeFile(path, 'x')
    expect(await cleanupMedia([path])).toBe(1)
  })

  it('ignores a file that is already gone', async () => {
    // Retention runs every cycle against rows that may have been cleaned by
    // a previous run. A missing file is the expected steady state.
    expect(await cleanupMedia([join(dir, 'never-existed.png')])).toBe(0)
  })
})
