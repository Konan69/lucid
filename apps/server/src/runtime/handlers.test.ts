import { NodeHttpClient, NodeHttpServer } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import {
  AuditEvent,
  MemoryConflict,
  MemorySource,
  MemoryAddress,
  MemoryEntry,
  MemoryFile,
  MemoryRevision,
  SavedMemory,
  Workspace,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { eq } from 'drizzle-orm'
import { Context, Effect, Layer, Option, Queue, Redacted, Ref, Schema } from 'effect'
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { findPerson } from '../auth/access.ts'
import { auditLayer } from '../audit/record.ts'
import { auditEntries } from '../audit/tables.ts'
import { ServerConfig } from '../config.ts'
import { Database } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured } from '../database/testdb.ts'
import { cellMemoryLayer } from './client.ts'
import { memoryHandlers } from './handlers.ts'
import { productFixture, productLayer } from './testing.ts'

const bodyJson = HttpServerRequest.schemaBodyJson(Schema.Json)

/** A real HTTP peer records the server protocol; PostgreSQL owns the real audit writes.
 * Deliberately put another Person's Thread in the actor context to catch creator-based addressing. */
const fixture = Effect.fn('CellMemory.test.fixture')(function* () {
  const owner = yield* productFixture()
  const actor = yield* productFixture()
  const found = yield* findPerson(actor.personId)
  if (Option.isNone(found)) return yield* Effect.sync(() => expect.fail('Missing fixture Person'))
  const auth = AuthState.Vivid({
    person: found.value,
    workspace: Workspace.cases.Personal.make({}),
    threadId: owner.threadId,
  })
  const requests = yield* Queue.unbounded<{
    readonly url: string
    readonly authorization: Option.Option<string>
    readonly body: Schema.Json
  }>()
  const response = yield* Ref.make(HttpServerResponse.empty({ status: 204 }))
  const platform = yield* Layer.build(NodeHttpServer.layerTest)
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(platform))
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const body = request.method === 'GET' ? null : yield* bodyJson
      yield* Queue.offer(requests, {
        url: request.url,
        authorization: Option.fromUndefinedOr(request.headers.authorization),
        body,
      })
      return yield* Ref.get(response)
    }),
  )
  const url = new URL(HttpServer.formatAddress(server.address))
  url.hostname = '127.0.0.1'
  const config = yield* ServerConfig
  const database = yield* Database
  const services = yield* Layer.build(
    Layer.mergeAll(
      cellMemoryLayer.pipe(
        Layer.provide([
          NodeHttpClient.layerUndici,
          Layer.succeed(ServerConfig, {
            ...config,
            RUNTIME_URLS: [new URL('http://127.0.0.1:1'), url],
            RUNTIME_TOKEN: Redacted.make('memory-fixture-token'),
          }),
        ]),
      ),
      auditLayer.pipe(Layer.provide(Layer.succeed(Database, database))),
    ),
  )
  return {
    personId: actor.personId,
    database,
    requests,
    response,
    context: Context.add(services, AuthContext, auth),
  }
})

