import { chromium, Browser, BrowserContext, Page } from 'playwright'
import { readFileSync } from 'fs'
import path from 'path'
import type winston from 'winston'
import { createLogger } from 'shared/logger'
import { Database } from './database.js'
import { MessageFilter } from './message-filter.js'
import {
  DiscordMessage,
  Channel,
  Config,
  ChannelInfo,
  ChannelHealthStatus,
} from './types.js'

export class DiscordMonitor {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private pages: Map<string, Page> = new Map()
  private database: Database
  private messageFilter: MessageFilter
  public logger: winston.Logger
  private config: Config
  private observerScript: string
  private channelStatus: Map<string, ChannelHealthStatus> = new Map()

  constructor(config: Config) {
    this.config = config
    this.database = new Database()
    this.messageFilter = new MessageFilter(
      config.filtering.trivialPhrases,
      config.filtering.minLength,
    )

    this.logger = createLogger('discord-monitor.log')

    // Load the observer script
    this.observerScript = readFileSync(
      path.join(process.cwd(), 'src', 'discord-observer.js'),
      'utf8',
    )
  }

  async start(): Promise<void> {
    try {
      this.logger.info('Starting Discord monitor...')

      // Launch browser
      this.browser = await chromium.launch({
        headless: false, // Keep visible for debugging
        handleSIGINT: false, // Disable automatic browser close on Ctrl+C
        handleSIGTERM: false, // Disable automatic browser close on SIGTERM
        handleSIGHUP: false, // Disable automatic browser close on SIGHUP
        // --no-sandbox, --disable-web-security and
        // --disable-features=VizDisplayCompositor used to be here. All three
        // are automation tells, and the second strips same-origin protection
        // from a browser holding a live Discord session. Only the shared-memory
        // workaround is kept, which changes no observable browser behaviour.
        args: ['--disable-dev-shm-usage'],
      })

      // Create or restore context
      if (this.config.storageStatePath) {
        try {
          this.context = await this.browser.newContext({
            storageState: this.config.storageStatePath,
          })
          this.logger.info('Restored browser session from storage state')
        } catch (error) {
          this.logger.warn(
            'Could not restore storage state, starting fresh session',
          )
          this.context = await this.browser.newContext()
        }
      } else {
        this.context = await this.browser.newContext()
      }

      // Monitor each channel in a separate tab
      for (const channel of this.config.channels) {
        await this.createChannelTab(channel)
      }

      this.logger.info(
        `Discord monitor started with ${this.config.channels.length} channels`,
      )
    } catch (error) {
      this.logger.error('Failed to start Discord monitor:', error)
      throw error
    }
  }

  private async createChannelTab(channel: ChannelInfo): Promise<void> {
    if (!this.context) {
      throw new Error('Browser context not initialized')
    }

    try {
      const page = await this.context.newPage()
      this.pages.set(channel.channelId, page)

      // Set up message handler
      page.on('console', (msg) => {
        if (msg.text().includes('Discord observer:')) {
          this.logger.debug(`[${channel.channelId}] ${msg.text()}`)
        }
      })

      // Handle messages from the injected script
      await page.exposeFunction(
        'handleDiscordMessage',
        async (messageData: DiscordMessage) => {
          // The scraper speaks Discord; the row speaks storage.
          messageData.spaceId = channel.guildId
          await this.handleDiscordMessage(messageData, channel.channelId)
        },
      )

      // Handle heartbeat from the injected script
      await page.exposeFunction('handleHeartbeat', async (status: any) => {
        await this.handleChannelHeartbeat(channel.channelId, status)
      })

      // Navigate to Discord channel
      const discordUrl = `https://discord.com/channels/${channel.guildId}/${channel.channelId}`
      await page.goto(discordUrl, { waitUntil: 'domcontentloaded' })

      // Wait for Discord to load
      await page.waitForTimeout(3000)

      // Inject the observer script
      await page.addInitScript(this.observerScript)
      await page.evaluate(this.observerScript)

      this.logger.info(`Created tab for channel: ${channel.channelId}`)

      const channelName = await this.extractChannelName(page)
      const guildName = await this.extractGuildName(page)
      // Store channel info
      const channelInfo: Channel = {
        channelId: channel.channelId,
        channelName,
        guildId: channel.guildId,
        guildName,
      }

      await this.database.insertChannel(channelInfo)

      // Initialize channel status
      this.channelStatus.set(channel.channelId, {
        channelId: channel.channelId,
        channelName: channelName,
        guildId: channel.guildId,
        guildName: guildName,
        lastMessageTime: Date.now(),
        lastHeartbeat: Date.now(),
        messageCount: 0,
        isObserving: true,
        timeSinceLastMessage: 0,
        processedMessagesCount: 0,
        url: `https://discord.com/channels/${channel.guildId}/${channel.channelId}`,
        errorCount: 0,
      })
    } catch (error) {
      this.logger.error(
        `Failed to create tab for channel ${channel.channelId}:`,
        error,
      )
      this.pages.delete(channel.channelId)

      // Mark channel as unhealthy
      const status = this.channelStatus.get(channel.channelId)
      if (status) {
        status.lastErrorTime = Date.now()
        status.errorCount++
      }
    }
  }

  private async extractChannelName(page: Page): Promise<string | undefined> {
    try {
      return await page.evaluate(() => {
        // Try to find the selected channel in the sidebar first
        const selectedChannelElement =
          document.querySelector('li[class*="selected_"][data-dnd-name]') ||
          document.querySelector('li.selected[data-dnd-name]') ||
          // Fallback to any channel with data-dnd-name in the current view
          document.querySelector('[data-dnd-name]')

        if (selectedChannelElement) {
          const channelName =
            selectedChannelElement.getAttribute('data-dnd-name')
          if (channelName) return channelName
        }

        // Fallback to other selectors for channel name in header/title areas
        const nameElement =
          document.querySelector('h1[class*="title"]') ||
          document.querySelector('.channel-name') ||
          document.querySelector('[aria-label*="channel"]')

        return nameElement?.textContent?.trim()
      })
    } catch {
      return undefined
    }
  }

