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

/**
 * Chrome's socket, cookie and hostname/PID lock identify a running process on this machine.
 * A restored machine creates its own, so carrying them over can block startup.
 * https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/process_singleton_posix.cc
 */
const browserLocks: ReadonlySet<string> = new Set([
  '.config/google-chrome/SingletonLock',
  '.config/google-chrome/SingletonSocket',
  '.config/google-chrome/SingletonCookie',
])

/**
 * Chrome rebuilds cached responses, compiled code and GPU shaders. Its cache deletion clears
 * these without removing site data, so the archive can omit them.
 * https://chromium.googlesource.com/chromium/src/+/main/content/browser/browsing_data/browsing_data_remover_impl.cc
 */
const browserProfileCaches: ReadonlySet<string> = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
])

/** Restrict cache pruning to Chrome profiles so a Person's equally named project files survive. */
const isChromeProfileCache = (path: HomePath): boolean => {
  if (!path.startsWith('.config/google-chrome/')) return false
  const segments = path.split('/')
  const profileCache = segments[3]
  if (profileCache === undefined) return false
  if (browserProfileCaches.has(profileCache)) return true
  // Chromium's service worker README, Storage section, says Database registrations reference
  // scripts in ScriptCache. Keep both together; omit only the separate CacheStorage response cache.
  // https://chromium.googlesource.com/chromium/src/+/master/content/browser/service_worker/README.md#storage
  return profileCache === 'Service Worker' && segments[4] === 'CacheStorage'
}

/** True when `path`, or a directory above it, is state a new machine rebuilds by itself. */
export const isRegenerable = (path: HomePath): boolean => {
  if (browserLocks.has(path) || isChromeProfileCache(path)) return true
  if (path.split('/').some((segment) => anywhere.has(segment))) return true
  return fromHome.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}
