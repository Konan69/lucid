import { build } from 'esbuild'
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'
import * as NodeProcess from 'node:process'
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
  sourcemap: 'external',
  logLevel: 'info',
}

await build({
  ...shared,
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist/main/main.cjs',
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

