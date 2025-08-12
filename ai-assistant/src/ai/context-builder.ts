import type { DiscordMessage } from '../types.js';

export interface MessageContext {
  originalMessage: DiscordMessage;
  relatedMessages: DiscordMessage[];
  threadMessages?: DiscordMessage[];
  totalContextLength: number;
}

export class ContextBuilder {
  
  buildContext(
    targetMessage: DiscordMessage, 
    relatedMessages: DiscordMessage[],
    maxContextLength: number = 4000
  ): MessageContext {
    let totalLength = targetMessage.content.length;
    const selectedMessages: DiscordMessage[] = [];

    // Sort messages by relevance (most recent first, but prioritize replies)
    const sortedMessages = this.sortMessagesByRelevance(targetMessage, relatedMessages);

    // Add messages until we reach the context length limit
    for (const message of sortedMessages) {
      const messageLength = message.content.length + 50; // Account for metadata
      
      if (totalLength + messageLength > maxContextLength) {
        break;
      }
      
      selectedMessages.push(message);
      totalLength += messageLength;
    }

    return {
      originalMessage: targetMessage,
      relatedMessages: selectedMessages,
      totalContextLength: totalLength
    };
  }

  private sortMessagesByRelevance(
    targetMessage: DiscordMessage, 
    messages: DiscordMessage[]
  ): DiscordMessage[] {
    return messages
      .filter(msg => msg.messageId !== targetMessage.messageId)
      .sort((a, b) => {
        // Prioritize replies to the target message
        if (a.replyToMessageId === targetMessage.messageId) return -1;
        if (b.replyToMessageId === targetMessage.messageId) return 1;
        
        // Prioritize messages from the same thread
        if (targetMessage.threadId && a.threadId === targetMessage.threadId) return -1;
        if (targetMessage.threadId && b.threadId === targetMessage.threadId) return 1;
        
        // Prioritize more recent messages
        return b.timestamp.getTime() - a.timestamp.getTime();
      });
  }

  buildPromptContext(context: MessageContext): string {
    const { originalMessage, relatedMessages } = context;
    
    let prompt = `Original Question:\n`;
    prompt += `${originalMessage.authorName} (${originalMessage.timestamp.toISOString()}): ${originalMessage.content}\n\n`;
    
    if (relatedMessages.length > 0) {
      prompt += `Recent Channel Context:\n`;
      for (const message of relatedMessages.slice(0, 10)) { // Limit to 10 most relevant
        prompt += `${message.authorName} (${message.timestamp.toISOString()}): ${message.content}\n`;
      }
    }
    
    return prompt;
  }

  extractKeywords(message: DiscordMessage): string[] {
    // Simple keyword extraction - could be enhanced with NLP
    const text = message.content.toLowerCase();
    const words = text.split(/\s+/);
    
    // Filter out common words and short words
    const stopWords = new Set(['the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but', 'in', 'with', 'to', 'for', 'of', 'as', 'by']);
    
    return words
      .filter(word => word.length > 3 && !stopWords.has(word))
      .filter(word => /^[a-zA-Z]+$/.test(word)) // Only alphabetic words
      .slice(0, 10); // Limit to 10 keywords
  }
}