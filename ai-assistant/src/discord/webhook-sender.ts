import winston from 'winston'
import { config } from '../config.js'
import type { QuestionAnalysis } from '../ai/message-analyzer.js'

export interface DiscordEmbed {
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
  url?: string
}

export interface DiscordWebhookPayload {
  content?: string
  embeds?: DiscordEmbed[]
  username?: string
  avatar_url?: string
}

export class DiscordWebhookSender {
  private webhookUrl: string
  private logger: winston.Logger

  constructor() {
    this.webhookUrl = config.discordWebhookUrl

    if (!this.webhookUrl) {
      throw new Error('DISCORD_WEBHOOK_URL is required')
    }

    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
      ),
      transports: [
        new winston.transports.File({ filename: 'discord-webhook.log' }),
        new winston.transports.Console(),
      ],
    })
  }

  async sendQuestionAndAnswer(analysis: QuestionAnalysis): Promise<void> {
    if (!analysis.suggestedAnswer) {
      this.logger.warn('No suggested answer available for question', {
        messageId: analysis.message.messageId,
      })
      return
    }

    try {
      const embed = this.createQuestionAnswerEmbed(analysis)
      const payload: DiscordWebhookPayload = {
        username: 'AI Assistant',
        embeds: [embed],
      }

      await this.sendWebhook(payload)

      this.logger.info('Question and answer sent to Discord', {
        messageId: analysis.message.messageId,
        confidence: analysis.confidence,
        questionType: analysis.questionType,
      })
    } catch (error) {
      this.logger.error('Error sending question and answer to Discord:', {
        messageId: analysis.message.messageId,
        error,
      })
      throw error
    }
  }

  async sendMultipleQuestions(analyses: QuestionAnalysis[]): Promise<void> {
    if (analyses.length === 0) return

    try {
      // Send questions in batches to avoid Discord rate limits
      const batchSize = 5
      for (let i = 0; i < analyses.length; i += batchSize) {
        const batch = analyses.slice(i, i + batchSize)

        for (const analysis of batch) {
          await this.sendQuestionAndAnswer(analysis)
          // Small delay between requests to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }

      this.logger.info(`Sent ${analyses.length} questions to Discord`)
    } catch (error) {
      this.logger.error('Error sending multiple questions to Discord:', error)
      throw error
    }
  }

  private createQuestionAnswerEmbed(analysis: QuestionAnalysis): DiscordEmbed {
    const {
      message,
      confidence,
      questionType,
      extractedQuestion,
      suggestedAnswer,
      contextMessages,
    } = analysis

    // Create Discord message URL (approximate - you may need to adjust based on actual Discord URLs)
    const messageUrl = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.messageId}`

    const embed: DiscordEmbed = {
      title: '🤖 AI Assistant - Question Detected',
      color: this.getColorByConfidence(confidence),
      fields: [
        {
          name: '❓ Original Question',
          value: `**Author:** ${message.authorName}\n**Content:** ${message.content}`,
          inline: false,
        },
        {
          name: '🎯 Extracted Question',
          value: extractedQuestion || 'N/A',
          inline: false,
        },
        {
          name: '💡 Suggested Answer',
          value: this.truncateText(
            suggestedAnswer || 'No answer generated',
            1000,
          ),
          inline: false,
        },
        {
          name: '📊 Analysis',
          value: `**Confidence:** ${confidence}%\n**Type:** ${
            questionType || 'Unknown'
          }\n**Context Messages:** ${contextMessages?.length || 0}`,
          inline: true,
        },
        {
          name: '🔗 Original Message',
          value: `[View in Discord](${messageUrl})`,
          inline: true,
        },
      ],
      footer: {
        text: `Channel ID: ${message.channelId} • Message ID: ${message.messageId}`,
      },
      timestamp: new Date().toISOString(),
    }

    return embed
  }

  private getColorByConfidence(confidence: number): number {
    if (confidence >= 90) return 0x00ff00 // Green - high confidence
    if (confidence >= 80) return 0xffff00 // Yellow - medium confidence
    if (confidence >= 70) return 0xff8000 // Orange - low confidence
    return 0xff0000 // Red - very low confidence
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text
    return text.substring(0, maxLength - 3) + '...'
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
      this.logger.warn('Discord webhook rate limited', { retryAfter })
      throw new Error(`Rate limited. Retry after: ${retryAfter}s`)
    }
  }

  async testWebhook(): Promise<boolean> {
    try {
      const testPayload: DiscordWebhookPayload = {
        content: '🔧 **AI Assistant Test**\nWebhook connection successful!',
        username: 'AI Assistant Test',
      }

      await this.sendWebhook(testPayload)
      this.logger.info('Webhook test successful')
      return true
    } catch (error) {
      this.logger.error('Webhook test failed:', error)
      return false
    }
  }
}
