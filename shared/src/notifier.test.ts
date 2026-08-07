import { describe, expect, it, vi } from 'vitest'
import { notifyAttention, notifyFailure } from './notifier.js'

describe('notifyFailure', () => {
  it('posts the message to the webhook under the service name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    await notifyFailure(
      'https://example.test/hook',
      'x-poster',
      'session expired',
      fetchImpl as never,
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://example.test/hook')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.username).toBe('x-poster')
    expect(body.content).toContain('session expired')
    expect(body.content).toContain('x-poster')
  })

  it('does nothing when no webhook is configured', async () => {
    const fetchImpl = vi.fn()
    await notifyFailure(null, 'x-poster', 'session expired', fetchImpl as never)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('swallows a webhook failure', async () => {
    // A broken notification must not mask the failure it was reporting.
    const fetchImpl = vi.fn().mockRejectedValue(new Error('webhook down'))
    await expect(
      notifyFailure(
        'https://example.test/hook',
        'x-poster',
        'session expired',
        fetchImpl as never,
      ),
    ).resolves.toBeUndefined()
  })
})

describe('notifyAttention', () => {
  async function contentOf(
    notify: typeof notifyAttention,
  ): Promise<string> {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    await notify(
      'https://example.test/hook',
      'x-poster',
      'log in and I will carry on',
      fetchImpl as never,
    )
    const [, init] = fetchImpl.mock.calls[0]!
    return JSON.parse((init as RequestInit).body as string).content
  }

  it('carries the message under the service name', async () => {
    const content = await contentOf(notifyAttention)
    expect(content).toContain('log in and I will carry on')
    expect(content).toContain('x-poster')
  })

  /**
   * The whole reason this is not `notifyFailure`. Saying "stopped" about a
   * process that is still running and will resume by itself costs someone a
   * trip to the machine to discover nothing was wrong.
   */
  it('does not claim the service stopped', async () => {
    expect(await contentOf(notifyAttention)).not.toContain('stopped')
    expect(await contentOf(notifyFailure)).toContain('stopped')
  })

  it('does nothing when no webhook is configured', async () => {
    const fetchImpl = vi.fn()
    await notifyAttention(null, 'x-poster', 'log in', fetchImpl as never)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('swallows a webhook failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('webhook down'))
    await expect(
      notifyAttention(
        'https://example.test/hook',
        'x-poster',
        'log in',
        fetchImpl as never,
      ),
    ).resolves.toBeUndefined()
  })
})
