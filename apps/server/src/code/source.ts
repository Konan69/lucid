import * as NodeFS from 'node:fs'
import * as NodeChildProcess from 'node:child_process'
import * as NodeProcess from 'node:process'
import * as NodeModule from 'node:module'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { Effect, Schema } from 'effect'

/** Missing or unbuildable trusted assets disable programs before a guest can be admitted. */
export class CodeAssetsUnavailable extends Schema.TaggedError<CodeAssetsUnavailable>()(
  'CodeAssetsUnavailable',
  {},
  { title: 'Program worker assets are unavailable' },
) {}

/** Populate Node 24's public module compile cache with trusted code only. A fresh credential-free
 * process writes it before any guest exists; guests can only read it. Cancellation kills precisely
 * this captured preparation process. Module parsing previously cost 1.7 seconds in each guest.
 */
const warm = Effect.fn('Code.prepareCompileCache')((directory: string) =>
  Effect.callback<void, CodeAssetsUnavailable>((resume) => {
    const child = NodeChildProcess.spawn(
      NodeProcess.execPath,
      ['--wasm-num-compilation-tasks=1', NodePath.join(directory, 'start.mjs'), 'prepare'],
      { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', NODE_NO_WARNINGS: '1' } },
    )
    child.once('error', () => resume(Effect.fail(new CodeAssetsUnavailable({}))))
    child.once('close', (code) =>
      resume(code === 0 ? Effect.void : Effect.fail(new CodeAssetsUnavailable({}))),
    )
    return Effect.sync(() => {
      child.kill('SIGKILL')
    })
  }),
)

/** Compile trusted assets once per supervisor lifetime, outside each one-CPU guest. Compilation
 * previously spent half a second inside every guest before importing the interpreter. The parent
 * owns this unique directory; guests mount it read-only and still get fresh processes and VMs.
 */
export const prepareWorker = Effect.fn('Code.prepareWorker')(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.try({
      try: () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-worker-')),
      catch: () => new CodeAssetsUnavailable({}),
    }),
    (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
  )
  yield* Effect.try({
    try: () => {
      const root = new URL('../../../../', import.meta.url)
      const sources = [
        ...['worker', 'pipe', 'protocol', 'budgets', 'results'].map(
          (name) => [name, new URL(`./${name}.ts`, import.meta.url)] as const,
        ),
        ...['code', 'identity'].map(
          (name) => [name, new URL(`packages/contracts/src/${name}.ts`, root)] as const,
        ),
      ]
      NodeFS.writeFileSync(NodePath.join(directory, 'package.json'), '{"type":"module"}')
      NodeFS.symlinkSync(
        NodeURL.fileURLToPath(new URL('apps/server/node_modules', root)),
        NodePath.join(directory, 'node_modules'),
      )
      for (const [name, path] of sources) {
        const compiled = NodeModule.stripTypeScriptTypes(NodeFS.readFileSync(path, 'utf8'), {
          mode: 'strip',
          sourceUrl: path.href,
        })
        const imports = compiled
          .replaceAll("'@vivid/contracts/code'", "'./code.js'")
          .replace(/(['"]\.\/[^'"]+)\.ts(['"])/gu, '$1.js$2')
        NodeFS.writeFileSync(NodePath.join(directory, `${name}.js`), imports)
      }
      NodeFS.copyFileSync(
        new URL('./start.mjs', import.meta.url),
        NodePath.join(directory, 'start.mjs'),
      )
    },
    catch: () => new CodeAssetsUnavailable({}),
  })
  yield* warm(directory)
  return directory
})
