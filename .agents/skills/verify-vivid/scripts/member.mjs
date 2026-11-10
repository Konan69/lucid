// Independent verification deliberately invokes the production member and database layers.
/* oxlint-disable vivid/no-cross-package-import */
import * as NodeFSP from 'node:fs/promises'
import * as NodeModule from 'node:module'
import { ConfigProvider, Effect, Layer, Redacted, Schema } from 'effect'
import { PersonId } from '@vivid/contracts'
import { ServerConfig, loadServerConfig } from '../../../../apps/server/src/config.ts'
import { databaseLayer } from '../../../../apps/server/src/database/client.ts'
import {
  ExecutorMembers,
  executorMembersLayer,
} from '../../../../apps/server/src/connections/members.ts'
import { alive } from './process.mjs'
import { decodeText } from './receipts.mjs'

const require = NodeModule.createRequire(
  new URL('../../../../apps/server/package.json', import.meta.url),
)
const { NodeHttpClient } = await import(require.resolve('@effect/platform-node'))
const Process = Schema.Struct({ pid: Schema.Int, start: Schema.String, boot: Schema.String })
const Run = Schema.Struct({ processes: Schema.Struct({ server: Process }) })
const decodePerson = Schema.decodeUnknownEffect(PersonId)

/** The captured disposable server owns the settings and member key. Reuse its actual caller
 * path without logging credentials or reaching any development database or auth store. */
export async function memberKey(state, person) {
  const run = decodeText(Run, await NodeFSP.readFile(state.evidence + '/state.json', 'utf8'))
  if (!(await alive(run.processes.server))) throw new Error('Disposable server is no longer live')
  const bytes = await NodeFSP.readFile('/proc/' + run.processes.server.pid + '/environ', 'utf8')
  const env = Object.fromEntries(
    bytes
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const at = entry.indexOf('=')
        return [entry.slice(0, at), entry.slice(at + 1)]
      }),
  )
  const settings = ConfigProvider.layer(ConfigProvider.fromUnknown(env))
  const database = databaseLayer.pipe(Layer.provide(Layer.effect(ServerConfig, loadServerConfig)))
  const members = executorMembersLayer.pipe(
    Layer.provide(database),
    Layer.provide(NodeHttpClient.layerUndici),
    Layer.provide(settings),
  )
  // oxlint-disable-next-line vivid/no-runpromise-in-library -- Script adapter to the production Effect layers.
  return Effect.runPromise(
    Effect.gen(function* () {
      const personId = yield* decodePerson(person)
      const caller = yield* (yield* ExecutorMembers).caller({ principal: 'member', personId })
      return Redacted.value(caller.key)
    }).pipe(Effect.provide(members), Effect.scoped),
  )
}
