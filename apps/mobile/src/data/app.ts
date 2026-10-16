import { Effect, Fiber } from 'effect'

/**
 * The mobile application's Effect runtime boundary: the one place a described program is started
 * and becomes a Promise a screen can await. The programs handed here carry their failures in
 * their value (`Result`), so the Promise only rejects for a defect.
 *
 * A press or a submit hands its whole flow here, once (`act` on the web). The program begins in
 * the turn it is started in (`Effect.runPromise` forks and evaluates the fiber at once, effect
 * 4.0.2 `internal/effect.ts` `runForkWith`), so what it does before its first wait happens during
 * the press, as it did when these flows were async functions.
 */
export const start = <Value>(program: Effect.Effect<Value>) => Effect.runPromise(program)

/**
 * Starts a program that goes on until it ends by itself or is stopped, and hands back the way to
 * stop it: a draft resting before it is saved (`drafts.ts`), which newer words call off.
 */
export const launch = (program: Effect.Effect<void>) => {
  const fiber = Effect.runFork(program)
  return () => {
    Effect.runFork(Fiber.interrupt(fiber))
  }
}
