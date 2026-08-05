/**
 * The five sources together are a firehose, not a niche. This narrows them
 * to what an AI developer can act on, and it runs before anything else so
 * that filtered material never costs an LLM call.
 *
 * Matched against `title + summary`.
 */
const RULES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    name: 'crypto',
    pattern: /crypto|web3|blockchain|on-chain|\bNFT\b|DePIN|airdrop/i,
  },
  {
    // `token` is deliberately NOT a deny term on its own. `tokens/sec`,
    // `tokenizer`, and `2M tokens of context` are core vocabulary here, and
    // a bare \btoken rule rejects most of the material this account exists
    // to post. The crypto sense needs these specific phrases — and the
    // crypto rule above already catches the AI × Crypto digests unaided.
    name: 'crypto',
    pattern: /\btokenomics\b|\btoken (sale|price|holders)\b/i,
  },
  {
    name: 'business',
    pattern: /\bfunding\b|raises \$|\bvaluation\b|\bacquires\b|\bIPO\b/i,
  },
]

/** The rule that rejected this text, or null if it passed. */
export function nicheRejectionReason(text: string): string | null {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.name
  }
  return null
}

export function passesNicheGate(text: string): boolean {
  return nicheRejectionReason(text) === null
}
