import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Predicate from 'effect/Predicate'
import * as Queue from 'effect/Queue'
import type * as HttpRouter from 'effect/http/HttpRouter'
import * as RpcServer from 'effect/rpc/RpcServer'
import { isCalled, LiveTally } from '../live/tally.ts'

/**
 * How long a client on the live socket may send nothing before it counts as gone. Every client
 * pings every five seconds while it runs (`packages/client/rpc` `layerLive`), so this is three
 * pings missed in a row.
 */
export const SILENT_AFTER_MS = 15_000

/**
 * One client's connection to the live socket, as the server hears it.
 *
 * Effect 4.0.2's socket server (`RpcServer.ts` `makeSocketProtocol`) ends a client only when its
 * socket closes, and never times out one that went quiet. A phone that lost its network, or was
 * put away and suspended, closes nothing: the server would keep it for as long as TCP takes to
 * give up, which is minutes. A client that is running pings every five seconds, so anything that
 * needs to know whether the client is still there asks whether it was heard lately.
 */
export class Link {
  #heardAt: number
  #open = true

  constructor(heardAt: number) {
    this.#heardAt = heardAt
  }

  /** Whether the client is still connected and was heard within `SILENT_AFTER_MS` of `now`. */
  live(now: number): boolean {
    return this.#open && now - this.#heardAt < SILENT_AFTER_MS
  }

  /** The client sent something: a call, an acknowledgement, an interruption or a ping. */
  heard(now: number): void {
    this.#heardAt = now
  }

  /** The socket closed. A closed link is never live again; the client opens a new one. */
  close(): void {
    this.#open = false
  }
}

/**
 * The link a call arrived on, for a handler whose answer is about the client staying there
 * (`BePresent`). A call over `/api/rpc` has none: one HTTP request is not a connection.
 */
export class LiveLink extends Context.Service<LiveLink, Link>()('vivid/LiveLink') {}

/**
 * The live socket's transport: Effect's own WebSocket protocol (`RpcServer.makeProtocolWebsocket`,
 * Effect 4.0.2), with every message a client sends heard on its way to the server.
 *
 * Each message refreshes its client's `Link`, which is put in the context the message is handled
 * in. Effect's server runs a call's handler in the context of the fiber that delivered the call
 * (`RpcServer.ts` `handleRequest`, `handlerContext`), so a handler on this socket finds its own
 * client's link as `LiveLink`. When the socket closes the link is closed before the server hears
 * of it, so nothing reads a gone client as present while its calls are being stopped.
 *
 * Each call is also counted under its tag (`live/tally.ts`), so a client that asks for the same
 * thing on a timer shows up in the minute's counts. Only tags of the contract are counted;
 * anything else a client sends is the server's to refuse, and is passed on untouched.
 */
export const liveProtocolLayer = (path: HttpRouter.PathInput) =>
  Layer.effect(RpcServer.Protocol)(
    Effect.gen(function* () {
      const socket = yield* RpcServer.makeProtocolWebsocket({ path })
      const tally = yield* LiveTally
      const clock = yield* Clock.Clock
      const links = new Map<number, Link>()
      const disconnects = yield* Queue.unbounded<number>()

      /** Closes a gone client's link, then tells the server, which stops that client's calls. */
      const closing = Effect.fn('LiveLink.closing')(function* () {
        const clientId = yield* Queue.take(socket.disconnects)
        const link = links.get(clientId)
        if (link !== undefined) {
          link.close()
          links.delete(clientId)
        }
        yield* Queue.offer(disconnects, clientId)
      })
      yield* closing().pipe(Effect.forever, Effect.forkScoped)

      /** The client's link, refreshed by this message, made on its first. */
      const heard = (clientId: number) => {
        const now = clock.currentTimeMillisUnsafe()
        const known = links.get(clientId)
        if (known !== undefined) {
          known.heard(now)
          return known
        }
        const made = new Link(now)
        links.set(clientId, made)
        return made
      }

      return RpcServer.Protocol.of({
        ...socket,
        disconnects,
        run: (write) =>
          socket.run((clientId, message) => {
            const link = heard(clientId)
            if (Predicate.isTagged(message, 'Request') && isCalled(message.tag))
              tally.called(message.tag)
            return write(clientId, message).pipe(Effect.provideService(LiveLink, link))
          }),
      })
    }),
  )
