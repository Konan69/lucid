import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'

/**
 * electron-builder's `afterPack` hook: runs once the app directory for a platform is complete,
 * before the installer is made.
 *
 * A Windows app must contain Vivid's helper. `scripts/build.mjs` compiles it only on Windows, and
 * electron-builder copies a missing `extraResources` source without complaint, so a Windows
 * installer built on another system, or after a build that skipped the compile, would ship
 * without it and nobody would be told. This stops that build instead. Other platforms have no
 * helper and are not checked.
 */
export default async function packed(context) {
  if (context.electronPlatformName !== 'win32') return
  const helper = NodePath.join(
    context.appOutDir,
    'resources',
    'native',
    'windows',
    'Vivid.Windows.exe',
  )
  try {
    await NodeFSP.access(helper)
  } catch {
    throw new Error(
      "The Windows app has no Vivid.Windows.exe. Build it on Windows: scripts/build.mjs compiles the helper with the system's own compiler.",
    )
  }
}
