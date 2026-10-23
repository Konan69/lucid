import { workLayer } from '../database/work.ts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, layer } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { LibraryUploadResponse } from '@vivid/contracts'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { bytesRoutes } from '../http/bytes.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { fixture } from './fixtures.ts'
import { LibraryStore, libraryStoreLayer } from './store.ts'
import { authLayer } from '../auth/provider.ts'

const testLayer = Layer.mergeAll(
  authLayer.pipe(Layer.provide(testConfigLayer)),
  libraryStoreLayer.pipe(Layer.provideMerge(workLayer.pipe(Layer.provideMerge(testDatabaseLayer)))),
  testConfigLayer,
  silentChangesLayer,
  NodeServices.layer,
)
const decodeUpload = Schema.decodeUnknownEffect(Schema.fromJsonString(LibraryUploadResponse))

/** Real multipart requests exercise auth, filesystem persistence, ingestion and shelf selection. */
const uploadRequest = (token: string, shelf: string) => {
  const body = new FormData()
  body.set('file', new Blob(['private amethyst document'], { type: 'text/plain' }), 'amethyst.txt')
  body.set('shelf', shelf)
  return new Request('http://vivid.test/api/library', {
    method: 'POST',
    body,
    headers: { authorization: `Bearer ${token}` },
  })
}

const streamedBoundary = 'vivid-fetch'
const streamedContentType = `multipart/form-data; boundary=${streamedBoundary}`
const streamedField = `--${streamedBoundary}\r\nContent-Disposition: form-data; name="shelf"\r\n\r\n`

/**
 * A pull-driven Web body whose source reports how it was consumed. The default queue holds one
 * chunk, so the source is asked to close only after a reader has taken the last chunk: `ended`
 * is a receipt that the whole body was read, and `cancelled` that its remainder was discarded.
 */
const receiptedBody = (chunks: ReadonlyArray<string>) => {
  const encoder = new TextEncoder()
  const receipt = { delivered: 0, ended: false, cancelled: false }
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[receipt.delivered]
      if (chunk === undefined) {
        receipt.ended = true
        controller.close()
        return
      }
      receipt.delivered += 1
      controller.enqueue(encoder.encode(chunk))
    },
    cancel() {
      receipt.cancelled = true
    },
  })
  return { stream, receipt }
}

/** A streamed Web request has no declared length, so only the parser can refuse its body. */
const streamedUpload = (token: string, body: ReadableStream<Uint8Array>) =>
  new Request('http://vivid.test/api/library', {
    method: 'POST',
    body,
    duplex: 'half',
    headers: { authorization: `Bearer ${token}`, 'content-type': streamedContentType },
  })

/** Parser limits and missing terminators retain their refusal after the whole body is read. */
const streamedRefusals = [
  {
    name: 'field over its limit',
    status: 413,
    // The field crosses its limit before its terminator; later chunks exercise the unread tail.
    chunks: [
      `${streamedField}${'x'.repeat(4096)}`,
      'x'.repeat(4096),
      'x'.repeat(4096),
      `\r\n--${streamedBoundary}--\r\n`,
    ],
  },
  {
    name: 'body without its multipart terminator',
    status: 400,
    chunks: [streamedField, 'Mi', 'ne'],
  },
]

/** Each HTTP call owns the SDK pool and multipart resources until its response has completed.
 * Better Auth's Promise adapter cannot cancel an in-flight query: a test timeout can finalize
 * its pool early. Real clocks and focused claims keep SDK work within the existing deadline.
 */
const httpFixture = Effect.fn('LibraryBytesTest.fixture')(function* () {
  const people = yield* fixture()
  const store = yield* LibraryStore
  const handle = yield* HttpRouter.toHttpEffect(bytesRoutes)
  const send = Effect.fn('LibraryBytesTest.send')((request: Request) =>
    handle.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
      Effect.scoped,
    ),
  )
  return { people, store, send }
})

/** Bearer requests exercise the public byte route rather than store-only permissions. */
const download = (id: string, token: string) =>
  new Request(`http://vivid.test/api/library/${id}/content`, {
    headers: { authorization: `Bearer ${token}` },
  })

