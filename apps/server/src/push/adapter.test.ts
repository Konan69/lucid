import * as NodeCrypto from 'node:crypto'
import * as NodeHttp from 'node:http'
import type * as NodeNet from 'node:net'
import { NodeHttpClient, NodeHttpServer, NodeHttpServerRequest } from '@effect/platform-node'
import * as Undici from '@effect/platform-node/Undici'
import { expect, it } from '@effect/vitest'
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Result,
  Schema,
  Stream,
} from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { NotificationId, PushDestination, PushPayload, ThreadId } from '@vivid/contracts'
import { PushAdapter, pushAdapterLayer } from './adapter.ts'
import { PushConfig } from './config.ts'
import { PushAcceptance } from './receipts.ts'
import { testPushConfig } from './testing.ts'

const decodeWireJsonSync = Schema.decodeSync(Schema.fromJsonString(Schema.Json))

const payload = PushPayload.make({
  notificationId: NotificationId.make('notification'),
  title: 'Meeting clash',
  body: 'Choose which meeting to move.',
  threadId: ThreadId.make('thread'),
})
const phone = PushDestination.cases.Phone.make({ token: 'ExpoPushToken[test-device]' })
/** RFC 8291 receiver derives its keys from the fixture private key and wire salt/public key.
 * Decrypting the actual HTTP body detects random, empty, mis-keyed or corrupted ciphertext. */
function decryptPush(bytes: Uint8Array, recipient: NodeCrypto.ECDH, auth: string) {
  const wire = Buffer.from(bytes)
  const salt = wire.subarray(0, 16)
  const keyLength = wire.readUInt8(20)
  const senderKey = wire.subarray(21, 21 + keyLength)
  const encrypted = wire.subarray(21 + keyLength)
  const shared = recipient.computeSecret(senderKey)
  const authentication = NodeCrypto.createHmac('sha256', Buffer.from(auth, 'base64url'))
    .update(shared)
    .digest()
  const info = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    recipient.getPublicKey(),
    senderKey,
    Buffer.from([1]),
  ])
  const material = NodeCrypto.createHmac('sha256', authentication).update(info).digest()
  const pseudorandom = NodeCrypto.createHmac('sha256', salt).update(material).digest()
  const key = NodeCrypto.createHmac('sha256', pseudorandom)
    .update(Buffer.from('Content-Encoding: aes128gcm\0\x01'))
    .digest()
    .subarray(0, 16)
  const nonce = NodeCrypto.createHmac('sha256', pseudorandom)
    .update(Buffer.from('Content-Encoding: nonce\0\x01'))
    .digest()
    .subarray(0, 12)
  const decipher = NodeCrypto.createDecipheriv('aes-128-gcm', key, nonce)
  decipher.setAuthTag(encrypted.subarray(-16))
  const plaintext = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()])
  let end = plaintext.length - 1
  while (plaintext[end] === 0) end -= 1
  expect(plaintext[end]).toBe(2)
  return plaintext.subarray(0, end).toString('utf8')
}

/** Encryption remains real; only provider HTTP responses are controlled at the narrow adapter. */
it.effect(
  'encrypts Web Push with VAPID and classifies expired authority without following redirects',
  () =>
    Effect.gen(function* () {
      const curve = NodeCrypto.createECDH('prime256v1')
      curve.generateKeys()
      const destination = PushDestination.cases.Browser.make({
        endpoint: 'https://fcm.googleapis.com/push/test',
        keys: {
          p256dh: curve.getPublicKey().toString('base64url'),
          auth: NodeCrypto.randomBytes(16).toString('base64url'),
        },
      })
      for (const status of [201, 410, 302]) {
        const transport = HttpClient.make((request) =>
          Effect.sync(() => {
            expect(request.url).toBe(destination.endpoint)
            expect(request.headers['content-encoding']).toBe('aes128gcm')
            expect(request.headers.authorization).toContain('vapid ')
            if (!Predicate.isTagged(request.body, 'Uint8Array'))
              return expect.fail('Expected encrypted Web Push body')
            const decoded = decodeWireJsonSync(
              decryptPush(request.body.body, curve, destination.keys.auth),
            )
            expect(decoded).toEqual({
              notificationId: 'notification',
              title: 'Meeting clash',
              body: 'Choose which meeting to move.',
              threadId: 'thread',
            })
            return HttpClientResponse.fromWeb(request, new Response(null, { status }))
          }),
        )
        const result = yield* Effect.gen(function* () {
          return yield* (yield* PushAdapter).send(destination, payload).pipe(Effect.result)
        }).pipe(
          Effect.provideServiceEffect(
            PushAdapter,
            Layer.build(Layer.fresh(pushAdapterLayer)).pipe(
              Effect.map((context) => Context.get(context, PushAdapter)),
              Effect.provideService(HttpClient.HttpClient, transport),
            ),
          ),
          Effect.scoped,
          Effect.provideService(PushConfig, testPushConfig),
        )
        if (status === 201)
          expect(result).toEqual(Result.succeed(PushAcceptance.cases.Browser.make({})))
        else
          expect(Result.isFailure(result) && result.failure._tag).toBe(
            status === 410 ? 'PushTargetGone' : 'PushRejected',
          )
      }
    }),
)

