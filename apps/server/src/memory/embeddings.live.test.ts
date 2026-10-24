import { NodeHttpClient } from '@effect/platform-node'
import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { describe, expect } from 'vitest'
import { Embeddings, embeddingsLayer } from './embeddings.ts'

const enabled = process.env['VIVID_LIVE_SERVER_MODEL'] === '1'

/** A real provider vector proves that changing gateways preserves the stored index dimension. */
describe.skipIf(!enabled)('Configured server embedding provider', () => {
  layer(embeddingsLayer.pipe(Layer.provide(NodeHttpClient.layerUndici)), {
    excludeTestServices: true,
  })((it) => {
    it.effect('returns the existing 1536-dimensional embedding', () =>
      Effect.gen(function* () {
        const embeddings = yield* Embeddings
        const vectors = yield* embeddings.embed(['A holiday in Florence, Italy.'])
        expect(vectors).toHaveLength(1)
        for (const vector of vectors) {
          expect(vector).toHaveLength(1536)
          expect(vector.every(Number.isFinite)).toBe(true)
        }
      }),
    )
  })
})
