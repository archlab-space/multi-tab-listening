/**
 * Notifications, sent through the Discord webhook the workspace already has.
 * A second notification channel is not warranted.
 *
 * `service` is a parameter rather than a constant because more than one
 * service now reports through here, and a notification that does not say
 * which process stopped is a notification you have to go and investigate.
 */
async function send(
  webhookUrl: string | null,
  service: string,
  headline: string,
  message: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!webhookUrl) return

  try {
    await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: service,
        content: `${headline}\n\`\`\`\n${message}\n\`\`\``,
      }),
    })
  } catch {
    // A broken notification must not mask the failure it was reporting.
  }
}

/** The process has stopped and will not start again on its own. */
export function notifyFailure(
  webhookUrl: string | null,
  service: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return send(
    webhookUrl,
    service,
    `🛑 **${service} stopped**`,
    message,
    fetchImpl,
  )
}

/**
 * The process is still running but is blocked on something only a person can
 * do, and will carry on by itself once they have done it.
 *
 * Worth its own headline rather than reusing `notifyFailure`: "stopped" would
 * be a lie, and a notification that misstates whether the service is alive
 * costs someone a trip to the machine to find out.
 */
export function notifyAttention(
  webhookUrl: string | null,
  service: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return send(
    webhookUrl,
    service,
    `⏸️ **${service} is waiting for you**`,
    message,
    fetchImpl,
  )
}
