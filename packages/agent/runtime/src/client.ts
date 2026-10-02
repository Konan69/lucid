import type { DeliveredMessage } from '@flue/runtime'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import { NodeHttpClient } from '@effect/platform-node'
import { VividRpcClient } from '@vivid/client-runtime'
import { PersonId, ThreadId, ThreadOrigin } from '@vivid/contracts'
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
const decodePerson = Schema.decodeUnknownOption(PersonId)
const decodeThread = Schema.decodeUnknownOption(ThreadId)

/** The Person a signal names. The server writes this attribute on everything it delivers. */
const speakerOf = (delivery: DeliveredMessage) =>
  delivery.kind === 'signal' && delivery.attributes !== undefined
    ? decodePerson(delivery.attributes.person)
    : Option.none<PersonId>()

/**
 * Works out who Vivid acts for from the message in front of the model.
 *
 * - A signal names its Person in the `person` attribute: a Member speaking in a shared Thread, a
 *   Routine's owner, the Person who decided an Approval. The server sets it; a client cannot.
 * - A plain user turn only happens in a private Thread, where the one Person is its creator,
 *   recorded when the conversation was created (`ThreadOrigin`).
 *
 * `delivery` is Flue's cursor: when a second Person's message joins a response in progress, the
 * next render sees that Person, so the next tool call is made as them.
 */
export const actingFor = (
  threadId: string,
  delivery: DeliveredMessage,
  origin: Option.Option<ThreadOrigin>,
): Option.Option<Acting> =>
  Option.flatMap(decodeThread(threadId), (thread) => {
    const creator = Option.map(origin, (seed) => seed.creator)
    const person = delivery.kind === 'signal' ? speakerOf(delivery) : creator
    return Option.map(person, (personId) => ({ threadId: thread, personId }))
  })

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
