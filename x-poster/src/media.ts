import { access, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The workspace root, derived from this module's own location rather than
 * from `process.cwd()`.
 *
 * cwd is precisely what cannot be trusted here: this whole module exists
 * because the two services that share the tweets table run from different
 * working directories. `import.meta.url` is the same answer under `tsx
 * src/index.ts` and under a built `dist/`, since both sit one level below the
 * package root.
 */
const DEFAULT_WORKSPACE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

/** Never searched: not ours, and it is enormous. */
const SKIPPED = new Set(['node_modules'])

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** The workspace root first, then each package directory, alphabetically. */
async function searchBases(workspaceRoot: string): Promise<string[]> {
  const entries = await readdir(workspaceRoot, { withFileTypes: true })
  const packages = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !SKIPPED.has(entry.name) &&
        !entry.name.startsWith('.'),
    )
    .map((entry) => join(workspaceRoot, entry.name))
    .sort()

  return [workspaceRoot, ...packages]
}

/**
 * Turns whatever `tweets.media_path` holds into a path this process can open.
 *
 * The column holds what tweet-generator's MEDIA_DIR produced, which is
 * relative by default — and relative to *its* package directory, not ours.
 * Storing an absolute path instead would fix the lookup and break something
 * worse: the rows would only be valid on the machine and checkout that wrote
 * them. Resolving on read keeps the column portable.
 *
 * First match wins, in a fixed order. A card only ever has one home, so the
 * order settles a question that should not arise; what earns its place is the
 * failure, which names every directory tried, because "file not found" from
 * inside `setInputFiles` says nothing about where the file was expected.
 */
export async function resolveMediaPath(
  mediaPath: string,
  workspaceRoot: string = DEFAULT_WORKSPACE_ROOT,
): Promise<string> {
  if (isAbsolute(mediaPath)) {
    if (await exists(mediaPath)) return mediaPath
    throw new Error(`The card for this tweet is not at ${mediaPath}`)
  }

  const bases = await searchBases(workspaceRoot)
  const tried: string[] = []

  for (const base of bases) {
    const candidate = join(base, mediaPath)
    if (await exists(candidate)) return candidate
    tried.push(candidate)
  }

  throw new Error(
    `The card "${mediaPath}" is in the database but not on disk. Looked in:\n` +
      tried.map((path) => `  ${path}`).join('\n'),
  )
}
