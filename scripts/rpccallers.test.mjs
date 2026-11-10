import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import { checkCallers, uncalledProcedures } from './rpccallers.mjs'

/** Exercise actual source files and Git discovery, including runtime callers and false mentions. */
void NodeTest.test(
  'RPC policy counts production invocations and rejects a new uncalled procedure',
  (t) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-rpccallers-'))
    t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }))
    const env = { ...process.env }
    for (const name of NodeChildProcess.execFileSync('git', ['rev-parse', '--local-env-vars'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n'))
      delete env[name]
    NodeChildProcess.execFileSync('git', ['init', '-q', root], { env })
    const write = (file, source) => {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true })
      NodeFS.writeFileSync(NodePath.join(root, file), source)
    }
    write(
      'packages/contracts/src/rpc.ts',
      `
    const Read = Rpc.make('Read', {}), Missing = Rpc.make('Missing', {})
    export const VividRpc = RpcGroup.make(Read, Missing)
  `,
    )
    write('packages/agent/runtime/src/tools/read.ts', 'scope.client.Read({}) // client.Missing({})')
    write('apps/web/src/data/read.ts', 'const text = "client.Missing({})"')
    write('apps/server/src/handlers.ts', 'client.Missing({})')
    write('packages/agent/runtime/src/read.test.ts', 'client.Missing({})')
    write('scripts/rpccallers.json', '{}')
    NodeAssert.deepEqual(
      uncalledProcedures(root).map(({ name }) => name),
      ['Missing'],
    )
    NodeAssert.match(checkCallers(root).failures.join('\n'), /Missing has no production caller/u)
    write(
      '.agents/skills/verify-vivid/scripts/read.mjs',
      `rpc(state, 'Missing', {}) // rpc(state, 'Read', {})`,
    )
    NodeAssert.deepEqual(uncalledProcedures(root), [])
    write('.agents/skills/verify-vivid/scripts/read.mjs', `const text = "rpc(state, 'Missing')"`)
    NodeAssert.match(checkCallers(root).failures.join('\n'), /Missing has no production caller/u)
    write('apps/cells/src/main.ts', "client['Missing']({})")
    NodeAssert.deepEqual(uncalledProcedures(root), [])
  },
)
