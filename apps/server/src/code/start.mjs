import * as NodeFS from 'node:fs'
import * as NodeModule from 'node:module'
import * as NodeProcess from 'node:process'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

// Node 24's public compiler transforms our trusted source modules without a loader hook.
// A tsx hook also loads its compiler into the child and can be inherited by pi's WASM worker;
// under the one-CPU cgroup that cold work exceeded the existing five-second test deadline.
// Generated code lives only in the child's scratch directory. Every request still gets a fresh VM.
const directory = NodeFS.mkdtempSync('/tmp/vivid-code-')
const root = new URL('../../../../', import.meta.url)
const sources = [
  ...['worker', 'pipe', 'protocol', 'budgets', 'results'].map((name) => [
    name,
    new URL(`./${name}.ts`, import.meta.url),
  ]),
  ...['code', 'identity'].map((name) => [name, new URL(`packages/contracts/src/${name}.ts`, root)]),
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
// The process owns its captured scratch path; no developer data or shared directory is touched.
NodeProcess.default.once('exit', () => NodeFS.rmSync(directory, { recursive: true, force: true }))
const worker = await import(NodeURL.pathToFileURL(NodePath.join(directory, 'worker.js')).href)
const Effect = await import('effect/Effect')
// oxlint-disable-next-line vivid/no-runpromise-in-library -- Standalone isolated process executable entry.
await Effect.runPromise(worker.program)
