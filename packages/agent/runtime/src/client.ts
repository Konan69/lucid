import type { DeliveredMessage } from '@flue/runtime'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as ManagedRuntime from 'effect/ManagedRuntime'
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
 * latest delivered message is in front of the model, and the server checks that Person's access
 * again on every call. Flue 2.1 joins a busy Thread's next delivery at a turn boundary and
 * rerenders the tools for it. The server keeps one response for one Person by refusing another
 * Person's delivery while a Run is working, so the delivery that joins is from the Person already
 * being answered and the acting Person does not change inside a response. A tool never chooses
 * its acting Person.
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

/** One HTTP client and Undici's process-owned pool serve every tool and context read.
 * dispatcherLayerGlobal owns no scoped Agent, so per-call Layer teardown cannot close the pool.
 * The ManagedRuntime memoizes the built HttpClient, rather than just the Layer description. */
const httpRuntime = ManagedRuntime.make(
  NodeHttpClient.layerUndiciNoDispatcher.pipe(Layer.provide(NodeHttpClient.dispatcherLayerGlobal)),
)
const httpLayer = Layer.effectContext(httpRuntime.contextEffect)

/** A bare runtime credential is permitted only for the restart scope lookup. */
export const runtimeClientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const serverUrl = yield* Config.URL('VIVID_SERVER_URL')
    const token = yield* Config.Redacted('VIVID_RUNTIME_TOKEN')
    return VividRpcClient.layer({
      url: new URL('/api/rpc', serverUrl).href,
      headers: { authorization: `Bearer ${Redacted.value(token)}` },
    }).pipe(Layer.provide(httpLayer))
  }),
)

/**
 * The product client for one Acting pair. The runtime token says the call comes from the runtime;
 * the two headers say for whom. The token never leaves this module and is never given to a tool.
 */
export const actingLayer = (acting: Acting) => {
  return Layer.unwrap(
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
      }).pipe(Layer.provide(httpLayer))
    }),
  )
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
