import { NodeHttpServer } from '@effect/platform-node'
import { NodeWS } from '@effect/platform-node/NodeSocket'
import { expect, layer } from '@effect/vitest'
import * as Clock from 'effect/Clock'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServer from 'effect/http/HttpServer'
import * as NetAddress from 'effect/net/NetAddress'
import * as RpcSerialization from 'effect/rpc/RpcSerialization'
import * as RpcServer from 'effect/rpc/RpcServer'
import * as TestClock from 'effect/testing/TestClock'
import { LiveTally, makeTally } from '../live/tally.ts'
import { type Link, LiveLink, liveProtocolLayer } from './link.ts'

/** What the server was handed for one message: its kind, and the link it found beside it. */
type Heard = readonly [string, Option.Option<Link>]

/**
 * The live socket's transport on a real HTTP server, with what reaches the server kept in order
 * and its disconnects handed to the test. The test speaks to it over a real WebSocket, as a
 * client's `RpcClient` would: JSON messages on one connection.
 */
const serving = Effect.fn('LinkTest.serving')(function* () {
  const tally = makeTally()
  const heard = yield* Queue.unbounded<Heard>()
  const gone = yield* Queue.unbounded<number>()
  const listening = Layer.effectDiscard(
    Effect.gen(function* () {
      const protocol = yield* RpcServer.Protocol
      yield* protocol
        .run((_clientId, message) =>
          Effect.flatMap(Effect.serviceOption(LiveLink), (link) =>
            Queue.offer(heard, [message._tag, link]),
          ),
        )
        .pipe(Effect.forkScoped)
      yield* Queue.take(protocol.disconnects).pipe(
        Effect.flatMap((clientId) => Queue.offer(gone, clientId)),
        Effect.forever,
        Effect.forkScoped,
      )
    }),
  ).pipe(
    Layer.provide(liveProtocolLayer('/api/live')),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(Layer.succeed(LiveTally, tally)),
  )
  yield* Layer.build(HttpRouter.serve(listening, { disableLogger: true }))
  const address = (yield* HttpServer.HttpServer).address
  if (!NetAddress.isInetAddress(address)) return yield* Effect.die('No TCP address')
  const client = yield* Effect.acquireRelease(
    Effect.callback<NodeWS.WebSocket>((resume) => {
      const opened = new NodeWS.WebSocket(`ws://127.0.0.1:${address.port}/api/live`)
      opened.on('error', () => undefined)
      opened.on('open', () => resume(Effect.succeed(opened)))
    }),
    (opened) => Effect.sync(() => opened.terminate()),
  )
  return { tally, heard, gone, client }
})

/** A call as `RpcClient` puts it on the wire, by tag. */
const request = (id: string, tag: string) =>
  `{"_tag":"Request","id":"${id}","tag":"${tag}","payload":{},"headers":[]}`

/** The transport's own ping, as `RpcClient` puts it on the wire every five seconds. */
const ping = '{"_tag":"Ping"}'

layer(NodeHttpServer.layerTest)('the live socket', (it) => {
  it.effect(
    'hands each message its client’s link, keeps it live on any message, and closes it with the socket',
    () =>
      Effect.gen(function* () {
        const { heard, gone, client } = yield* serving()
        client.send(ping)
        const [kind, first] = yield* Queue.take(heard)
        expect(kind).toBe('Ping')
        if (Option.isNone(first)) return expect.fail('A message on the live socket has its link')
        expect(first.value.live(yield* Clock.currentTimeMillis)).toBe(true)

        client.send(request('1', 'FindServices'))
        const [, second] = yield* Queue.take(heard)
        // The same client, the same link: a call and a ping both say the client is there.
        if (Option.isNone(second)) return expect.fail('A call on the live socket has its link')
        expect(second.value).toBe(first.value)

        client.terminate()
        yield* Queue.take(gone)
        expect(first.value.live(yield* Clock.currentTimeMillis)).toBe(false)
      }),
  )
})

// One server per test: on a shared test server, a second app served did not get the connection.
layer(NodeHttpServer.layerTest)('the live socket’s counts', (it) => {
  it.effect('counts each call of the contract by its tag and nothing else', () =>
    Effect.gen(function* () {
      const { tally, heard, client } = yield* serving()
      client.send(request('1', 'BePresent'))
      client.send(request('2', 'FindServices'))
      client.send(request('3', 'FindServices'))
      client.send(request('4', 'NoSuchCall'))
      client.send(ping)
      for (let message = 0; message < 5; message++) yield* Queue.take(heard)
      expect(tally.drain().calls).toEqual([
        ['BePresent', 1],
        ['FindServices', 2],
      ])
      expect(tally.drain().calls).toEqual([])
    }),
  )
})

layer(NodeHttpServer.layerTest)('the live socket’s timeout', (it) => {
  it.effect('closes a connection quiet for two minutes, and not one heard within them', () =>
    Effect.gen(function* () {
      const { heard, gone, client } = yield* serving()
      const closed = yield* Deferred.make<number>()
      client.once('close', (code) => Effect.runFork(Deferred.succeed(closed, code)))
      client.send(ping)
      const [, link] = yield* Queue.take(heard)
      if (Option.isNone(link)) return expect.fail('A message on the live socket has its link')

      yield* TestClock.adjust('100 seconds')
      client.send(ping)
      yield* Queue.take(heard)
      yield* TestClock.adjust('100 seconds')
      expect(client.readyState).toBe(NodeWS.WebSocket.OPEN)

      // Two minutes since the last ping, and nothing in between: the server ends the connection.
      yield* TestClock.adjust('20 seconds')
      yield* Queue.take(gone)
      expect(link.value.live(yield* Clock.currentTimeMillis)).toBe(false)
      expect(yield* Deferred.await(closed)).toBeGreaterThan(0)
    }),
  )
})
