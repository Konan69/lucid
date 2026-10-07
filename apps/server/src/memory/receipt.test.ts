import { NodeHttpClient } from '@effect/platform-node'
import { layer } from '@effect/vitest'
import {
  g,
  Predicate,
  Projection,
  readBatch,
  SourcePredicate,
  type QueryRequest,
} from '@helix-db/helix-db'
import { Memory, MemoryId, MemoryScope, PersonId, PersonSummary } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Option, Result, Schema, Scope } from 'effect'
import * as NodeCrypto from 'node:crypto'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import { describe, expect } from 'vitest'
import { embeddingDimensions } from './embeddings.js'
import {
  HelixConflict,
  HelixDuplicate,
  HelixMemory,
  helixMemoryLayer,
  MemoryPartition,
  MemoryReceiptId,
  MemoryRecord,
  MemoryScopeKey,
  ReceiptedWrite,
} from './helix.js'

const url = process.env['VIVID_TEST_HELIX_URL']
const configuration = ConfigProvider.layerAdd(
  ConfigProvider.fromUnknown({ VIVID_HELIX_URL: url }),
  { asPrimary: true },
)
const adapters = helixMemoryLayer.pipe(
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provide(configuration),
)
const scope = MemoryScopeKey.make('company')
const learnedFrom = PersonSummary.make({
  id: PersonId.make('receipt-person'),
  name: 'Dami',
  image: null,
})
const isConflict = Schema.is(HelixConflict)
const isDuplicate = Schema.is(HelixDuplicate)

/** Fixtures keep identities and attribution valid without calling the embedding provider for graph-only tests. */
function record(content: string, now: number) {
  return MemoryRecord.make({
    memory: Memory.make({
      id: MemoryId.make(NodeCrypto.randomUUID()),
      kind: 'fact',
      content,
      scope: MemoryScope.cases.Company.make({}),
      learnedIn: null,
      learnedFrom,
      createdAt: now,
      updatedAt: now,
    }),
    aliases: ['first-alias'],
    scope,
  })
}

/** Register every possible record's cleanup before writing so failed assertions cannot retain live fixtures. */
const fixture = Effect.fn('ReceiptTest.fixture')(function* () {
  const helix = yield* HelixMemory
  const partition = MemoryPartition.make(`c-receipt-${NodeCrypto.randomUUID()}`)
  const receiptId = MemoryReceiptId.make(JSON.stringify([partition, NodeCrypto.randomUUID(), 0]))
  const seed = record('First memory', 100)
  const replacement = record('Replacement memory', 200)
  const outgoing = record('Outgoing neighbour', 50)
  const incoming = record('Incoming neighbour', 60)
  const dimensions = yield* embeddingDimensions
  const embedding = Array.from({ length: dimensions }, (_, index) => (index === 0 ? 1 : 0))
  yield* Effect.addFinalizer(() =>
    Effect.forEach([seed, replacement, outgoing, incoming], (value) =>
      helix.forget({ partition, id: value.memory.id, now: 1000 }),
    ).pipe(
      Effect.match({
        onFailure: (error) => expect.fail(`Cleanup failed: ${error._tag}`),
        onSuccess: () => undefined,
      }),
    ),
  )
  return { helix, partition, receiptId, seed, replacement, outgoing, incoming, embedding }
})

const decodeInspection = HttpClientResponse.schemaBodyJson(
  Schema.Struct({
    memories: Schema.Array(Schema.Struct({ memoryId: MemoryId, accessCount: Schema.Finite })),
    receipts: Schema.Array(Schema.Struct({ memoryId: MemoryId })),
    edges: Schema.Array(Schema.Struct({ kind: Schema.String })),
  }),
)

