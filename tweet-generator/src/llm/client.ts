import type { LlmConfig } from '../config.js'

/** Any failure talking to the model. The cycle is skipped; nothing is written. */
export class LlmError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmError'
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>
}

export class LlmClient {
  constructor(
    private readonly config: LlmConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`
    }

    let response: Response
    try {
      response = await this.fetchImpl(
        `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: this.config.model,
            messages,
            stream: false,
            // Deliberately no response_format. OmniRoute's lower provider
            // tiers ignore it, so depending on it would break on exactly the
            // days the router falls back. extractJson plus the validator do
            // the job instead.
            temperature: 0.7,
          }),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        },
      )
    } catch (cause) {
      throw new LlmError('The LLM request failed', { cause })
    }

    if (!response.ok) {
      throw new LlmError(`The LLM returned ${response.status}`)
    }

    const body = (await response.json()) as ChatResponse
    const content = body.choices?.[0]?.message?.content
    if (!content) {
      throw new LlmError('The LLM returned no content')
    }
    return content
  }
}

/**
 * Pulls the first complete JSON object out of a reply.
 *
 * Weaker models narrate around their output and wrap it in code fences, and
 * no amount of prompting reliably stops that. Scanning for a balanced object
 * — while tracking string state, so a brace inside a string does not end it —
 * costs twenty lines and removes a whole class of retry.
 */
export function extractJson<T>(raw: string): T {
  const start = raw.indexOf('{')
  if (start === -1) {
    throw new LlmError('The LLM reply contained no JSON object')
  }

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < raw.length; i++) {
    const char = raw[i]!

    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && inString) {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (char === '{') depth++
    if (char === '}') {
      depth--
      if (depth === 0) {
        const slice = raw.slice(start, i + 1)
        try {
          return JSON.parse(slice) as T
        } catch (cause) {
          throw new LlmError('The LLM reply was not valid JSON', { cause })
        }
      }
    }
  }

  throw new LlmError('The LLM reply contained an unterminated JSON object')
}
