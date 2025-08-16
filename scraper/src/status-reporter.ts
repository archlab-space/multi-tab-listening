import * as cron from 'node-cron'
import { DiscordMonitor } from './discord-monitor.js'
import { ChannelHealthStatus } from './types.js'

interface DiscordEmbed {
  title?: string
  description?: string
  color?: number
  fields?: Array<{
    name: string
    value: string
    inline?: boolean
  }>
  footer?: {
    text: string
  }
  timestamp?: string
}

interface DiscordWebhookPayload {
  content?: string
  embeds?: DiscordEmbed[]
  username?: string
}

export class StatusReporter {
  private monitor: DiscordMonitor
  private dailyReportSchedule: cron.ScheduledTask | null = null
  private healthCheckSchedule: cron.ScheduledTask | null = null
  private webhookUrl: string

  constructor(monitor: DiscordMonitor, webhookUrl?: string) {
    this.monitor = monitor
    this.webhookUrl = webhookUrl || process.env.DISCORD_WEBHOOK_URL || ''
  }

  public start(): void {
    console.log('Starting status reporter...')

    // Daily status report at 9 AM
    this.dailyReportSchedule = cron.schedule(
      '0 9 * * *',
      () => {
        this.generateDailyReport()
      },
      {
        timezone: 'America/New_York', // Adjust timezone as needed
      },
    )

    // Health check every 5 minutes
    this.healthCheckSchedule = cron.schedule('*/5 * * * *', () => {
      this.performHealthCheck()
    })

    console.log(
      'Status reporter started - Daily reports at 9 AM, health checks every 5 minutes',
    )
  }

  public stop(): void {
    if (this.dailyReportSchedule) {
      this.dailyReportSchedule.stop()
      this.dailyReportSchedule = null
    }

    if (this.healthCheckSchedule) {
      this.healthCheckSchedule.stop()
      this.healthCheckSchedule = null
    }

    console.log('Status reporter stopped')
  }

  private async generateDailyReport(): Promise<void> {
    try {
      console.log('📊 Generating daily status report...')

      const allChannels = this.monitor.getChannelStatus()
      const unhealthyChannels = this.getUnhealthyChannels(allChannels)

      // Send webhook notification for daily report
      if (this.webhookUrl) {
        try {
          await this.sendDailyReportWebhook(allChannels, unhealthyChannels)
        } catch (webhookError) {
          console.error('Failed to send daily report webhook:', webhookError)
        }
      }

      // If there are unhealthy channels, try to restart them
      if (unhealthyChannels.length > 0) {
        console.warn(
          `Found ${unhealthyChannels.length} unhealthy channels, attempting restart...`,
        )
        for (const channel of unhealthyChannels) {
          await this.monitor.restartChannel(channel.channelId)
          await new Promise((resolve) => setTimeout(resolve, 2000)) // Wait between restarts
        }
      }
    } catch (error) {
      console.error('Failed to generate daily report:', error)
    }
  }

  private async performHealthCheck(): Promise<void> {
    try {
      const allChannels = this.monitor.getChannelStatus()
      const unhealthyChannels = this.getUnhealthyChannels(allChannels)

      if (unhealthyChannels.length > 0) {
        console.warn(
          `Health check found ${unhealthyChannels.length} unhealthy channels`,
        )

        // Send alert webhook for unhealthy channels
        if (this.webhookUrl) {
          try {
            await this.sendStatusAlertWebhook(unhealthyChannels)
          } catch (webhookError) {
            console.error('Failed to send status alert webhook:', webhookError)
          }
        }

        for (const channel of unhealthyChannels) {
          const timeSinceLastMessage = Math.round(
            channel.timeSinceLastMessage / 60000,
          ) // minutes
          const timeSinceLastHeartbeat = Math.round(
            (Date.now() - channel.lastHeartbeat) / 60000,
          ) // minutes

          console.warn(`Unhealthy channel: ${channel.channelId}`, {
            timeSinceLastMessage,
            timeSinceLastHeartbeat,
            isObserving: channel.isObserving,
            errorCount: channel.errorCount,
          })

          // Auto-restart channels that have been unhealthy for more than 10 minutes (heartbeat check)
          // if (timeSinceLastHeartbeat > 10) {
          //   console.log(`Auto-restarting unhealthy channel: ${channel.channelId}`)
          //   await this.monitor.restartChannel(channel.channelId)
          // }
        }
      }
    } catch (error) {
      console.error('Health check failed:', error)
    }
  }

