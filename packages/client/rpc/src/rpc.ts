import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Match from 'effect/Match'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Schedule from 'effect/Schedule'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as RpcClient from 'effect/rpc/RpcClient'
import * as RpcClientError from 'effect/rpc/RpcClientError'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import * as RpcSerialization from 'effect/rpc/RpcSerialization'
import * as Socket from 'effect/socket/Socket'
import { ComputerState, type ThreadId } from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'

/** What the protocol exposes to reads waiting for its next usable connection. */
export interface RpcConnectionService {
  readonly ready: Effect.Effect<void, RpcClientError.RpcClientError>
}

/** The live socket's readiness, owned by the same Layer as its protocol and client. */
export class RpcConnection extends Context.Service<RpcConnection, RpcConnectionService>()(
  'vivid/RpcConnection',
) {}

/**
 * A scope-owned socket supervisor retries all transport failures except positively identified
 * permanent refusals. Unknown edge/proxy close codes can recover after a deployment, so they
 * must not strand a mounted app. Protocol, decoding and worker errors require caller action.
 */
export const isTransientSocketReason = Match.type<RpcClientError.RpcClientError['reason']>().pipe(
  Match.tagsExhaustive({
    SocketReadError: () => true,
    SocketWriteError: () => true,
    SocketOpenError: () => true,
    SocketCloseError: ({ code }) => !PERMANENT_CLOSES.has(code),
    SocketUpgradeError: ({ cause }) => cause !== undefined,
    HttpError: () => false,
    RpcClientDefect: () => false,
    WorkerReceiveError: () => false,
    WorkerSendError: () => false,
    WorkerSpawnError: () => false,
    WorkerUnknownError: () => false,
  }),
)

/** RFC 6455 protocol/data/policy refusals cannot be repaired by replaying the same client. */
const PERMANENT_CLOSES = new Set([1002, 1003, 1007, 1008, 1009, 1010])

/**
 * Reconnect pacing for a socket owned by the app, with no total lifetime cap.
 * Source: Effect 4.0.2 RpcClient.defaultRetryPolicy, 500 ms times 1.5 capped at five seconds.
 * Permanent socket refusals end the supervisor and reach each request as RpcClientError.
 */
const RECONNECT_FIRST = Duration.millis(500)
const RECONNECT_GROWTH = 1.5
const RECONNECT_MAX = Duration.seconds(5)
/** Stops on a permanent refusal and completes any pending connection wait with that failure. */
const reconnect = (stopped: (error: RpcClientError.RpcClientError) => Effect.Effect<void>) =>
  Schedule.min([
    Schedule.exponential(RECONNECT_FIRST, RECONNECT_GROWTH),
    Schedule.spaced(RECONNECT_MAX),
  ]).pipe(
    Schedule.setInputType<Socket.SocketError>(),
    Schedule.tap(({ input }) =>
      Effect.logWarning('Live socket disconnected; reconnect policy evaluated').pipe(
        Effect.annotateLogs({
          reason: input.reason._tag,
          closeCode: input.reason instanceof Socket.SocketCloseError ? input.reason.code : 'none',
        }),
      ),
    ),
    Schedule.while(({ input }) =>
      isTransientSocketReason(input.reason)
        ? Effect.succeed(true)
        : Effect.as(stopped(RpcClientError.RpcClientError.make({ reason: input.reason })), false),
    ),
  )

/**
 * Protocol heartbeat cadence. Source: Effect 4.0.2 RpcClient.makePinger's five-second default.
 * A quiet connection is pinged; two missed intervals close it so its owner can reconnect.
 */
const PING_INTERVAL = Duration.seconds(5)
const PING_IDLE = Duration.times(PING_INTERVAL, 2)

/**
 * Keep the schema-derived client named in Context.Service's emitted base class.
 * A mapped type alias expands every RPC method there (6,000 declaration lines),
 * forcing each consumer to parse another expanded copy of the contract.
 * The interface inherits the same calls, payloads, results, and failure channels.
 */
export interface VividRpcClientService extends RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof VividRpc>,
  RpcClientError.RpcClientError
> {}

