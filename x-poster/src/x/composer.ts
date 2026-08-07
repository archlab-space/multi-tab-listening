import { mkdir } from 'node:fs/promises'
import type { Locator, Page } from 'playwright'
import type winston from 'winston'
import type { XPosterConfig } from '../config.js'
import { FatalError, RetryableError, UncertainError } from '../errors.js'
import { withClipboard } from '../human/clipboard.js'
import { humanDelay, sampleDelay } from '../human/delay.js'
import { elementCentre, travelTo, type Point } from '../human/mouse.js'
import { resolveMediaPath } from '../media.js'
import { HOME_URL, selectors } from './selectors.js'
import { assertLoggedIn } from './session.js'

export interface PostResult {
  url: string | null
  dryRun: boolean
}

/** Where the cursor starts each session. Somewhere unremarkable. */
const CURSOR_ORIGIN: Point = { x: 420, y: 300 }

/** How much of the draft has to be found in the composer to call it pasted. */
const HEAD_LENGTH = 20

/** Every run of whitespace becomes one space, so two spellings compare equal. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Whether the composer is holding the text we pasted.
 *
 * Compared with whitespace collapsed on both sides rather than literally.
 * `digest` and `metric` assemble to multi-line drafts, X renders each
 * paragraph as its own Draft.js block, and `innerText` joins those blocks
 * with a single newline — so the source's `\n\n` never comes back verbatim.
 * A literal comparison therefore rejected every `metric` post (its 40-char
 * field puts the break inside the first 20 characters every time) while
 * passing every single-line `take` and `question`. The text was in the
 * composer throughout; only its whitespace was spelled differently.
 *
 * The check still has to fail closed — it is what stands between a blocked
 * paste or a stale editor selector and a click on submit — so an empty
 * composer is never a match, whatever the draft.
 */
export function pasteLanded(typed: string, content: string): boolean {
  const head = flatten(content).slice(0, HEAD_LENGTH)
  if (head === '') return false
  return flatten(typed).includes(head)
}

async function pointOn(locator: Locator, what: string): Promise<Point> {
  const box = await locator.boundingBox()
  if (!box) {
    throw new FatalError(
      `${what} is present but has no layout box — the page may have changed`,
    )
  }
  return elementCentre(box)
}

/**
 * Step 2 of the script: read the timeline the way a person would.
 *
 * This also does real work beyond looking human. X needs roughly ten seconds
 * or an interaction before the composer exists at all — verified: at six
 * seconds after load the compose elements are absent, after a scroll they
 * are present. Browsing first is what makes step 3 reliable.
 */
async function browseTimeline(page: Page, logger: winston.Logger): Promise<void> {
  const scrolls = 3 + Math.floor(Math.random() * 4)
  logger.debug('Browsing the timeline', { scrolls })

  for (let i = 0; i < scrolls; i++) {
    await page.mouse.wheel(0, sampleDelay(280, 900))
    // Pausing to read is most of what browsing actually is.
    await humanDelay(800, 3500)

    // Occasionally glance back up at something.
    if (Math.random() < 0.25) {
      await page.mouse.wheel(0, -sampleDelay(80, 260))
      await humanDelay(500, 1600)
    }
  }
}

/**
 * The seven-step posting script. The only place that knows the whole flow.
 *
 * Never calls page.bringToFront(): CDP input events reach the tab's renderer
 * directly, so none of this steals the operator's cursor or focus.
 */
export async function postTweet(
  page: Page,
  content: string,
  mediaPath: string | null,
  config: XPosterConfig,
  logger: winston.Logger,
): Promise<PostResult> {
  // 1. Arrive.
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' })
  await assertLoggedIn(page)
  await humanDelay(900, 2600)

  // 2. Browse.
  await browseTimeline(page, logger)

  // 3. Travel to the compose button and click it.
  const compose = page.locator(selectors.composeButton).first()
  await compose.waitFor({ state: 'visible', timeout: 15_000 })
  let cursor = await travelTo(
    page,
    CURSOR_ORIGIN,
    await pointOn(compose, 'compose button'),
  )
  await page.mouse.click(cursor.x, cursor.y)

  // Both of these are scoped to [role="dialog"], which is what keeps them
  // from resolving to the inline composer sitting behind the modal.
  const editor = page.locator(selectors.editor).first()
  await editor.waitFor({ state: 'visible', timeout: 15_000 })
  await humanDelay(400, 1200)

  // 4. Focus the editor and paste.
  cursor = await travelTo(page, cursor, await pointOn(editor, 'composer editor'))
  await page.mouse.click(cursor.x, cursor.y)
  await humanDelay(200, 700)

  await withClipboard(content, async () => {
    await page.keyboard.press('Meta+V')
  })

  // Confirm the paste actually landed before going anywhere near submit.
  await humanDelay(300, 900)
  if (!pasteLanded(await editor.innerText(), content)) {
    throw new FatalError(
      'The pasted text did not appear in the composer. The clipboard paste ' +
        'may have been blocked, or the editor selector is out of date.',
    )
  }

  // 4b. Attach the card, if this tweet has one.
  if (mediaPath) {
    // The column is relative to whichever package rendered the card, so it
    // cannot be handed to setInputFiles as-is from this working directory.
    const file = await resolveMediaPath(mediaPath)
    await page.locator(selectors.fileInput).first().setInputFiles(file)

    try {
      await page
        .locator(selectors.mediaReady)
        .first()
        .waitFor({ state: 'visible', timeout: 60_000 })
    } catch (error) {
      // Submit has not been clicked, so the tweet definitively did not post
      // and retrying is safe. Classifying this as uncertain would strand a
      // healthy tweet awaiting manual review.
      throw new RetryableError(
        `The image at ${file} never finished uploading`,
        { cause: error },
      )
    }

    // The preview appearing and the upload being committed are not quite the
    // same instant, and this is also just what a person does after attaching
    // something.
    await humanDelay(900, 2400)
    logger.debug('Attached media', { mediaPath, file })
  }

  // 5. Re-read it, the way a person does before posting.
  await humanDelay(1500, 4000)

  // 6. Travel to submit.
  const submit = page.locator(selectors.submitButton).first()
  await submit.waitFor({ state: 'visible', timeout: 10_000 })
  cursor = await travelTo(page, cursor, await pointOn(submit, 'submit button'))

  if (config.dryRun) {
    await mkdir('screenshots', { recursive: true })
    const path = `screenshots/dry-run-${Date.now()}.png`
    await page.screenshot({ path })
    logger.info('Dry run: stopping before submit', { path, content })
    return { url: null, dryRun: true }
  }

  await page.mouse.click(cursor.x, cursor.y)

  // 7. Verify. From here on, failure is uncertainty rather than failure —
  //    the click already happened and the tweet may well be live.
  try {
    await editor.waitFor({ state: 'hidden', timeout: 20_000 })
  } catch (error) {
    throw new UncertainError(
      'Submit was clicked but the composer never closed. The tweet may or ' +
        'may not have been posted — check the account before requeueing.',
      { cause: error },
    )
  }

  await humanDelay(1500, 4000)
  logger.info('Posted', { length: content.length })

  // The permalink is not reliably reachable straight after posting, and
  // hunting for it risks turning a success into a false uncertainty.
  return { url: null, dryRun: false }
}
