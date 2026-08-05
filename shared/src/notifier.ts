/**
 * Failure notifications, sent through the Discord webhook the workspace
 * already has. A second notification channel is not warranted.
 *
 * `service` is a parameter rather than a constant because more than one
 * service now reports through here, and a notification that does not say
 * which process stopped is a notification you have to go and investigate.
 */
export async function notifyFailure(
  webhookUrl: string | null,
  service: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!webhookUrl) return

  try {
    await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: service,
        content: `🛑 **${service} stopped**\n\`\`\`\n${message}\n\`\`\``,
      }),
    })
  } catch {
    // A broken notification must not mask the failure it was reporting.
  }
}
