import * as NodeChildProcess from 'node:child_process'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'

/** pnpm owns workspace traversal, including the runtime's transitive client imports. */
export const cellInputs = (root = NodeURL.fileURLToPath(new URL('../', import.meta.url))) => {
  const packages = Result.getOrThrow(
    Schema.decodeUnknownResult(
      Schema.fromJsonString(Schema.Array(Schema.Struct({ path: Schema.String }))),
    )(
      NodeChildProcess.execFileSync(
        'pnpm',
        ['--filter', '@vivid/cells...', 'list', '--depth', '-1', '--json'],
        { cwd: root, encoding: 'utf8' },
      ),
    ),
  )
  return packages.map(({ path }) => `/${NodePath.relative(root, path)}/**`)
}
