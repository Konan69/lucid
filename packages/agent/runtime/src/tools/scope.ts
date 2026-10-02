import type { DeliveredMessage, ToolContext } from '@flue/runtime'
import { VividRpcClient } from '@vivid/client-runtime'
import type { LibraryFolderId, ThreadOrigin } from '@vivid/contracts'
import { Context, Effect, Layer, Option } from 'effect'
import { actingLayer, runtimeClientLayer, type Acting } from '../client.ts'
import { recoverAuthority, resolveAuthority } from '../delivery.ts'
import { settle, type ToolFailure, type ToolResult } from './result.ts'

export interface ScopeService {
  readonly acting: Acting
  readonly client: VividRpcClient['Service']
  readonly folder: Option.Option<LibraryFolderId>
}

/** Authority is server-bound per render; neither actor nor folder can be chosen by model input. */
export class Scope extends Context.Service<Scope, ScopeService>()('vivid/Tools/Scope') {}

/** Tool-time recovery is lazy: a restart misses render context but still resolves authority before any action. */
export function scopeLayer(
  thread: string,
  delivery: DeliveredMessage,
  origin: Option.Option<ThreadOrigin>,
): Layer.Layer<Scope, ToolFailure> {
  return Layer.effect(
    Scope,
    Effect.gen(function* () {
      const authority = yield* resolveAuthority(thread, delivery, origin, (threadId, turn) =>
        recoverAuthority(threadId, turn).pipe(Effect.provide(runtimeClientLayer)),
      )
      return yield* Effect.gen(function* () {
        return Scope.of({
          acting: authority.acting,
          client: yield* VividRpcClient,
          folder: authority.folder,
        })
      }).pipe(Effect.provide(actingLayer(authority.acting)))
    }),
  )
}

/** One Flue boundary per render provides authority and settles failures; durable tools wrap this call in step.do. */
export function toolRunner(layer: Layer.Layer<Scope, ToolFailure>) {
  return function runTool(
    program: Effect.Effect<ToolResult, ToolFailure, Scope>,
    { signal }: Pick<ToolContext<undefined>, 'signal'>,
  ) {
    // oxlint-disable-next-line vivid/no-runpromise-in-library -- This is the single Flue tool execution boundary, classified exactly by the Effect audit.
    return Effect.runPromise(settle(program.pipe(Effect.provide(layer))), { signal })
  }
}

export type RunTool = ReturnType<typeof toolRunner>
