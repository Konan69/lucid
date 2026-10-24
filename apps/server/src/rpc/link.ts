import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import type { FromClientEncoded } from 'effect/rpc/RpcMessage'
import * as RpcServer from 'effect/rpc/RpcServer'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { isCalled, LiveTally } from '../live/tally.ts'

/**
 * How long a client on the live socket may send nothing before it counts as gone. Every client
 * pings every five seconds while it runs (`packages/client/rpc` `layerLive`), so this is three
 * pings missed in a row.
 */
export const SILENT_AFTER_MS = 15_000

/**
 * How long a client may send nothing before its socket is closed. A browser runs the timers of a
 * tab left in the background once a minute, and at that tick the client either pings or, finding
 * the socket quiet for longer than its own timeout, opens a new one (`packages/client/rpc`
 * `layerLive`). So a client that is running is heard at least once a minute, and only a connection
 * nobody is at any more stays quiet for two.
 */
export const CLOSED_AFTER_MS = 120_000

/**
 * One client's connection to the live socket, as the server hears it.
 *
 * Effect 4.0.2's socket server (`RpcServer.ts` `makeSocketProtocol`) ends a client only when its
 * socket closes, and never times out one that went quiet. A phone that lost its network, or was
 * put away and suspended, closes nothing: the server would keep it, and every call it left open,
 * for as long as TCP takes to give up. A client that is running pings every five seconds, so
 * whether it was heard lately says whether it is still there.
 */
const LinkActivity = Schema.TaggedUnion({
  Listening: { heardAt: Schema.Finite },
  Closed: {},
})

/** One socket owns activity, and every presence reader observes the same transitions. */
export class Link {
  #activity: typeof LinkActivity.Type
  #listeners = new Set<(activity: typeof LinkActivity.Type) => void>()

  constructor(heardAt: number) {
    this.#activity = LinkActivity.cases.Listening.make({ heardAt })
  }

  /** Closed is terminal, so its silence has no finite next deadline. */
  silentFor(now: number): number {
    return LinkActivity.match(this.#activity, {
      Listening: ({ heardAt }) => now - heardAt,
      Closed: () => Infinity,
    })
  }

  /** Only a connected socket heard inside the heartbeat gap is live. */
  live(now: number): boolean {
    return this.silentFor(now) < SILENT_AFTER_MS
  }

  /** A late frame cannot reopen a closed socket. Publish before the next silence deadline. */
  heard(now: number): void {
    if (LinkActivity.guards.Closed(this.#activity)) return
    this.#activity = LinkActivity.cases.Listening.make({ heardAt: now })
    for (const listener of this.#listeners) listener(this.#activity)
  }

  /** Closing the socket immediately wakes every observer, without waiting for a scan. */
  close(): void {
    this.#activity = LinkActivity.cases.Closed.make({})
    for (const listener of this.#listeners) listener(this.#activity)
  }

  /** Subscribe before the initial snapshot. Each frame cancels the old silence timer; a silent
   * peer cannot emit its own departure, so only the heartbeat gap still needs a clock. */
  readonly activity = Stream.callback<typeof LinkActivity.Type>((queue) => {
    const emit = (activity: typeof LinkActivity.Type) => {
      Queue.offerUnsafe(queue, activity)
    }
    return Effect.acquireRelease(
      Effect.sync(() => {
        this.#listeners.add(emit)
        emit(this.#activity)
      }),
      () =>
        Effect.sync(() => {
          this.#listeners.delete(emit)
        }),
    )
  }).pipe(
    Stream.switchMap((activity) =>
      LinkActivity.match(activity, {
        Closed: () => Stream.make(false),
        Listening: ({ heardAt }) =>
          Stream.unwrap(
            Effect.map(Clock.currentTimeMillis, (now) => {
              const remaining = SILENT_AFTER_MS - (now - heardAt)
              return remaining <= 0
                ? Stream.make(false)
                : Stream.concat(
                    Stream.make(true),
                    Stream.fromEffect(Effect.as(Effect.sleep(remaining), false)),
                  )
            }),
          ),
      }),
    ),
    Stream.changes,
  )
}

/**
 * The link a call arrived on, for a handler whose answer is about the client staying there
 * (`BePresent`). A call over `/api/rpc` has none: one HTTP request is not a connection.
 */
export class LiveLink extends Context.Service<LiveLink, Link>()('vivid/LiveLink') {}

/**
 * The live socket's transport: Effect's own WebSocket protocol
 * (`RpcServer.makeProtocolWithHttpEffectWebsocket`, Effect 4.0.2), with each connection given a
 * `Link` and every message a client sends heard on its way to the server.
 *
 * The route holds a connection for as long as its socket is open (`httpEffect` reads it until it
 * closes), and reads its messages in that same fiber. So the link is provided around the route,
 * each message refreshes it there, and the server, which runs a call's handler in the context of
 * the fiber that delivered the call (`RpcServer.ts` `handleRequest`, `handlerContext`), hands it
 * to the call as `LiveLink`. A connection quiet for `CLOSED_AFTER_MS` is ended: the route returns,
 * the request's scope closes the socket (`@effect/platform-node` `NodeHttpServer.ts`
 * `makeUpgradeHandler`), and the server stops every call the client left open.
 *
 * Each call is also counted under its tag (`live/tally.ts`), so a client that asks for the same
 * thing on a timer shows up in the minute's counts. Only tags of the contract are counted;
 * anything else a client sends is the server's to refuse, and is passed on untouched.
 */
export const liveProtocolLayer = (path: HttpRouter.PathInput) =>
  Layer.effect(RpcServer.Protocol)(
    Effect.gen(function* () {
      const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket
      const router = yield* HttpRouter.HttpRouter
      const tally = yield* LiveTally
      const clock = yield* Clock.Clock

      /** Waits until the link has been quiet for `CLOSED_AFTER_MS`, waking only when it might be. */
      const silence = Effect.fn('LiveLink.silence')(function* (link: Link) {
        for (;;) {
          const quiet = link.silentFor(clock.currentTimeMillisUnsafe())
          if (quiet >= CLOSED_AFTER_MS) return HttpServerResponse.empty()
          yield* Effect.sleep(CLOSED_AFTER_MS - quiet)
        }
      })

      /** One connection: open until its socket closes or it goes quiet, then its link is closed. */
      const connection = Effect.fn('LiveLink.connection')(function* () {
        const link = new Link(clock.currentTimeMillisUnsafe())
        return yield* httpEffect.pipe(
          Effect.provideService(LiveLink, link),
          Effect.raceFirst(silence(link)),
          Effect.ensuring(Effect.sync(() => link.close())),
        )
      })
      yield* router.add('GET', path, connection())

      /** Refreshes the delivering connection's link and counts a call of the contract. */
      const hear = (message: FromClientEncoded, link: Option.Option<Link>) => {
        if (Option.isSome(link)) link.value.heard(clock.currentTimeMillisUnsafe())
        if (Predicate.isTagged(message, 'Request') && isCalled(message.tag))
          tally.called(message.tag)
      }

      return RpcServer.Protocol.of({
        ...protocol,
        run: (write) =>
          protocol.run((clientId, message) =>
            Effect.flatMap(Effect.serviceOption(LiveLink), (link) => {
              hear(message, link)
              return write(clientId, message)
            }),
          ),
      })
    }),
  )
