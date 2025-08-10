import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { readFileSync } from 'fs';
import path from 'path';
import winston from 'winston';
import { Database } from './database.js';
import { MessageFilter } from './message-filter.js';
import { DiscordMessage, Channel, Config } from './types.js';

export class DiscordMonitor {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Map<string, Page> = new Map();
  private database: Database;
  private messageFilter: MessageFilter;
  private logger: winston.Logger;
  private config: Config;
  private observerScript: string;

  constructor(config: Config) {
    this.config = config;
    this.database = new Database();
    this.messageFilter = new MessageFilter(
      config.filtering.trivialPhrases,
      config.filtering.minLength
    );

    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          return `${timestamp} [${level.toUpperCase()}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
        })
      ),
      transports: [
        new winston.transports.File({ filename: 'discord-monitor.log' }),
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        })
      ],
    });

    // Load the observer script
    this.observerScript = readFileSync(
      path.join(process.cwd(), 'src', 'discord-observer.js'),
      'utf8'
    );
  }

  async start(): Promise<void> {
    try {
      this.logger.info('Starting Discord monitor...');

      // Launch browser
      this.browser = await chromium.launch({
        headless: false, // Keep visible for debugging
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor'
        ]
      });

      // Create or restore context
      if (this.config.storageStatePath) {
        try {
          this.context = await this.browser.newContext({
            storageState: this.config.storageStatePath
          });
          this.logger.info('Restored browser session from storage state');
        } catch (error) {
          this.logger.warn('Could not restore storage state, starting fresh session');
          this.context = await this.browser.newContext();
        }
      } else {
        this.context = await this.browser.newContext();
      }

      // Monitor each channel in a separate tab
      for (const channelId of this.config.channels) {
        await this.createChannelTab(channelId);
      }

      this.logger.info(`Discord monitor started with ${this.config.channels.length} channels`);
    } catch (error) {
      this.logger.error('Failed to start Discord monitor:', error);
      throw error;
    }
  }

  private async createChannelTab(channelId: string): Promise<void> {
    if (!this.context) {
      throw new Error('Browser context not initialized');
    }

    try {
      const page = await this.context.newPage();
      this.pages.set(channelId, page);

      // Set up message handler
      page.on('console', (msg) => {
        if (msg.text().includes('Discord observer:')) {
          this.logger.debug(`[${channelId}] ${msg.text()}`);
        }
      });

      // Handle messages from the injected script
      page.on('message', async (msg) => {
        if (msg.type() === 'DISCORD_MESSAGE') {
          await this.handleDiscordMessage(msg.args()[0] as DiscordMessage, channelId);
        }
      });

      // Navigate to Discord channel
      const discordUrl = `https://discord.com/channels/@me/${channelId}`;
      await page.goto(discordUrl, { waitUntil: 'domcontentloaded' });

      // Wait for Discord to load
      await page.waitForTimeout(3000);

      // Inject the observer script
      await page.addInitScript(this.observerScript);
      await page.evaluate(this.observerScript);

      this.logger.info(`Created tab for channel: ${channelId}`);

      // Store channel info
      const channelInfo: Channel = {
        channelId,
        channelName: await this.extractChannelName(page),
        guildId: await this.extractGuildId(page),
        guildName: await this.extractGuildName(page)
      };

      await this.database.insertChannel(channelInfo);

    } catch (error) {
      this.logger.error(`Failed to create tab for channel ${channelId}:`, error);
      this.pages.delete(channelId);
    }
  }

  private async extractChannelName(page: Page): Promise<string | undefined> {
    try {
      return await page.evaluate(() => {
        const nameElement = document.querySelector('h1[class*="title"]') ||
                           document.querySelector('[data-dnd-name]') ||
                           document.querySelector('.channel-name');
        return nameElement?.textContent?.trim();
      });
    } catch {
      return undefined;
    }
  }

  private async extractGuildId(page: Page): Promise<string | undefined> {
    try {
      const url = page.url();
      const match = url.match(/\/channels\/(\d+)\//);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  private async extractGuildName(page: Page): Promise<string | undefined> {
    try {
      return await page.evaluate(() => {
        const guildElement = document.querySelector('[data-dnd-name]') ||
                           document.querySelector('.guild-name') ||
                           document.querySelector('h1');
        return guildElement?.getAttribute('data-dnd-name') || guildElement?.textContent?.trim();
      });
    } catch {
      return undefined;
    }
  }

  private async handleDiscordMessage(message: DiscordMessage, channelId: string): Promise<void> {
    try {
      // Apply filtering
      const shouldProcess = this.config.filtering.enabled ? 
        this.messageFilter.shouldProcess(message, {
          ignoreBots: true,
          customTrivialCheck: (msg) => msg.content.length === 0
        }) : true;

      // Store message in database
      await this.database.insertMessage(message, !shouldProcess);

      if (shouldProcess) {
        this.logger.info(`[${channelId}] New message from ${message.authorName}: ${message.content.substring(0, 100)}...`);
        
        // Handle thread/reply logic
        if (message.replyToMessageId || message.threadId) {
          await this.handleThreadMessage(message);
        }
      } else {
        this.logger.debug(`[${channelId}] Filtered message from ${message.authorName}`);
      }

    } catch (error) {
      this.logger.error(`Error handling message from channel ${channelId}:`, error);
    }
  }

  private async handleThreadMessage(message: DiscordMessage): Promise<void> {
    if (message.threadId && message.replyToMessageId) {
      // This is a thread message
      await this.database.insertThread({
        threadId: message.threadId,
        originalMessageId: message.replyToMessageId,
        channelId: message.channelId
      });
    }
  }

  async saveStorageState(path: string): Promise<void> {
    if (this.context) {
      await this.context.storageState({ path });
      this.logger.info(`Saved storage state to: ${path}`);
    }
  }

  async getChannelMessages(channelId: string, limit: number = 100): Promise<DiscordMessage[]> {
    return await this.database.getMessagesByChannel(channelId, limit);
  }

  async getThreadMessages(threadId: string): Promise<DiscordMessage[]> {
    return await this.database.getThreadMessages(threadId);
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping Discord monitor...');

    // Close all pages
    for (const [channelId, page] of this.pages) {
      try {
        await page.close();
        this.logger.debug(`Closed tab for channel: ${channelId}`);
      } catch (error) {
        this.logger.warn(`Error closing tab for channel ${channelId}:`, error);
      }
    }
    this.pages.clear();

    // Close browser context and browser
    if (this.context) {
      await this.context.close();
    }
    
    if (this.browser) {
      await this.browser.close();
    }

    // Close database connection
    await this.database.close();

    this.logger.info('Discord monitor stopped');
  }
}