import type { HomePath } from './manifest.ts'

/**
 * State the archive must never hold, because a fresh machine regenerates it and it dwarfs what a
 * Person actually made: package stores, compiler caches, build output, trash, and browser caches.
 * Archiving it would make every capture slow and every restore slower, for bytes nobody can tell
 * apart.
 *
 * `anywhere` matches a directory name at any depth; `fromHome` matches a path prefix from the home
 * directory.
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
  '.config/google-chrome/Crashpad',
  '.config/google-chrome/BrowserMetrics',
]

/**
 * Files that belong to a running browser, not to the Person: restoring them makes the next
 * machine's Chrome think an instance is already up.
 */
const browserLocks: ReadonlySet<string> = new Set([
  '.config/google-chrome/SingletonLock',
  '.config/google-chrome/SingletonSocket',
  '.config/google-chrome/SingletonCookie',
])

/** Per-profile directories inside `.config/google-chrome/<profile>/` that Chrome rebuilds itself. */
const browserProfileCaches: ReadonlySet<string> = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Service Worker',
])

/** True when `path`, or a directory above it, is state a new machine rebuilds by itself. */
export const isRegenerable = (path: HomePath): boolean => {
  if (browserLocks.has(path)) return true
  const segments = path.split('/')
  if (segments.some((segment) => anywhere.has(segment))) return true
  // Chrome's own rebuildable caches sit one level below a profile directory, so the segment after
  // `.config/google-chrome/<profile>` decides. A project directory that happens to be named
  // `Cache` is never matched, because the path must start under the Chrome profile.
  const profileCache = segments[3]
  if (
    path.startsWith('.config/google-chrome/') &&
    profileCache !== undefined &&
    browserProfileCaches.has(profileCache)
  ) {
    return true
  }
  return fromHome.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}