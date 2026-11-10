import * as NodeCrypto from 'node:crypto'
import { Clock, Config, Effect, Layer, Redacted, Option } from 'effect'
import { eq } from 'drizzle-orm'
import { expect } from '@effect/vitest'
import {
  ComputerHealth,
  ComputerProbeFailure,
  ComputerProbeResult,
  PersonId,
  Workspace,
} from '@vivid/contracts'
import { Database } from '../../database/client.ts'
import { personTable } from '../../auth/tables.ts'
import { silentChangesLayer } from '../../live/changes.ts'
import { ComputerStore, computerStoreLayer, computerMachineKey } from '../store.ts'
import { Machine, type MachineKey } from '../machine.ts'
import { boatMachineLayer } from '../boat.ts'
import { transport, type Transport } from '../boat/transport.ts'
import { bindings } from '../boat/bindings.ts'
import { computers, machineBindings } from '../tables.ts'
import { incidentsLayer } from '../../observability/incidents.ts'

/** The store as the server composes it: its Incidents go to the real recorder. */
const computerStores = computerStoreLayer.pipe(Layer.provide(incidentsLayer))
/** Cleanup can relinquish only this fixture’s exact holder generation. A different holder is
 * untouched. This removes test metadata, never the provided machine or its files/profile. */
const releaseHolder = Effect.fn('ComputerHealthProof.release')(function* (
  api: Transport,
  key: MachineKey,
) {
  const saved = yield* (yield* bindings()).load(key)
  if (Option.isNone(saved) || saved.value.providerId === null) return
  const { providerId: id, intent } = saved.value
  const command = `record="$HOME/.vivid/holder"; exec 9>"$HOME/.vivid/holder.lock"; flock -w 10 9 || exit 1; if [ -f "$record" ] && [ ! -L "$record" ] && [ "$(cat "$record")" = '${id} ${intent}' ]; then rm -- "$record"; fi`
  const receipt = yield* api.command(id, key, command, 20)
  expect(receipt.exitCode, 'The proof’s own holder cleanup must finish').toBe(0)
})

/** Only an explicit, already-running, non-production proof Computer may be adopted. Normal
 * Machine.ensure ownership checks remain intact; another server’s holder returns MachineHeld.
 * No create or provider deletion is possible with the required explicit adoption setting. */
export const healthFixture = Effect.fn('ComputerHealthProof.fixture')(function* () {
  const target = yield* Config.NonEmptyString('VIVID_BOAT_MACHINE')
  expect(target, 'Production Computer is forbidden').not.toBe('bx_yjj2hakd')
  const url = new URL(Redacted.value(yield* Config.Redacted('VIVID_TEST_DATABASE_URL')))
  expect(url.port, 'The shared local database is forbidden').not.toBe('55433')
  const api = yield* transport()
  if (Option.isNone(api.adopt)) return expect.fail('An explicit proof-owned machine is required')
  expect(api.adopt.value).toBe(target)
  expect(
    (yield* api.get(api.adopt.value)).sandbox.state,
    'The proof machine must already run',
  ).toBe('ready')
  const database = yield* Database
  const personId = PersonId.make(NodeCrypto.randomUUID())
  const key = computerMachineKey(personId)
  const removeRows = database
    .run(database.delete(personTable).where(eq(personTable.id, personId)))
    .pipe(
      Effect.andThen(
        database.run(database.delete(machineBindings).where(eq(machineBindings.key, key))),
      ),
    )
  yield* Effect.addFinalizer(() =>
    releaseHolder(api, key).pipe(
      Effect.andThen(removeRows),
      Effect.orElseSucceed(() => expect.fail('Health proof cleanup failed')),
    ),
  )
  const person = {
    id: personId,
    name: 'Computer health proof',
    email: personId + '@example.test',
    image: null,
  }
  yield* database.run(database.insert(personTable).values(person))
  const context = yield* Layer.build(
    computerStores.pipe(
      Layer.provideMerge(boatMachineLayer),
      Layer.provide(silentChangesLayer),
    ),
  )
  const machine = yield* Machine.pipe(Effect.provideContext(context))
  const running = yield* machine.ensure(key)
  const now = yield* Clock.currentTimeMillis
  yield* database.run(
    database.insert(computers).values({
      id: NodeCrypto.randomUUID(),
      personId,
      machine: key,
      status: 'running',
      since: running.since,
      createdAt: now,
      lastActivityAt: now,
    }),
  )
  const store = yield* ComputerStore.pipe(Effect.provideContext(context))
  return {
    store,
    personId,
    actor: {
      person,
      workspace: Workspace.cases.Personal.make({}),
      by: 'person' as const,
      threadId: Option.none(),
      helper: Option.none(),
    },
    read: store.health(personId, 'Deep'),
  }
})

/** Assert a real browser fault, rather than accepting an absent browser or permission refusal. */
export function browserFailed(health: ComputerHealth) {
  return (
    ComputerHealth.guards.Degraded(health) &&
    health.probes.some(
      (probe) =>
        probe.component === 'Browser' &&
        ComputerProbeResult.guards.Failed(probe.result) &&
        ComputerProbeFailure.guards.BrowserUnresponsive(probe.result.failure),
    )
  )
}
