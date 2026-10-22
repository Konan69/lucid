import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'

const manifest = JSON.parse(
  NodeFS.readFileSync(new URL('../packages/compiler/package.json', import.meta.url), 'utf8'),
)
export const blockedCommands = Object.keys(manifest.bin)

export function isCompilerBlocker(root, file) {
  return (
    NodeFS.existsSync(file) &&
    NodeFS.lstatSync(file).isSymbolicLink() &&
    NodeFS.realpathSync(file) === NodePath.join(root, 'packages/compiler/disabled.mjs')
  )
}
