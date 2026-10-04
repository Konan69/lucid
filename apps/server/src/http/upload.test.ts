import { workLayer } from '../database/work.ts'
import { NodeHttpServer } from '@effect/platform-node'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, layer } from '@effect/vitest'
import { Context, Effect, Layer, Schema, Stream } from 'effect'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { fixture } from '../library/fixtures.ts'
import { MAX_LIBRARY_FILE_BYTES } from '../library/ingest.ts'
import { LibraryStore, libraryStoreLayer } from '../library/store.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { bytesRoutes } from './bytes.ts'

const testLayer = Layer.mergeAll(
  libraryStoreLayer.pipe(Layer.provideMerge(workLayer.pipe(Layer.provideMerge(testDatabaseLayer)))),
  testConfigLayer,
  silentChangesLayer,
  NodeServices.layer,
)
const decodeRefusal = Schema.decodeUnknownEffect(Schema.Struct({ error: Schema.String }))
const fileRefusal = `This file is larger than ${MAX_LIBRARY_FILE_BYTES / 1024 / 1024} MB.`
const malformedRefusal = 'Vivid could not read this upload.'

/** Real Node requests cover parser limits and constructor errors that Fetch adapters can hide.
 * The SDK's parser bounds temporary writes; HTTP tests prove status, message and absence of items.
 */
const httpFixture = Effect.fn('LibraryUploadTest.fixture')(function* () {
  const people = yield* fixture()
  const store = yield* LibraryStore
  const server = yield* Layer.build(NodeHttpServer.layerTest)
  yield* Layer.build(HttpRouter.serve(bytesRoutes, { disableLogger: true })).pipe(
    Effect.provide(server),
  )
  const client = Context.get(server, HttpClient.HttpClient)
  const send = Effect.fn('LibraryUploadTest.send')((request: HttpClientRequest.HttpClientRequest) =>
    client.execute(
      request.pipe(HttpClientRequest.setHeader('authorization', `Bearer ${people.owner.token}`)),
    ),
  )
  return { people, store, send, client }
})

/** Whitespace keeps a maximum-size accepted text file to one indexed chunk. */
const uploadBody = (size: number) => {
  const body = new FormData()
  body.set('file', new Blob(['a'.padEnd(size, ' ')], { type: 'text/plain' }), 'bounded.txt')
  body.set('shelf', 'Mine')
  return body
}

/** All surfaces send the same multipart form; the real client serializes its boundary. */
const request = (body: FormData) =>
  HttpClientRequest.post('/api/library').pipe(HttpClientRequest.bodyFormData(body))

