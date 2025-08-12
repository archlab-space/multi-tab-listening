import winston from 'winston';
import { FireworksClient } from './fireworks-client.js';
import { DatabaseQueries } from '../database/queries.js';
import type { DiscordMessage } from '../types.js';

export interface QuestionAnalysis {
  message: DiscordMessage;
  isQuestion: boolean;
  questionType?: 'technical' | 'general' | 'support' | 'discussion';
  confidence: number;
  extractedQuestion?: string;
  suggestedAnswer?: string;
  contextMessages?: DiscordMessage[];
}

export class MessageAnalyzer {
  private fireworks: FireworksClient;
  private db: DatabaseQueries;
  private logger: winston.Logger;

  constructor() {
    this.fireworks = new FireworksClient();
    this.db = new DatabaseQueries();
    
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({ filename: 'message-analyzer.log' }),
        new winston.transports.Console()
      ],
    });
  }

  async analyzeMessages(messages: DiscordMessage[]): Promise<QuestionAnalysis[]> {
    const analyses: QuestionAnalysis[] = [];

    for (const message of messages) {
      try {
        const analysis = await this.analyzeMessage(message);
        analyses.push(analysis);
        
        // Small delay to avoid overwhelming the API
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        this.logger.error('Error analyzing message:', { 
          messageId: message.messageId, 
          error 
        });
        
        // Add failed analysis to maintain order
        analyses.push({
          message,
          isQuestion: false,
          confidence: 0
        });
      }
    }

    return analyses;
  }

  async analyzeMessage(message: DiscordMessage): Promise<QuestionAnalysis> {
    this.logger.info('Analyzing message for questions', {
      messageId: message.messageId,
      contentLength: message.content.length,
      author: message.authorName
    });

    // Step 1: Check if message contains a question
    const questionAnalysis = await this.fireworks.analyzeMessage(message.content);

    const analysis: QuestionAnalysis = {
      message,
      isQuestion: questionAnalysis.isQuestion,
      questionType: questionAnalysis.questionType,
      confidence: questionAnalysis.confidence,
      extractedQuestion: questionAnalysis.extractedQuestion
    };

    // Step 2: If it's a question with decent confidence, generate suggested answer
    if (questionAnalysis.isQuestion && questionAnalysis.confidence >= 70) {
      try {
        // Get related messages from the same channel for context
        const contextMessages = await this.db.getRelatedMessages(
          message.channelId, 
          20 // Get last 20 processed messages for context
        );

        analysis.contextMessages = contextMessages;

        // Generate suggested answer using context
        if (contextMessages.length > 0) {
          const contextForAI = contextMessages.map(msg => ({
            content: msg.content,
            author: msg.authorName,
            timestamp: msg.timestamp
          }));

          analysis.suggestedAnswer = await this.fireworks.generateAnswer(
            questionAnalysis.extractedQuestion || message.content,
            contextForAI
          );
        } else {
          analysis.suggestedAnswer = "No previous context available to generate answer.";
        }

        this.logger.info('Generated answer for question', {
          messageId: message.messageId,
          questionType: questionAnalysis.questionType,
          confidence: questionAnalysis.confidence,
          contextMessagesCount: contextMessages.length,
          answerLength: analysis.suggestedAnswer?.length || 0
        });

      } catch (error) {
        this.logger.error('Error generating answer for question:', {
          messageId: message.messageId,
          error
        });
        analysis.suggestedAnswer = "Error generating suggested answer.";
      }
    }

    return analysis;
  }

  async filterQuestions(analyses: QuestionAnalysis[], minConfidence: number = 70): Promise<QuestionAnalysis[]> {
    return analyses.filter(analysis => 
      analysis.isQuestion && 
      analysis.confidence >= minConfidence &&
      analysis.suggestedAnswer
    );
  }
}