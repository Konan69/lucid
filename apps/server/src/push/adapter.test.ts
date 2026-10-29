import * as NodeCrypto from 'node:crypto'
import * as NodeHttp from 'node:http'
import type * as NodeNet from 'node:net'
import { NodeHttpClient, NodeHttpServer, NodeHttpServerRequest } from '@effect/platform-node'
import * as Undici from '@effect/platform-node/Undici'
import { expect, it } from '@effect/vitest'
import { Effect, Layer, Queue, Result, Schema, Stream } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import {
  NotificationId,
  NotificationOpens,
  PushDestination,
  PushPayload,
  ThreadId,
} from '@vivid/contracts'
import { PushAdapter, pushAdapterLayer } from './adapter.ts'
import { PushConfig } from './config.ts'
import { testPushConfig } from './testing.ts'

const payload = PushPayload.make({
  notificationId: NotificationId.make('notification'),
  title: 'Meeting clash',
  body: 'Choose which meeting to move.',
  opens: NotificationOpens.cases.Thread.make({ threadId: ThreadId.make('thread') }),
})
const phone = PushDestination.cases.Phone.make({ token: 'ExpoPushToken[test-device]' })

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