describe.skipIf(!testDatabaseConfigured)('Library upload limits over Node HTTP', () => {
  layer(testLayer, { excludeTestServices: true })((it) => {
    it.effect('accepts the payload limit with all three supported parts', () =>
      Effect.gen(function* () {
        const { people, store, send } = yield* httpFixture()
        const folder = yield* store.createFolder(people.owner.actor, {
          name: 'Bounded files',
          shelf: 'Mine',
          parentId: null,
        })
        const body = uploadBody(MAX_LIBRARY_FILE_BYTES)
        body.set('folderId', folder.id)
        expect((yield* send(request(body))).status).toBe(201)
        const list = yield* store.list(people.owner.actor, { shelf: 'Mine' })
        expect(list.documents).toEqual([
          expect.objectContaining({ size: MAX_LIBRARY_FILE_BYTES, folderId: folder.id }),
        ])
      }),
    )
    for (const size of [
      MAX_LIBRARY_FILE_BYTES + 1,
      MAX_LIBRARY_FILE_BYTES + 4096,
      MAX_LIBRARY_FILE_BYTES * 4,
    ]) {
      it.effect(`refuses a ${size}-byte file with a readable 413 and no item`, () =>
        Effect.gen(function* () {
          const { people, store, send } = yield* httpFixture()
          const response = yield* send(request(uploadBody(size)))
          expect(response.status).toBe(413)
          expect(response.headers.connection).toBe('close')
          expect(yield* decodeRefusal(yield* response.json)).toEqual({ error: fileRefusal })
          expect((yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents).toEqual([])
          // Closing a refused upload must still permit the next request through a fresh connection.
          expect((yield* send(request(uploadBody(8)))).status).toBe(201)
        }),
      )
    }
    it.effect('bounds chunked uploads without a declared length and permits the next upload', () =>
      Effect.gen(function* () {
        const { people, store, send } = yield* httpFixture()
        const encoder = new TextEncoder()
        const prefix = encoder.encode(
          '--vivid-test\r\nContent-Disposition: form-data; name="file"; filename="chunked.txt"\r\nContent-Type: text/plain\r\n\r\n',
        )
        const chunk = encoder.encode('a'.repeat(1024 * 1024))
        const suffix = encoder.encode('\r\n--vivid-test--\r\n')
        // No contentLength: the real HTTP client uses chunked transfer, bypassing the preflight.
        const body = Stream.fromIterable([
          prefix,
          ...Array.from({ length: 40 }, () => chunk),
          suffix,
        ])
        const response = yield* send(
          HttpClientRequest.post('/api/library').pipe(
            HttpClientRequest.bodyStream(body, {
              contentType: 'multipart/form-data; boundary=vivid-test',
            }),
          ),
        )
        expect(response.status).toBe(413)
        expect(response.headers.connection).toBe('close')
        expect(yield* decodeRefusal(yield* response.json)).toEqual({ error: fileRefusal })
        expect((yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents).toEqual([])
        expect((yield* send(request(uploadBody(8)))).status).toBe(201)
      }),
    )
    it.effect('refuses oversized fields before creating an item', () =>
      Effect.gen(function* () {
        const { people, store, send } = yield* httpFixture()
        const body = uploadBody(8)
        body.set('shelf', 'x'.repeat(2048))
        const response = yield* send(request(body))
        expect(response.status).toBe(413)
        expect(yield* decodeRefusal(yield* response.json)).toEqual({ error: malformedRefusal })
        expect((yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents).toEqual([])
      }),
    )
    it.effect('refuses a fourth part before creating an item', () =>
      Effect.gen(function* () {
        const { people, store, send } = yield* httpFixture()
        const body = uploadBody(8)
        body.set('extra', 'one')
        body.set('another', 'two')
        const response = yield* send(request(body))
        expect(response.status).toBe(413)
        expect(yield* decodeRefusal(yield* response.json)).toEqual({ error: malformedRefusal })
        expect((yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents).toEqual([])
      }),
    )
    for (const contentType of [
      'text/plain',
      'multipart/form-data',
      'multipart/form-data; boundary=vivid-test; broken',
      'multipart/form-data; boundary=vivid-test;',
      'multipart/form-data; boundary=a/b',
    ]) {
      it.effect(`refuses malformed ${contentType} as a readable 400`, () =>
        Effect.gen(function* () {
          const { send } = yield* httpFixture()
          const response = yield* send(
            HttpClientRequest.post('/api/library').pipe(
              HttpClientRequest.bodyText('malformed', contentType),
            ),
          )
          expect(response.status).toBe(400)
          expect(response.headers.connection).toBe('close')
          expect(yield* decodeRefusal(yield* response.json)).toEqual({ error: malformedRefusal })
        }),
      )
    }
    it.effect('refuses a truncated body as a readable 400', () =>
      Effect.gen(function* () {
        const { send } = yield* httpFixture()
        const response = yield* send(
          HttpClientRequest.post('/api/library').pipe(
            HttpClientRequest.bodyText(
              '--vivid-test\r\nContent-Disposition: form-data; name="shelf"\r\n\r\nMine',
              'multipart/form-data; boundary=vivid-test',
            ),
          ),
        )
        expect(response.status).toBe(400)
        expect(response.headers.connection).toBe('close')
        expect(yield* decodeRefusal(yield* response.json)).toEqual({ error: malformedRefusal })
      }),
    )
    it.effect('authenticates before inspecting a malformed upload', () =>
      Effect.gen(function* () {
        const { client } = yield* httpFixture()
        const response = yield* client.execute(
          HttpClientRequest.post('/api/library').pipe(HttpClientRequest.bodyText('malformed')),
        )
        expect(response.status).toBe(401)
        expect(yield* decodeRefusal(yield* response.json)).toEqual({
          error: 'Authentication required',
        })
      }),
    )
    it.effect('refuses a truncated file before creating an item', () =>
      Effect.gen(function* () {
        const { people, store, send } = yield* httpFixture()
        const response = yield* send(
          HttpClientRequest.post('/api/library').pipe(
            HttpClientRequest.bodyText(
              '--vivid-test\r\nContent-Disposition: form-data; name="file"; filename="truncated.txt"\r\nContent-Type: text/plain\r\n\r\nunfinished',
              'multipart/form-data; boundary=vivid-test',
            ),
          ),
        )
        expect(response.status).toBe(400)
        expect(response.headers.connection).toBe('close')
        expect(yield* decodeRefusal(yield* response.json)).toEqual({ error: malformedRefusal })
        expect((yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents).toEqual([])
      }),
    )
  })
})