/** Public expand deduplicates neighbours and hides UPDATES; this read-only SDK query measures exact edge/receipt counts and accessCount. */
const inspect = Effect.fn('ReceiptTest.inspect')(function* (partition: MemoryPartition) {
  if (url === undefined) expect.fail('Disposable Helix URL required')
  const client = yield* HttpClient.HttpClient
  const query: QueryRequest = readBatch()
    .varAs(
      'memories',
      g()
        .nWithLabelWhere('Memory', SourcePredicate.eq('tenant_id', partition))
        .project([
          Projection.property('memoryId', 'memoryId'),
          Projection.property('accessCount', 'accessCount'),
        ]),
    )
    .varAs(
      'receipts',
      g()
        .nWithLabelWhere('MemoryReceipt', SourcePredicate.eq('tenant_id', partition))
        .project([Projection.property('memoryId', 'memoryId')]),
    )
    .varAs(
      'edges',
      g()
        .nWithLabelWhere('Memory', SourcePredicate.eq('tenant_id', partition))
        .outE()
        .where(Predicate.eq('tenant_id', partition))
        .project([Projection.property('$label', 'kind')]),
    )
    .returning(['memories', 'receipts', 'edges'])
    .toQueryRequest()
  const response = yield* client.execute(
    HttpClientRequest.bodyText(
      HttpClientRequest.post(`${url}/v2/query`),
      query.toJsonString(),
      'application/json',
    ),
  )
  expect(response.status).toBe(200)
  return yield* decodeInspection(response)
})

/** Per-test scopes release fixtures; the shared suite supplies already acquired live HTTP services. */
function verified<A, E>(
  effect: Effect.Effect<A, E, HelixMemory | HttpClient.HttpClient | Scope.Scope>,
) {
  return effect.pipe(Effect.scoped)
}

/** A fresh Layer acquisition per competitor prevents shared Layer memoization from disguising cross-client races. */
const independentInsert = Effect.fn('ReceiptTest.independentInsert')(
  function* (input: Parameters<HelixMemory['Service']['insertOnce']>[0]) {
    const helix = yield* HelixMemory
    return yield* helix.insertOnce(input).pipe(Effect.result)
  },
  (effect) =>
    effect.pipe(Effect.provide(helixMemoryLayer, { local: true }), Effect.provide(configuration)),
)

/** Both empty-neighbour and bidirectional-neighbour batches preserve guarded edge ordering on first application and replay. */
const supersession = Effect.fn('ReceiptTest.supersession')(function* (neighbours: boolean) {
  const f = yield* fixture()
  yield* f.helix.insert({ partition: f.partition, record: f.seed, embedding: f.embedding })
  if (neighbours) {
    for (const value of [f.outgoing, f.incoming])
      yield* f.helix.insert({ partition: f.partition, record: value, embedding: f.embedding })
    yield* f.helix.link({
      partition: f.partition,
      from: f.seed.memory.id,
      to: f.outgoing.memory.id,
      kind: 'EXTENDS',
    })
    yield* f.helix.link({
      partition: f.partition,
      from: f.incoming.memory.id,
      to: f.seed.memory.id,
      kind: 'EXTENDS',
    })
  }
  const input = {
    partition: f.partition,
    receiptId: f.receiptId,
    oldId: f.seed.memory.id,
    record: f.replacement,
    embedding: f.embedding,
  }
  expect(yield* f.helix.supersedeOnce(input)).toEqual(ReceiptedWrite.cases.Applied.make({}))
  const first = yield* inspect(f.partition)
  expect(yield* f.helix.supersedeOnce(input)).toEqual(
    ReceiptedWrite.cases.Recorded.make({ memoryId: f.replacement.memory.id }),
  )
  expect(yield* inspect(f.partition)).toEqual(first)
  expect(first.receipts).toEqual([{ memoryId: f.replacement.memory.id }])
  expect(first.edges.filter((edge) => edge.kind === 'UPDATES')).toHaveLength(1)
  expect(first.edges.filter((edge) => edge.kind === 'EXTENDS')).toHaveLength(neighbours ? 4 : 0)
  expect(yield* f.helix.get({ partition: f.partition, id: f.seed.memory.id })).toEqual(
    Option.none(),
  )
  expect(yield* f.helix.get({ partition: f.partition, id: f.replacement.memory.id })).toEqual(
    Option.some(f.replacement),
  )
  const live = yield* f.helix.list({ partition: f.partition, scopes: [scope] })
  expect(live).toHaveLength(neighbours ? 3 : 1)
  const context = yield* f.helix.expand({
    partition: f.partition,
    scopes: [scope],
    ids: [f.replacement.memory.id],
    limit: 10,
  })
  expect(context.map((value) => value.memory.id).toSorted()).toEqual(
    neighbours ? [f.outgoing.memory.id, f.incoming.memory.id].toSorted() : [],
  )
  if (neighbours) {
    for (const value of [f.outgoing, f.incoming]) {
      const reverse = yield* f.helix.expand({
        partition: f.partition,
        scopes: [scope],
        ids: [value.memory.id],
        limit: 10,
      })
      expect(reverse.map((row) => row.memory.id)).toEqual([f.replacement.memory.id])
    }
  }
  const missing = yield* f.helix.supersedeOnce({
    ...input,
    receiptId: MemoryReceiptId.make(NodeCrypto.randomUUID()),
  })
  expect(missing).toEqual(ReceiptedWrite.cases.Missing.make({}))
  expect(yield* inspect(f.partition)).toEqual(first)
})

