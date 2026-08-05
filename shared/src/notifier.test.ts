import { describe, expect, it, vi } from 'vitest'
import { notifyFailure } from './notifier.js'

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
