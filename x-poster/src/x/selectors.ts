/**
 * Every X DOM selector, in one place.
 *
 * X ships frontend changes without notice, so this file is where that cost
 * is paid. It is deliberately the only module in the package that contains a
 * selector string.
 *
 * Verified against the live site on 2026-08-04 (Chrome 150, logged in).
 * If a run fails with "all selectors missing", re-verify before guessing —
 * `x-poster/scratch-recon.ts` in the git history shows how.
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
   * Appears once an attachment has finished uploading and is previewable.
   *
   * X disables the submit button while an upload is in flight, so this is
   * the signal that submitting is safe. Submitting early either posts
   * without the image or throws.
   */
  mediaReady: '[role="dialog"] [data-testid="removeMedia"]',

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
