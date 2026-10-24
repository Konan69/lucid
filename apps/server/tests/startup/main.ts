import * as NodeFS from 'node:fs'
import NodeProcess from 'node:process'
import * as NodeURL from 'node:url'
import { parseSync } from 'oxc-parser'
import * as Schema from 'effect/Schema'
import { StartupReceipt, StartupRequest } from './protocol.ts'

const entry = new URL('../../src/main.ts', import.meta.url)
const decodeStartupRequest = Schema.decodeUnknownSync(StartupRequest)

/**
 * Evaluate only the entry's runtime dependencies through the same public tsx loader as main.
 * OXC retains TypeScript import kinds, so type-only declarations never add runtime work.
 * Node traverses and caches the actual installed graph without bundling or replacing modules.
 */
const dependencies = parseSync(NodeURL.fileURLToPath(entry), NodeFS.readFileSync(entry, 'utf8'), {
  astType: 'ts',
})
if (dependencies.errors.length > 0) throw new Error('Server startup dependency parsing failed')
for (const statement of dependencies.program.body) {
  if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue
  if (
    statement.specifiers.length > 0 &&
    statement.specifiers.every(
      (specifier) => specifier.type === 'ImportSpecifier' && specifier.importKind === 'type',
    )
  )
    continue
  const name = statement.source.value
  await import(name.startsWith('.') ? new URL(name, entry).href : name)
}

/** Close the control channel before real startup so IPC cannot hold the production exit open. */
NodeProcess.once('message', (message) => {
  const request = decodeStartupRequest(message)
  StartupRequest.match(request, {
    Run: () => {
      NodeProcess.disconnect()
      void import(entry.href)
    },
  })
})
if (NodeProcess.send === undefined) throw new Error('Server startup control channel unavailable')
NodeProcess.send(StartupReceipt.cases.Ready.make({}))