/** Validate the documented Expo ticket and late receipt protocols, including malformed responses. */
it.effect(
  'sends the Expo v2 payload without Person identifiers and decodes tickets and gone receipts',
  () =>
    Effect.gen(function* () {
      const transport = HttpClient.make((request) =>
        Effect.sync(() => {
          if (!Predicate.isTagged(request.body, 'Uint8Array'))
            return expect.fail('Expected Expo JSON body')
          const wire = new TextDecoder().decode(request.body.body)
          expect(decodeWireJsonSync(wire)).toEqual({
            to: 'ExpoPushToken[test-device]',
            title: 'Meeting clash',
            body: 'Choose which meeting to move.',
            sound: 'default',
            data: {
              notificationId: 'notification',
              title: 'Meeting clash',
              body: 'Choose which meeting to move.',
              threadId: 'thread',
            },
          })
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ data: { status: 'ok', id: 'ticket' } })),
          )
        }),
      )
      const receiptTransport = HttpClient.make((request) =>
        Effect.sync(() => {
          expect(request.url).toBe('https://exp.host/--/api/v2/push/getReceipts')
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                data: {
                  ticket: { status: 'error', details: { error: 'DeviceNotRegistered' } },
                },
              }),
            ),
          )
        }),
      )
      const acceptance = yield* Effect.gen(function* () {
        return yield* (yield* PushAdapter).send(phone, payload)
      }).pipe(
        Effect.provideServiceEffect(
          PushAdapter,
          Layer.build(Layer.fresh(pushAdapterLayer)).pipe(
            Effect.map((context) => Context.get(context, PushAdapter)),
            Effect.provideService(HttpClient.HttpClient, transport),
          ),
        ),
        Effect.scoped,
        Effect.provideService(PushConfig, testPushConfig),
      )
      expect(acceptance).toEqual(
        PushAcceptance.cases.Phone.make({ ticket: 'ticket', confirmed: false }),
      )
      const receipt = yield* Effect.gen(function* () {
        return yield* (yield* PushAdapter).receipt('ticket')
      }).pipe(
        Effect.provideServiceEffect(
          PushAdapter,
          Layer.build(Layer.fresh(pushAdapterLayer)).pipe(
            Effect.map((context) => Context.get(context, PushAdapter)),
            Effect.provideService(HttpClient.HttpClient, receiptTransport),
          ),
        ),
        Effect.scoped,
        Effect.provideService(PushConfig, testPushConfig),
      )
      expect(receipt).toEqual(Option.some('Gone'))
    }),
)

/** A lost response may have sent: the ten-second deadline reports uncertainty, never retries. */
it.effect('times out a pending provider using TestClock and reports the send as uncertain', () =>
  Effect.gen(function* () {
    const requested = yield* Deferred.make<void>()
    const transport = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() =>
        Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
      ),
    )
    const result = yield* Effect.gen(function* () {
      const caseContext = yield* Layer.build(pushAdapterLayer.pipe(Layer.provideMerge(transport)))
      return yield* Effect.gen(function* () {
        const adapter = yield* PushAdapter
        const pending = yield* adapter.send(phone, payload).pipe(Effect.result, Effect.forkChild)
        yield* Deferred.await(requested)
        yield* TestClock.adjust('9999 millis')
        expect(pending.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust('1 millis')
        return yield* Fiber.join(pending)
      }).pipe(Effect.provide(caseContext))
    }).pipe(Effect.scoped, Effect.provideService(PushConfig, testPushConfig))
    expect(Result.isFailure(result) && result.failure._tag).toBe('PushUncertain')
  }),
)

const Exchange = Schema.TaggedUnion({
  Received: { path: Schema.String, port: Schema.Finite },
  Released: { path: Schema.String, port: Schema.Finite },
})

/**
 * Hold every response incomplete on the wire. Undici's public connector records the client
 * socket before delivering it, so scope release is asserted before awaiting server teardown.
 * NodeHttpServer.makeHandler interrupts the stream on premature close; its ensuring is the receipt.
 * Layers release in reverse build order, so the listener is built before the client Agent.
 */
