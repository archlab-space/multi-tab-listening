import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveMediaPath } from './media.js'

let root: string

/** A throwaway workspace shaped like the real one. */
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-poster-media-'))
  for (const pkg of ['shared', 'tweet-generator', 'x-poster', 'node_modules']) {
    await mkdir(join(root, pkg), { recursive: true })
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function place(...segments: string[]): Promise<string> {
  const path = join(root, ...segments)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, 'png')
  return path
}

describe('resolveMediaPath', () => {
  it('finds a card under the package that rendered it', async () => {
    // The case in the database today: tweet-generator writes `media/x.png`
    // relative to its own package directory, x-poster runs from its own.
    const expected = await place('tweet-generator', 'media', 'card.png')

    await expect(resolveMediaPath('media/card.png', root)).resolves.toBe(expected)
  })

  it('prefers the workspace root over any package', async () => {
    const expected = await place('media', 'card.png')
    await place('tweet-generator', 'media', 'card.png')

    await expect(resolveMediaPath('media/card.png', root)).resolves.toBe(expected)
  })

  it('returns an absolute path untouched', async () => {
    const expected = await place('tweet-generator', 'media', 'card.png')

    await expect(resolveMediaPath(expected, root)).resolves.toBe(expected)
  })

  it('ignores node_modules', async () => {
    // Nothing under node_modules is ours, and scanning it is how a lookup
    // this cheap turns into a walk of thousands of directories.
    await place('node_modules', 'media', 'card.png')

    await expect(resolveMediaPath('media/card.png', root)).rejects.toThrow(
      /media\/card\.png/,
    )
  })

  it('names every place it looked when the card is missing', async () => {
    // The whole point of failing here rather than at setInputFiles: the
    // operator needs to know where to put the file.
    await expect(resolveMediaPath('media/card.png', root)).rejects.toThrow(
      /tweet-generator/,
    )
  })

  it('rejects an absolute path that does not exist', async () => {
    await expect(
      resolveMediaPath(join(root, 'nope', 'card.png'), root),
    ).rejects.toThrow(/nope/)
  })
})
