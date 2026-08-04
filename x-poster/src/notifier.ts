/**
 * Circuit-break notifications, sent through the Discord webhook the
 * workspace already has. A second notification channel is not warranted.
 */
export async function notifyCircuitBreak(
  webhookUrl: string | null,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!webhookUrl) return

  try {
    await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'x-poster',
        content: `🛑 **x-poster stopped**\n\`\`\`\n${message}\n\`\`\``,
      }),
    })
  } catch {
    // A broken notification must not mask the failure it was reporting.
  }
}
