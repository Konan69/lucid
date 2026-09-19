import { Effect, Layer, ManagedRuntime } from 'effect'
import type * as Result from 'effect/Result'

// The web application owns one long-lived Effect runtime. Screens receive typed Results rather
// than rejected Promises, so expected ClientRequestFailed values stay in the domain error channel.
const runtime = ManagedRuntime.make(Layer.empty)

/** Executes a client program at the web application's single Effect runtime boundary. */
export function run<Value, Failure>(
  program: Effect.Effect<Value, Failure>,
): Promise<Result.Result<Value, Failure>> {
  return runtime.runPromise(Effect.result(program))
}
