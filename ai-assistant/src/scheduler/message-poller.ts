import * as cron from 'node-cron';
import winston from 'winston';
import { DatabaseQueries } from '../database/queries.js';
import { MessageAnalyzer } from '../ai/message-analyzer.js';
import { config } from '../config.js';
import type { DiscordMessage } from '../types.js';
import type { QuestionAnalysis } from '../ai/message-analyzer.js';

export class MessagePoller {
  private db: DatabaseQueries;
  private analyzer: MessageAnalyzer;
  private logger: winston.Logger;
  private isProcessing: boolean = false;
  private onQuestionsFound?: (questions: QuestionAnalysis[]) => Promise<void>;

  constructor() {
    this.db = new DatabaseQueries();
    this.analyzer = new MessageAnalyzer();
    
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
    if (this.isProcessing) {
      this.logger.warn('Previous processing still running, skipping this cycle');
      return [];
    }

    this.isProcessing = true;

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
      
      // Filter for high-confidence questions
      const questions = await this.analyzer.filterQuestions(analyses, 70);

      this.logger.info(`Found ${questions.length} questions out of ${analyses.length} messages`);

      // Mark all messages as processed
      const messageIds = unprocessedMessages.map(msg => msg.messageId);
      await this.markMessagesAsProcessed(messageIds);

      // Notify callback if questions found
      if (questions.length > 0 && this.onQuestionsFound) {
        await this.onQuestionsFound(questions);
      }

      return questions;

    } catch (error) {
      this.logger.error('Error processing messages:', error);
      return [];
    } finally {
      this.isProcessing = false;
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

  start(): void {
    const cronExpression = `*/${config.polling.intervalMinutes} * * * *`;
    
    this.logger.info(`Starting message poller with ${config.polling.intervalMinutes}min interval`);

    cron.schedule(cronExpression, async () => {
      await this.processNewMessages();
    });
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping message poller...');
    await this.db.close();
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
}