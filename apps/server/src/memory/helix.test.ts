import { defineParams, g, param, writeBatch } from '@helix-db/helix-db'
import * as NodeCrypto from 'node:crypto'
import { it, layer as testLayer } from '@effect/vitest'
import {
  Memory,
  MemoryBrief,
  MemoryId,
  MemoryScope,
  PersonId,
  PersonSummary,
} from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Option, Result, Schema } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { NodeHttpClient } from '@effect/platform-node'
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
const enabled = url !== undefined && process.env['EXPLABS_API_KEY'] !== undefined
const configuration = ConfigProvider.layerAdd(
  ConfigProvider.fromUnknown({ VIVID_HELIX_URL: url }),
  { asPrimary: true },
)
const adapters = Layer.merge(helixMemoryLayer, embeddingsLayer).pipe(
  Layer.provideMerge(NodeHttpClient.layerUndici),
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

/** Related Company and Thread facts keep both incoming and outgoing context after a correction. */
const preservesLinks = Effect.fn('MemoryTest.links')(function* (input: {
  readonly helix: HelixMemory['Service']
  readonly partition: MemoryPartition
  readonly records: ReadonlyArray<MemoryRecord>
  readonly embedding: ReadonlyArray<number>
}) {
  const [seed, shared, hidden] = input.records
  if (seed === undefined || shared === undefined || hidden === undefined)
    expect.fail('Three graph records required')
  const replacement = MemoryRecord.make({
    ...shared,
    memory: Memory.make({
      ...shared.memory,
      id: MemoryId.make(NodeCrypto.randomUUID()),
      createdAt: 350,
      updatedAt: 350,
    }),
  })
  yield* Effect.addFinalizer(() =>
    input.helix
      .forget({ partition: input.partition, id: replacement.memory.id, now: 500 })
      .pipe(
        Effect.match({ onFailure: (error) => expect.fail(error._tag), onSuccess: () => undefined }),
      ),
  )
  yield* input.helix.supersede({
    partition: input.partition,
    oldId: shared.memory.id,
    record: replacement,
    embedding: input.embedding,
  })
  const scopes = input.records.map((value) => value.scope)
  const fromReplacement = yield* input.helix.expand({
    partition: input.partition,
    scopes,
    ids: [replacement.memory.id],
    limit: 5,
  })
  expect(fromReplacement).toHaveLength(2)
  expect(fromReplacement.map((value) => value.memory.id)).toEqual(
    expect.arrayContaining([seed.memory.id, hidden.memory.id]),
  )
  for (const neighbor of [seed, hidden]) {
    const context = yield* input.helix.expand({
      partition: input.partition,
      scopes,
      ids: [neighbor.memory.id],
      limit: 5,
    })
    expect(context.map((value) => value.memory.id)).toEqual([replacement.memory.id])
  }
})

/** A change to one unreadable scope preserves both stored pages; each reader lazily rejects only changes it can read, including tombstones. */
const scopedBriefs = Effect.fn('MemoryTest.briefs')(function* (input: {
  readonly helix: HelixMemory['Service']
  readonly partition: MemoryPartition
  readonly seed: MemoryRecord
  readonly embedding: ReadonlyArray<number>
}) {
  const { helix, partition, seed } = input
  const reader = PersonId.make('A')
  const other = PersonId.make('B')
  const privateScope = seed.scope
  const companyScope = MemoryScopeKey.make('company')
  const firstPage = MemoryBrief.make({ text: 'Dami prefers morning meetings.', updatedAt: 360 })
  const otherPage = MemoryBrief.make({ text: 'B prefers written updates.', updatedAt: 360 })
  yield* helix.briefPut({ partition, personId: reader, brief: firstPage })
  yield* helix.briefPut({ partition, personId: other, brief: otherPage })
  const changed = record({
    content: seed.memory.content,
    scope: MemoryScopeKey.make('person:C'),
    createdAt: 370,
  })
  const sharedChange = record({ content: seed.memory.content, scope: companyScope, createdAt: 380 })
  yield* Effect.addFinalizer(() =>
    Effect.forEach([changed, sharedChange], (value) =>
      helix.forget({ partition, id: value.memory.id, now: 600 }),
    ).pipe(
      Effect.match({ onFailure: (error) => expect.fail(error._tag), onSuccess: () => undefined }),
    ),
  )
  yield* helix.insert({ partition, record: changed, embedding: input.embedding })
  const identity = { partition, personId: reader, scopes: [privateScope, companyScope] }
  expect(yield* helix.briefGet(identity)).toEqual(Option.some(firstPage))
  expect(
    yield* helix.briefGet({
      partition,
      personId: other,
      scopes: [MemoryScopeKey.make('person:B')],
    }),
  ).toEqual(Option.some(otherPage))
  yield* helix.insert({ partition, record: sharedChange, embedding: input.embedding })
  expect(yield* helix.briefGet(identity)).toEqual(Option.none())
  expect(yield* helix.briefGet({ partition, personId: other, scopes: [companyScope] })).toEqual(
    Option.none(),
  )
  expect(
    yield* helix.briefGet({
      partition,
      personId: other,
      scopes: [MemoryScopeKey.make('person:B')],
    }),
  ).toEqual(Option.some(otherPage))
  const rebuilt = MemoryBrief.make({ text: firstPage.text, updatedAt: 390 })
  yield* helix.briefPut({ partition, personId: reader, brief: rebuilt })
  expect(yield* helix.briefGet(identity)).toEqual(Option.some(rebuilt))
  yield* helix.forget({ partition, id: seed.memory.id, now: 400 })
  expect(yield* helix.briefGet(identity)).toEqual(Option.none())
  expect(
    yield* helix.briefGet({
      partition,
      personId: other,
      scopes: [MemoryScopeKey.make('person:B')],
    }),
  ).toEqual(Option.some(otherPage))
  // Changing the reader set exposes the stored page again, proving invalidation did not delete it.
  expect(yield* helix.briefGet({ ...identity, scopes: [companyScope] })).toEqual(
    Option.some(rebuilt),
  )
})

/** Prepare the list fixture in one transaction: 201 individual writes would test backfill contention instead of the read bound. All vectors came from the configured embedding provider. */
const insertListFixture = Effect.fn('MemoryTest.insertList')(function* (input: {
  readonly partition: MemoryPartition
  readonly records: ReadonlyArray<MemoryRecord>
  readonly embedding: ReadonlyArray<number>
}) {
  if (url === undefined) expect.fail('Helix test URL required')
  const client = yield* HttpClient.HttpClient
  const p = defineParams({ embedding: param.array(param.f32()) })
  const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(MemoryRecord))
  const rows = yield* Effect.forEach(
    input.records,
    Effect.fn('MemoryTest.encodeList')(function* (value) {
      return { value, payload: yield* encodeRecord(value) }
    }),
  )
  const query = rows
    .reduce(
      (batch, { value, payload }, index) =>
        batch.varAs(
          `created${index}`,
          g().addN('Memory', {
            tenant_id: input.partition,
            memoryId: value.memory.id,
            scope: value.scope,
            content: value.memory.content,
            searchText: [value.memory.content, ...value.aliases].join(' '),
            payload,
            embedding: p.embedding,
            isLatest: true,
            validTo: null,
            deletedAt: null,
            createdAt: value.memory.createdAt,
            updatedAt: value.memory.updatedAt,
            accessCount: 1,
          }),
        ),
      writeBatch(),
    )
    .returning([])
    .toQueryRequest(p, { embedding: [...input.embedding] })
  const response = yield* client.execute(
    HttpClientRequest.bodyText(
      HttpClientRequest.post(`${url}/v2/query`).pipe(
        HttpClientRequest.setHeader('x-helix-await-durable', 'true'),
      ),
      query.toJsonString(),
      'application/json',
    ),
  )
  expect(response.status).toBe(200)
})

