import type { HomePath } from './manifest.ts'

/**
 * State the archive must never hold, because a fresh machine regenerates it and it dwarfs what a
 * Person actually made: package stores, compiler caches, build output, trash. Archiving it would
 * make every capture slow and every restore slower, for bytes nobody can tell apart.
 *
 * `anywhere` matches a directory name at any depth; `fromHome` matches a path prefix from the home
 * directory. Both are directory rules: a plain file is never regenerable by name alone.
 */
const anywhere: ReadonlySet<string> = new Set([
  'node_modules',
  '.cache',
  '__pycache__',
  '.venv',
  'target',
  '.turbo',
  '.next',
  'dist',
  '.gradle',
])

const fromHome: ReadonlyArray<string> = [
  // Vivid's own bookkeeping on the machine, including the restore marker. It describes this
  // machine, not the Computer, so it must not travel to the next one.
  '.vivid',
  '.npm',
  '.nvm',
  '.rustup',
  '.cargo/registry',
  '.cargo/git',
  '.local/share/pnpm',
  '.local/share/Trash',
  '.local/state',
  '.docker/buildx',
]

/** True when `path`, or a directory above it, is state a new machine rebuilds by itself. */
export const isRegenerable = (path: HomePath): boolean => {
  const segments = path.split('/')
  if (segments.some((segment) => anywhere.has(segment))) return true
  return fromHome.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}
