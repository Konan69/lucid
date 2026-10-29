import { describe, expect, layer } from '@effect/vitest'
import { NodeHttpClient } from '@effect/platform-node'
import * as NodeCrypto from 'node:crypto'
import { ComputerHealth, ComputerRecoveryId } from '@vivid/contracts'
import { Effect, Layer } from 'effect'
import { testDatabaseLayer } from '../database/testdb.ts'
import { browserFailed, healthFixture } from './tests/health.ts'

/** The operator must supply an already-faulted proof-owned browser. This test does not invent
 * a fault by stopping an unrelated process, and never runs against the production Computer. */
describe.skipIf(process.env['VIVID_LIVE_COMPUTER_HEALTH'] !== '1')(
  'Computer browser recovery, live',
  () => {
    layer(Layer.mergeAll(testDatabaseLayer, NodeHttpClient.layerUndici), {
      excludeTestServices: true,
    })((it) => {
      it.effect('restarts an attested unresponsive browser and reports Ready', () =>
        Effect.gen(function* () {
          const fixture = yield* healthFixture()
          const before = yield* fixture.read
          expect(browserFailed(before), 'A real unresponsive browser is required').toBe(true)
          if (!ComputerHealth.guards.Degraded(before))
            return expect.fail('Expected a diagnosed browser fault')
          expect(
            (yield* fixture.store.recover(fixture.actor, {
              id: ComputerRecoveryId.make(NodeCrypto.randomUUID()),
              step: 'RestartBrowser',
            }))._tag,
          ).toBe('Completed')
          expect((yield* fixture.read)._tag).toBe('Ready')
        }).pipe(Effect.scoped),
      )
    })
  },
)
