/**
 * Every X DOM selector, in one place.
 *
 * X ships frontend changes without notice, so this file is where that cost
 * is paid. It is deliberately the only module in the package that contains a
 * selector string.
 *
 * Verified against the live site on 2026-08-04 (Chrome 150, logged in), and
 * `mediaReady` again on 2026-08-07 — the composer with an image attached is
 * a state the first pass could not reach.
 *
 * If a run fails with "all selectors missing", re-verify before guessing.
 * What works: a throwaway script (gitignored as `scratch-*.ts`) that drives
 * the dedicated profile into the state in question, then prints `.count()`
 * for a list of candidate selectors on a timer. Counting is enough, and it
 * avoids page.evaluate(), which the rest of this package forbids because
 * injected script is detectable and this runs against the live account.
 * Check `.waitFor({ state: 'visible' })` on the winner too — the composer
 * has nodes that are present long before they are visible.
 */
export const selectors = {
  /** Side-nav compose button. Opens the modal composer. */
  composeButton: '[data-testid="SideNav_NewTweet_Button"]',

  /**
   * The modal composer's container.
   *
   * Scoping through this is not optional. Once the modal is open the page
   * holds TWO elements with data-testid="tweetTextarea_0" — the modal's and
   * the timeline's inline composer behind it — so an unscoped `.first()`
   * silently types into the wrong one. Verified: unscoped count is 2, scoped
   * count is 1.
   */
  composerDialog: '[role="dialog"]',

  /** The contenteditable body of the modal composer. */
  editor: '[role="dialog"] [data-testid="tweetTextarea_0"]',

  /**
   * Submit inside the modal composer.
   *
   * `tweetButton` exists only while the modal is open; the timeline's inline
   * composer uses `tweetButtonInline` instead. Scoping to the dialog picks
   * the right one without depending on which is present.
   */
  submitButton: '[role="dialog"] [data-testid="tweetButton"]',

  /**
   * The composer's hidden file input.
   *
   * `setInputFiles` writes this directly. Clicking the visible media button
   * instead opens a NATIVE OS file dialog in a real, non-headless Chrome;
   * Playwright's filechooser interception is less reliable against a
   * CDP-attached browser, and one missed interception leaves a modal system
   * dialog blocking the session — on an unattended process, until someone
   * notices.
   */
  fileInput: '[role="dialog"] input[type="file"][data-testid="fileInput"]',

  /**
   * The attachment strip. X renders it only once the upload has been
   * committed, not on local preview, so its presence is the signal that
   * submitting is safe — submitting earlier posts without the image.
   *
   * Verified 2026-08-07 by sampling the open composer every 40ms after
   * setInputFiles: for the first 720ms the dialog holds a third
   * role="progressbar" and no attachments node; at 760ms that progressbar is
   * gone and this node is there, in the same sample. The other two
   * progressbars are permanent furniture — one of them is the character
   * counter — so counting them is not a usable signal.
   *
   * Replaces [data-testid="removeMedia"], which is no longer anywhere in the
   * composer. That was the only selector in this file which requires an
   * attached image to appear, and therefore the only one no successful post
   * had ever exercised: every card-bearing tweet died waiting on it, which
   * read as "images are broken" rather than "this testid is stale".
   *
   * Deliberately not [aria-label="Remove media"], which appears in the same
   * sample and would work today: that label is English, and it moves with
   * the profile's display language.
   */
  mediaReady: '[role="dialog"] [data-testid="attachments"]',

  /** Any tweet in the timeline. Used to confirm the timeline rendered. */
  tweetArticle: 'article[data-testid="tweet"]',

  /** The main column. Its presence means the app shell has loaded. */
  timeline: '[data-testid="primaryColumn"]',

  /**
   * A marker on the logged-out landing page.
   *
   * There is no `loginButton` testid — verified against the live logged-out
   * view, where every obvious candidate (`loginButton`, `signinButton`,
   * `LoginForm_Login_Button`) is absent. The Google sign-in widget is the
   * one testid actually present, but it is a third-party embed and may vary,
   * so `session.ts` treats the URL redirect as the authoritative signal and
   * uses this only to fail fast.
   */
  loggedOutLanding: '[data-testid="google_sign_in_container"]',

  /** Present only when logged in. Confirms the session, not just the shell. */
  accountSwitcher: '[data-testid="SideNav_AccountSwitcher_Button"]',
} as const

/** Where a logged-in `x.com/home` request must end up. */
export const HOME_URL = 'https://x.com/home'
