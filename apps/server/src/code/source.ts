import * as NodeFS from 'node:fs'
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
  return directory
})
