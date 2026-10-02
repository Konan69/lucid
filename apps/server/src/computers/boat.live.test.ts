import * as NodeCrypto from 'node:crypto'
import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { BrowserAction, ComputerState, DesktopAction } from '@vivid/contracts'
import { Effect, Layer, Predicate } from 'effect'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { boatMachineLayer } from './boat.ts'
import { Machine, MachineKey } from './machine.ts'

// Explicit cost opt-in and isolated persistence are mandatory. Read presence, never print key values.
const enabled =
  testDatabaseConfigured &&
  Object.hasOwn(NodeProcess.env, 'VIVID_BOAT_API_KEY') &&
  NodeProcess.env.VIVID_TEST_BOAT_LIVE === '1'
const dependencies = Layer.mergeAll(testDatabaseLayer, NodeHttpClient.layerUndici)
const provider = boatMachineLayer.pipe(Layer.provide(dependencies))

/** A real machine is intentionally left archived with its durable binding for inspection.
 * Cleanup is registered before ensure, never force-stops, and never prints viewer or picture data. */
describe.skipIf(!enabled)('Boat native guest live proof', () => {
  it.live(
    'creates, issues a viewer, looks, opens a page, archives and resumes the same machine',
    () =>
      Effect.gen(function* () {
        const machine = yield* Machine
        const key = MachineKey.make(NodeCrypto.randomUUID())
        yield* Effect.addFinalizer(() =>
          machine
            .stop(key)
            .pipe(
              Effect.catch(() =>
                Effect.logWarning('Live Computer archival failed; inspect the provider account.'),
              ),
            ),
        )
        const created = yield* machine.ensure(key)
        expect(Predicate.isTagged(created.screen, 'Viewer')).toBe(true)
        const view = yield* machine.desktop({ key, action: DesktopAction.cases.Look.make({}) })
        expect(view.picture.length > 0 && view.width > 0 && view.height > 0).toBe(true)
        const page = yield* machine.browse({
          key,
          action: BrowserAction.cases.Open.make({ address: 'https://example.com' }),
        })
        expect(page.title.includes('Example')).toBe(true)
        yield* machine.stop(key)
        expect(ComputerState.guards.Stopped(yield* machine.status(key))).toBe(true)
        expect(Predicate.isTagged((yield* machine.ensure(key)).screen, 'Viewer')).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(provider)),
    25 * 60_000,
  )
})
