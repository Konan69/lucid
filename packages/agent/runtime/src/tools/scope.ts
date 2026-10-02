import type { DeliveredMessage, ToolContext } from '@flue/runtime'
import { VividRpcClient } from '@vivid/client-runtime'
import { LibraryFolderId } from '@vivid/contracts'
import { Context, Effect, Layer, Option, Schema, type Config } from 'effect'
import { actingLayer, NobodyToActFor, type Acting } from '../client.ts'
import { settle, type ToolFailure, type ToolResult } from './result.ts'

export interface ScopeService {
  readonly acting: Acting
  readonly client: VividRpcClient['Service']
  readonly folder: Option.Option<LibraryFolderId>
}

/** Authority is server-bound per render; neither actor nor folder can be chosen by model input. */
export class Scope extends Context.Service<Scope, ScopeService>()('vivid/Tools/Scope') {}

// LibraryFolderId is only branded in contracts; this ingress also rejects empty/malformed UUIDs.
const decodeFolder = Schema.decodeUnknownOption(
  LibraryFolderId.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu),
  ),
)

/** Invalid or non-signal attributes mean no Routine folder, without crashing an ordinary turn. */
export function folderOf(delivery: DeliveredMessage) {
  if (delivery.kind !== 'signal' || delivery.attributes === undefined)
    return Option.none<LibraryFolderId>()
  return decodeFolder(delivery.attributes.libraryFolder)
}

/** Acquire the same attributed client as context loading, failing before any product call without a Person. */
export function scopeLayer(
  acting: Option.Option<Acting>,
  delivery: DeliveredMessage,
): Layer.Layer<Scope, NobodyToActFor | Config.ConfigError> {
  return Option.match(acting, {
    onNone: () =>
      Layer.effect(
        Scope,
        Effect.fail(
          new NobodyToActFor({ message: 'There is no Person behind this message to act for.' }),
        ),
      ),
    onSome: (who) =>
      Layer.effect(
        Scope,
        Effect.gen(function* () {
          const client = yield* VividRpcClient
          return Scope.of({ acting: who, client, folder: folderOf(delivery) })
        }),
      ).pipe(Layer.provide(actingLayer(who))),
  })
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
