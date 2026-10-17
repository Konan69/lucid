import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Predicate from 'effect/Predicate'
import type * as HttpRouter from 'effect/http/HttpRouter'
import * as RpcServer from 'effect/rpc/RpcServer'
import { isCalled, LiveTally } from '../live/tally.ts'

/**
 * The live socket's transport: Effect's own WebSocket protocol (`RpcServer.makeProtocolWebsocket`,
 * Effect 4.0.2), with every message a client sends heard on its way to the server.
 *
 * Each call is counted under its tag (`live/tally.ts`), so a client that asks for the same thing
 * on a timer shows up in the minute's counts. Only tags of the contract are counted; anything
 * else a client sends is the server's to refuse, and is passed on untouched.
 */
export const liveProtocolLayer = (path: HttpRouter.PathInput) =>
  Layer.effect(RpcServer.Protocol)(
    Effect.gen(function* () {
      const socket = yield* RpcServer.makeProtocolWebsocket({ path })
      const tally = yield* LiveTally
      return RpcServer.Protocol.of({
        ...socket,
        run: (write) =>
          socket.run((clientId, message) => {
            if (Predicate.isTagged(message, 'Request') && isCalled(message.tag))
              tally.called(message.tag)
            return write(clientId, message)
          }),
      })
    }),
  )
