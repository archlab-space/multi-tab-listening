import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { chromium, type Browser, type Page } from 'playwright'
import type winston from 'winston'
import type { XPosterConfig } from '../config.js'
import { FatalError } from '../errors.js'
import { buildLaunchArgs } from './launch-args.js'

export interface BrowserHandle {
  browser: Browser
  page: Page
  /** Closes our page. Kills Chrome only if we were the one who started it. */
  close(): Promise<void>
}

export function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    const settle = (open: boolean) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(1000)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

async function waitForPort(
  port: number,
  timeoutMs: number,
  logger: winston.Logger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  logger.error('Chrome did not open its debugging port in time', { port })
  throw new FatalError(
    `Chrome did not open a debugging port on 127.0.0.1:${port} within ${timeoutMs}ms`,
  )
}

function spawnChrome(
  config: XPosterConfig,
  logger: winston.Logger,
): ChildProcess {
  const args = buildLaunchArgs(config.profileDir, config.debugPort)
  logger.info('Starting Chrome', { path: config.chromePath, args })

  const child = spawn(config.chromePath, args, {
    detached: false,
    stdio: 'ignore',
  })
  child.on('error', (error) => {
    logger.error('Chrome failed to start', { error: error.message })
  })
  return child
}

/**
 * Attaches to a Chrome already listening on the debugging port, or starts one
 * if nothing is there.
 *
 * The distinction matters on shutdown: a browser the operator started is
 * theirs, and closing it out from under them would be rude. We only ever kill
 * a Chrome we spawned ourselves.
 */
export async function connectOrLaunch(
  config: XPosterConfig,
  logger: winston.Logger,
): Promise<BrowserHandle> {
  let child: ChildProcess | null = null

  if (await isPortOpen(config.debugPort)) {
    logger.info('Attaching to the Chrome already on the debugging port', {
      port: config.debugPort,
    })
  } else {
    child = spawnChrome(config, logger)
    await waitForPort(config.debugPort, 30_000, logger)
  }

  const browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${config.debugPort}`,
  )
  const context = browser.contexts()[0]
  if (!context) {
    throw new FatalError('Chrome exposed no browser context over CDP')
  }

  // Our own tab. Never brought to the front — the operator's focus is theirs.
  const page = await context.newPage()

  return {
    browser,
    page,
    async close() {
      await page.close().catch(() => {})
      if (child) {
        await browser.close().catch(() => {})
        child.kill('SIGTERM')
      } else {
        // Attached, not owned: disconnect without closing the browser.
        await browser.close().catch(() => {})
      }
    },
  }
}
