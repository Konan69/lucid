import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import type { VividRpcClient } from '@vivid/client-runtime'
import type { PersonId } from '@vivid/contracts'
import { Context, Effect, type Layer, Option, Predicate } from 'effect'
import { Notes } from '../notes.ts'
import type { Acting } from '../client.ts'
import { settle, type ToolFailure, type ToolResult } from './result.ts'
import { ComputerSaid } from './sandbox.ts'

export interface ScopeService {
  readonly acting: Acting
  readonly client: VividRpcClient['Service']
}

/** Authority is server-bound per call; neither actor nor folder can be chosen by model input. */
export class Scope extends Context.Service<Scope, ScopeService>()('vivid/Tools/Scope') {}

/** The core resolves the call's server-owned delivery authority. Its Layer owns the attributed
 * RPC client's lifetime through the entire call, including lazy recovery and cancellation.
 * Model arguments never participate in choosing a Person, Thread or Library folder. */
export type ResolveScope = (
  call: Pick<ToolExecutionApi, 'conversationId' | 'callId' | 'taskId'>,
) => Layer.Layer<Scope, ToolFailure>

/** Preserve the exported authority seam while making delivery resolution an explicit core input. */
export function scopeLayer(resolve: ResolveScope, call: Parameters<ResolveScope>[0]) {
  return resolve(call)
}

/** Pi invokes this one Effect boundary per call; the Layer lives until the settled RPC receipt. */
export function toolRunner(layer: Layer.Layer<Scope, ToolFailure>) {
  return function runTool(
    program: Effect.Effect<ToolResult, ToolFailure, Scope>,
    { signal, tool }: { readonly signal: AbortSignal; readonly tool: string },
  ) {
    const settled = program.pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- The single Pi tool execution boundary owns the tool Layer.
      Effect.provide(layer),
      (provided) => settle(provided, tool),
    )
    // oxlint-disable-next-line vivid/no-runpromise-in-library -- This is the single Pi tool execution boundary, classified exactly by the Effect audit.
    return Effect.runPromise(settled, { signal })
  }
}

export type RunTool = ReturnType<typeof toolRunner>

/**
 * The same authority for a call whose answer is not a tool result: the Computer sandbox's file and
 * shell verbs, which the six Computer tools call and which answer bytes and output, not a display
 * record. A failure rejects with an `Error` whose message Pi shows the model; a server failure
 * that is not a sentence for the model becomes one here.
 */
export function scopedRunner(layer: Layer.Layer<Scope, ToolFailure>) {
  return function runScoped<A>(
    program: Effect.Effect<A, ToolFailure | ComputerSaid, Scope>,
    signal: Option.Option<AbortSignal>,
  ): Promise<A> {
    const settled = program.pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- The Pi sandbox execution boundary owns the tool Layer.
      Effect.provide(layer),
      Effect.mapError(
        (failure) =>
          new ComputerSaid({
            message: Predicate.isTagged(failure, 'ComputerSaid')
              ? failure.message
              : 'The Computer could not be reached. Try again.',
          }),
      ),
    )
    // oxlint-disable-next-line vivid/no-runpromise-in-library -- The Pi sandbox verb boundary, classified exactly by the Effect audit.
    return Effect.runPromise(
      settled,
      Option.match(signal, { onNone: () => ({}), onSome: (value) => ({ signal: value }) }),
    )
  }
}

export type RunScoped = ReturnType<typeof scopedRunner>

/**
 * Local notes require the prepared Person authority, not a product RPC client. Resolve it
 * through the same production resolver as Scope, including durable recovery if needed. An
 * absent product server therefore cannot block local memory on an already attributed turn.
 * The caller supplies the Notes layer so tool definitions can load without runtime settings.
 */
export function noteRunner(
  person: () => Effect.Effect<PersonId, ToolFailure>,
  notes: Notes['Service'],
) {
  return function runNote(
    operation: (person: PersonId) => Effect.Effect<ToolResult, ToolFailure, Notes>,
    { signal, tool }: { readonly signal: AbortSignal; readonly tool: string },
  ) {
    const program = Effect.gen(function* () {
      return yield* operation(yield* person())
    }).pipe(Effect.provideService(Notes, notes))
    // oxlint-disable-next-line vivid/no-runpromise-in-library -- Pi's local note tool callback requires a Promise.
    return Effect.runPromise(settle(program, tool), { signal })
  }
}

export type RunNote = ReturnType<typeof noteRunner>
