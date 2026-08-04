import { describe, expect, it } from 'vitest'
import {
  macClipboard,
  withClipboard,
  type ClipboardBackend,
} from './clipboard.js'

function fakeClipboard(initial: string): ClipboardBackend & { value: string } {
  return {
    value: initial,
    async read() {
      return this.value
    },
    async write(text: string) {
      this.value = text
    },
  }
}

describe('withClipboard', () => {
  it('puts the text on the clipboard for the duration of the callback', async () => {
    const clipboard = fakeClipboard('whatever was there')
    let seenDuringCallback = ''

    await withClipboard(
      'the tweet body',
      async () => {
        seenDuringCallback = await clipboard.read()
      },
      clipboard,
    )

    expect(seenDuringCallback).toBe('the tweet body')
  })

  it('restores the previous clipboard contents afterwards', async () => {
    const clipboard = fakeClipboard('whatever was there')
    await withClipboard('the tweet body', async () => {}, clipboard)
    expect(clipboard.value).toBe('whatever was there')
  })

  it('restores the clipboard even when the callback throws', async () => {
    // The operator's clipboard is not ours to lose on an error path.
    const clipboard = fakeClipboard('whatever was there')

    await expect(
      withClipboard(
        'the tweet body',
        async () => {
          throw new Error('posting blew up')
        },
        clipboard,
      ),
    ).rejects.toThrow('posting blew up')

    expect(clipboard.value).toBe('whatever was there')
  })

  it('returns the callback result', async () => {
    const clipboard = fakeClipboard('')
    const result = await withClipboard('body', async () => 'done', clipboard)
    expect(result).toBe('done')
  })

  it('still runs the callback when the backup read fails', async () => {
    // An unreadable clipboard must not block posting; it only means there is
    // nothing to restore.
    const clipboard: ClipboardBackend = {
      read: async () => {
        throw new Error('pbpaste unavailable')
      },
      write: async () => {},
    }
    await expect(
      withClipboard('body', async () => 'done', clipboard),
    ).resolves.toBe('done')
  })
})

describe('macClipboard', () => {
  it('round-trips through the real system clipboard', async () => {
    const backup = await macClipboard.read().catch(() => '')
    try {
      await macClipboard.write('x-poster round trip')
      expect(await macClipboard.read()).toBe('x-poster round trip')
    } finally {
      await macClipboard.write(backup)
    }
  })
})
