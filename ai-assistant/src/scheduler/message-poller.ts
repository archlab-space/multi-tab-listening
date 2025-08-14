import winston from 'winston';
import { DatabaseQueries } from '../database/queries.js';
import { MessageAnalyzer } from '../ai/message-analyzer.js';
import { DiscordWebhookSender } from '../discord/webhook-sender.js';
import { config } from '../config.js';
import type { DiscordMessage } from '../types.js';
import type { QuestionAnalysis } from '../ai/message-analyzer.js';

export class MessagePoller {
  private db: DatabaseQueries;
  private analyzer: MessageAnalyzer;
  private webhookSender: DiscordWebhookSender;
  private logger: winston.Logger;
  private isRunning: boolean = false;
  private shouldStop: boolean = false;
  private onQuestionsFound?: (questions: QuestionAnalysis[]) => Promise<void>;

  constructor() {
    this.db = new DatabaseQueries();
    this.analyzer = new MessageAnalyzer();
    this.webhookSender = new DiscordWebhookSender();
    
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({ filename: 'message-poller.log' }),
        new winston.transports.Console()
      ],
    });
  }

  async processNewMessages(): Promise<QuestionAnalysis[]> {
    const startTime = Date.now();
    
    try {
      this.logger.info('Starting message processing cycle');

      const unprocessedMessages = await this.db.getUnprocessedMessages(
        config.polling.batchSize
      );

      if (unprocessedMessages.length === 0) {
        this.logger.info('No unprocessed messages found');
        return [];
      }

      this.logger.info(`Found ${unprocessedMessages.length} unprocessed messages`);

      // Analyze messages with AI
      const analyses = await this.analyzer.analyzeMessages(unprocessedMessages);
      
      // Store question analysis results in database
      for (const analysis of analyses) {
        await this.db.updateMessageQuestionAnalysis(
          analysis.message.messageId,
          analysis.isQuestion,
          analysis.confidence,
          analysis.questionType
        );
      }
      
      // Filter for high-confidence questions
      const questions = await this.analyzer.filterQuestions(analyses, 70);

      const processingTime = Date.now() - startTime;
      this.logger.info(`Found ${questions.length} questions out of ${analyses.length} messages (${processingTime}ms)`);

      // Mark all messages as processed
      const messageIds = unprocessedMessages.map(msg => msg.messageId);
      await this.markMessagesAsProcessed(messageIds);

      // Send questions to Discord webhook
      if (questions.length > 0) {
        try {
          await this.webhookSender.sendMultipleQuestions(questions);
          this.logger.info(`Sent ${questions.length} questions to Discord webhook`);
        } catch (error) {
          this.logger.error('Failed to send questions to Discord webhook:', error);
          // Continue processing even if webhook fails
        }
      }

      // Notify callback if questions found
      if (questions.length > 0 && this.onQuestionsFound) {
        await this.onQuestionsFound(questions);
      }

      return questions;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      this.logger.error('Error processing messages:', { error, processingTime });
      return [];
    }
  }

  async markMessagesAsProcessed(messageIds: string[]): Promise<void> {
    try {
      await this.db.markMultipleMessagesAsProcessed(messageIds);
    } catch (error) {
      this.logger.error('Error marking messages as processed:', error);
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Message poller is already running');
      return;
    }

    this.isRunning = true;
    this.shouldStop = false;
    
    this.logger.info(`Starting message poller with ${config.polling.intervalMinutes}min base interval`);

    await this.processingLoop();
  }

  private async processingLoop(): Promise<void> {
    while (!this.shouldStop) {
      try {
        const questions = await this.processNewMessages();
        
        // Adaptive delay based on activity
        let delay: number;
        if (questions.length > 0) {
          // Found questions - check again sooner
          delay = 30000; // 30 seconds
          this.logger.info(`Found ${questions.length} questions, checking again in 30s`);
        } else {
          // No questions - standard interval
          delay = config.polling.intervalMinutes * 60 * 1000; // Convert minutes to ms
          this.logger.info(`No questions found, checking again in ${config.polling.intervalMinutes}m`);
        }

        // Wait with interruption support
        await this.interruptibleDelay(delay);
        
      } catch (error) {
        this.logger.error('Error in processing loop:', error);
        
        // Back off on error - wait 2 minutes
        await this.interruptibleDelay(120000);
      }
    }

    this.logger.info('Processing loop stopped');
    this.isRunning = false;
  }

  private async interruptibleDelay(ms: number): Promise<void> {
    const checkInterval = 1000; // Check for stop signal every second
    let elapsed = 0;
    
    while (elapsed < ms && !this.shouldStop) {
      await new Promise(resolve => setTimeout(resolve, Math.min(checkInterval, ms - elapsed)));
      elapsed += checkInterval;
    }
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping message poller...');
    this.shouldStop = true;
    
    // Wait for processing loop to finish
    while (this.isRunning) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    await this.db.close();
    this.logger.info('Message poller stopped');
  }

  // Set callback for when questions are found
  onQuestionsFoundCallback(callback: (questions: QuestionAnalysis[]) => Promise<void>): void {
    this.onQuestionsFound = callback;
  }

  // Manual trigger for testing
  async triggerProcessing(): Promise<QuestionAnalysis[]> {
    this.logger.info('Manual trigger for message processing');
    return await this.processNewMessages();
  }

  // Test webhook connection
  async testWebhook(): Promise<boolean> {
    this.logger.info('Testing Discord webhook connection');
    return await this.webhookSender.testWebhook();
  }
}