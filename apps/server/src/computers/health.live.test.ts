import { describe, expect, layer } from '@effect/vitest'
import { NodeHttpClient } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { testDatabaseLayer } from '../database/testdb.ts'
import { healthFixture } from './tests/health.ts'

/** No live authority exists today. This opt-in consumes an existing proof binding only. */
describe.skipIf(process.env['VIVID_LIVE_COMPUTER_HEALTH'] !== '1')(
  'Computer deep health, live',
  () => {
    layer(Layer.mergeAll(testDatabaseLayer, NodeHttpClient.layerUndici), {
      excludeTestServices: true,
    })((it) => {
      it.effect('reports Ready for the already-running proof Computer', () =>
        Effect.gen(function* () {
          const fixture = yield* healthFixture()
          expect((yield* fixture.read)._tag).toBe('Ready')
        }).pipe(Effect.scoped),
      )
    })
  },
)