/** Exercise acting authority, revision failures and audit persistence through production handlers and HTTP. */
describe.skipIf(!testDatabaseConfigured)('Settings cell memory', () => {
  layer(Layer.mergeAll(productLayer, testConfigLayer))((it) => {
    it.effect(
      'addresses the acting Person, preserves conflicts and audits only a successful forget',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const entry = MemoryEntry.make({
            layer: 'memory',
            file: MemoryFile.make('coffee.md'),
            kind: 'preference',
            description: 'Coffee preference',
            body: 'I prefer coffee.',
            basis: 'said',
          })
          const expected = MemoryRevision.make(1)
          const address = MemoryAddress.make({ layer: entry.layer, file: entry.file })
          const saved = SavedMemory.make({
            ...entry,
            revision: MemoryRevision.make(2),
            updatedAt: 0,
            authority: {
              actor: test.personId,
              source: MemorySource.cases.Settings.make({ at: 0 }),
            },
          })
          const base = `/persons/${test.personId}/memory`
          yield* Effect.gen(function* () {
            yield* Ref.set(
              test.response,
              HttpServerResponse.jsonUnsafe({ standing: [], lines: [], more: false }),
            )
            expect(yield* memoryHandlers.GetMemoryIndex()).toEqual({
              standing: [],
              lines: [],
              more: false,
            })
            expect(yield* Queue.take(test.requests)).toMatchObject({
              url: base,
              authorization: Option.some('Bearer memory-fixture-token'),
            })
            yield* Ref.set(
              test.response,
              HttpServerResponse.jsonUnsafe({ entries: [], next: null }),
            )
            expect(
              yield* memoryHandlers.ListMemory({ layer: null, after: null, limit: 10 }),
            ).toEqual({ entries: [], next: null })
            expect(yield* Queue.take(test.requests)).toMatchObject({
              url: base + '/list',
              body: { layer: null, after: null, limit: 10 },
            })
            yield* Ref.set(test.response, HttpServerResponse.jsonUnsafe(saved))
            expect(yield* memoryHandlers.ReadMemory(address)).toEqual(saved)
            expect(yield* Queue.take(test.requests)).toMatchObject({
              url: base + '/read',
              body: address,
            })
            expect(yield* memoryHandlers.CorrectMemory({ entry, expected })).toEqual(saved)
            const correction = yield* Queue.take(test.requests)
            expect(correction).toMatchObject({
              url: base + '/write',
              body: {
                entry,
                expected,
                authority: {
                  actor: test.personId,
                  source: MemorySource.cases.Settings.make({ at: 0 }),
                },
              },
            })
            yield* Ref.set(
              test.response,
              HttpServerResponse.jsonUnsafe(
                MemoryConflict.make({ address, expected, actual: MemoryRevision.make(2) }),
                { status: 409 },
              ),
            )
            const conflict = yield* memoryHandlers
              .ForgetMemory({ address, expected })
              .pipe(Effect.flip)
            expect(conflict._tag).toBe('Conflict')
            yield* Queue.take(test.requests)
            yield* Ref.set(
              test.response,
              HttpServerResponse.jsonUnsafe({ error: 'NotFound' }, { status: 404 }),
            )
            expect((yield* memoryHandlers.ReadMemory(address).pipe(Effect.flip))._tag).toBe(
              'NotFound',
            )
            yield* Queue.take(test.requests)
            yield* Ref.set(
              test.response,
              HttpServerResponse.jsonUnsafe({ error: 'Unavailable' }, { status: 503 }),
            )
            expect((yield* memoryHandlers.GetMemoryIndex().pipe(Effect.flip))._tag).toBe(
              'ServiceUnavailable',
            )
            yield* Queue.take(test.requests)
            expect(
              yield* test.database.run(
                test.database
                  .select()
                  .from(auditEntries)
                  .where(eq(auditEntries.personId, test.personId)),
              ),
            ).toMatchObject([{ event: AuditEvent.cases.MemorySaved.make({ scope: 'Person' }) }])
            yield* Ref.set(test.response, HttpServerResponse.empty({ status: 204 }))
            yield* memoryHandlers.ForgetMemory({ address, expected })
            expect(yield* Queue.take(test.requests)).toMatchObject({
              url: base + '/delete',
              body: {
                address,
                expected,
                authority: {
                  actor: test.personId,
                  source: MemorySource.cases.Settings.make({ at: 0 }),
                },
              },
            })
            const audits = yield* test.database.run(
              test.database
                .select()
                .from(auditEntries)
                .where(eq(auditEntries.personId, test.personId)),
            )
            expect(audits).toHaveLength(2)
            expect(audits).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  event: AuditEvent.cases.MemorySaved.make({ scope: 'Person' }),
                }),
                expect.objectContaining({
                  event: AuditEvent.cases.MemoryForgotten.make({ scope: 'Person' }),
                }),
              ]),
            )
          }).pipe(Effect.provideContext(test.context))
        }).pipe(Effect.scoped),
    )
  })
})
