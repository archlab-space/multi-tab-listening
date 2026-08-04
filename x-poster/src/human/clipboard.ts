import { spawn } from 'node:child_process'

export interface ClipboardBackend {
  read(): Promise<string>
  write(text: string): Promise<void>
}

function run(command: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command)
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} exited with code ${code}`))
    })
    if (input !== undefined) {
      child.stdin.end(input)
    }
  })
}

/**
 * The system clipboard, driven through pbcopy/pbpaste.
 *
 * Deliberately not navigator.clipboard.writeText(): that would require
 * page.evaluate() — forbidden in this package — and a clipboard permission
 * grant. Driving the OS clipboard keeps the browser's view of the input a
 * pure keyboard paste, indistinguishable from a human one.
 */
export const macClipboard: ClipboardBackend = {
  read: () => run('pbpaste'),
  write: async (text: string) => {
    await run('pbcopy', text)
  },
}

/**
 * Runs `fn` with `text` on the clipboard, then puts back whatever was there.
 *
 * Restoration runs on the error path too — the operator's clipboard is not
 * ours to lose because posting failed.
 */
export async function withClipboard<T>(
  text: string,
  fn: () => Promise<T>,
  backend: ClipboardBackend = macClipboard,
): Promise<T> {
  let backup: string | null = null
  try {
    backup = await backend.read()
  } catch {
    // An unreadable clipboard is not a reason to refuse to post. It only
    // means there is nothing to put back.
    backup = null
  }

  await backend.write(text)
  try {
    return await fn()
  } finally {
    if (backup !== null) {
      await backend.write(backup).catch(() => {})
    }
  }
}
