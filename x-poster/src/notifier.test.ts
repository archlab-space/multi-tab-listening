import { describe, expect, it, vi } from 'vitest'
import { notifyCircuitBreak } from './notifier.js'

describe('notifyCircuitBreak', () => {
  it('posts the message to the webhook', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    await notifyCircuitBreak(
      'https://example.test/hook',
      'session expired',
      fetchImpl as never,
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://example.test/hook')
    expect(JSON.parse((init as RequestInit).body as string).content).toContain(
      'session expired',
    )
  })

  it('does nothing when no webhook is configured', async () => {
    const fetchImpl = vi.fn()
    await notifyCircuitBreak(null, 'session expired', fetchImpl as never)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('swallows a webhook failure', async () => {
    // A broken notification must not mask the failure it was reporting.
    const fetchImpl = vi.fn().mockRejectedValue(new Error('webhook down'))
    await expect(
      notifyCircuitBreak(
        'https://example.test/hook',
        'session expired',
        fetchImpl as never,
      ),
    ).resolves.toBeUndefined()
  })
})
