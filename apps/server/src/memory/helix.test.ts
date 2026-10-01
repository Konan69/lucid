import * as NodeCrypto from 'node:crypto'
import { it } from '@effect/vitest'
import {
  Memory,
  MemoryBrief,
  MemoryId,
  MemoryScope,
  PersonId,
  PersonSummary,
} from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Option, Result } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { describe, expect } from 'vitest'
import { Embeddings, embeddingsLayer } from './embeddings.js'
import {
  HelixMemory,
  helixMemoryLayer,
  MemoryIndexMismatch,
  MemoryPartition,
  MemoryRecord,
  MemoryScopeKey,
} from './helix.js'

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

/** Create attributed protocol fixtures without weakening the public Memory contract. */
function record(input: {
  readonly content: string
  readonly scope: MemoryScopeKey
  readonly createdAt: number
}) {
  const person = PersonSummary.make({ id: PersonId.make('A'), name: 'Dami', image: null })
  const scope =
    input.scope === 'company'
      ? MemoryScope.cases.Company.make({})
      : MemoryScope.cases.Person.make({})
  return MemoryRecord.make({
    memory: Memory.make({
      id: MemoryId.make(NodeCrypto.randomUUID()),
      kind: 'fact',
      content: input.content,
      scope,
      learnedIn: null,
      learnedFrom: person,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    }),
    aliases: ['laminaropal776'],
    scope: input.scope,
  })
}

/** These tests exercise graph membership, aliases, lifecycle and embedding-space protection through real Helix requests. */
describe.skipIf(!enabled)('Helix memory graph', () => {
  it.effect(
    'filters graph neighbors by scope and lifecycle, indexes aliases, and invalidates stale briefs',
    () =>
      Effect.gen(function* () {
        const helix = yield* HelixMemory
        const embeddings = yield* Embeddings
        const partition = MemoryPartition.make(`company:test-${NodeCrypto.randomUUID()}`)
        const privateScope = MemoryScopeKey.make('person:A')
        const companyScope = MemoryScopeKey.make('company')
        const hiddenScope = MemoryScopeKey.make('person:B')
        const scopes = [privateScope, companyScope, hiddenScope]
        const seed = record({
          content: 'Dami prefers morning meetings.',
          scope: privateScope,
          createdAt: 100,
        })
        const shared = record({
          content: 'The Company launch workstream is in progress.',
          scope: companyScope,
          createdAt: 200,
        })
        const hidden = record({
          content: 'B prefers private written updates.',
          scope: hiddenScope,
          createdAt: 300,
        })
        yield* Effect.addFinalizer(() =>
          Effect.forEach([seed, shared, hidden], (value) =>
            helix.forget({ partition, id: value.memory.id, now: 400 }),
          ).pipe(
            Effect.match({
              onFailure: (failure) => expect.fail(`Cleanup failed: ${failure._tag}`),
              onSuccess: () => undefined,
            }),
          ),
        )
        const vectors = yield* embeddings.embed([
          seed.memory.content,
          shared.memory.content,
          hidden.memory.content,
        ])
        const [seedVector, sharedVector, hiddenVector] = vectors
        if (seedVector === undefined || sharedVector === undefined || hiddenVector === undefined)
          expect.fail('Expected three provider vectors')
        yield* helix.insert({ partition, record: seed, embedding: seedVector })
        yield* helix.insert({ partition, record: shared, embedding: sharedVector })
        yield* helix.insert({ partition, record: hidden, embedding: hiddenVector })
        yield* helix.link({
          partition,
          from: seed.memory.id,
          to: shared.memory.id,
          kind: 'EXTENDS',
        })
        yield* helix.link({
          partition,
          from: shared.memory.id,
          to: hidden.memory.id,
          kind: 'RELATES_TO',
        })
        const privateNeighbors = yield* helix.expand({
          partition,
          scopes: [privateScope],
          ids: [seed.memory.id],
          limit: 5,
        })
        expect(privateNeighbors).toHaveLength(0)
        const readableNeighbors = yield* helix.expand({
          partition,
          scopes: [privateScope, companyScope],
          ids: [seed.memory.id],
          limit: 5,
        })
        expect(readableNeighbors.map((value) => value.memory.id)).toEqual([shared.memory.id])
        const reverseNeighbors = yield* helix.expand({
          partition,
          scopes: [privateScope, companyScope],
          ids: [shared.memory.id],
          limit: 5,
        })
        expect(reverseNeighbors.map((value) => value.memory.id)).toEqual([seed.memory.id])
        const search = yield* helix.search({
          partition,
          scopes: [privateScope],
          query: 'laminaropal776',
          embedding: seedVector,
          limit: 5,
        })
        expect(search.keyword.map((value) => value.record.memory.id)).toEqual([seed.memory.id])
        expect((yield* helix.list({ partition, scopes })).map((value) => value.memory.id)).toEqual([
          hidden.memory.id,
          shared.memory.id,
          seed.memory.id,
        ])
        const personId = PersonId.make('A')
        yield* helix.briefPut({
          partition,
          personId,
          brief: MemoryBrief.make({ text: 'Dami prefers morning meetings.', updatedAt: 300 }),
        })
        yield* helix.forget({ partition, id: seed.memory.id, now: 400 })
        expect(yield* helix.briefGet({ partition, personId })).toEqual(Option.none())
        expect(
          yield* helix.expand({
            partition,
            scopes: [privateScope, companyScope],
            ids: [shared.memory.id],
            limit: 5,
          }),
        ).toHaveLength(0)
      }).pipe(Effect.provide(adapters)),
    { timeout: 120000 },
  )

  it.effect(
    'rejects opening the existing index under a different embedding model',
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          yield* HelixMemory
        }).pipe(
          Effect.provide(helixMemoryLayer),
          Effect.provide(FetchHttpClient.layer),
          Effect.provide(
            ConfigProvider.layerAdd(
              ConfigProvider.fromUnknown({
                VIVID_HELIX_URL: url,
                VIVID_EMBEDDING_MODEL: 'mismatched-test-model',
              }),
              { asPrimary: true },
            ),
          ),
          Effect.result,
        )
        if (Result.isSuccess(result)) expect.fail('Expected an embedding-space mismatch')
        expect(result.failure).toBeInstanceOf(MemoryIndexMismatch)
      }),
    { timeout: 10000 },
  )
})
