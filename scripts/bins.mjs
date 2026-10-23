import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as Schema from 'effect/Schema'

const Manifest = Schema.Struct({ bin: Schema.Record(Schema.String, Schema.String) })
const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
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
