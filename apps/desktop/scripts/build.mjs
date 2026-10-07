import { build } from 'esbuild'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

const desktopDirectory = NodeURL.fileURLToPath(new URL('..', import.meta.url))
const rendererDirectory = NodePath.resolve(desktopDirectory, '../web/dist')
// Fail before replacing staged assets when the renderer has not been built.
await NodeFSP.access(NodePath.join(rendererDirectory, 'index.html'))

/**
 * Bundle main and preload as CommonJS because Electron loads both directly. The preload stays one
 * file: sandboxed preloads may require Electron and selected built-ins only, so Effect and the
 * shared bridge contract must be inlined rather than resolved at runtime.
 */
const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  // The map ships beside its bundle with the comment that names it (`linked`, not `external`),
  // which is what Sentry's `inject` pairs the two by: a map without that comment is never found
  // from its bundle, and the desktop's main and preload maps are injected and uploaded by
  // `scripts/sentry-upload.mjs` below. The comment only names a file that ships with the deploy.
  sourcemap: 'linked',
  logLevel: 'info',
}

// Which commit an error report names (`src/main/telemetry.ts`). `VIVID_COMMIT` is the name the
// server and the web build already read theirs from; a build without it reports the version alone.
const commit = process.env.VIVID_COMMIT === undefined ? '' : process.env.VIVID_COMMIT

await build({
  ...shared,
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist/main/main.cjs',
  define: { __VIVID_COMMIT__: JSON.stringify(commit) },
})

// Packaging consumes this snapshot, so later web-lane builds cannot change a bundle mid-package.
await NodeFSP.rm('dist/renderer', { recursive: true, force: true })
await NodeFSP.cp(rendererDirectory, 'dist/renderer', { recursive: true })
await NodeFSP.copyFile('../../packages/design/tokens/src/tokens.css', 'dist/tokens.css')

await build({
  ...shared,
  entryPoints: ['src/preload/main.ts'],
  outfile: 'dist/preload/main.cjs',
})

// The notice window has a preload of its own, with only what the notice may do.
await build({
  ...shared,
  entryPoints: ['src/preload/notice.ts'],
  outfile: 'dist/preload/notice.cjs',
})

// The main and preload maps ship to Sentry (`src/main/telemetry.ts`) so their stack frames name
// sources instead of `dist/main/main.cjs` lines, and the renderer's assets are uploaded to this
// project again because the same files report under `vivid-web` and `vivid-desktop`. The debug
// IDs the renderer's bundles already carry (`apps/web/vite.config.ts`) are kept; the script's
// inject step is idempotent. Without `SENTRY_AUTH_TOKEN` the script leaves everything in place.
// `spawnSync` without a shell, so one wrong word cannot run anything else.
const sentryUpload = NodeChildProcess.spawnSync(
  'node',
  [
    '../../scripts/sentry-upload.mjs',
    'vivid-desktop',
    'dist/main',
    'dist/preload',
    'dist/renderer/assets',
  ],
  { stdio: 'inherit' },
)
if (sentryUpload.error !== undefined) throw sentryUpload.error
if (sentryUpload.status !== 0) process.exit(sentryUpload.status ?? 1)
