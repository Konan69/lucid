import type { VividRpcClient } from '@vivid/client-runtime'
import type { ProductFailure, Settle } from '@vivid/state'
import { Effect, Fiber } from 'effect'
import { engine } from './runtime'

/**
 * The web application's Effect runtime boundary: the one module where a described program is
 * started and becomes a Promise an event handler can await. The live engine only describes work;
 * nothing else in the app starts an Effect.
 */

/**
 * One program with the app's client, on the socket the live queries use, described and not yet
 * started: the step a larger flow yields. Its refusal is in the value (`Result`), so the flow
 * that yields it cannot fail of it and draws it instead.
 */
export const running = <Value, Failure>(program: Effect.Effect<Value, Failure, VividRpcClient>) =>
  engine.run(program)

/**
 * A change, described and not yet started: when the flow that yields it reaches it, it is shown
 * at once in every live query it touches, sent, and its expectation taken back if the server
 * refuses. On success the server's next result confirms it. The refusal is in the value.
 */
export const changing = <Value>(
  program: (client: VividRpcClient['Service']) => Effect.Effect<Value, ProductFailure>,
  ...expectations: ReadonlyArray<() => Settle>
) => engine.change(program, ...expectations)

/**
 * Starts one whole flow: everything a press or a submit does after its first wait, described as
 * one program of `running` and `changing` steps and the screen's own updates between them. It is
 * started here, once, at the event handler; the flow has already been given all it needs and
 * cannot fail, so the Promise is only "it has ended", with what it ended on.
 *
 * The program begins in the same turn it is started in (`Effect.runFork` evaluates the fiber at
 * once, effect 4.0.0-rc.116 `internal/effect.ts` `runForkWith`), so what it does before its first
 * wait happens during the press, as it did when these flows were async functions.
 */
export const act = <Value>(flow: Effect.Effect<Value>) => Effect.runPromise(flow)

/** Runs one program with the app's client, on the socket the live queries use. */
export const run = <Value, Failure>(program: Effect.Effect<Value, Failure, VividRpcClient>) =>
  act(running(program))

/**
 * Makes a change: shows it at once in every live query it touches, sends it, and takes the
 * expectation back if the server refuses. On success the server's next result confirms it.
 */
export const change = <Value>(
  program: (client: VividRpcClient['Service']) => Effect.Effect<Value, ProductFailure>,
  ...expectations: ReadonlyArray<() => Settle>
) => act(changing(program, ...expectations))

/**
 * Starts a program that needs nothing from the app: no client, no socket. It exists for the one
 * thing that must work while the rest is broken, reporting a fault (`fault.ts`).
 */
export const send = (program: Effect.Effect<void>) => Effect.runPromise(program)

/**
 * Starts a program that goes on until it ends by itself or is stopped, and hands back the way to
 * stop it. It is for the one thing in the app that waits on something outside it for minutes: the
 * desktop app waiting for a Person to choose a Google account in their browser (`handoff.ts`).
 * Stopping interrupts the program where it stands, in the middle of a wait included.
 */
export const start = (program: Effect.Effect<void>) => {
  const fiber = Effect.runFork(program)
  return () => {
    Effect.runFork(Fiber.interrupt(fiber))
  }
}
