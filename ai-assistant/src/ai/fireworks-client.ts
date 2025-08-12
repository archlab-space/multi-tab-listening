import winston from 'winston';
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

    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({ filename: 'fireworks-ai.log' }),
        new winston.transports.Console()
      ],
    });
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

      const data: FireworksResponse = await response.json();
      
      if (!data.choices || data.choices.length === 0) {
        throw new Error('No response choices returned from Fireworks AI');
      }

      const result = data.choices[0].message.content;
      
      this.logger.info('Fireworks AI response received', {
        responseLength: result.length,
        usage: data.usage,
        finishReason: data.choices[0].finish_reason
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
    const contextText = context
      .map(msg => `${msg.author} (${msg.timestamp.toISOString()}): ${msg.content}`)
      .join('\n');

    const messages: FireworksMessage[] = [
      {
        role: 'system',
        content: `You are a helpful assistant that answers Discord questions based on previous channel conversations.

Guidelines:
- Use the provided context to give relevant, accurate answers
- If the context doesn't contain enough information, say so clearly
- Keep answers concise and Discord-appropriate (not too long)
- Reference specific previous messages when relevant
- Be conversational but informative
- If you're not sure, express uncertainty rather than guessing

The context below contains previous messages from the same Discord channel.`
      },
      {
        role: 'user',
        content: `Question: ${question}

${channelContext ? `Channel context: ${channelContext}\n` : ''}

Previous messages for context:
${contextText}

Please provide a helpful answer based on this information.`
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