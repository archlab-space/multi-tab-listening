import { DiscordMessage } from './types.js'

export class MessageFilter {
  private trivialPhrases: Set<string>
  private minLength: number

  constructor(trivialPhrases: string[] = [], minLength: number = 30) {
    // Default trivial phrases
    const defaultTrivial = [
      'hi',
      'hello',
      'hey',
      'sup',
      'yo',
      'good morning',
      'good afternoon',
      'good evening',
      'good night',
      'gm',
      'gn',
      'ty',
      'thanks',
      'thx',
      'lol',
      'lmao',
      'haha',
      'ok',
      'okay',
      'yes',
      'no',
      'yep',
      'nope',
      'sure',
      'brb',
      'gtg',
      'ttyl',
      'afk',
      '+1',
      '-1',
      '👍',
      '👎',
      '❤️',
      '🔥',
      'same',
      'agreed',
      'this',
      'exactly',
      'nice',
      'cool',
      'awesome',
      'great',
    ]

    this.trivialPhrases = new Set([
      ...defaultTrivial,
      ...trivialPhrases.map((p) => p.toLowerCase()),
    ])
    this.minLength = minLength
  }

  isTrivial(message: DiscordMessage): boolean {
    const content = message.content.trim().toLowerCase()

    // Check if message is too short
    if (content.length < this.minLength) {
      return true
    }

    // Remove common punctuation and emojis for checking
    const cleanContent = content
      .replace(/[.,!?:;'"(){}[\]@#$%^&*+=~`|\\<>]/g, '')
      .trim()

    // Check if it's just trivial phrases
    if (this.trivialPhrases.has(cleanContent)) {
      return true
    }

    // Check if it's only emojis/reactions
    const emojiRegex =
      /^[\u{1F600}-\u{1F64F}|\u{1F300}-\u{1F5FF}|\u{1F680}-\u{1F6FF}|\u{1F1E0}-\u{1F1FF}|\u{2600}-\u{26FF}|\u{2700}-\u{27BF}|\s]+$/u
    if (emojiRegex.test(content)) {
      return true
    }

    // Check if it's just mentions without meaningful content
    const withoutMentions = content.replace(/<@[!&]?\d+>/g, '').trim()
    if (
      withoutMentions.length === 0 ||
      this.trivialPhrases.has(withoutMentions)
    ) {
      return true
    }

    return false
  }

  hasKeywords(message: DiscordMessage, keywords: string[]): boolean {
    const content = message.content.toLowerCase()
    return keywords.some((keyword) => content.includes(keyword.toLowerCase()))
  }

  isFromBot(message: DiscordMessage): boolean {
    // Check if the message is from a bot (common bot indicators)
    return (
      message.rawData?.author?.bot === true ||
      message.authorName.toLowerCase().includes('bot') ||
      message.authorId.endsWith('0000')
    ) // Discord bot IDs often end in 0000
  }

  shouldProcess(
    message: DiscordMessage,
    options: {
      ignoreBots?: boolean
      requiredKeywords?: string[]
      customTrivialCheck?: (msg: DiscordMessage) => boolean
    } = {},
  ): boolean {
    const {
      ignoreBots = true,
      requiredKeywords = [],
      customTrivialCheck,
    } = options

    // Skip bot messages if configured
    if (ignoreBots && this.isFromBot(message)) {
      return false
    }

    // Check for required keywords
    if (
      requiredKeywords.length > 0 &&
      !this.hasKeywords(message, requiredKeywords)
    ) {
      return false
    }

    // Check if message is trivial
    if (this.isTrivial(message)) {
      return false
    }

    // Apply custom trivial check if provided
    if (customTrivialCheck && customTrivialCheck(message)) {
      return false
    }

    return true
  }
}
