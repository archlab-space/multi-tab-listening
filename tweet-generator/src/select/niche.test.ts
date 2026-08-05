import { describe, expect, it } from 'vitest'
import { nicheRejectionReason, passesNicheGate } from './niche.js'

describe('passesNicheGate', () => {
  it('rejects the crypto digest', () => {
    expect(
      passesNicheGate(
        'AI × Crypto Roundup: Agent Payments, Decentralized Compute',
      ),
    ).toBe(false)
  })

  it('keeps the frontier tech digest', () => {
    expect(
      passesNicheGate('AI & Frontier Tech Roundup – Model Scaling, Agent Routers'),
    ).toBe(true)
  })

  it('rejects web3 and blockchain material', () => {
    expect(passesNicheGate('A web3 identity layer for agents')).toBe(false)
    expect(passesNicheGate('Blockchain-verified inference')).toBe(false)
  })

  it('rejects funding news', () => {
    expect(passesNicheGate('Anthropic raises $5B at a new valuation')).toBe(false)
    expect(passesNicheGate('Nvidia acquires an inference startup')).toBe(false)
  })

  it('keeps token vocabulary, which is core to this niche', () => {
    // A bare \btoken rule rejects most of the material this account exists
    // to post. The crypto sense is matched by specific phrases instead.
    expect(passesNicheGate('2M tokens of context on a single GPU')).toBe(true)
    expect(passesNicheGate('A faster tokenizer for Llama models')).toBe(true)
    expect(passesNicheGate('Throughput hits 4200 tokens/sec')).toBe(true)
    expect(passesNicheGate('Cutting the token budget by 40%')).toBe(true)
  })

  it('still rejects the crypto sense of token', () => {
    expect(passesNicheGate('Tokenomics for autonomous agents')).toBe(false)
    expect(passesNicheGate('The token sale opens Monday')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(passesNicheGate('CRYPTO agents')).toBe(false)
  })
})

describe('nicheRejectionReason', () => {
  it('names the rule that fired, for the log', () => {
    expect(nicheRejectionReason('AI × Crypto Roundup')).toBe('crypto')
    expect(nicheRejectionReason('Anthropic raises $5B')).toBe('business')
    expect(nicheRejectionReason('2M tokens of context')).toBeNull()
  })
})