describe.skipIf(!testDatabaseConfigured)('Library bytes HTTP', () => {
  layer(testLayer, { excludeTestServices: true })((it) => {
    it.effect('uploads and deduplicates authenticated Mine bytes', () =>
      Effect.gen(function* () {
        const { people, store, send } = yield* httpFixture()
        const response = yield* send(uploadRequest(people.owner.token, 'Mine'))
        expect(response.status).toBe(201)
        const web = HttpServerResponse.toWeb(response)
        const body = yield* Effect.promise(() => web.text())
        const first = (yield* decodeUpload(body)).document
        expect(first.status).toBe('processing')
        const again = yield* send(uploadRequest(people.owner.token, 'Mine'))
        expect(again.status).toBe(200)
        const duplicate = yield* decodeUpload(
          yield* Effect.promise(() => HttpServerResponse.toWeb(again).text()),
        )
        expect(duplicate.document.id).toBe(first.id)
        expect(
          (yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents.map(({ id }) => id),
        ).toEqual([first.id])
      }),
    )
    it.effect('keeps Mine bytes private even from another Member and an admin', () =>
      Effect.gen(function* () {
        const { people, store, send } = yield* httpFixture()
        expect((yield* send(uploadRequest(people.owner.token, 'Mine'))).status).toBe(201)
        const mine = (yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents[0]
        if (mine === undefined) return yield* Effect.die('Uploaded Mine must exist')
        const owned = yield* send(download(mine.id, people.owner.token))
        expect(owned.status).toBe(200)
        const body = HttpServerResponse.toWeb(owned)
        expect(yield* Effect.promise(() => body.text())).toBe('private amethyst document')
        expect(body.headers.get('content-type')).toContain('text/plain')
        expect(body.headers.get('content-disposition')).toBe(
          "inline; filename*=UTF-8''amethyst.txt",
        )
        expect((yield* send(download(mine.id, people.reader.token))).status).toBe(404)
        expect((yield* send(download(mine.id, people.admin.token))).status).toBe(404)
        expect(
          (yield* send(
            new Request('http://vivid.test/api/library/source?name=amethyst.txt', {
              headers: { authorization: `Bearer ${people.reader.token}` },
            }),
          )).status,
        ).toBe(404)
        return yield* Effect.void
      }),
    )
    it.effect('lets a Company Member download Company bytes', () =>
      Effect.gen(function* () {
        const { people, store, send } = yield* httpFixture()
        expect((yield* send(uploadRequest(people.owner.token, 'Company'))).status).toBe(201)
        const company = (yield* store.list(people.owner.actor, { shelf: 'Company' })).documents[0]
        if (company === undefined) return yield* Effect.die('Uploaded Company document must exist')
        const shared = yield* send(download(company.id, people.reader.token))
        expect(shared.status).toBe(200)
        const body = HttpServerResponse.toWeb(shared)
        expect(yield* Effect.promise(() => body.text())).toBe('private amethyst document')
        expect(body.headers.get('content-type')).toContain('text/plain')
        expect(body.headers.get('content-disposition')).toBe(
          "inline; filename*=UTF-8''amethyst.txt",
        )
        return yield* Effect.void
      }),
    )
    it.effect('refuses runtime authority, missing sessions and invalid upload metadata', () =>
      Effect.gen(function* () {
        const { people, send } = yield* httpFixture()
        const id = crypto.randomUUID()
        expect((yield* send(download(id, 'test-runtime-token'))).status).toBe(401)
        expect(
          (yield* send(new Request(`http://vivid.test/api/library/${id}/content`))).status,
        ).toBe(401)
        expect((yield* send(uploadRequest(people.owner.token, 'invalid shelf'))).status).toBe(400)
      }),
    )
    for (const row of streamedRefusals) {
      it.effect(
        `reads a ${row.name} to its end before its ${row.status}, never cancelling it`,
        () =>
          Effect.gen(function* () {
            const { people, store, send } = yield* httpFixture()
            const { stream, receipt } = receiptedBody(row.chunks)
            const response = yield* send(streamedUpload(people.owner.token, stream))
            expect(response.status).toBe(row.status)
            expect(receipt).toEqual({ delivered: row.chunks.length, ended: true, cancelled: false })
            expect((yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents).toEqual([])
          }),
      )
    }
    it.effect('answers an upload without a body by its own refusal', () =>
      Effect.gen(function* () {
        const { people, send } = yield* httpFixture()
        // A Web request made without a body has none to wait for; it must not read as abandoned.
        const bodyless = (headers: Record<string, string>) =>
          new Request('http://vivid.test/api/library', { method: 'POST', headers })
        expect((yield* send(bodyless({ 'content-type': streamedContentType }))).status).toBe(401)
        expect(
          (yield* send(
            bodyless({
              authorization: `Bearer ${people.owner.token}`,
              'content-type': streamedContentType,
            }),
          )).status,
        ).toBe(400)
      }),
    )
  })
})