const unreadTransport = Effect.fn('PushTest.unreadTransport')(function* () {
  const receipts = yield* Queue.unbounded<typeof Exchange.Type>()
  const sockets = new Map<number, NodeNet.Socket>()
  const dispatcher = Layer.effect(
    NodeHttpClient.Dispatcher,
    Effect.acquireRelease(
      Effect.sync(() => {
        const connector = Undici.buildConnector({})
        return new Undici.Agent({
          connect: (options, callback) =>
            connector(options, (...args) => {
              const [error, socket] = args
              if (error === null) {
                const port = socket.localPort
                if (port === undefined) throw new Error('Connected socket has no local port')
                sockets.set(port, socket)
              }
              callback(...args)
            }),
        })
      }),
      (agent) => Effect.promise(() => agent.destroy()),
    ),
  )
  const exchange = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const port = NodeHttpServerRequest.toIncomingMessage(request).socket.remotePort
    if (port === undefined) return expect.fail('Request socket has no remote port')
    const path = request.url
    yield* Queue.offer(receipts, Exchange.cases.Received.make({ path, port }))
    const status = path.endsWith('/send')
      ? 500
      : path.endsWith('/getReceipts')
        ? 503
        : Number(path.slice(path.lastIndexOf('/') + 1))
    return HttpServerResponse.stream(
      Stream.make(new TextEncoder().encode('incomplete')).pipe(
        Stream.concat(Stream.never),
        Stream.ensuring(Queue.offer(receipts, Exchange.cases.Released.make({ path, port }))),
      ),
      { status },
    )
  }).pipe(Effect.withSpan('PushTest.exchange'))
  // Acquired first, so released last: NodeHttpServer's serve finalizer awaits `server.close`
  // (PN/NodeHttpServer.ts make, preemptiveShutdown), which only settles once the Agent below
  // has destroyed every client socket. The reverse order parks a failed assertion behind it.
  const listener = HttpServer.serve(exchange).pipe(
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { port: 0 })),
  )
  const transport = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer
      const client = yield* HttpClient.HttpClient
      const origin = new URL(HttpServer.formatAddress(server.address))
      origin.hostname = '127.0.0.1'
      return HttpClient.mapRequest(client, (request) => {
        const url = new URL(request.url)
        url.protocol = origin.protocol
        url.host = origin.host
        return HttpClientRequest.setUrl(request, url.toString())
      })
    }),
  ).pipe(
    Layer.provide(NodeHttpClient.layerUndiciNoDispatcher.pipe(Layer.provide(dispatcher))),
    Layer.provide(listener),
  )
  return { receipts, sockets, transport }
})

/** All status-only exits must synchronously destroy their incomplete socket, then release the server stream. */
it.effect('releases unread Push responses before returning their status outcome', () =>
  Effect.gen(function* () {
    const remote = yield* unreadTransport()
    const curve = NodeCrypto.createECDH('prime256v1')
    curve.generateKeys()
    const keys = {
      p256dh: curve.getPublicKey().toString('base64url'),
      auth: NodeCrypto.randomBytes(16).toString('base64url'),
    }
    const cases = [
      { path: '/browser/201', tag: 'Browser', kind: 'Browser' },
      { path: '/browser/410', tag: 'PushTargetGone', kind: 'Browser' },
      { path: '/browser/403', tag: 'PushRejected', kind: 'Browser' },
      { path: '/--/api/v2/push/send', tag: 'PushRejected', kind: 'Phone' },
      { path: '/--/api/v2/push/getReceipts', tag: 'PushRejected', kind: 'Receipt' },
    ]
    yield* Effect.gen(function* () {
      const caseContext = yield* Layer.build(
        pushAdapterLayer.pipe(Layer.provideMerge(remote.transport)),
      )
      return yield* Effect.gen(function* () {
        const adapter = yield* PushAdapter
        for (const test of cases) {
          const tag = yield* test.kind === 'Receipt'
            ? adapter.receipt('ticket').pipe(
                Effect.result,
                Effect.map((result) =>
                  Result.match(result, {
                    onFailure: (failure) => failure._tag,
                    onSuccess: () => expect.fail('The receipt provider must refuse this exchange'),
                  }),
                ),
              )
            : adapter
                .send(
                  test.kind === 'Phone'
                    ? phone
                    : PushDestination.cases.Browser.make({
                        endpoint: `https://push.example.test${test.path}`,
                        keys,
                      }),
                  payload,
                )
                .pipe(
                  Effect.result,
                  Effect.map((result) =>
                    Result.match(result, {
                      onFailure: (failure) => failure._tag,
                      onSuccess: (acceptance) => acceptance._tag,
                    }),
                  ),
                )
          expect(tag).toBe(test.tag)
          const received = yield* Queue.take(remote.receipts)
          expect(Exchange.guards.Received(received)).toBe(true)
          expect(received.path).toBe(test.path)
          const socket = remote.sockets.get(received.port)
          if (socket === undefined)
            return expect.fail('Received port has no recorded client socket')
          // RED must fail here immediately, before waiting for a receipt from an open connection.
          expect(socket.destroyed).toBe(true)
          expect(yield* Queue.take(remote.receipts)).toEqual(
            Exchange.cases.Released.make({ path: received.path, port: received.port }),
          )
        }
        return undefined
      }).pipe(Effect.provide(caseContext))
    }).pipe(Effect.scoped, Effect.provideService(PushConfig, testPushConfig))
  }),
)
