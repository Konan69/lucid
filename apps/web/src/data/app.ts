import type { VividRpcClient } from '@vivid/client-runtime'
import type { ProductFailure, Settle } from '@vivid/state'
import { Effect } from 'effect'
import { engine } from './runtime'

/**
 * The web application's Effect runtime boundary: the one module where a described program is
 * started and becomes a Promise an event handler can await. The live engine only describes work;
 * nothing else in the app starts an Effect.
 */

/** Runs one program with the app's client, on the socket the live queries use. */
export const run = <Value, Failure>(program: Effect.Effect<Value, Failure, VividRpcClient>) =>
  Effect.runPromise(engine.run(program))

/**
 * Makes a change: shows it at once in every live query it touches, sends it, and takes the
 * expectation back if the server refuses. On success the server's next result confirms it.
 */
export const change = <Value>(
  program: (client: VividRpcClient['Service']) => Effect.Effect<Value, ProductFailure>,
  ...expectations: ReadonlyArray<() => Settle>
) => Effect.runPromise(engine.change(program, ...expectations))

/**
 * Starts a program that needs nothing from the app: no client, no socket. It exists for the one
 * thing that must work while the rest is broken, reporting a fault (`fault.ts`).
 */
export const send = (program: Effect.Effect<void>) => Effect.runPromise(program)