/** Schema-derived product client shared by web, mobile, desktop, and the Flue runtime. */
export class VividRpcClient extends Context.Service<VividRpcClient, VividRpcClientService>()(
  'vivid/VividRpcClient',
) {
  static readonly layer = (options: {
    readonly url: string
    readonly headers?: Readonly<Record<string, string>>
  }) => {
    const headers = options.headers
    return Layer.effect(VividRpcClient, RpcClient.make(VividRpc)).pipe(
      Layer.provide(
        RpcClient.layerProtocolHttp({
          url: options.url,
          transformClient:
            headers === undefined
              ? undefined
              : (client) =>
                  HttpClient.mapRequest(client, (request) =>
                    HttpClientRequest.setHeaders(request, headers),
                  ),
        }),
      ),
      Layer.provide(RpcSerialization.layerNdjson),
    )
  }

  /**
   * The live client: every call and every `Watch…` subscription over one WebSocket to
   * `/api/live`.
   *
   * When the connection drops, everything in flight on it fails, and the socket is opened again
   * on a backoff for as long as the client lives. Nothing is replayed by the transport: a
   * subscription that wants to continue asks again (the live layer in `@vivid/state` does), and a
   * write that was on its way reports that it did not arrive. `retryTransientErrors` is off on
   * purpose: with it on, the protocol keeps a connection that failed to open to itself, and the
   * requests on it are neither failed nor sent again. A connection that stopped answering (a
   * laptop that slept, a phone that changed network) fails what is in flight either way in
   * Effect 4.0.2 (`RpcClient.ts` `makeProtocolSocket`: a ping timeout is a `SocketReadError`).
   *
   * The ping timeout is set, not left to its default. Effect 4.0.2 (`RpcClient.ts` `makePinger`)
   * pings every five seconds and, before each ping, closes the connection when no frame has come
   * for longer than the timeout, which defaults to those same five seconds. A timer never fires
   * early, so on a quiet connection the first check already finds more than five seconds gone
   * and a healthy socket is closed without a ping having been sent. Ten seconds is two intervals:
   * a ping goes out and its answer has a whole interval to arrive, and a dead connection is
   * still found within fifteen seconds (rc.116 found it within ten).
   *
   * What ten seconds does not cover: the check runs on a timer, and the pinger measures the time
   * since the last frame before it pings, so a page whose timers stall for longer than the
   * timeout closes a healthy connection at its next tick and opens another. A browser pass on
   * 10 October 2026 saw exactly that when its debugger paused the page for ten seconds. A
   * browser does the same to a tab left in the background for minutes (its timers run once a
   * minute), so such a tab reconnects each minute; nothing is lost, because every subscription
   * asks again when the socket opens. A longer timeout would hide that and leave a visible page
   * showing stale data for as long after its network changed, which is the worse failure.
   *
   * `onLink` hears each time the socket opens and each time it closes or fails to open, through
   * the protocol's own `ConnectionHooks`, so an app can say that it is reconnecting.
   *
   * The caller supplies how a WebSocket is opened (`Socket.WebSocketConstructor`): a browser uses
   * the global one and sends its session cookie with the upgrade; a paired device supplies one
   * that adds its bearer token, since a native socket has no cookie to send.
   */
  static readonly layerLive = (options: {
    readonly url: string
    readonly onLink: (open: boolean) => void
  }) =>
    Layer.unwrap(
      Effect.gen(function* () {
        let connected = yield* Deferred.make<void, RpcClientError.RpcClientError>()
        // Failed opens share the same receipt. Only losing a previously open socket creates a
        // new one, or a waiter from an earlier failed open would be stranded forever.
        const lost = Effect.sync(() => {
          if (Deferred.isDoneUnsafe(connected)) connected = Deferred.makeUnsafe()
          options.onLink(false)
        })
        const client = Layer.effect(VividRpcClient, RpcClient.make(VividRpc)).pipe(
          Layer.provide(
            RpcClient.layerProtocolSocket({
              retryTransientErrors: false,
              retryPolicy: reconnect((error) => Effect.asVoid(Deferred.fail(connected, error))),
              pingInterval: PING_INTERVAL,
              pingTimeout: PING_IDLE,
            }),
          ),
          Layer.provide(
            Layer.succeed(RpcClient.ConnectionHooks)({
              // Effect 4.0.2 clears currentError before onConnect and runs onDisconnect before
              // broadcasting a failed connection. Waiting requests therefore cannot reuse it.
              onConnect: Effect.andThen(
                Effect.suspend(() => Deferred.succeed(connected, undefined)),
                Effect.sync(() => options.onLink(true)),
              ),
              onDisconnect: lost,
            }),
          ),
          Layer.provide(Socket.layerWebSocket(options.url)),
          Layer.provide(RpcSerialization.layerJson),
        )
        return Layer.merge(
          client,
          Layer.succeed(RpcConnection)({ ready: Effect.suspend(() => Deferred.await(connected)) }),
        )
      }),
    )
}

/** Opens the signed-in Person's first Thread through the shared schema-derived transport. */
export const openFirstThread = Effect.fn('VividRpcClient.openFirstThread')(function* () {
  return yield* (yield* VividRpcClient).OpenFirstThread()
})

/** Ask for a meaningfully improved title through the shared transport on every client surface. */
export const regenerateThreadTitle = Effect.fn('VividRpcClient.regenerateThreadTitle')(function* (
  thread: ThreadId,
) {
  return yield* (yield* VividRpcClient).RegenerateThreadTitle({ thread })
})

/**
 * What arriving at the Computer's view does, on every client surface: a Computer that was never
 * started, or was turned off, is turned on, so the Person who came to see its screen sees it and
 * is not asked to press Start first.
 *
 * The server is asked where the Computer stands and not this device's copy, which can be a
 * launch old. One that is starting or running is left as it is. One whose last start failed is
 * left too: the server counts every start a Person asks for against the provider's hourly limit
 * (`apps/server/src/computers/README.md`), so trying again stays a press and is never the price
 * of opening a view.
 */
export const wakeComputer = Effect.fn('VividRpcClient.wakeComputer')(function* () {
  const client = yield* VividRpcClient
  const { computer } = yield* client.GetComputer()
  if (!ComputerState.isAnyOf(['Absent', 'Stopped'])(computer.state)) return computer
  return (yield* client.StartComputer()).computer
})
