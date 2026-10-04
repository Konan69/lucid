import { NodeHttpClient } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { ConfigProvider, Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect } from 'vitest'
import { HelixMemory, helixMemoryLayer, MemoryPartition, MemoryScopeKey } from './helix.js'

const url = process.env['VIVID_TEST_HELIX_URL']
const configuration = ConfigProvider.layerAdd(
  ConfigProvider.fromUnknown({ VIVID_HELIX_URL: url }),
  { asPrimary: true },
)

/** The layer must create its lookup index before checking it, and repeated acquisition must keep empty reads valid. */
const emptyReads = Effect.fn('MemoryTest.bootstrap')(
  function* () {
    const helix = yield* HelixMemory
    const partition = MemoryPartition.make('p-bootstrap-read-only')
    expect(yield* helix.scopes(partition)).toEqual([])
    expect(yield* helix.list({ partition, scopes: [MemoryScopeKey.make('company')] })).toEqual([])
  },
  (effect) => effect.pipe(Effect.provide(helixMemoryLayer)),
)

/**
 * The first acquisition on empty Helix storage waits until every index build has succeeded
 * (`readyIndexes`); that is a real signal, not a sleep, and on a new database it takes longer than
 * the default per-test limit. Later acquisitions find the indexes active.
 */
const COLD_INDEX_BUILD = { timeout: 60_000 }

/** Run this on a freshly started, in-memory instance to prove first boot without fixtures, embeddings, or credentials. */
describe.skipIf(url === undefined)('Helix bootstrap', COLD_INDEX_BUILD, () => {
  it.effect('acquires and re-acquires indexed reads before any record exists', () =>
    Effect.gen(function* () {
      yield* emptyReads()
      yield* emptyReads()
    }).pipe(
      Effect.provide(NodeHttpClient.layerUndici),
      Effect.provide(configuration),
      // Acquisition waits on real index builds through a Schedule; a controlled clock never advances it.
      TestClock.withLive,
    ),
  )
})
