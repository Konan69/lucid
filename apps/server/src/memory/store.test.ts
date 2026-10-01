import * as NodeCrypto from 'node:crypto'
import { it } from '@effect/vitest'
import { PersonId, PersonSummary } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Option } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { describe, expect } from 'vitest'
import { embeddingsLayer } from './embeddings.js'
import { helixMemoryLayer, MemoryPartition, MemoryScopeKey } from './helix.js'
import {
  MemoryLocation,
  MemoryStore,
  memoryStoreLayer,
  RememberInput,
  RememberResult,
} from './store.js'

const url = process.env['VIVID_TEST_HELIX_URL']
const enabled = url !== undefined && process.env['OPENROUTER_API_KEY'] !== undefined
const configuration = ConfigProvider.layerAdd(
  ConfigProvider.fromUnknown({ VIVID_HELIX_URL: url }),
  { asPrimary: true },
)
const adapters = Layer.merge(helixMemoryLayer, embeddingsLayer).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(configuration),
)
const store = memoryStoreLayer.pipe(Layer.provide(adapters))

/** A unique test partition isolates fixture lifetime; cleanup is registered before the first write. */
describe.skipIf(!enabled)('MemoryStore on isolated Helix', () => {
  it.effect(
    'recalls semantic and rare terms, reinforces, versions, forgets, and isolates scope and partition',
    () =>
      Effect.gen(function* () {
        const memory = yield* MemoryStore
        const partition = MemoryPartition.make(`c-test-${NodeCrypto.randomUUID()}`)
        const other = MemoryPartition.make(`c-test-${NodeCrypto.randomUUID()}`)
        const personId = PersonId.make('A')
        const scope = MemoryScopeKey.make('person:A')
        const input = RememberInput.make({
          partition,
          scope: MemoryLocation.cases.Person.make({ personId }),
          kind: 'preference',
          content: 'Dami prefers morning meetings. The preference is called zephyrquartz731.',
          aliases: ['sunrise scheduling'],
          learnedIn: null,
          learnedFrom: PersonSummary.make({ id: personId, name: 'Dami', image: null }),
        })
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const remaining = yield* memory.list({ partition, scopes: [scope] })
            yield* Effect.forEach(remaining, (record) =>
              memory.forget({ partition, id: record.id }),
            )
          }).pipe(
            Effect.match({
              onFailure: (failure) => expect.fail(`Cleanup failed: ${failure._tag}`),
              onSuccess: () => undefined,
            }),
          ),
        )
        const concurrent = yield* Effect.all([memory.remember(input), memory.remember(input)], {
          concurrency: 2,
        })
        const first = concurrent.find((result) => RememberResult.guards.Stored(result))
        if (first === undefined) expect.fail('One concurrent remember must create the record')
        expect(
          concurrent.filter((result) => RememberResult.guards.Reinforced(result)),
        ).toHaveLength(1)
        expect(concurrent.every((result) => result.memory.id === first.memory.id)).toBe(true)
        const rare = yield* memory.recall({
          partition,
          scopes: [scope],
          query: 'zephyrquartz731',
          limit: 5,
        })
        expect(rare.map((record) => record.id)).toContain(first.memory.id)
        const started = performance.now()
        const paraphrase = yield* memory.recall({
          partition,
          scopes: [scope],
          query: 'When does Dami like to meet?',
          limit: 5,
        })
        process.stdout.write(
          `Hybrid recall milliseconds: ${(performance.now() - started).toFixed(2)}\n`,
        )
        expect(paraphrase.map((record) => record.id)).toContain(first.memory.id)
        const second = yield* memory.remember(input)
        expect(RememberResult.guards.Reinforced(second)).toBe(true)
        expect(second.memory.id).toBe(first.memory.id)
        expect(yield* memory.list({ partition, scopes: [scope] })).toHaveLength(1)
        expect(
          yield* memory.recall({
            partition,
            scopes: [MemoryScopeKey.make('company')],
            query: 'zephyrquartz731',
            limit: 5,
          }),
        ).toHaveLength(0)
        expect(
          yield* memory.recall({
            partition: other,
            scopes: [scope],
            query: 'zephyrquartz731',
            limit: 5,
          }),
        ).toHaveLength(0)
        expect(
          yield* memory.recall({ partition, scopes: [], query: 'zephyrquartz731', limit: 5 }),
        ).toHaveLength(0)
        const corrected = yield* memory.correct({
          partition,
          id: first.memory.id,
          content: 'Dami now prefers evening meetings instead of morning meetings.',
        })
        const current = yield* memory.recall({
          partition,
          scopes: [scope],
          query: 'When does Dami like to meet?',
          limit: 5,
        })
        expect(current.map((record) => record.id)).toContain(corrected.id)
        expect(current.map((record) => record.id)).not.toContain(first.memory.id)
        expect(current.every((record) => record.content === corrected.content)).toBe(true)
        yield* memory.forget({ partition, id: corrected.id })
        expect(
          yield* memory.recall({
            partition,
            scopes: [scope],
            query: 'When does Dami like to meet?',
            limit: 5,
          }),
        ).toHaveLength(0)
        const brief = yield* memory.brief.put({
          partition,
          personId,
          text: 'Dami likes concise answers.',
        })
        expect(yield* memory.brief.get({ partition, personId })).toEqual(Option.some(brief))
        expect(yield* memory.brief.get({ partition: other, personId })).toEqual(Option.none())
      }).pipe(Effect.provide(store)),
    { timeout: 120000 },
  )
})
