import { NodeHttpClient } from '@effect/platform-node'
import { layer } from '@effect/vitest'
import { ConfigProvider, Effect, Layer } from 'effect'
import { describe, expect } from 'vitest'
import { HelixMemory, helixMemoryLayer, MemoryPartition, MemoryScopeKey } from './helix.js'

const url = process.env['VIVID_TEST_HELIX_URL']
const configuration = ConfigProvider.layerAdd(
  ConfigProvider.fromUnknown({ VIVID_HELIX_URL: url }),
  { asPrimary: true },
)

const adapters = helixMemoryLayer.pipe(
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provide(configuration),
)

/** The layer must create its lookup index before checking it, and repeated acquisition must keep empty reads valid. */
const emptyReads = Effect.fn('MemoryTest.bootstrap')(function* () {
  const helix = yield* HelixMemory
  const partition = MemoryPartition.make('p-bootstrap-read-only')
  expect(yield* helix.scopes(partition)).toEqual([])
  expect(yield* helix.list({ partition, scopes: [MemoryScopeKey.make('company')] })).toEqual([])
})

/** Suite acquisition waits for all thirteen real index-build success signals on empty storage; assertion limits stay unchanged. */
const INDEX_ACQUISITION_LIMIT = 60_000

/** Run this on a freshly started, in-memory instance to prove first boot without fixtures, embeddings, or credentials. */
describe.skipIf(url === undefined)('Helix bootstrap', () => {
  layer(adapters, { timeout: INDEX_ACQUISITION_LIMIT, excludeTestServices: true })(
    'indexed storage',
    (it) => {
      it.effect('acquires and re-acquires indexed reads before any record exists', () =>
        Effect.gen(function* () {
          yield* emptyReads()
          // The setup proved first acquisition; a separate acquisition must preserve empty indexed reads.
          yield* emptyReads().pipe(Effect.provide(yield* Layer.build(Layer.fresh(adapters))))
        }),
      )
    },
  )
})
