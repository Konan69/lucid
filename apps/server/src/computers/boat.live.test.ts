import * as NodeCrypto from 'node:crypto'
import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { BrowserAction, ComputerState, DesktopAction } from '@vivid/contracts'
import { Config, Duration, Effect, Function, Layer, Option, Predicate } from 'effect'
import { eq } from 'drizzle-orm'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { Database } from '../database/client.ts'
import { machineBindings } from './tables.ts'
import { bindings } from './boat/bindings.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { boatMachineLayer } from './boat.ts'
import { Machine, MachineKey } from './machine.ts'

// Explicit cost opt-in and isolated persistence are mandatory. Read presence, never print key values.
const enabled =
  testDatabaseConfigured &&
  Object.hasOwn(NodeProcess.env, 'VIVID_BOAT_API_KEY') &&
  NodeProcess.env.VIVID_TEST_BOAT_LIVE === '1'
const dependencies = Layer.mergeAll(testDatabaseLayer, NodeHttpClient.layerUndici)
const provider = boatMachineLayer.pipe(Layer.provideMerge(dependencies))

/** Record only operation timings, never viewer authority, screenshots or private guest output. */
const measured = <A, E, R>(step: string, program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const [duration, result] = yield* Effect.timed(program)
    yield* Effect.logInfo('Boat live proof', { step, milliseconds: Duration.toMillis(duration) })
    return result
  })

/** Deletion and isolated binding cleanup are registered before the first billable create.
 * A failed deletion stays visible so the operator can reconcile it; no failure detail is logged. */
const cleanup = Effect.fn('BoatLive.cleanup')(function* (key: MachineKey) {
  const saved = yield* bindings()
  const database = yield* Database
  const client = yield* HttpClient.HttpClient
  const apiKey = yield* Config.Redacted('VIVID_BOAT_API_KEY')
  const org = yield* Config.option(Config.NonEmptyString('VIVID_BOAT_ORG'))
  const billed = Option.match(org, {
    onNone: () => Function.identity<HttpClientRequest.HttpClientRequest>,
    onSome: (name) => HttpClientRequest.setHeader('X-Boat-Org', name),
  })
  yield* Effect.addFinalizer(() =>
    measured(
      'delete',
      Effect.gen(function* () {
        const binding = yield* saved.load(key)
        if (Option.isSome(binding) && binding.value.providerId !== null) {
          const id = binding.value.providerId
          const response = yield* client.execute(
            HttpClientRequest.delete(`https://boat.dev/api/v1/sandboxes/${id}`).pipe(
              HttpClientRequest.bearerToken(apiKey),
              billed,
            ),
          )
          expect(response.status >= 200 && response.status < 300).toBe(true)
          yield* Effect.logInfo('Boat live machine deleted', { id })
        }
        yield* database.run(database.delete(machineBindings).where(eq(machineBindings.key, key)))
      }),
    ).pipe(
      Effect.catch(() =>
        Effect.sync(() =>
          expect.fail('Live Boat deletion failed; reconcile the provider account.'),
        ),
      ),
    ),
  )
})

/** Exercise the owned Machine seam against a real guest, with explicit compute opt-in. */
describe.skipIf(!enabled)('Boat native guest live proof', () => {
  it.live(
    'creates, issues a viewer, looks, opens a page, archives and resumes the same machine',
    () =>
      Effect.gen(function* () {
        const machine = yield* Machine
        const key = MachineKey.make(NodeCrypto.randomUUID())
        yield* cleanup(key)
        yield* measured('create', machine.ensure(key))
        const created = yield* measured('viewer', machine.status(key))
        if (!ComputerState.guards.Running(created))
          expect.fail('The created Computer must be running')
        expect(Predicate.isTagged(created.screen, 'Viewer')).toBe(true)
        const view = yield* measured(
          'look',
          machine.desktop({ key, action: DesktopAction.cases.Look.make({}) }),
        )
        expect(view.picture.length > 0 && view.width > 0 && view.height > 0).toBe(true)
        const page = yield* measured(
          'open-and-read',
          machine.browse({
            key,
            action: BrowserAction.cases.Open.make({ address: 'https://example.com' }),
          }),
        )
        expect(page.title.includes('Example')).toBe(true)
        yield* measured('archive', machine.stop(key))
        expect(ComputerState.guards.Stopped(yield* machine.status(key))).toBe(true)
        yield* measured('resume', machine.ensure(key))
        const resumed = yield* measured('resumed-viewer', machine.status(key))
        if (!ComputerState.guards.Running(resumed))
          expect.fail('The resumed Computer must be running')
        expect(Predicate.isTagged(resumed.screen, 'Viewer')).toBe(true)
        const restored = yield* measured(
          'resumed-look',
          machine.desktop({ key, action: DesktopAction.cases.Look.make({}) }),
        )
        expect(restored.width).toBe(view.width)
        expect(restored.height).toBe(view.height)
      }).pipe(Effect.scoped, Effect.provide(provider)),
    25 * 60_000,
  )
})
