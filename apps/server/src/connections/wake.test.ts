import * as NodeNet from 'node:net'
import { NodeHttpClient } from '@effect/platform-node'
import { expect, it } from '@effect/vitest'
import {
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Schema,
} from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { Message } from '../observability/messages.ts'
import { Executor, executorLayer } from './executor.ts'
import { hostedExecutorFixture, hostedOrganization, remoteEntries } from './testing.ts'

const isTcpAddress = Schema.is(Schema.Struct({ port: Schema.Finite }))

/** A loopback port nothing listens on, so a connection to it is refused the way Railway refuses
 * the first private-network connection to a sleeping Executor. */
const refusingPort = Effect.callback<number>((resume) => {
  const server = NodeNet.createServer()
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    server.close(() =>
      resume(
        isTcpAddress(address) ? Effect.succeed(address.port) : Effect.die('Expected a TCP address'),
      ),
    )
  })
})

/** Executor wakes: the refusing port starts accepting and relays each connection to the fixture. */
const wake = (port: number, target: URL) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly server: NodeNet.Server; readonly sockets: Set<NodeNet.Socket> }>(
      (resume) => {
        const sockets = new Set<NodeNet.Socket>()
        const server = NodeNet.createServer((socket) => {
          const upstream = NodeNet.connect(Number(target.port), target.hostname)
          for (const end of [socket, upstream]) {
            sockets.add(end)
            end.on('error', () => {
              socket.destroy()
              upstream.destroy()
            })
          }
          socket.pipe(upstream)
          upstream.pipe(socket)
        })
        server.listen(port, '127.0.0.1', () => resume(Effect.succeed({ server, sockets })))
      },
    ),
    ({ server, sockets }) =>
      Effect.sync(() => {
        for (const socket of sockets) socket.destroy()
        server.close()
      }),
  )

it.effect('a read that meets a sleeping Executor waits for it to wake', () =>
  Effect.gen(function* () {
    const remote = yield* hostedExecutorFixture()
    const port = yield* refusingPort
    const waking = yield* Deferred.make<void>()
    const logger = Logger.make(({ message }) => {
      if (JSON.stringify(message).includes(Message.executorWaking))
        Deferred.doneUnsafe(waking, Exit.void)
    })
    const context = yield* Layer.build(
      executorLayer.pipe(
        Layer.provide(Layer.fresh(NodeHttpClient.layerUndici)),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              GOOGLE_CLIENT_ID: 'isolated-test-client',
              GOOGLE_CLIENT_SECRET: 'isolated-test-secret',
              VIVID_EXECUTOR_URL: `http://127.0.0.1:${port}`,
              VIVID_EXECUTOR_KEY: 'isolated-test-key',
              VIVID_EXECUTOR_ORGANIZATION: hostedOrganization,
              VIVID_EXECUTOR_PUBLIC_ONLY: true,
            }),
          ),
        ),
        Layer.provide(Logger.layer([logger])),
      ),
    )
    const executor = Context.get(context, Executor)
    const read = yield* Effect.forkChild(executor.catalog)
    const first = yield* Effect.raceFirst(
      Fiber.join(read).pipe(Effect.as('answered without Executor' as const)),
      Deferred.await(waking).pipe(Effect.as('waiting for Executor' as const)),
    )
    expect(first).toBe('waiting for Executor')
    yield* wake(port, remote.url)
    yield* TestClock.adjust('1 second')
    expect(remoteEntries(yield* Fiber.join(read))).toHaveLength(1)
  }).pipe(Effect.scoped),
)