  private async extractGuildName(page: Page): Promise<string | undefined> {
    try {
      return await page.evaluate(() => {
        // Try the new Discord UI structure first
        const guildNameElement =
          document.querySelector('h2[class*="name_"]') ||
          document.querySelector('h2[data-text-variant="text-md/semibold"]') ||
          document.querySelector('.headerContent_f37cb1 h2') ||
          // Fallback to older selectors
          document.querySelector('[data-dnd-name]') ||
          document.querySelector('.guild-name') ||
          document.querySelector('h1')

        return (
          guildNameElement?.getAttribute('data-dnd-name') ||
          guildNameElement?.textContent?.trim()
        )
      })
    } catch {
      return undefined
    }
  }

  private async handleDiscordMessage(
    message: DiscordMessage,
    channelId: string,
  ): Promise<void> {
    try {
      // Apply filtering
      const shouldProcess = this.config.filtering.enabled
        ? this.messageFilter.shouldProcess(message, {
            ignoreBots: true,
            customTrivialCheck: (msg) => (msg.content ?? '').length === 0,
          })
        : true

      // Skip messages with unknown author
      const hasUnknownAuthor =
        message.authorId === 'unknown' && message.authorName === 'unknown'

      // Only store message if it should be processed (not filtered) and has known author
      if (shouldProcess && !hasUnknownAuthor) {
        await this.database.insertMessage(message, false)
      }

      if (shouldProcess) {
        this.logger.info(
          `[${channelId}] New message from ${
            message.authorName
          }: ${(message.content ?? '').substring(0, 100)}...`,
        )

        // Handle thread/reply logic
        if (message.replyToMessageId || message.threadId) {
          await this.handleThreadMessage(message)
        }
      } else {
        this.logger.debug(
          `[${channelId}] Filtered message from ${message.authorName}`,
        )
      }
    } catch (error) {
      this.logger.error(
        `Error handling message from channel ${channelId}:`,
        error,
      )
    }
  }

  private async handleThreadMessage(message: DiscordMessage): Promise<void> {
    if (message.threadId && message.replyToMessageId) {
      // This is a thread message
      await this.database.insertThread({
        threadId: message.threadId,
        originalMessageId: message.replyToMessageId,
        channelId: message.channelId,
      })
    }
  }

  async saveStorageState(path: string): Promise<void> {
    if (this.context) {
      await this.context.storageState({ path })
      this.logger.info(`Saved storage state to: ${path}`)
    }
  }

  async getChannelMessages(
    channelId: string,
    limit: number = 100,
  ): Promise<DiscordMessage[]> {
    return await this.database.getMessagesByChannel(channelId, limit)
  }

  async getThreadMessages(threadId: string): Promise<DiscordMessage[]> {
    return await this.database.getThreadMessages(threadId)
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping Discord monitor...')

    // Close all pages
    for (const [channelId, page] of this.pages) {
      try {
        await page.close()
        this.logger.debug(`Closed tab for channel: ${channelId}`)
      } catch (error) {
        this.logger.warn(`Error closing tab for channel ${channelId}:`, error)
      }
    }
    this.pages.clear()

    // Close browser context and browser
    if (this.context) {
      await this.context.close()
    }

    if (this.browser) {
      await this.browser.close()
    }

    // Close database connection
    await this.database.close()

    this.logger.info('Discord monitor stopped')
  }

  private async handleChannelHeartbeat(
    channelId: string,
    status: any,
  ): Promise<void> {
    const channelStatus = this.channelStatus.get(channelId)
    if (!channelStatus) return

    // Update status with heartbeat data
    channelStatus.lastHeartbeat = status.lastHeartbeat
    channelStatus.lastMessageTime = status.lastMessageTime
    channelStatus.messageCount = status.messageCount
    channelStatus.isObserving = status.isObserving
    channelStatus.timeSinceLastMessage = status.timeSinceLastMessage
    channelStatus.processedMessagesCount = status.processedMessagesCount
    channelStatus.url = status.url

    // Determine if channel is healthy
    const now = Date.now()
    const timeSinceHeartbeat = now - status.lastHeartbeat
    const timeSinceMessage = status.timeSinceLastMessage

    this.logger.info(
      `Heartbeat for guild ${channelStatus.guildName} channel ${channelStatus.channelName}`,
      {
        messageCount: status.messageCount,
        timeSinceLastMessage: Math.round(timeSinceMessage / 1000),
      },
    )
  }

  public getChannelStatus(): ChannelHealthStatus[] {
    return Array.from(this.channelStatus.values())
  }

  public async restartChannel(channelId: string): Promise<void> {
    this.logger.info(`Restarting channel ${channelId}`)

    const page = this.pages.get(channelId)
    if (page) {
      try {
        // Try to restart the observer
        await page.evaluate(() => {
          if ((window as any).discordObserver) {
            ;(window as any).discordObserver.stop()
            setTimeout(() => (window as any).discordObserver.start(), 1000)
          }
        })

        // Reset status
        const status = this.channelStatus.get(channelId)
        if (status) {
          status.lastHeartbeat = Date.now()
          status.errorCount = 0
        }

        this.logger.info(`Channel ${channelId} restarted successfully`)
      } catch (error) {
        this.logger.error(`Failed to restart channel ${channelId}:`, error)

        const status = this.channelStatus.get(channelId)
        if (status) {
          status.lastErrorTime = Date.now()
          status.errorCount++
        }
      }
    }
  }
}
