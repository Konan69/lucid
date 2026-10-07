import { workLayer } from '../database/work.ts'
import { NodeHttpServer } from '@effect/platform-node'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, layer } from '@effect/vitest'
import { Context, Effect, Fiber, FileSystem, Layer, Ref, Schema, Stream } from 'effect'
import * as NodeHttp from 'node:http'
import type * as NodeNet from 'node:net'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServer from 'effect/unstable/http/HttpServer'
import * as NetAddress from 'effect/unstable/net/NetAddress'
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
/** Native HTTP fixture failures retain the underlying Node error for diagnosis. */
class UploadFixtureFailure extends Schema.TaggedError<UploadFixtureFailure>()(
  'UploadFixtureFailure',
  { message: Schema.String, cause: Schema.Unknown },
) {}

const refusal = Schema.Struct({ error: Schema.String })
const decodeRefusal = Schema.decodeUnknownEffect(refusal)
const decodeRefusalText = Schema.decodeUnknownEffect(Schema.fromJsonString(refusal))
const fileRefusal = `This file is larger than ${MAX_LIBRARY_FILE_BYTES / 1024 / 1024} MB.`
const malformedRefusal = 'Vivid could not read this upload.'
const storageRefusal = 'Vivid could not store this file. Try again.'

/**
 * rc.116 NodeMultipart.persisted uses native fs.createWriteStream, so replacing writeFile
 * would miss the real failure. Return a removed directory only once: its native file open
 * fails, while the next upload uses the real Node FileSystem. Register forced scoped removal
 * before deleting the directory; NodeFileSystem.makeTempDirectoryScoped's own finalizer does
 * not force removal and would defect on the missing path, masking the route's actual 500.
 */
/** The one-shot filesystem fault is acquired per case so later uploads keep the real adapter. */
const removedTemporaryDirectoryLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const real = yield* FileSystem.FileSystem
    const failFirst = yield* Ref.make(true)
    // Consume the fault once; later scoped creation and every other operation stay on real Node FS.
    const makeTempDirectoryScoped: FileSystem.FileSystem['makeTempDirectoryScoped'] = Effect.fn(
      'LibraryUploadTest.makeTempDirectoryScoped',
    )(function* (options: Parameters<FileSystem.FileSystem['makeTempDirectoryScoped']>[0]) {
      if (!(yield* Ref.getAndSet(failFirst, false)))
        return yield* real.makeTempDirectoryScoped(options)
      const directory = yield* Effect.acquireRelease(real.makeTempDirectory(options), (owned) =>
        // Force tolerates the removed path; other filesystem failures remain cleanup defects.
        real
          .remove(owned, { recursive: true, force: true })
          .pipe(Effect.catchTag('PlatformError', (error) => Effect.die(error))),
      )
      yield* real.remove(directory, { recursive: true, force: true })
      return directory
    })
    return FileSystem.FileSystem.of({ ...real, makeTempDirectoryScoped })
  }),
)

/** Real Node requests cover parser limits and constructor errors that Fetch adapters can hide.
 * The SDK's parser bounds temporary writes; HTTP tests prove status, message and absence of items.
 */
