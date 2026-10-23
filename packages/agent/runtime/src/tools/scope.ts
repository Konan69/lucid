import type { DeliveredMessage, ToolContext } from '@flue/runtime'
import { VividRpcClient } from '@vivid/client-runtime'
import type { ThreadOrigin } from '@vivid/contracts'
import { Context, Effect, Layer, Option, Predicate } from 'effect'
import { actingLayer, runtimeClientLayer, type Acting } from '../client.ts'
import { recoverAuthority, resolveAuthority } from '../delivery.ts'
import { settle, type ToolFailure, type ToolResult } from './result.ts'
import type { ComputerSaid } from './sandbox.ts'

export interface ScopeService {
  readonly acting: Acting
  readonly client: VividRpcClient['Service']
}

/** Authority is server-bound per render; the actor cannot be chosen by model input. */
export class Scope extends Context.Service<Scope, ScopeService>()('vivid/Tools/Scope') {}

/** Tool-time recovery is lazy; the attributed client shares the tool Layer's lifetime.
 * Returning a client from a nested Effect.provide closes its RPC scope before the first call.
 * The bare recovery client instead lives only for the lookup, in its own inner scope;
 * Layer.build forks the same MemoMap as the former per-lookup Effect.provide(layer). */
export function scopeLayer(
  thread: string,
  delivery: DeliveredMessage,
  origin: Option.Option<ThreadOrigin>,
): Layer.Layer<Scope, ToolFailure> {
  return Layer.unwrap(
    Effect.gen(function* () {
      const authority = yield* resolveAuthority(thread, delivery, origin, (threadId, turn) =>
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(runtimeClientLayer)
            return yield* recoverAuthority(threadId, turn).pipe(Effect.provide(context))
          }),
        ),
      )
      return Layer.effect(
        Scope,
        Effect.gen(function* () {
          return Scope.of({
            acting: authority.acting,
            client: yield* VividRpcClient,
          })
        }),
      ).pipe(Layer.provide(actingLayer(authority.acting)))
    }),
  )
}

/** One Flue boundary per render provides authority and settles failures; durable tools wrap this call in step.do. */
export function toolRunner(layer: Layer.Layer<Scope, ToolFailure>) {
  return function runTool(
    program: Effect.Effect<ToolResult, ToolFailure, Scope>,
    { signal, tool }: Pick<ToolContext<undefined>, 'signal'> & { readonly tool: string },
  ) {
    const settled = program.pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- The single Flue tool execution boundary owns the tool Layer.
      Effect.provide(layer),
      (provided) => settle(provided, tool),
    )
    // oxlint-disable-next-line vivid/no-runpromise-in-library -- This is the single Flue tool execution boundary, classified exactly by the Effect audit.
    return Effect.runPromise(settled, { signal })
  }
}

export type RunTool = ReturnType<typeof toolRunner>

/**
 * The same authority for a call whose answer is not a tool result: the Computer sandbox's file and
 * shell verbs, which Flue's own tools call and which answer bytes and output, not a display
 * record. A failure rejects with an `Error` whose message Flue shows the model; a server failure
 * that is not a sentence for the model becomes one here.
 */
export function scopedRunner(layer: Layer.Layer<Scope, ToolFailure>) {
  return function runScoped<A>(
    program: Effect.Effect<A, ToolFailure | ComputerSaid, Scope>,
    signal: Option.Option<AbortSignal>,
  ): Promise<A> {
    const settled = program.pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- The Flue sandbox execution boundary owns the tool Layer.
      Effect.provide(layer),
      Effect.mapError(
        (failure) =>
          // @effect-diagnostics-next-line globalErrorInEffectFailure:off -- Flue's sandbox verbs reject with an Error whose message the model reads; this is the one conversion to that contract.
          new Error(
            Predicate.isTagged(failure, 'ComputerSaid')
              ? failure.message
              : 'The Computer could not be reached. Try again.',
          ),
      ),
    )
    // oxlint-disable-next-line vivid/no-runpromise-in-library -- The Flue sandbox verb boundary, classified exactly by the Effect audit.
    return Effect.runPromise(
      settled,
      Option.match(signal, { onNone: () => ({}), onSome: (value) => ({ signal: value }) }),
    )
  }
}

export type RunScoped = ReturnType<typeof scopedRunner>
