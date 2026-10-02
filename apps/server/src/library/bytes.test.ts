import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { bytesRoutes } from '../http/bytes.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { fixture } from './fixtures.ts'
import { LibraryStore, libraryStoreLayer } from './store.ts'

const testLayer = Layer.mergeAll(
  libraryStoreLayer.pipe(Layer.provideMerge(testDatabaseLayer)),
  testConfigLayer,
  silentChangesLayer,
  NodeServices.layer,
)

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
        const { people, send } = yield* httpFixture()
        expect((yield* send(uploadRequest(people.owner.token, 'Mine'))).status).toBe(201)
        expect((yield* send(uploadRequest(people.owner.token, 'Mine'))).status).toBe(200)
      }),
    )
    it.effect('keeps Mine bytes private even from another Member and an admin', () =>
      Effect.gen(function* () {
        const { people, store, send } = yield* httpFixture()
        expect((yield* send(uploadRequest(people.owner.token, 'Mine'))).status).toBe(201)
        const mine = (yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents[0]
        if (mine === undefined) return yield* Effect.die('Uploaded Mine must exist')
        expect((yield* send(download(mine.id, people.owner.token))).status).toBe(200)
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
        expect((yield* send(download(company.id, people.reader.token))).status).toBe(200)
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
  })
})
