import { createHash } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'

const WIDTH = 1600
const HEIGHT = 900

/**
 * A deterministic filename, so a retried candidate overwrites its own file
 * rather than orphaning one. Hashing is also what makes a dedupe key full of
 * colons and slashes safe to put on a filesystem.
 */
export function mediaPathFor(mediaDir: string, dedupeKey: string): string {
  const digest = createHash('sha256')
    .update(dedupeKey)
    .digest('hex')
    .slice(0, 16)
  return join(mediaDir, `${digest}.png`)
}

/**
 * Renders one card in a throwaway headless Chromium.
 *
 * A browser is launched and closed per render on purpose. At one image every
 * two hours there is no throughput to gain, and a long-lived instance is a
 * leak, a wedge risk, and a health check to maintain.
 *
 * This must never touch the x-poster's Chrome profile: that one holds a live
 * x.com session behind an open CDP debugging port, and any local process
 * that connects to it gains full control of the account.
 */
export async function renderCard(html: string, outPath: string): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true })

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 2,
    })
    await page.setContent(html, { waitUntil: 'load' })
    // Embedded fonts decode asynchronously; screenshotting before they are
    // ready captures a fallback face and different metrics.
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: outPath })
  } finally {
    await browser.close()
  }
}

/** Returns how many files were actually removed. */
export async function cleanupMedia(paths: string[]): Promise<number> {
  let removed = 0
  for (const path of paths) {
    try {
      await unlink(path)
      removed++
    } catch {
      // Already gone is the expected steady state: retention runs every
      // cycle against rows a previous run may have cleaned.
    }
  }
  return removed
}
