import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'

/**
 * electron-builder's `afterPack` hook: runs once the app directory for a platform is complete,
 * before the installer is made.
 *
 * A Windows app must contain Vivid's Computer — the vendored supervisor and its engine
 * (`vendor/computer/`). electron-builder copies a missing `extraResources` source without
 * complaint, so a Windows installer built elsewhere, or from a tree missing the pair, would
 * ship without it and nobody would be told. This stops that build instead. Other platforms have
 * no Computer and are not checked.
 */
export default async function packed(context) {
  if (context.electronPlatformName !== 'win32') return
  const computer = NodePath.join(
    context.appOutDir,
    'resources',
    'native',
    'computer',
    'codex-computer-use.exe',
  )
  try {
    await NodeFSP.access(computer)
  } catch {
    throw new Error(
      'The Windows app has no Computer. The vendored pair is missing from apps/desktop/vendor/computer/.',
    )
  }
}
