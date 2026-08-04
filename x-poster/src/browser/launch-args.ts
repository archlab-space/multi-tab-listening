/**
 * Arguments that would give the automation away, kept here so the test can
 * assert their absence. `--disable-web-security` additionally strips
 * same-origin protection from a browser holding a live logged-in session.
 */
export const FORBIDDEN_ARGS: readonly string[] = [
  '--no-sandbox',
  '--disable-web-security',
  '--disable-features=VizDisplayCompositor',
  '--enable-automation',
  '--disable-blink-features',
  '--disable-popup-blocking',
  '--headless',
  '--remote-debugging-pipe',
]

/**
 * The complete argument set. Six arguments, no more.
 *
 * The three backgrounding switches defeat background-tab throttling, which
 * would otherwise stall X's lazy-loaded frontend whenever our tab is not
 * frontmost. They are pure scheduling switches: they alter no navigator
 * property and contribute nothing to a fingerprint.
 *
 * Everything else is left alone on purpose. This browser is a real Chrome
 * started by us rather than by Playwright, so navigator.webdriver is already
 * false, and canvas, WebGL, fonts and screen metrics are already genuine.
 * Adding a spoofing layer on top of that is how a fingerprint stops agreeing
 * with itself.
 */
export function buildLaunchArgs(
  profileDir: string,
  debugPort: number,
): string[] {
  if (!profileDir) {
    throw new Error('A dedicated profile directory is required')
  }
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ]
}
