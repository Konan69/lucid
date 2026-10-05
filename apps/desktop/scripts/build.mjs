import { build } from 'esbuild'
import * as NodeChildProcess from 'node:child_process'
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

/**
 * Vivid's Windows helper (`native/windows`), compiled by its own script with the compiler that
 * ships in Windows: no download, no SDK. It is staged in `dist/native/windows`, where the app
 * finds it in development (`locateHelper` in src/main/helper.ts) and from where
 * `electron-builder.yml` ships it. A compile that fails stops the build: the script exits
 * non-zero and `execFileSync` throws. Anywhere but Windows there is no compiler for it, so the
 * build goes on without the helper and that app says it cannot work in apps; `scripts/packed.mjs`
 * refuses to package a Windows app that lacks it.
 */
await NodeFSP.rm('dist/native', { recursive: true, force: true })
if (NodeProcess.platform === 'win32') {
  const staged = NodePath.resolve(desktopDirectory, 'dist/native/windows')
  NodeChildProcess.execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      NodePath.resolve(desktopDirectory, 'native/windows/build.ps1'),
      '-Output',
      staged,
    ],
    { stdio: 'inherit' },
  )
  await NodeFSP.access(NodePath.join(staged, 'Vivid.Windows.exe'))
} else {
  console.log(
    `desktop: not on Windows (${NodeProcess.platform}); Vivid's Windows helper is not built, and this build cannot work in apps`,
  )
}