/** Suite acquisition waits for all thirteen real index-build success signals on empty storage; assertion limits stay unchanged. */
const INDEX_ACQUISITION_LIMIT = 60_000

/** These assertions cross real durable Helix requests; no fake storage, sleep, poll, or test timeout supplies correctness. */
describe.skipIf(process.env['VIVID_TEST_HELIX_URL'] === undefined)('Helix memory receipts', () => {
  layer(adapters, { timeout: INDEX_ACQUISITION_LIMIT, excludeTestServices: true })(
    'indexed storage',
    (it) => {
      it.effect('inserts once and reads the first memory from its tenant-qualified receipt', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            const input = {
              partition: f.partition,
              receiptId: f.receiptId,
              record: f.seed,
              embedding: f.embedding,
              extends: Option.none<MemoryId>(),
            }
            expect(yield* f.helix.insertOnce(input)).toEqual(ReceiptedWrite.cases.Applied.make({}))
            expect(yield* f.helix.insertOnce({ ...input, record: f.replacement })).toEqual(
              ReceiptedWrite.cases.Recorded.make({ memoryId: f.seed.memory.id }),
            )
            expect(yield* f.helix.list({ partition: f.partition, scopes: [scope] })).toEqual([
              f.seed,
            ])
            expect(yield* f.helix.receipt(input)).toEqual(Option.some(f.seed.memory.id))
            expect(
              yield* f.helix.receipt({
                ...input,
                partition: MemoryPartition.make(`c-other-${NodeCrypto.randomUUID()}`),
              }),
            ).toEqual(Option.none())
            const stored = yield* inspect(f.partition)
            expect(stored.memories).toHaveLength(1)
            expect(stored.receipts).toEqual([{ memoryId: f.seed.memory.id }])
          }),
        ),
      )

      it.effect('races independent acquisitions without committing two records or receipts', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            const input = {
              partition: f.partition,
              receiptId: f.receiptId,
              embedding: f.embedding,
              extends: Option.none<MemoryId>(),
            }
            const results = yield* Effect.all(
              [
                independentInsert({ ...input, record: f.seed }),
                independentInsert({ ...input, record: f.replacement }),
              ],
              { concurrency: 'unbounded' },
            )
            const stored = yield* inspect(f.partition)
            expect(stored.memories).toHaveLength(1)
            expect(stored.receipts).toHaveLength(1)
            const survivor = stored.memories[0]
            if (survivor === undefined) expect.fail('One survivor required')
            expect(yield* f.helix.receipt(input)).toEqual(Option.some(survivor.memoryId))
            expect(stored.receipts).toEqual([{ memoryId: survivor.memoryId }])
            let applied = 0
            for (const result of results) {
              if (Result.isFailure(result)) {
                expect(isConflict(result.failure) || isDuplicate(result.failure)).toBe(true)
              } else {
                ReceiptedWrite.match(result.success, {
                  Applied: () => {
                    applied += 1
                  },
                  Recorded: ({ memoryId }) => expect(memoryId).toBe(survivor.memoryId),
                  Missing: () => expect.fail('Insert cannot be missing'),
                })
              }
            }
            expect(applied).toBe(1)
          }),
        ),
      )

      it.effect('creates one EXTENDS edge with insertion and skips missing targets', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            yield* f.helix.insert({
              partition: f.partition,
              record: f.outgoing,
              embedding: f.embedding,
            })
            const input = {
              partition: f.partition,
              receiptId: f.receiptId,
              record: f.seed,
              embedding: f.embedding,
              extends: Option.some(f.outgoing.memory.id),
            }
            expect(yield* f.helix.insertOnce(input)).toEqual(ReceiptedWrite.cases.Applied.make({}))
            expect(yield* f.helix.insertOnce(input)).toEqual(
              ReceiptedWrite.cases.Recorded.make({ memoryId: f.seed.memory.id }),
            )
            const context = yield* f.helix.expand({
              partition: f.partition,
              scopes: [scope],
              ids: [f.seed.memory.id],
              limit: 10,
            })
            expect(context.map((value) => value.memory.id)).toEqual([f.outgoing.memory.id])
            expect((yield* inspect(f.partition)).edges).toEqual([{ kind: 'EXTENDS' }])
            const missingTarget = {
              ...input,
              receiptId: MemoryReceiptId.make(NodeCrypto.randomUUID()),
              record: f.replacement,
              extends: Option.some(MemoryId.make(NodeCrypto.randomUUID())),
            }
            expect(yield* f.helix.insertOnce(missingTarget)).toEqual(
              ReceiptedWrite.cases.Applied.make({}),
            )
            expect(
              yield* f.helix.expand({
                partition: f.partition,
                scopes: [scope],
                ids: [f.replacement.memory.id],
                limit: 10,
              }),
            ).toEqual([])
            expect((yield* inspect(f.partition)).edges).toHaveLength(1)
          }),
        ),
      )

      it.effect('reinforces once, preserving the first aliases, timestamp and EXTENDS edge', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            for (const value of [f.seed, f.outgoing])
              yield* f.helix.insert({
                partition: f.partition,
                record: value,
                embedding: f.embedding,
              })
            const reinforced = MemoryRecord.make({
              ...f.seed,
              aliases: [...f.seed.aliases, 'second-alias'],
              memory: Memory.make({ ...f.seed.memory, updatedAt: 200 }),
            })
            const input = {
              partition: f.partition,
              receiptId: f.receiptId,
              record: reinforced,
              extends: Option.some(f.outgoing.memory.id),
            }
            expect(yield* f.helix.reinforceOnce(input)).toEqual(
              ReceiptedWrite.cases.Applied.make({}),
            )
            const replayed = MemoryRecord.make({
              ...reinforced,
              aliases: [...reinforced.aliases, 'replay-alias'],
              memory: Memory.make({ ...reinforced.memory, updatedAt: 300 }),
            })
            expect(yield* f.helix.reinforceOnce({ ...input, record: replayed })).toEqual(
              ReceiptedWrite.cases.Recorded.make({ memoryId: f.seed.memory.id }),
            )
            expect(yield* f.helix.get({ partition: f.partition, id: f.seed.memory.id })).toEqual(
              Option.some(reinforced),
            )
            const stored = yield* inspect(f.partition)
            const reinforcedRow = stored.memories.find((row) => row.memoryId === f.seed.memory.id)
            if (reinforcedRow === undefined) expect.fail('Reinforced record required')
            expect(reinforcedRow.accessCount).toBe(2)
            expect(stored.edges).toEqual([{ kind: 'EXTENDS' }])
            expect(stored.receipts).toEqual([{ memoryId: f.seed.memory.id }])
          }),
        ),
      )

      it.effect('skips reinforcement self-links and missing EXTENDS targets', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            yield* f.helix.insert({
              partition: f.partition,
              record: f.seed,
              embedding: f.embedding,
            })
            const input = {
              partition: f.partition,
              receiptId: f.receiptId,
              record: f.seed,
              extends: Option.some(f.seed.memory.id),
            }
            expect(yield* f.helix.reinforceOnce(input)).toEqual(
              ReceiptedWrite.cases.Applied.make({}),
            )
            expect(
              yield* f.helix.reinforceOnce({
                ...input,
                receiptId: MemoryReceiptId.make(NodeCrypto.randomUUID()),
                extends: Option.some(MemoryId.make(NodeCrypto.randomUUID())),
              }),
            ).toEqual(ReceiptedWrite.cases.Applied.make({}))
            expect((yield* inspect(f.partition)).edges).toEqual([])
          }),
        ),
      )

      it.effect('does not consume a receipt when reinforcement targets a forgotten record', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            yield* f.helix.insert({
              partition: f.partition,
              record: f.seed,
              embedding: f.embedding,
            })
            yield* f.helix.forget({ partition: f.partition, id: f.seed.memory.id, now: 200 })
            const input = {
              partition: f.partition,
              receiptId: f.receiptId,
              record: f.seed,
              extends: Option.some(f.outgoing.memory.id),
            }
            expect(yield* f.helix.reinforceOnce(input)).toEqual(
              ReceiptedWrite.cases.Missing.make({}),
            )
            expect(yield* f.helix.receipt(input)).toEqual(Option.none())
            expect((yield* inspect(f.partition)).memories).toEqual([
              { memoryId: f.seed.memory.id, accessCount: 1 },
            ])
            expect((yield* inspect(f.partition)).receipts).toEqual([])
          }),
        ),
      )

      it.effect('supersedes and replays a record with no neighbours', () =>
        verified(supersession(false)),
      )
      it.effect(
        'supersedes once, copies both EXTENDS directions and replays without duplicate edges',
        () => verified(supersession(true)),
      )

      it.effect(
        'returns Missing without a receipt for an already superseded oldId under a new key',
        () =>
          verified(
            Effect.gen(function* () {
              const f = yield* fixture()
              yield* f.helix.insert({
                partition: f.partition,
                record: f.seed,
                embedding: f.embedding,
              })
              yield* f.helix.supersede({
                partition: f.partition,
                oldId: f.seed.memory.id,
                record: f.replacement,
                embedding: f.embedding,
              })
              const input = {
                partition: f.partition,
                receiptId: f.receiptId,
                oldId: f.seed.memory.id,
                record: f.outgoing,
                embedding: f.embedding,
              }
              expect(yield* f.helix.supersedeOnce(input)).toEqual(
                ReceiptedWrite.cases.Missing.make({}),
              )
              expect(yield* f.helix.receipt(input)).toEqual(Option.none())
              expect((yield* inspect(f.partition)).memories).toHaveLength(2)
              expect((yield* inspect(f.partition)).receipts).toEqual([])
            }),
          ),
      )

      it.effect(
        'decodes a forced receipt uniqueness violation and rolls back the earlier record creation',
        () =>
          verified(
            Effect.gen(function* () {
              const first = yield* fixture()
              const second = yield* fixture()
              const input = {
                partition: first.partition,
                receiptId: first.receiptId,
                record: first.seed,
                embedding: first.embedding,
                extends: Option.none<MemoryId>(),
              }
              yield* first.helix.insertOnce(input)
              // The unique key is global, while receipt lookup is tenant-qualified. Deliberately violating
              // key construction forces the server's exact 500 uniqueness path without a probabilistic race.
              const duplicate = yield* second.helix
                .insertOnce({ ...input, partition: second.partition, record: second.seed })
                .pipe(Effect.result)
              if (Result.isSuccess(duplicate))
                expect.fail('Unique receipt index must reject the write')
              expect(duplicate.failure).toBeInstanceOf(HelixDuplicate)
              expect(
                yield* second.helix.receipt({
                  partition: second.partition,
                  receiptId: first.receiptId,
                }),
              ).toEqual(Option.none())
              expect((yield* inspect(second.partition)).memories).toEqual([])
              expect((yield* inspect(second.partition)).receipts).toEqual([])
              expect(yield* first.helix.receipt(input)).toEqual(Option.some(first.seed.memory.id))
            }),
          ),
      )
    },
  )
})
