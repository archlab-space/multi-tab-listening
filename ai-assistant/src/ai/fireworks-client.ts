import type winston from 'winston'
import { createLogger } from 'shared/logger'
import { config } from '../config.js';

export interface FireworksMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface FireworksResponse {
  choices: Array<{
    message: {
      content: string;
      role: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class FireworksClient {
  private apiKey: string;
  private baseUrl = 'https://api.fireworks.ai/inference/v1';
  private logger: winston.Logger;

  constructor() {
    this.apiKey = config.fireworksApiKey;
    
    if (!this.apiKey) {
      throw new Error('FIREWORKS_API_KEY is required');
    }

    this.logger = createLogger('fireworks-ai.log')
  }

  async chat(
    messages: FireworksMessage[],
    model: string = 'accounts/fireworks/models/llama-v3p1-70b-instruct',
    options?: {
      temperature?: number;
      max_tokens?: number;
      top_p?: number;
    }
  ): Promise<string> {
    const requestBody = {
      model,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.max_tokens ?? 2000,
      top_p: options?.top_p ?? 0.9,
    };

    try {
      this.logger.info('Making Fireworks AI request', { 
        model, 
        messageCount: messages.length,
        options 
      });

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Fireworks API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as FireworksResponse;
      
      if (!data.choices || data.choices.length === 0) {
        throw new Error('No response choices returned from Fireworks AI');
      }

      const firstChoice = data.choices[0];
      if (!firstChoice || !firstChoice.message) {
        throw new Error('Invalid response format from Fireworks AI');
      }

      const result = firstChoice.message.content;
      
      this.logger.info('Fireworks AI response received', {
        responseLength: result.length,
        usage: data.usage,
        finishReason: firstChoice.finish_reason
      });

      return result;

    } catch (error) {
      this.logger.error('Error calling Fireworks AI:', error);
      throw error;
    }
  }

  async analyzeMessage(messageContent: string): Promise<{
    isQuestion: boolean;
    questionType?: 'technical' | 'general' | 'support' | 'discussion';
    confidence: number;
    extractedQuestion?: string;
  }> {
    const messages: FireworksMessage[] = [
      {
        role: 'system',
        content: `You are an expert at analyzing Discord messages to identify questions that might need answers. 

Analyze the given message and determine:
1. If it contains a question that someone might want to answer
2. What type of question it is
3. Your confidence level (0-100)
4. Extract the core question if found

Consider these as questions:
- Direct questions with question marks
- Requests for help ("how do I...", "can someone help with...")
- Technical problems ("I'm having trouble with...", "X is not working...")
- Seeking recommendations ("what's the best...", "which should I use...")

Don't consider these as questions:
- Rhetorical questions
- Greetings
- Simple acknowledgments
- Statements that happen to end with "?"

Respond ONLY with a JSON object in this exact format:
{
  "isQuestion": true/false,
  "questionType": "technical|general|support|discussion",
  "confidence": 0-100,
  "extractedQuestion": "the main question or null"
}`
      },
      {
        role: 'user',
        content: messageContent
      }
    ];

    try {
      const response = await this.chat(messages, 'accounts/fireworks/models/llama-v3p1-70b-instruct', {
        temperature: 0.3,
        max_tokens: 300
      });

      // Parse JSON response
      const parsed = JSON.parse(response.trim());
      
      return {
        isQuestion: parsed.isQuestion || false,
        questionType: parsed.questionType,
        confidence: parsed.confidence || 0,
        extractedQuestion: parsed.extractedQuestion
      };

    } catch (error) {
      this.logger.error('Error analyzing message:', { messageContent, error });
      // Return safe defaults on error
      return {
        isQuestion: false,
        confidence: 0
      };
    }
  }

  async generateAnswer(
    question: string,
    context: Array<{ content: string; author: string; timestamp: Date }>,
    channelContext?: string
  ): Promise<string> {
    const hasContext = context && context.length > 0;
    const contextText = hasContext 
      ? context.map(msg => `${msg.author} (${msg.timestamp.toISOString()}): ${msg.content}`).join('\n')
      : '';

    const messages: FireworksMessage[] = [
      {
        role: 'system',
        content: `You are a helpful Discord assistant that provides accurate and concise answers to user questions.

Your approach:
1. FIRST: Check if the provided channel context contains relevant information to answer the question
2. If the context is helpful and relevant, use it to provide a specific answer with references
3. If the context is empty, incomplete, or not relevant to the question, draw from your general knowledge
4. Always be honest about your information sources

Guidelines:
- Keep answers concise and Discord-appropriate (1-3 short paragraphs max)
- Be conversational and helpful
- When using context: Reference specific messages or users when relevant
- When using general knowledge: Be clear that you're providing general information
- If unsure about specifics, acknowledge uncertainty
- Avoid overly long explanations

Context quality: The provided context contains recent messages from this Discord channel that may or may not be relevant to the current question.`
      },
      {
        role: 'user',
        content: hasContext 
          ? `Question: ${question}

${channelContext ? `Channel: ${channelContext}\n` : ''}

Recent channel messages (ranked by relevance):
${contextText}

Please answer the question. Use the channel context if it's relevant, otherwise provide a helpful answer based on your knowledge.`
          : `Question: ${question}

${channelContext ? `Channel: ${channelContext}\n` : ''}

No relevant channel context available. Please provide a helpful answer based on your general knowledge.`
      }
    ];

    try {
      return await this.chat(messages, 'accounts/fireworks/models/llama-v3p1-70b-instruct', {
        temperature: 0.7,
        max_tokens: 1000
      });
    } catch (error) {
      this.logger.error('Error generating answer:', { question, error });
      throw error;
    }
  }
}