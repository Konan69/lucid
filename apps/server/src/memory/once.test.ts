import * as NodeCrypto from 'node:crypto'
import { NodeHttpClient } from '@effect/platform-node'
import { layer } from '@effect/vitest'
import { g, Predicate, Projection, readBatch, SourcePredicate } from '@helix-db/helix-db'
import {
  Company,
  CompanyId,
  InvalidRequest,
  MemoryId,
  NotFound,
  Person,
  PersonId,
  RunId,
  ThreadId,
  Workspace,
  type Memory,
} from '@vivid/contracts'
import { eq, inArray } from 'drizzle-orm'
import {
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
  Scope,
} from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import { describe, expect } from 'vitest'
import type { Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { threads } from '../threads/tables.ts'
import { Embeddings, embeddingDimensions } from './embeddings.js'
import { MemoryCandidate, MemoryExtraction, MemoryRelation } from './extract.js'
import {
  HelixMemory,
  helixMemoryLayer,
  MemoryPartition,
  MemoryReceiptId,
  MemoryScopeKey,
} from './helix.js'
import {
  DestinationChanged,
  LearnKey,
  LearnResult,
  MemoryAccess,
  memoryAccessLayer,
  MemoryStore,
  memoryStoreLayer,
  type LearnOnceInput,
} from './store.js'

const url = process.env['VIVID_TEST_HELIX_URL']
const configuration = ConfigProvider.layerAdd(
  ConfigProvider.fromUnknown({ VIVID_HELIX_URL: url }),
  { asPrimary: true },
)

/** Embeddings are not the seam under test. SHA-256 gives stable nonzero text-derived vectors in the configured embedding dimension, without any provider key. */
const deterministicEmbeddings = Layer.effect(
  Embeddings,
  Effect.gen(function* () {
    const dimensions = yield* embeddingDimensions
    return Embeddings.of({
      embed: Effect.fn('OnceTest.embed')((texts) =>
        Effect.succeed(
          texts.map((text) => {
            const digest = NodeCrypto.createHash('sha256').update(text).digest()
            return Array.from(
              { length: dimensions },
              (_, index) => (digest.readUInt8(index % digest.length) + 1) / 256,
            )
          }),
        ),
      ),
    })
  }),
)

/** learnOnce consumes an already extracted candidate; any accidental extraction or summarization is a test defect. */
const unusedExtraction = Layer.succeed(
  MemoryExtraction,
  MemoryExtraction.of({
    extract: () => Effect.die('learnOnce must not call extraction'),
    summarize: () => Effect.die('learnOnce must not call summarization'),
  }),
)
const adapters = Layer.mergeAll(helixMemoryLayer, deterministicEmbeddings, unusedExtraction).pipe(
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provide(configuration),
)
const persistence = memoryStoreLayer.pipe(Layer.provideMerge(adapters))
const access = memoryAccessLayer.pipe(
  Layer.provideMerge(persistence),
  Layer.provideMerge(testDatabaseLayer),
)

/** UUID ownership isolates every test; cleanup is registered before the first PostgreSQL or Helix write. Historical receipts live only until the disposable container is removed. */
const fixture = Effect.fn('OnceTest.fixture')(function* () {
  const database = yield* Database
  const helix = yield* HelixMemory
  const store = yield* MemoryStore
  const memory = yield* MemoryAccess
  const suffix = NodeCrypto.randomUUID()
  const person = Person.make({
    id: PersonId.make(`once-${suffix}`),
    name: 'Dami',
    email: `once-${suffix}@example.test`,
  })
  const outsider = Person.make({
    id: PersonId.make(`outside-${suffix}`),
    name: 'Ada',
    email: `outside-${suffix}@example.test`,
  })
  const company = Company.make({
    id: CompanyId.make(`once-${suffix}`),
    name: 'Once',
    slug: `once-${suffix}`,
  })
  const personalThread = ThreadId.make(`personal-${suffix}`)
  const sharedThread = ThreadId.make(`shared-${suffix}`)
  const privateThread = ThreadId.make(`private-${suffix}`)
  const personalPartition = MemoryPartition.make(`p-${person.id}`)
  const companyPartition = MemoryPartition.make(`c-${company.id}`)
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const partition of [personalPartition, companyPartition]) {
        const scopes = yield* helix.scopes(partition)
        const remaining = yield* store.list({ partition, scopes })
        yield* Effect.forEach(remaining, (value) => store.forget({ partition, id: value.id }))
      }
      yield* database.run(database.delete(companyTable).where(eq(companyTable.id, company.id)))
      yield* database.run(
        database.delete(personTable).where(inArray(personTable.id, [person.id, outsider.id])),
      )
    }).pipe(
      Effect.match({
        onFailure: (error) => expect.fail(`Cleanup failed: ${error._tag}`),
        onSuccess: () => undefined,
      }),
    ),
  )
  yield* database.run(
    database.insert(personTable).values(
      [person, outsider].map((value) => ({
        id: value.id,
        name: value.name,
        email: value.email,
      })),
    ),
  )
  yield* database.run(
    database
      .insert(companyTable)
      .values({ id: company.id, name: company.name, slug: company.slug }),
  )
  yield* database.run(
    database.insert(membershipTable).values({
      id: NodeCrypto.randomUUID(),
      companyId: company.id,
      userId: person.id,
      role: 'member',
    }),
  )
  yield* database.run(
    database.insert(threads).values([
      {
        id: personalThread,
        personId: person.id,
        companyId: null,
        title: 'Personal',
        titleSource: 'Person',
        updatedAt: 1,
        audience: 'private',
      },
      {
        id: sharedThread,
        personId: person.id,
        companyId: company.id,
        title: 'Shared',
        titleSource: 'Person',
        updatedAt: 1,
        audience: 'company',
      },
      {
        id: privateThread,
        personId: person.id,
        companyId: company.id,
        title: 'Private',
        titleSource: 'Person',
        updatedAt: 1,
        audience: 'private',
      },
    ]),
  )
  const workspace = Workspace.cases.Company.make({ company, role: 'member' })
  const personal: Actor = {
    person,
    workspace: Workspace.cases.Personal.make({}),
    by: 'vivid',
    threadId: Option.some(personalThread),
  }
  const shared: Actor = { person, workspace, by: 'vivid', threadId: Option.some(sharedThread) }
  const privateAtWork: Actor = {
    person,
    workspace,
    by: 'vivid',
    threadId: Option.some(privateThread),
  }
  const unauthorized: Actor = {
    person: outsider,
    workspace,
    by: 'vivid',
    threadId: Option.some(sharedThread),
  }
  return {
    database,
    helix,
    store,
    memory,
    personal,
    shared,
    privateAtWork,
    unauthorized,
    personalPartition,
    companyPartition,
    sharedThread,
  }
})
type Fixture = Effect.Success<ReturnType<typeof fixture>>

