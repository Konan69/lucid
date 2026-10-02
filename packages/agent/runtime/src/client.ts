import type { DeliveredMessage } from '@flue/runtime'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import { NodeHttpClient } from '@effect/platform-node'
import { VividRpcClient } from '@vivid/client-runtime'
import { ThreadOrigin, type PersonId, type ThreadId } from '@vivid/contracts'
import { cachedAuthority } from './delivery.ts'
import { runtimeHeaders } from '@vivid/contracts/auth'

/**
 * Who Vivid is acting for right now: one Person, in one Thread.
 *
 * Vivid has no identity of its own. Every product call a tool makes is made as the Person whose
 * message is in front of the model, and the server checks that Person's access again on every
 * call. This is the only thing a tool needs to know about identity, and a tool never chooses it.
 */
export interface Acting {
  readonly threadId: ThreadId
  readonly personId: PersonId
}

/** A tool was asked to act and there is no Person behind the message. Nothing is done. */
export class NobodyToActFor extends Schema.TaggedError<NobodyToActFor>()(
  'NobodyToActFor',
  { message: Schema.String },
  { title: 'Nobody to act for' },
) {}

/** Decodes what the server recorded when the conversation was created: who started the Thread. */
export const threadOriginOf = Schema.decodeUnknownOption(ThreadOrigin)
/** The render consults server-prepared authority; it never decodes a Person from model-visible attributes. */
export const actingFor = (
  threadId: string,
  delivery: DeliveredMessage,
  origin: Option.Option<ThreadOrigin>,
): Option.Option<Acting> =>
  Option.map(cachedAuthority(threadId, delivery, origin), (scope) => scope.acting)

/** A bare runtime credential is permitted only for the restart scope lookup. */
export const runtimeClientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const serverUrl = yield* Config.URL('VIVID_SERVER_URL')
    const token = yield* Config.Redacted('VIVID_RUNTIME_TOKEN')
    return VividRpcClient.layer({
      url: new URL('/api/rpc', serverUrl).href,
      headers: { authorization: `Bearer ${Redacted.value(token)}` },
    }).pipe(Layer.provide(NodeHttpClient.layerUndici))
  }),
)

const layers = new Map<string, Layer.Layer<VividRpcClient, Config.ConfigError>>()

/**
 * The product client for one Acting pair. The runtime token says the call comes from the runtime;
 * the two headers say for whom. The token never leaves this module and is never given to a tool.
 */
export const actingLayer = (acting: Acting) => {
  const key = `${acting.threadId}\u0000${acting.personId}`
  const cached = layers.get(key)
  if (cached !== undefined) return cached
  const layer = Layer.unwrap(
    Effect.gen(function* () {
      const serverUrl = yield* Config.URL('VIVID_SERVER_URL')
      const token = yield* Config.Redacted('VIVID_RUNTIME_TOKEN')
      return VividRpcClient.layer({
        url: new URL('/api/rpc', serverUrl).href,
        headers: {
          authorization: `Bearer ${Redacted.value(token)}`,
          [runtimeHeaders.thread]: acting.threadId,
          [runtimeHeaders.actor]: acting.personId,
        },
      }).pipe(Layer.provide(NodeHttpClient.layerUndici))
    }),
  )
  layers.set(key, layer)
  return layer
}

/**
 * Runs a context read as the acting Person. Tools acquire the same attributed Layer through
 * Scope, retaining the client's resources for the whole tool program.
 */
export const asActing = <A, E>(
  acting: Option.Option<Acting>,
  use: (client: VividRpcClient['Service']) => Effect.Effect<A, E>,
) =>
  Option.match(acting, {
    onNone: () =>
      Effect.fail(
        new NobodyToActFor({ message: 'There is no Person behind this message to act for.' }),
      ),
    onSome: (who) =>
      Effect.gen(function* () {
        return yield* use(yield* VividRpcClient)
      }).pipe(Effect.provide(actingLayer(who))),
  })
