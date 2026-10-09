/** Ported from opencode `packages/codemode/src/tool-runtime.ts` at 3884062 (MIT). */
import { Cause, Effect } from 'effect'
import { ToolRefusal, toolRefusal } from './refusal.ts'

/** Preserve explicit safe refusals and interruption; sanitize every other host failure once at ingress. */
export const runHost = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ToolRefusal, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
      const error = Cause.squash(cause)
      return Effect.fail(
        error instanceof ToolRefusal ? error : toolRefusal('Tool execution failed', error),
      )
    }),
  )
