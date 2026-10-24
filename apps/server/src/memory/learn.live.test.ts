import * as NodeCrypto from 'node:crypto'
import { layer } from '@effect/vitest'
import { AuditEvent, MemoryScope, Person, PersonId, RunId, ThreadId } from '@vivid/contracts'
import { RuntimeUnavailable } from '@vivid/contracts/rpc'
import { eq } from 'drizzle-orm'
import { ConfigProvider, Effect, Layer, Ref, Stream } from 'effect'
import { TestConsole } from 'effect/testing'
import { HttpClient } from 'effect/http'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect } from 'vitest'
import { Audit } from '../audit/record.ts'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Changes, Topic, type Topic as ChangeTopic } from '../live/changes.ts'
import { StoredThread } from '../threads/access.ts'
import { threads } from '../threads/tables.ts'
import { embeddingsLayer } from './embeddings.js'
import { memoryExtractionLayer } from './extract.js'
import { HelixMemory, helixMemoryLayer, MemoryPartition, MemoryScopeKey } from './helix.js'
import { Learning, learningLayer } from './learn.js'
import { memoryAccessLayer, MemoryStore, memoryStoreLayer } from './store.js'
import { Runtime } from '../runtime/client.ts'

const url = process.env['VIVID_TEST_HELIX_URL']
const enabled =
  process.env['VIVID_LIVE_MEMORY'] === '1' &&
  testDatabaseConfigured &&
  url !== undefined &&
  (process.env['EXPLABS_API_KEY'] !== undefined || process.env['OPENROUTER_API_KEY'] !== undefined)
/** Model-backed learning keeps transport diagnostics in the test console; endpoint category and status explain outages without recording exchange text or credentials. */
const observedClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return HttpClient.transform(client, (effect, request) => {
      const endpoint = request.url.endsWith('/embeddings') ? 'embeddings' : 'memory'
      return effect.pipe(
        Effect.tap(
          Effect.fn('MemoryTest.status')(function* (response) {
            if (response.status >= 400)
              yield* Effect.logWarning('Memory test HTTP failure', {
                endpoint,
                status: response.status,
              })
          }),
        ),
        Effect.tapError(
          Effect.fn('MemoryTest.transport')((error) =>
            Effect.logWarning('Memory test transport failure', {
              endpoint,
              reason: error.reason._tag,
            }),
          ),
        ),
      )
    })
  }),
).pipe(Layer.provide(NodeHttpClient.layerUndici))

const adapters = Layer.mergeAll(helixMemoryLayer, embeddingsLayer, memoryExtractionLayer).pipe(
  Layer.provide(observedClient),
  Layer.provide(
    ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ VIVID_HELIX_URL: url }), {
      asPrimary: true,
    }),
  ),
)
const persistence = memoryStoreLayer.pipe(Layer.provideMerge(adapters))
const access = memoryAccessLayer.pipe(
  Layer.provideMerge(persistence),
  Layer.provideMerge(testDatabaseLayer),
)

/** One real settled exchange proves learning, provenance, and invalidation through the production authority seams. */
describe.skipIf(!enabled)('Settled Run learning', () => {
  /** Only persistence is shared; learning uses per-case audit and publication recordings. */
  layer(access, { excludeTestServices: true })((it) => {
    it.effect(
      'takes a private durable note and publishes its Person topic without failing the Run',
      () =>
        Effect.gen(function* () {
          const database = yield* Database
          const store = yield* MemoryStore
          const suffix = NodeCrypto.randomUUID()
          const person = Person.make({
            id: PersonId.make(`learning-${suffix}`),
            name: 'Dami',
            email: `learning-${suffix}@example.test`,
          })
          const thread = StoredThread.make({
            titleSource: 'Person',
            id: ThreadId.make(`learning-${suffix}`),
            title: 'A private preference',
            preview: '',
            updatedAt: 1,
            archived: false,
            personId: person.id,
            companyId: null,
            audience: 'private',
            projectId: null,
            place: 'Conversation',
          })
          const partition = MemoryPartition.make(`p-${person.id}`)
          const scopes = [MemoryScopeKey.make(`person:${person.id}`)]
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              const remaining = yield* store.list({ partition, scopes })
              yield* Effect.forEach(remaining, (memory) =>
                store.forget({ partition, id: memory.id }),
              )
              yield* database.run(database.delete(personTable).where(eq(personTable.id, person.id)))
            }).pipe(
              Effect.match({
                onFailure: (failure) => expect.fail(`Cleanup failed: ${failure._tag}`),
                onSuccess: () => undefined,
              }),
            ),
          )
          yield* database.run(
            database
              .insert(personTable)
              .values({ id: person.id, name: person.name, email: person.email }),
          )
          yield* database.run(database.insert(threads).values(thread))
          const topics = yield* Ref.make<ReadonlyArray<ChangeTopic>>([])
          const events = yield* Ref.make<ReadonlyArray<AuditEvent>>([])
          const changes = Changes.of({
            publish: (moved) => Ref.update(topics, (previous) => [...previous, ...moved]),
            subscribe: () => Effect.succeed(Stream.never),
          })
          const audit = Audit.of({
            record: (_actor, event) => Ref.update(events, (previous) => [...previous, event]),
          })
          yield* Effect.gen(function* () {
            const learning = yield* Learning
            yield* learning.afterRun({
              thread,
              person,
              said: 'Remember my lasting personal preference: I want written project updates on Friday mornings. Call that preference quartzfern329. This is just for me.',
              replied:
                'I will remember your preference for written project updates on Friday mornings as quartzfern329.',
              runId: RunId.make(`learning-${suffix}`),
            })
            const remembered = yield* store.list({ partition, scopes })
            expect(
              remembered.some((memory) => /Friday|quartzfern329/.test(memory.content)),
              JSON.stringify(yield* TestConsole.logLines),
            ).toBe(true)
            expect(
              remembered.every(
                (memory) =>
                  MemoryScope.guards.Person(memory.scope) &&
                  memory.learnedIn === thread.id &&
                  memory.learnedFrom.id === person.id,
              ),
            ).toBe(true)
            expect(new Set(yield* Ref.get(topics))).toEqual(new Set([Topic.person(person.id)]))
            expect((yield* Ref.get(events)).some(AuditEvent.guards.MemorySaved)).toBe(true)
            // Losing the Thread after settlement is logged and dropped before recall or extraction.
            yield* database.run(database.delete(threads).where(eq(threads.id, thread.id)))
            const before = yield* store.list({ partition, scopes })
            yield* learning.afterRun({
              thread,
              person,
              said: 'An inaccessible Thread must not teach new facts.',
              replied: 'The Run has already finished.',
              runId: RunId.make(`inaccessible-${suffix}`),
            })
            expect(yield* store.list({ partition, scopes })).toEqual(before)
          }).pipe(
            Effect.provide(
              yield* Layer.build(
                learningLayer.pipe(
                  Layer.provide(
                    Layer.merge(Layer.succeed(Changes, changes), Layer.succeed(Audit, audit)),
                  ),
                  Layer.provide(
                    Layer.mock(Runtime, {
                      read: Effect.fn('MemoryTest.noHistory')(() =>
                        Effect.fail(
                          RuntimeUnavailable.make({ message: 'No conversation in this fixture' }),
                        ),
                      ),
                    }),
                  ),
                ),
              ),
            ),
            Effect.provideService(Changes, changes),
            Effect.provideService(Audit, audit),
          )
          const helix = yield* HelixMemory
          expect(yield* helix.scopes(partition)).toEqual(scopes)
        }).pipe(Effect.scoped),
      { timeout: 120000 },
    )
  })
})