const httpFixture = Effect.fn('LibraryUploadTest.fixture')(function* () {
  const people = yield* fixture()
  const store = yield* LibraryStore
  const fileSystem = yield* FileSystem.FileSystem
  const server = yield* Layer.build(NodeHttpServer.layerTest)
  // layerTest includes its own Node FileSystem; preserve the caller's deliberate test Layer.
  yield* Layer.build(HttpRouter.serve(bytesRoutes, { disableLogger: true })).pipe(
    Effect.provide(Context.add(server, FileSystem.FileSystem, fileSystem)),
  )
  const client = Context.get(server, HttpClient.HttpClient)
  const send = Effect.fn('LibraryUploadTest.send')((request: HttpClientRequest.HttpClientRequest) =>
    client.execute(
      request.pipe(HttpClientRequest.setHeader('authorization', `Bearer ${people.owner.token}`)),
    ),
  )
  return {
    people,
    store,
    send,
    client,
    address: Context.get(server, HttpServer.HttpServer).address,
  }
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

interface UploadResponseReceipt {
  readonly status: number
  readonly text: string
  readonly socket: NodeNet.Socket
}

/**
 * Node owns response framing; end/error/close receipts replace timing and a hand-written parser.
 * UTF-8 response accumulation is capped at 64 KiB, enough for these small route JSON responses.
 * Error listeners remain attached after end so teardown errors cannot become unhandled events.
 * Attach every listener before end starts the complete upload; resuming this same test fiber
 * preserves the synchronous writableFinished assertion without an extra response-fiber join.
 */
const uploadResponse = Effect.fn('LibraryUploadTest.uploadResponse')(
  (outgoing: NodeHttp.ClientRequest, body: Buffer) =>
    Effect.callback<UploadResponseReceipt, UploadFixtureFailure>((resume) => {
      const fail = (error: Error) =>
        resume(Effect.fail(new UploadFixtureFailure({ message: error.message, cause: error })))
      let responseStarted = false
      outgoing.once('error', fail)
      outgoing.once('close', () => {
        if (!responseStarted) fail(new Error('Upload connection closed before its response'))
      })
      outgoing.once('response', (incoming) => {
        responseStarted = true
        let text = ''
        incoming.setEncoding('utf8')
        incoming.once('error', fail)
        incoming.on('data', (chunk: string) => {
          text += chunk
          if (Buffer.byteLength(text) > 64 * 1024)
            outgoing.destroy(new Error('Upload response exceeded the receipt limit'))
        })
        incoming.once('close', () => {
          if (!incoming.complete)
            fail(new Error('Upload response ended before its HTTP terminator'))
        })
        incoming.once('end', () => {
          const socket = outgoing.socket
          const status = incoming.statusCode
          if (socket === null || status === undefined) {
            fail(new Error('Upload response has no socket or status'))
            return
          }
          resume(Effect.succeed({ status, text, socket }))
        })
      })
      outgoing.end(body)
      return Effect.sync(() => {
        outgoing.destroy()
      })
    }),
)

/**
 * Node v24.14.1 node:_http_client responseOnEnd/requestOnFinish free a keep-alive socket only
 * after response end AND request finish. node:_http_agent's own free listener runs before ours,
 * so this receipt means the original socket is already in the pool, ready for reusedSocket.
 * A forced server close fails through error/close; it cannot silently open a replacement socket.
 */
const freedUpload = Effect.fn('LibraryUploadTest.freedUpload')(
  (agent: NodeHttp.Agent, outgoing: NodeHttp.ClientRequest) =>
    Effect.callback<NodeNet.Socket, UploadFixtureFailure>((resume) => {
      const cleanup = () => {
        agent.off('free', onFree)
        outgoing.off('error', onError)
        outgoing.off('close', onClose)
      }
      const onError = (error: Error) => {
        cleanup()
        resume(Effect.fail(new UploadFixtureFailure({ message: error.message, cause: error })))
      }
      const onFree = (socket: NodeNet.Socket) => {
        cleanup()
        if (socket !== outgoing.socket) {
          resume(
            Effect.fail(
              new UploadFixtureFailure({
                message: 'Upload agent freed a different socket',
                cause: undefined,
              }),
            ),
          )
          return
        }
        resume(Effect.succeed(socket))
      }
      const onClose = () => {
        if (outgoing.socket === null || outgoing.socket.destroyed)
          onError(new Error('Upload closed its socket before reuse'))
      }
      agent.once('free', onFree)
      outgoing.once('error', onError)
      outgoing.once('close', onClose)
      return Effect.sync(() => {
        cleanup()
        outgoing.destroy()
      })
    }),
)

/** Full multipart framing is shared by refusal and recovery on the very same Node socket. */
const reusableUpload = (name: string, bytes: Buffer) =>
  Buffer.concat([
    Buffer.from(
      `--vivid-reuse\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`,
    ),
    bytes,
    Buffer.from(
      '\r\n--vivid-reuse\r\nContent-Disposition: form-data; name="shelf"\r\n\r\nMine\r\n--vivid-reuse--\r\n',
    ),
  ])

/** Forty MiB exceeds loopback socket buffers; a complete multipart tail stays queued on refusal. */
const largeUpload = () =>
  Buffer.concat([
    Buffer.from(
      '--vivid-lifetime\r\nContent-Disposition: form-data; name="file"; filename="large.txt"\r\nContent-Type: text/plain\r\n\r\n',
    ),
    Buffer.alloc(40 * 1024 * 1024, 'a'),
    Buffer.from(
      '\r\n--vivid-lifetime\r\nContent-Disposition: form-data; name="shelf"\r\n\r\nMine\r\n--vivid-lifetime--\r\n',
    ),
  ])

const closingRefusals = [
  {
    name: 'declared 40 MiB upload',
    status: 413,
    error: fileRefusal,
    headers: (token: string, length: number) => ({
      authorization: `Bearer ${token}`,
      connection: 'close',
      'content-type': 'multipart/form-data; boundary=vivid-lifetime',
      'content-length': length,
    }),
  },
  {
    name: 'chunked 40 MiB upload',
    status: 413,
    error: fileRefusal,
    headers: (token: string) => ({
      authorization: `Bearer ${token}`,
      connection: 'close',
      'content-type': 'multipart/form-data; boundary=vivid-lifetime',
      'transfer-encoding': 'chunked',
    }),
  },
  {
    name: 'bad-boundary 40 MiB upload',
    status: 400,
    error: malformedRefusal,
    // Chunked framing reaches the boundary refusal instead of the declared-size preflight.
    headers: (token: string) => ({
      authorization: `Bearer ${token}`,
      connection: 'close',
      'content-type': 'multipart/form-data',
      'transfer-encoding': 'chunked',
    }),
  },
  {
    name: 'unauthenticated 40 MiB upload',
    status: 401,
    error: 'Authentication required',
    headers: (_token: string, length: number) => ({
      connection: 'close',
      'content-type': 'multipart/form-data; boundary=vivid-lifetime',
      'content-length': length,
    }),
  },
]

interface UploadEndpoint {
  readonly host: string
  readonly port: number
}

/** The native listener must supply a TCP address before a client can target this owned hop. */
const forwardingAddress = Schema.Struct({
  address: Schema.String,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
})
const decodeForwardingAddress = Schema.decodeUnknownEffect(forwardingAddress)

/**
 * Adapt Vite 8.3.0 dist/node/chunks/node.js stream (18741, 18765, 18773): preserve both
 * native pipes and a keep-alive backend client. No buffering or delayed response masks Node's
 * _http_client.socketOnData removal of ondrain when a final response completes too early.
 * Errors on either request/response side destroy the owned hop and remain handled during teardown.
 */
const forwardUpload = (
  target: NodeHttp.RequestOptions,
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
) => {
  const proxyReq = NodeHttp.request({ ...target, headers: req.headers })
  const fail = (error: Error) => {
    req.destroy(error)
    proxyReq.destroy(error)
    res.destroy(error)
  }
  req.on('error', fail)
  proxyReq.on('error', fail)
  res.on('error', fail)
  res.on('close', () => {
    if (!res.writableFinished) proxyReq.destroy()
  })
  proxyReq.on('response', (proxyRes) => {
    proxyRes.on('error', fail)
    if (proxyRes.statusCode === undefined) {
      fail(new Error('Upload forwarder received no upstream status'))
      return
    }
    res.writeHead(proxyRes.statusCode, proxyRes.headers)
    proxyRes.pipe(res)
  })
  req.pipe(proxyReq)
}

/**
 * Own the agent and forwarding server before listen or requests can fail. Listening/close
 * callbacks are native receipts; force-close only this scoped server's connections on release.
 * Node's default keep-alive timer is preserved, including the current-code stalled-pipe failure.
 */
const forwardingHop = Effect.fn('LibraryUploadTest.forwardingHop')(function* (
  endpoint: UploadEndpoint,
) {
  const agent = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeHttp.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 })),
    (owned) => Effect.sync(() => owned.destroy()),
  )
  const target = { ...endpoint, agent, method: 'POST', path: '/api/library' }
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => NodeHttp.createServer((req, res) => forwardUpload(target, req, res))),
    (owned) =>
      Effect.callback<void>((resume) => {
        owned.close(() => resume(Effect.void))
        owned.closeAllConnections()
      }),
  )
  yield* Effect.callback<void, UploadFixtureFailure>((resume) => {
    server.on('error', (error) =>
      resume(Effect.fail(new UploadFixtureFailure({ message: error.message, cause: error }))),
    )
    server.listen({ host: '127.0.0.1', port: 0 }, () => resume(Effect.void))
  })
  const address = yield* decodeForwardingAddress(server.address())
  return { host: address.address, port: address.port }
})

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
          expect(yield* decodeRefusal(yield* response.json)).toEqual({ error: fileRefusal })
          expect((yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents).toEqual([])
          // The refusal must remain readable and permit a subsequent upload through this client.
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
        expect(yield* decodeRefusal(yield* response.json)).toEqual({ error: fileRefusal })
        expect((yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents).toEqual([])
        expect((yield* send(request(uploadBody(8)))).status).toBe(201)
      }),
    )
    it.effect('a refused upload leaves its connection usable', () =>
      Effect.gen(function* () {
        const { people, store, address } = yield* httpFixture()
        if (!NetAddress.isInetAddress(address))
          expect.fail('Upload reuse requires the mounted TCP server')
        const agent = yield* Effect.acquireRelease(
          Effect.sync(
            () => new NodeHttp.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 }),
          ),
          (owned) => Effect.sync(() => owned.destroy()),
        )
        const options = {
          agent,
          host: NetAddress.formatIp(address.address),
          port: address.port,
          method: 'POST',
          path: '/api/library',
        }
        const headers = {
          authorization: `Bearer ${people.owner.token}`,
          'content-type': 'multipart/form-data; boundary=vivid-reuse',
        }
        const first = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeHttp.request({
              ...options,
              headers: { ...headers, 'transfer-encoding': 'chunked' },
            }),
          ),
          (owned) =>
            Effect.sync(() => {
              owned.destroy()
            }),
        )
        // Listen for the actual agent pool receipt before end; response/free can race each other.
        const freed = yield* freedUpload(agent, first).pipe(
          Effect.forkScoped({ startImmediately: true }),
        )
        // Cross the parser allowance and include the remaining MiB and multipart terminator now.
        const refused = yield* uploadResponse(
          first,
          reusableUpload(
            'refused.txt',
            Buffer.alloc(MAX_LIBRARY_FILE_BYTES + 64 * 1024 + 1024 * 1024, 'a'),
          ),
        )
        expect(first.writableFinished).toBe(true)
        expect(refused.status).toBe(413)
        expect(yield* decodeRefusalText(refused.text)).toEqual({ error: fileRefusal })
        expect((yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents).toEqual([])
        expect(yield* Fiber.join(freed)).toBe(refused.socket)
        const valid = reusableUpload('reused.txt', Buffer.from('a       '))
        const second = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeHttp.request({
              ...options,
              headers: { ...headers, 'content-length': valid.length },
            }),
          ),
          (owned) =>
            Effect.sync(() => {
              owned.destroy()
            }),
        )
        const accepted = yield* uploadResponse(second, valid)
        expect(second.writableFinished).toBe(true)
        expect(second.reusedSocket).toBe(true)
        expect(accepted.socket).toBe(refused.socket)
        expect(accepted.status).toBe(201)
        expect((yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents).toEqual([
          expect.objectContaining({ name: 'reused.txt', size: 8 }),
        ])
      }),
    )
    it.effect(
      'a temporary file write failure answers after the body and leaves its connection usable',
      () =>
        Effect.gen(function* () {
          const { people, store, address } = yield* httpFixture().pipe(
            Effect.provide(yield* Layer.build(removedTemporaryDirectoryLayer)),
          )
          if (!NetAddress.isInetAddress(address))
            expect.fail('Upload storage failure requires the mounted TCP server')
          const agent = yield* Effect.acquireRelease(
            Effect.sync(
              () => new NodeHttp.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 }),
            ),
            (owned) => Effect.sync(() => owned.destroy()),
          )
          const options = {
            agent,
            host: NetAddress.formatIp(address.address),
            port: address.port,
            method: 'POST',
            path: '/api/library',
          }
          const headers = {
            authorization: `Bearer ${people.owner.token}`,
            'content-type': 'multipart/form-data; boundary=vivid-reuse',
          }
          // Below every upload bound: this case exercises native storage failure and socket recovery.
          const body = reusableUpload(
            'unstored.txt',
            Buffer.alloc(MAX_LIBRARY_FILE_BYTES - 64 * 1024, 'a'),
          )
          const first = yield* Effect.acquireRelease(
            Effect.sync(() =>
              NodeHttp.request({
                ...options,
                headers: { ...headers, 'content-length': body.length },
              }),
            ),
            (owned) => Effect.sync(() => owned.destroy()),
          )
          // Native free is observed before sending, so an early pool event cannot be missed.
          const freed = yield* freedUpload(agent, first).pipe(
            Effect.forkScoped({ startImmediately: true }),
          )
          const unstored = yield* uploadResponse(first, body)
          expect(first.writableFinished).toBe(true)
          expect(unstored.status).toBe(500)
          expect(yield* decodeRefusalText(unstored.text)).toEqual({ error: storageRefusal })
          expect((yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents).toEqual([])
          expect(yield* Fiber.join(freed)).toBe(unstored.socket)
          const valid = reusableUpload('recovered.txt', Buffer.from('a       '))
          const second = yield* Effect.acquireRelease(
            Effect.sync(() =>
              NodeHttp.request({
                ...options,
                headers: { ...headers, 'content-length': valid.length },
              }),
            ),
            (owned) => Effect.sync(() => owned.destroy()),
          )
          const accepted = yield* uploadResponse(second, valid)
          expect(second.writableFinished).toBe(true)
          expect(second.reusedSocket).toBe(true)
          expect(accepted.socket).toBe(unstored.socket)
          expect(accepted.status).toBe(201)
          expect((yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents).toEqual([
            expect.objectContaining({ name: 'recovered.txt', size: 8 }),
          ])
        }),
    )
    for (const row of closingRefusals) {
      it.effect(
        `finishes a ${row.name} before its readable ${row.status} on Connection: close`,
        () =>
          Effect.gen(function* () {
            const { people, store, address } = yield* httpFixture()
            if (!NetAddress.isInetAddress(address))
              expect.fail('Upload lifetime requires the mounted TCP server')
            const body = largeUpload()
            const outgoing = yield* Effect.acquireRelease(
              Effect.sync(() =>
                NodeHttp.request({
                  agent: false,
                  host: NetAddress.formatIp(address.address),
                  port: address.port,
                  method: 'POST',
                  path: '/api/library',
                  headers: row.headers(people.owner.token, body.length),
                }),
              ),
              (owned) => Effect.sync(() => owned.destroy()),
            )
            // Queue the whole body and terminator together; the response must not release its tail.
            const response = yield* uploadResponse(outgoing, body)
            expect(outgoing.writableFinished).toBe(true)
            expect(response.status).toBe(row.status)
            expect(yield* decodeRefusalText(response.text)).toEqual({ error: row.error })
            expect((yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents).toEqual([])
          }),
      )
    }
    it.effect(
      'finishes a declared 40 MiB upload before its readable 413 through a forwarding hop',
      () =>
        Effect.gen(function* () {
          const { people, store, address } = yield* httpFixture()
          if (!NetAddress.isInetAddress(address))
            expect.fail('Upload forwarding requires the mounted TCP server')
          const endpoint = yield* forwardingHop({
            host: NetAddress.formatIp(address.address),
            port: address.port,
          })
          const agent = yield* Effect.acquireRelease(
            Effect.sync(
              () => new NodeHttp.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 }),
            ),
            (owned) => Effect.sync(() => owned.destroy()),
          )
          const body = largeUpload()
          const outgoing = yield* Effect.acquireRelease(
            Effect.sync(() =>
              NodeHttp.request({
                ...endpoint,
                agent,
                method: 'POST',
                path: '/api/library',
                headers: {
                  authorization: `Bearer ${people.owner.token}`,
                  connection: 'keep-alive',
                  'content-type': 'multipart/form-data; boundary=vivid-lifetime',
                  'content-length': body.length,
                },
              }),
            ),
            (owned) => Effect.sync(() => owned.destroy()),
          )
          const response = yield* uploadResponse(outgoing, body)
          expect(outgoing.writableFinished).toBe(true)
          expect(response.status).toBe(413)
          expect(yield* decodeRefusalText(response.text)).toEqual({ error: fileRefusal })
          expect((yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents).toEqual([])
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
        expect(yield* decodeRefusal(yield* response.json)).toEqual({ error: malformedRefusal })
        expect((yield* store.list(people.owner.actor, { shelf: 'Mine' })).documents).toEqual([])
      }),
    )
  })
})