  private isChannelHealthy(channel: ChannelHealthStatus): boolean {
    const now = Date.now()
    const timeSinceHeartbeat = now - channel.lastHeartbeat
    const timeSinceMessage = channel.timeSinceLastMessage

    // Channel is healthy if:
    // - Heartbeat within 10 minutes (600000 ms)
    // - Messages within 24 hours (86400000 ms) OR it's a new channel (messageCount === 0)
    const hasRecentHeartbeat = timeSinceHeartbeat < 600000 // 10 minutes
    const hasRecentMessages =
      timeSinceMessage < 86400000 || channel.messageCount === 0 // 24 hours or new channel

    return hasRecentHeartbeat && hasRecentMessages && channel.isObserving
  }

  private getUnhealthyChannels(
    channels: ChannelHealthStatus[],
  ): ChannelHealthStatus[] {
    return channels.filter((channel) => !this.isChannelHealthy(channel))
  }

  private async sendDailyReportWebhook(
    allChannels: ChannelHealthStatus[],
    unhealthyChannels: ChannelHealthStatus[],
  ): Promise<void> {
    const healthyCount = allChannels.length - unhealthyChannels.length
    const healthPercentage = Math.round(
      (healthyCount / allChannels.length) * 100,
    )

    const summaryField = {
      name: '📊 Summary',
      value: `Total Channels: ${allChannels.length}\nHealthy: ${healthyCount}\nUnhealthy: ${unhealthyChannels.length}\nOverall Health: ${healthPercentage}%`,
      inline: false,
    }

    const fields = [summaryField]

    // Add top active channels
    const activeChannels = allChannels
      .filter((c) => this.isChannelHealthy(c) && c.messageCount > 0)
      .sort((a, b) => b.messageCount - a.messageCount)
      .slice(0, 5)

    if (activeChannels.length > 0) {
      fields.push({
        name: '🔥 Most Active Channels (24h)',
        value: activeChannels
          .map((c) => `${c.channelId}: ${c.messageCount} messages`)
          .join('\n'),
        inline: true,
      })
    }

    // Add unhealthy channels if any
    if (unhealthyChannels.length > 0) {
      fields.push({
        name: '⚠️ Unhealthy Channels',
        value: unhealthyChannels
          .slice(0, 10)
          .map((c) => {
            const timeSinceMessage = Math.round(c.timeSinceLastMessage / 60000)
            return `${c.channelId}: ${timeSinceMessage}m ago`
          })
          .join('\n'),
        inline: true,
      })
    }

    const color =
      unhealthyChannels.length === 0
        ? 0x4caf50 // Green if all healthy
        : unhealthyChannels.length < allChannels.length / 2
        ? 0xffc107 // Yellow if some unhealthy
        : 0xff6b6b // Red if majority unhealthy

    const embed: DiscordEmbed = {
      title: '📋 Daily Discord Monitor Report',
      description: `Daily status report for ${new Date().toLocaleDateString()}`,
      color: color,
      fields: fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Discord Multi-Tab Monitor - Daily Report',
      },
    }

    const payload: DiscordWebhookPayload = {
      username: 'Discord Monitor Bot',
      embeds: [embed],
    }

    await this.sendWebhook(payload)
  }

  private async sendStatusAlertWebhook(
    unhealthyChannels: ChannelHealthStatus[],
  ): Promise<void> {
    const fields = unhealthyChannels.map((channel) => {
      const timeSinceMessage = Math.round(channel.timeSinceLastMessage / 60000) // minutes
      const timeSinceHeartbeat = Math.round(
        (Date.now() - channel.lastHeartbeat) / 60000,
      ) // minutes

      return {
        name: `🚨 Channel ${channel.channelId}`,
        value: `Last Message: ${timeSinceMessage}m ago\nLast Heartbeat: ${timeSinceHeartbeat}m ago\nObserver: ${
          channel.isObserving ? '✅' : '❌'
        }\nErrors: ${channel.errorCount}`,
        inline: true,
      }
    })

    const embed: DiscordEmbed = {
      title: '⚠️ Discord Monitor Alert',
      description: `Found ${unhealthyChannels.length} unhealthy channel(s) that may have stopped receiving messages.`,
      color: 0xff6b6b, // Red color
      fields: fields.slice(0, 25), // Discord embed limit
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Discord Multi-Tab Monitor',
      },
    }

    const payload: DiscordWebhookPayload = {
      username: 'Discord Monitor Bot',
      embeds: [embed],
    }

    await this.sendWebhook(payload)
  }

  private async sendWebhook(payload: DiscordWebhookPayload): Promise<void> {
    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(
        `Discord webhook error: ${response.status} - ${errorText}`,
      )
    }

    // Check for rate limiting
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after')
      console.warn('Discord webhook rate limited', { retryAfter })
      throw new Error(`Rate limited. Retry after: ${retryAfter}s`)
    }
  }

  // Manual trigger methods for testing
  public async triggerDailyReport(): Promise<void> {
    await this.generateDailyReport()
  }

  public async triggerHealthCheck(): Promise<void> {
    await this.performHealthCheck()
  }
}