/** A complete extracted value makes each relation and sharing intent explicit. */
function candidate(content: string, relation: typeof MemoryRelation.Type) {
  return MemoryCandidate.make({
    shouldStore: true,
    content,
    kind: 'fact',
    aliases: ['original-alias'],
    relation,
    forCompany: false,
  })
}

/** Resolve the same public authorized destination the lifecycle checkpoints, with a unique Run for every candidate. */
const checkpoint = Effect.fn('OnceTest.checkpoint')(function* (
  memory: MemoryAccess['Service'],
  actor: Actor,
  value: MemoryCandidate,
) {
  const destination = yield* memory.destination(actor, value)
  if (Option.isNone(destination)) expect.fail('Storable candidate needs a destination')
  return {
    candidate: value,
    key: LearnKey.make({ runId: RunId.make(NodeCrypto.randomUUID()), position: 0 }),
    destination: destination.value,
  }
})

/** Receipts are checked through the public Helix service using the accepted persisted identity format. */
function receiptIdentity(input: LearnOnceInput) {
  const partition = input.destination.partition
  return {
    partition,
    receiptId: MemoryReceiptId.make(
      JSON.stringify([partition, input.key.runId, input.key.position]),
    ),
  }
}

/** Assert the result variant before accessing knowledge, keeping unexpected AlreadyApplied/Skipped visible. */
function saved(result: LearnResult, tag: 'Saved' | 'AlreadySaved'): Memory {
  expect(result._tag).toBe(tag)
  if (!LearnResult.isAnyOf(['Saved', 'AlreadySaved'])(result))
    return expect.fail('Readable saved memory required')
  return result.memory
}

