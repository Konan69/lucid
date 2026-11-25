import type { HomePath } from './manifest.ts'

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

const browserLocks: ReadonlySet<string> = new Set([
  '.config/google-chrome/SingletonLock',
  '.config/google-chrome/SingletonSocket',
  '.config/google-chrome/SingletonCookie',
])

const browserProfileCaches: ReadonlySet<string> = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
])

const isChromeProfileCache = (path: HomePath): boolean => {
  if (!path.startsWith('.config/google-chrome/')) return false
  const segments = path.split('/')
  const profileCache = segments[3]
  if (profileCache === undefined) return false
  if (browserProfileCaches.has(profileCache)) return true
  // Chromium stores registration metadata in Service Worker/Database separately from these caches.
  // https://chromium.googlesource.com/chromium/src/+/master/content/browser/service_worker/README.md#storage
  return (
    profileCache === 'Service Worker' &&
    (segments[4] === 'CacheStorage' || segments[4] === 'ScriptCache')
  )
}

/** True when `path`, or a directory above it, is state a new machine rebuilds by itself. */
export const isRegenerable = (path: HomePath): boolean => {
  if (browserLocks.has(path) || isChromeProfileCache(path)) return true
  if (path.split('/').some((segment) => anywhere.has(segment))) return true
  return fromHome.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}
