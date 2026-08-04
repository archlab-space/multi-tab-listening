import { describe, expect, it } from 'vitest'
import { FORBIDDEN_ARGS, buildLaunchArgs } from './launch-args.js'

describe('buildLaunchArgs', () => {
  it('produces exactly the six arguments the design permits', () => {
    expect(buildLaunchArgs('/tmp/x-profile', 9333)).toEqual([
      '--user-data-dir=/tmp/x-profile',
      '--remote-debugging-port=9333',
      '--remote-debugging-address=127.0.0.1',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ])
  })

  it('binds the debugging port to loopback only', () => {
    // An open debugging port grants full control over every session in the
    // profile to whoever can reach it.
    expect(buildLaunchArgs('/tmp/x-profile', 9333)).toContain(
      '--remote-debugging-address=127.0.0.1',
    )
  })

  it('always passes an explicit user-data-dir', () => {
    // Chrome 136+ ignores --remote-debugging-port without one.
    const args = buildLaunchArgs('/tmp/x-profile', 9333)
    expect(args.some((a) => a.startsWith('--user-data-dir='))).toBe(true)
  })

  it('contains no automation tell', () => {
    const args = buildLaunchArgs('/tmp/x-profile', 9333)
    for (const forbidden of FORBIDDEN_ARGS) {
      expect(args.some((a) => a.startsWith(forbidden))).toBe(false)
    }
  })

  it('rejects an empty profile directory', () => {
    expect(() => buildLaunchArgs('', 9333)).toThrow(/profile directory/i)
  })
})
