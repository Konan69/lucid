import { Effect } from 'effect'

/**
 * The mobile application's Effect runtime boundary: the one place a described program is started
 * and becomes a Promise a screen can await. The programs handed here carry their failures in
 * their value (`Result`), so the Promise only rejects for a defect.
 */
export const start = <Value>(program: Effect.Effect<Value>) => Effect.runPromise(program)
