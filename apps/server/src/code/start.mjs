import * as NodeModule from 'node:module'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'

// Preparation and guests use identical absolute module paths. The parent populates this cache;
// bwrap mounts it read-only, preventing a guest from poisoning subsequent executions. Node's public
// compile-cache API tolerates cache writes failing on a read-only mount (Node 24 module API).
const cache = NodeModule.enableCompileCache(
  NodeURL.fileURLToPath(new URL('./cache', import.meta.url)),
)
if (
  cache.status === NodeModule.constants.compileCacheStatus.FAILED ||
  cache.status === NodeModule.constants.compileCacheStatus.DISABLED
) {
  NodeProcess.exit(1)
} else {
  const { program } = await import('./worker.js')
  if (NodeProcess.argv[2] === 'prepare') {
    NodeModule.flushCompileCache()
  } else {
    const Effect = await import('effect/Effect')
    // The fresh process owns only its VM and pipe; it inherits no application runtime authority.
    // oxlint-disable-next-line vivid/no-runpromise-in-library -- Standalone isolated process executable entry.
    await Effect.runPromise(program)
  }
}