const decodeInspection = HttpClientResponse.schemaBodyJson(
  Schema.Struct({
    memories: Schema.Array(Schema.Struct({ memoryId: MemoryId, accessCount: Schema.Number })),
    edges: Schema.Array(Schema.Struct({ kind: Schema.String, from: MemoryId, to: MemoryId })),
  }),
)

/** Public expand deduplicates neighbors; this narrow read-only SDK query exposes exact edge direction/multiplicity and accessCount without replacing persistence. */
const inspect = Effect.fn('OnceTest.inspect')(function* (partition: MemoryPartition) {
  if (url === undefined) expect.fail('Disposable Helix URL required')
  const client = yield* HttpClient.HttpClient
  const nodes = g().nWithLabelWhere('Memory', SourcePredicate.eq('tenant_id', partition))
  const query = readBatch()
    .varAs(
      'memories',
      nodes.project([
        Projection.property('memoryId', 'memoryId'),
        Projection.property('accessCount', 'accessCount'),
      ]),
    )
    .varAs(
      'edges',
      nodes
        .outE('EXTENDS')
        .where(Predicate.eq('tenant_id', partition))
        .project([
          Projection.property('$label', 'kind'),
          Projection.fromEndpoint('memoryId', 'from'),
          Projection.toEndpoint('memoryId', 'to'),
        ]),
    )
    .returning(['memories', 'edges'])
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

/** Count lookup remains partition-qualified even for superseded/forgotten nodes. */
const count = Effect.fn('OnceTest.count')(function* (partition: MemoryPartition, id: MemoryId) {
  const row = (yield* inspect(partition)).memories.find((value) => value.memoryId === id)
  if (row === undefined) expect.fail('Persisted memory required')
  return row.accessCount
})

/** Per-test scopes release fixtures; the shared suite supplies already acquired live HTTP and database services. */
function verified<A, E>(
  effect: Effect.Effect<
    A,
    E,
    | MemoryAccess
    | MemoryStore
    | MemoryExtraction
    | HelixMemory
    | Database
    | HttpClient.HttpClient
    | Scope.Scope
  >,
) {
  return effect.pipe(Effect.scoped)
}

/** Build only a new access service over the deliberate public store wrapper; all its other authorities remain production adapters. */
const wrappedAccess = Effect.fn('OnceTest.wrappedAccess')(function* (
  store: MemoryStore['Service'],
) {
  const context = yield* Layer.build(
    Layer.fresh(memoryAccessLayer.pipe(Layer.provide(Layer.succeed(MemoryStore, store)))),
  )
  return Context.get(context, MemoryAccess)
})

/** The first receipt miss is forced only at the public interface. A committed competitor makes the old target non-current before the real target read. */
const missedReceipt = Effect.fn('OnceTest.missedReceipt')(function* (
  store: MemoryStore['Service'],
) {
  const reads = yield* Ref.make(0)
  const wrapped = MemoryStore.of({
    ...store,
    receipt: Effect.fn('OnceTest.receipt')(function* (input) {
      const read = yield* Ref.getAndUpdate(reads, (previous) => previous + 1)
      return read === 0 ? Option.none<MemoryId>() : yield* store.receipt(input)
    }),
  })
  return { memory: yield* wrappedAccess(wrapped), reads }
})

/** A replay must preserve the full persisted projection, including its first application's timestamp. */
const replay = Effect.fn('OnceTest.replay')(function* (
  f: Fixture,
  actor: Actor,
  input: LearnOnceInput,
) {
  const first = saved(yield* f.memory.learnOnce(actor, input), 'Saved')
  const second = saved(yield* f.memory.learnOnce(actor, input), 'AlreadySaved')
  expect(second).toEqual(first)
  expect(yield* f.helix.receipt(receiptIdentity(input))).toEqual(Option.some(first.id))
  return first
})

/** Suite acquisition waits for all thirteen real index-build success signals on empty storage; assertion limits stay unchanged. */
const INDEX_ACQUISITION_LIMIT = 60_000

describe.skipIf(!testDatabaseConfigured || url === undefined)('MemoryAccess.learnOnce', () => {
  layer(access, { timeout: INDEX_ACQUISITION_LIMIT, excludeTestServices: true })(
    'indexed storage',
    (it) => {
      it.effect('new: one record, one count and the same memory on replay', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            const input = yield* checkpoint(
              f.memory,
              f.personal,
              candidate('Dami prefers Tuesday planning.', MemoryRelation.cases.new.make({})),
            )
            const first = yield* replay(f, f.personal, input)
            expect(yield* f.memory.list(f.personal)).toEqual([first])
            expect(
              yield* f.memory.recall(f.personal, { query: input.candidate.content, limit: 10 }),
            ).toEqual([first])
            expect((yield* inspect(f.personalPartition)).memories).toEqual([
              { memoryId: first.id, accessCount: 1 },
            ])
          }),
        ),
      )

      it.effect('extends: one new record and exactly one directed EXTENDS edge', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            const target = yield* f.memory.remember(f.personal, {
              kind: 'fact',
              content: 'Dami runs the planning team.',
              forCompany: false,
            })
            const input = yield* checkpoint(
              f.memory,
              f.personal,
              candidate(
                'Dami plans Tuesdays with the product team.',
                MemoryRelation.cases.extends.make({ id: target.id }),
              ),
            )
            const first = yield* replay(f, f.personal, input)
            expect(yield* f.memory.list(f.personal)).toHaveLength(2)
            expect((yield* inspect(f.personalPartition)).edges).toEqual([
              { kind: 'EXTENDS', from: first.id, to: target.id },
            ])
            expect(
              (yield* f.helix.expand({
                partition: f.personalPartition,
                scopes: [MemoryScopeKey.make(`person:${f.personal.person.id}`)],
                ids: [first.id],
                limit: 10,
              })).map((value) => value.memory.id),
            ).toEqual([target.id])
          }),
        ),
      )

      it.effect('duplicate: accessCount and aliases merge once, retaining updatedAt', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            const target = yield* f.memory.remember(f.personal, {
              kind: 'fact',
              content: 'Dami prefers Tuesday planning.',
              forCompany: false,
            })
            const before = yield* count(f.personalPartition, target.id)
            const input = yield* checkpoint(
              f.memory,
              f.personal,
              candidate(
                'Planning happens on Tuesday for Dami.',
                MemoryRelation.cases.duplicate.make({ id: target.id }),
              ),
            )
            const first = yield* replay(f, f.personal, input)
            expect(first.id).toBe(target.id)
            expect(yield* count(f.personalPartition, target.id)).toBe(before + 1)
            const record = yield* f.helix.get({ partition: f.personalPartition, id: target.id })
            expect(Option.map(record, (value) => value.aliases)).toEqual(
              Option.some(['original-alias']),
            )
            expect(yield* f.memory.list(f.personal)).toEqual([first])
          }),
        ),
      )

      it.effect(
        'updates: replacement replays although its original target is no longer current',
        () =>
          verified(
            Effect.gen(function* () {
              const f = yield* fixture()
              const target = yield* f.memory.remember(f.personal, {
                kind: 'fact',
                content: 'Dami plans Mondays.',
                forCompany: false,
              })
              const input = yield* checkpoint(
                f.memory,
                f.personal,
                candidate(
                  'Dami now plans Tuesdays.',
                  MemoryRelation.cases.updates.make({ id: target.id }),
                ),
              )
              const first = yield* replay(f, f.personal, input)
              expect(first.id).not.toBe(target.id)
              expect(yield* f.store.get({ partition: f.personalPartition, id: target.id })).toEqual(
                Option.none(),
              )
              expect(yield* f.memory.list(f.personal)).toEqual([first])
              expect((yield* inspect(f.personalPartition)).memories).toHaveLength(2)
            }),
          ),
      )

      it.effect('dedup new: receipts name the existing record and reinforcement happens once', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            const value = candidate(
              'Dami prefers Tuesday planning.',
              MemoryRelation.cases.new.make({}),
            )
            const original = yield* checkpoint(f.memory, f.personal, value)
            const target = saved(yield* f.memory.learnOnce(f.personal, original), 'Saved')
            const input = yield* checkpoint(f.memory, f.personal, value)
            const first = yield* replay(f, f.personal, input)
            expect(first.id).toBe(target.id)
            expect(yield* count(f.personalPartition, target.id)).toBe(2)
            expect(yield* f.memory.list(f.personal)).toEqual([first])
          }),
        ),
      )

      it.effect(
        'dedup extends: reinforcement atomically adds one EXTENDS edge and replays once',
        () =>
          verified(
            Effect.gen(function* () {
              const f = yield* fixture()
              const original = yield* checkpoint(
                f.memory,
                f.personal,
                candidate('Dami prefers Tuesday planning.', MemoryRelation.cases.new.make({})),
              )
              const existing = saved(yield* f.memory.learnOnce(f.personal, original), 'Saved')
              const target = yield* f.memory.remember(f.personal, {
                kind: 'fact',
                content: 'The planning team meets weekly.',
                forCompany: false,
              })
              const input = yield* checkpoint(
                f.memory,
                f.personal,
                candidate(
                  original.candidate.content,
                  MemoryRelation.cases.extends.make({ id: target.id }),
                ),
              )
              const first = yield* replay(f, f.personal, input)
              expect(first.id).toBe(existing.id)
              expect(yield* count(f.personalPartition, existing.id)).toBe(2)
              expect((yield* inspect(f.personalPartition)).edges).toEqual([
                { kind: 'EXTENDS', from: existing.id, to: target.id },
              ])
              expect(yield* f.memory.list(f.personal)).toHaveLength(2)
            }),
          ),
      )

      it.effect('dedup extends: extending the deduplicated record creates no self-link', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            const original = yield* checkpoint(
              f.memory,
              f.personal,
              candidate('Dami prefers Tuesday planning.', MemoryRelation.cases.new.make({})),
            )
            const existing = saved(yield* f.memory.learnOnce(f.personal, original), 'Saved')
            const input = yield* checkpoint(
              f.memory,
              f.personal,
              candidate(
                original.candidate.content,
                MemoryRelation.cases.extends.make({ id: existing.id }),
              ),
            )
            expect((yield* replay(f, f.personal, input)).id).toBe(existing.id)
            expect(yield* count(f.personalPartition, existing.id)).toBe(2)
            expect((yield* inspect(f.personalPartition)).edges).toEqual([])
          }),
        ),
      )

      it.effect('concurrent independent access stacks: both callers settle to one mutation', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            const input = yield* checkpoint(
              f.memory,
              f.personal,
              candidate('Dami prefers Tuesday planning.', MemoryRelation.cases.new.make({})),
            )
            // Separate full subtree builds acquire distinct MemoryStore semaphores and adapter resources.
            const a = Context.get(yield* Layer.build(Layer.fresh(access)), MemoryAccess)
            const b = Context.get(yield* Layer.build(Layer.fresh(access)), MemoryAccess)
            expect(a).not.toBe(b)
            const gate = yield* Deferred.make<void>()
            const operation = (memory: MemoryAccess['Service']) =>
              Deferred.await(gate).pipe(Effect.andThen(memory.learnOnce(f.personal, input)))
            const left = yield* operation(a).pipe(Effect.forkScoped)
            const right = yield* operation(b).pipe(Effect.forkScoped)
            yield* Deferred.succeed(gate, undefined)
            const results = yield* Effect.all([Fiber.join(left), Fiber.join(right)])
            const tags = results.map((value) => value._tag).toSorted()
            expect(tags).toEqual(['AlreadySaved', 'Saved'])
            const memories = results.map((value) =>
              saved(value, LearnResult.guards.Saved(value) ? 'Saved' : 'AlreadySaved'),
            )
            const winner = memories[0]
            if (winner === undefined) expect.fail('Concurrent winner required')
            expect(memories[0]).toEqual(memories[1])
            expect((yield* inspect(f.personalPartition)).memories).toEqual([
              { memoryId: winner.id, accessCount: 1 },
            ])
          }),
        ),
      )

      it.effect('updates interleaving: B commits before A receipt pre-read', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            const target = yield* f.memory.remember(f.personal, {
              kind: 'fact',
              content: 'Dami plans Mondays.',
              forCompany: false,
            })
            const input = yield* checkpoint(
              f.memory,
              f.personal,
              candidate(
                'Dami now plans Tuesdays.',
                MemoryRelation.cases.updates.make({ id: target.id }),
              ),
            )
            const a = Context.get(yield* Layer.build(Layer.fresh(access)), MemoryAccess)
            const b = Context.get(yield* Layer.build(Layer.fresh(access)), MemoryAccess)
            const first = saved(yield* b.learnOnce(f.personal, input), 'Saved')
            expect(saved(yield* a.learnOnce(f.personal, input), 'AlreadySaved')).toEqual(first)
            expect(yield* f.memory.list(f.personal)).toEqual([first])
          }),
        ),
      )

      it.effect('updates forced receipt miss: target NotFound reconciles to B replacement', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            const target = yield* f.memory.remember(f.personal, {
              kind: 'fact',
              content: 'Dami plans Mondays.',
              forCompany: false,
            })
            const input = yield* checkpoint(
              f.memory,
              f.personal,
              candidate(
                'Dami now plans Tuesdays.',
                MemoryRelation.cases.updates.make({ id: target.id }),
              ),
            )
            const a = yield* missedReceipt(f.store)
            const b = Context.get(yield* Layer.build(Layer.fresh(access)), MemoryAccess)
            const first = saved(yield* b.learnOnce(f.personal, input), 'Saved')
            expect(saved(yield* a.memory.learnOnce(f.personal, input), 'AlreadySaved')).toEqual(
              first,
            )
            expect(yield* Ref.get(a.reads)).toBe(2)
            expect(yield* f.memory.list(f.personal)).toEqual([first])
            expect((yield* inspect(f.personalPartition)).memories).toHaveLength(2)
          }),
        ),
      )

      it.effect(
        'destination change: shared Thread made private writes neither partition nor receipt',
        () =>
          verified(
            Effect.gen(function* () {
              const f = yield* fixture()
              const input = yield* checkpoint(
                f.memory,
                f.shared,
                candidate('Dami prefers Tuesday planning.', MemoryRelation.cases.new.make({})),
              )
              // handlers.test.ts uses this same database-backed audience transition, not a mocked Thread authority.
              yield* f.database.run(
                f.database
                  .update(threads)
                  .set({ audience: 'private' })
                  .where(eq(threads.id, f.sharedThread)),
              )
              expect(yield* f.memory.learnOnce(f.shared, input).pipe(Effect.flip)).toBeInstanceOf(
                DestinationChanged,
              )
              expect(yield* f.helix.receipt(receiptIdentity(input))).toEqual(Option.none())
              for (const partition of [f.personalPartition, f.companyPartition])
                expect((yield* inspect(partition)).memories).toEqual([])
            }),
          ),
      )

      it.effect('forgotten result: replay is AlreadyApplied and never recreates knowledge', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            const input = yield* checkpoint(
              f.memory,
              f.personal,
              candidate('Dami prefers Tuesday planning.', MemoryRelation.cases.new.make({})),
            )
            const first = saved(yield* f.memory.learnOnce(f.personal, input), 'Saved')
            yield* f.memory.forget(f.personal, first.id)
            expect(yield* f.memory.learnOnce(f.personal, input)).toEqual(
              LearnResult.cases.AlreadyApplied.make({}),
            )
            expect(yield* f.memory.list(f.personal)).toEqual([])
            expect(yield* f.helix.receipt(receiptIdentity(input))).toEqual(Option.some(first.id))
            expect((yield* inspect(f.personalPartition)).memories).toEqual([
              { memoryId: first.id, accessCount: 1 },
            ])
          }),
        ),
      )

      it.effect(
        'lost access: unauthorized replay matches learn failure before any receipt read',
        () =>
          verified(
            Effect.gen(function* () {
              const f = yield* fixture()
              const input = yield* checkpoint(
                f.memory,
                f.shared,
                candidate('Dami prefers Tuesday planning.', MemoryRelation.cases.new.make({})),
              )
              yield* f.memory.learnOnce(f.shared, input)
              const reads = yield* Ref.make(0)
              const observed = yield* wrappedAccess(
                MemoryStore.of({
                  ...f.store,
                  receipt: (value) =>
                    Ref.update(reads, (n) => n + 1).pipe(Effect.andThen(f.store.receipt(value))),
                }),
              )
              const expected = yield* f.memory
                .learn(f.unauthorized, input.candidate)
                .pipe(Effect.flip)
              const failure = yield* observed.learnOnce(f.unauthorized, input).pipe(Effect.flip)
              expect(failure).toEqual(expected)
              expect(failure).toBeInstanceOf(NotFound)
              expect(yield* Ref.get(reads)).toBe(0)
            }),
          ),
      )

      it.effect('lost access during reconciliation: refuse before rereading the receipt', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            const target = yield* f.memory.remember(f.shared, {
              kind: 'fact',
              content: 'Dami plans Mondays.',
              forCompany: false,
            })
            const input = yield* checkpoint(
              f.memory,
              f.shared,
              candidate(
                'Dami now plans Tuesdays.',
                MemoryRelation.cases.updates.make({ id: target.id }),
              ),
            )
            const first = saved(yield* f.memory.learnOnce(f.shared, input), 'Saved')
            const reads = yield* Ref.make(0)
            // Revoke real Membership after A's initial authority check, at its forced receipt miss.
            const observed = yield* wrappedAccess(
              MemoryStore.of({
                ...f.store,
                receipt: Effect.fn('OnceTest.revokedReceipt')(function* (value) {
                  const read = yield* Ref.getAndUpdate(reads, (n) => n + 1)
                  if (read !== 0) return yield* f.store.receipt(value)
                  yield* f.database
                    .run(
                      f.database
                        .delete(membershipTable)
                        .where(eq(membershipTable.userId, f.shared.person.id)),
                    )
                    .pipe(
                      Effect.match({
                        // A failed test-owned SQL interleaving is an assertion defect, not a fabricated MemoryStore failure.
                        onFailure: (error) =>
                          expect.fail(`Membership revocation fixture failed: ${error._tag}`),
                        onSuccess: () => undefined,
                      }),
                    )
                  return Option.none<MemoryId>()
                }),
              }),
            )
            const result = yield* observed.learnOnce(f.shared, input).pipe(Effect.result)
            expect.soft(yield* Ref.get(reads)).toBe(1)
            if (Result.isSuccess(result))
              expect.fail(`Expected NotFound; received ${result.success._tag}`)
            expect(result.failure).toEqual(NotFound.make({ message: 'Thread not found' }))
            expect(yield* f.helix.receipt(receiptIdentity(input))).toEqual(Option.some(first.id))
          }),
        ),
      )

      it.effect(
        'destination change during reconciliation: refuse before rereading the receipt',
        () =>
          verified(
            Effect.gen(function* () {
              const f = yield* fixture()
              const target = yield* f.memory.remember(f.shared, {
                kind: 'fact',
                content: 'Dami plans Mondays.',
                forCompany: false,
              })
              const input = yield* checkpoint(
                f.memory,
                f.shared,
                candidate(
                  'Dami now plans Tuesdays.',
                  MemoryRelation.cases.updates.make({ id: target.id }),
                ),
              )
              yield* f.memory.learnOnce(f.shared, input)
              const reads = yield* Ref.make(0)
              // The checkpoint remains shared while PostgreSQL makes the acting Thread private.
              const observed = yield* wrappedAccess(
                MemoryStore.of({
                  ...f.store,
                  receipt: Effect.fn('OnceTest.changedReceipt')(function* (value) {
                    const read = yield* Ref.getAndUpdate(reads, (n) => n + 1)
                    if (read !== 0) return yield* f.store.receipt(value)
                    yield* f.database
                      .run(
                        f.database
                          .update(threads)
                          .set({ audience: 'private' })
                          .where(eq(threads.id, f.sharedThread)),
                      )
                      .pipe(
                        Effect.match({
                          // Keep test setup errors out of the public store wrapper's production error contract.
                          onFailure: (error) =>
                            expect.fail(`Audience transition fixture failed: ${error._tag}`),
                          onSuccess: () => undefined,
                        }),
                      )
                    return Option.none<MemoryId>()
                  }),
                }),
              )
              const result = yield* observed.learnOnce(f.shared, input).pipe(Effect.result)
              expect.soft(yield* Ref.get(reads)).toBe(1)
              if (Result.isSuccess(result))
                expect.fail(`Expected MemoryDestinationChanged; received ${result.success._tag}`)
              expect(result.failure).toBeInstanceOf(DestinationChanged)
              expect((yield* inspect(f.personalPartition)).memories).toEqual([])
            }),
          ),
      )

      it.effect('skipped shouldStore false: no destination, mutation or receipt', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            const input = yield* checkpoint(
              f.memory,
              f.personal,
              candidate('Dami prefers Tuesday planning.', MemoryRelation.cases.new.make({})),
            )
            const value = MemoryCandidate.make({ ...input.candidate, shouldStore: false })
            expect(yield* f.memory.destination(f.personal, value)).toEqual(Option.none())
            expect(yield* f.memory.learn(f.personal, value)).toEqual(Option.none())
            expect(yield* f.memory.learnOnce(f.personal, { ...input, candidate: value })).toEqual(
              LearnResult.cases.Skipped.make({}),
            )
            expect(yield* f.helix.receipt(receiptIdentity(input))).toEqual(Option.none())
            expect(yield* f.memory.list(f.personal)).toEqual([])
          }),
        ),
      )

      it.effect('skipped Company candidate in Personal workspace: no destination or receipt', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            const input = yield* checkpoint(
              f.memory,
              f.personal,
              candidate('Dami prefers Tuesday planning.', MemoryRelation.cases.new.make({})),
            )
            const value = MemoryCandidate.make({ ...input.candidate, forCompany: true })
            expect(yield* f.memory.destination(f.personal, value)).toEqual(Option.none())
            expect(yield* f.memory.learn(f.personal, value)).toEqual(Option.none())
            expect(yield* f.memory.learnOnce(f.personal, { ...input, candidate: value })).toEqual(
              LearnResult.cases.Skipped.make({}),
            )
            expect(yield* f.helix.receipt(receiptIdentity(input))).toEqual(Option.none())
            expect(yield* f.memory.list(f.personal)).toEqual([])
          }),
        ),
      )

      it.effect('vanished duplicate target without receipt: precise NotFound and no receipt', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            const target = yield* f.memory.remember(f.personal, {
              kind: 'fact',
              content: 'Dami plans Mondays.',
              forCompany: false,
            })
            const input = yield* checkpoint(
              f.memory,
              f.personal,
              candidate(
                'Dami plans on Monday.',
                MemoryRelation.cases.duplicate.make({ id: target.id }),
              ),
            )
            yield* f.memory.forget(f.personal, target.id)
            const failure = yield* f.memory.learnOnce(f.personal, input).pipe(Effect.flip)
            expect(failure).toEqual(NotFound.make({ message: 'Memory not found' }))
            expect(yield* f.helix.receipt(receiptIdentity(input))).toEqual(Option.none())
            expect(yield* f.memory.list(f.personal)).toEqual([])
            expect(yield* count(f.personalPartition, target.id)).toBe(1)
          }),
        ),
      )

      it.effect('updates across destination scope: InvalidRequest and no receipt', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            const target = yield* f.memory.remember(f.privateAtWork, {
              kind: 'fact',
              content: 'Dami plans Mondays.',
              forCompany: false,
            })
            const value = MemoryCandidate.make({
              ...candidate(
                'Dami plans Tuesdays.',
                MemoryRelation.cases.updates.make({ id: target.id }),
              ),
              forCompany: true,
            })
            const input = yield* checkpoint(f.memory, f.privateAtWork, value)
            expect(yield* f.memory.learnOnce(f.privateAtWork, input).pipe(Effect.flip)).toEqual(
              InvalidRequest.make({ message: 'Memory relation crosses its write scope' }),
            )
            expect(yield* f.helix.receipt(receiptIdentity(input))).toEqual(Option.none())
            expect(yield* f.memory.list(f.privateAtWork)).toEqual([target])
            expect((yield* inspect(f.companyPartition)).memories).toEqual([])
          }),
        ),
      )

      it.effect('Thread rename preserves the checkpointed scope identity', () =>
        verified(
          Effect.gen(function* () {
            const f = yield* fixture()
            const input = yield* checkpoint(
              f.memory,
              f.shared,
              candidate('Dami prefers Tuesday planning.', MemoryRelation.cases.new.make({})),
            )
            yield* f.database.run(
              f.database
                .update(threads)
                .set({ title: 'Renamed' })
                .where(eq(threads.id, f.sharedThread)),
            )
            const first = yield* replay(f, f.shared, input)
            expect(yield* f.memory.list(f.shared)).toEqual([first])
            expect((yield* inspect(f.companyPartition)).memories).toHaveLength(1)
          }),
        ),
      )
    },
  )
})
