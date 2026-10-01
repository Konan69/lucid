import { VividRpcClient } from '@vivid/client-runtime'
import type { RpcFailure } from '@vivid/contracts/rpc'
import type { LiveEnvironment } from '@vivid/state'
import { Effect, Fiber, Layer, ManagedRuntime } from 'effect'
import type * as Result from 'effect/Result'
import * as RpcClientError from 'effect/unstable/rpc/RpcClientError'
import * as Socket from 'effect/unstable/socket/Socket'

/** Everything a product call can fail with: what the server said, or that it could not be reached. */
export type ProductFailure = RpcFailure | RpcClientError.RpcClientError

/** An Effect program the web runtime can run. */
export type Program<Value> = Effect.Effect<Value, ProductFailure, VividRpcClient>

/** Turns a browser-only transport failure into the same failure the screens already draw. */
export function clientFailure(message: string, cause: unknown): RpcClientError.RpcClientError {
  return RpcClientError.RpcClientError.make({
    reason: RpcClientError.RpcClientDefect.make({ message, cause }),
  })
}

/**
 * The live endpoint on the origin the page came from. The app never names a server: in
 * development Vite forwards `/api`, in the desktop app the shell serves the page from the saved
 * server's origin, and on the web the server is the origin.
 */
const liveAddress = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`

// One socket for the whole app. Every call and every live query rides it; the browser sends the
// session cookie with the upgrade, so signing in or out reloads the page to open a new one.
const runtimeLayer = VividRpcClient.layerLive({ url: liveAddress }).pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
)
const runtime = ManagedRuntime.make(runtimeLayer)

/** Runs one program at the web application's single Effect runtime boundary. */
export function run<Value, Failure>(
  program: Effect.Effect<Value, Failure, VividRpcClient>,
): Promise<Result.Result<Value, Failure>> {
  return runtime.runPromise(Effect.result(program))
}

/** Where live queries run and wait. `later` is a timer because lingering is wall-clock time. */
export const environment: LiveEnvironment<VividRpcClient> = {
  fork: (program) => {
    const fiber = runtime.runFork(program)
    return () => {
      runtime.runFork(Fiber.interrupt(fiber))
    }
  },
  later: (task, milliseconds) => {
    const timer = setTimeout(task, milliseconds)
    return () => clearTimeout(timer)
  },
}