/** The hard list bound returns the most recent 200 after filtering, even when older history accumulates. */
const boundedList = Effect.fn('MemoryTest.list')(function* (input: {
  readonly helix: HelixMemory['Service']
  readonly embedding: ReadonlyArray<number>
}) {
  const { helix, embedding } = input
  const partition = MemoryPartition.make(`c-limit-${NodeCrypto.randomUUID()}`)
  const scope = MemoryScopeKey.make('company')
  const records = Array.from({ length: 201 }, (_, index) =>
    record({ content: 'The Company launch workstream is in progress.', scope, createdAt: index }),
  )
  yield* Effect.addFinalizer(() =>
    Effect.forEach(records, (value) =>
      helix.forget({ partition, id: value.memory.id, now: 500 }),
    ).pipe(
      Effect.match({ onFailure: (error) => expect.fail(error._tag), onSuccess: () => undefined }),
    ),
  )
  yield* insertListFixture({ partition, records, embedding })
  const listed = yield* helix.list({ partition, scopes: [scope] })
  expect(listed).toHaveLength(200)
  expect(listed.map((value) => value.memory.createdAt)).toEqual(
    Array.from({ length: 200 }, (_, index) => 200 - index),
  )
})

/** These tests exercise graph membership, aliases, lifecycle and embedding-space protection through real Helix requests. */
describe.skipIf(!enabled)('Helix memory graph', () => {
  testLayer(adapters)((it) => {
    it.effect(
      'filters graph neighbors by scope and lifecycle, indexes aliases, and invalidates stale briefs',
      () =>
        Effect.gen(function* () {
          const helix = yield* HelixMemory
          const embeddings = yield* Embeddings
          const partition = MemoryPartition.make(`c-test-${NodeCrypto.randomUUID()}`)
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
          expect(
            (yield* helix.list({ partition, scopes })).map((value) => value.memory.id),
          ).toEqual([hidden.memory.id, shared.memory.id, seed.memory.id])
          yield* preservesLinks({
            helix,
            partition,
            records: [seed, shared, hidden],
            embedding: sharedVector,
          })
          yield* scopedBriefs({ helix, partition, seed, embedding: seedVector })
          yield* boundedList({ helix, embedding: sharedVector })
        }).pipe(Effect.scoped),
      { timeout: 120000 },
    )
  })

  it.effect(
    'rejects opening the existing index under a different embedding model',
    () =>
      Effect.gen(function* () {
        const result = yield* Layer.build(
          helixMemoryLayer.pipe(
            Layer.provide(NodeHttpClient.layerUndici),
            Layer.provide(
              ConfigProvider.layerAdd(
                ConfigProvider.fromUnknown({
                  VIVID_HELIX_URL: url,
                  VIVID_EMBEDDING_MODEL: 'mismatched-test-model',
                }),
                { asPrimary: true },
              ),
            ),
          ),
        ).pipe(Effect.scoped, Effect.result)
        if (Result.isSuccess(result)) expect.fail('Expected an embedding-space mismatch')
        expect(result.failure).toBeInstanceOf(MemoryIndexMismatch)
      }),
    { timeout: 10000 },
  )
})
