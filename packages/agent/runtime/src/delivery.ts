import type { DeliveredMessage } from '@flue/runtime'
import { VividRpcClient } from '@vivid/client-runtime'
import {
  DeliveryScope,
  ThreadId,
  type RuntimeRunRequest,
  type ThreadOrigin,
} from '@vivid/contracts'
import { Cache, Data, Duration, Effect, Exit, Option, Schema } from 'effect'
import { NobodyToActFor, type Acting } from './client.ts'

export interface DeliveryAuthority {
  readonly acting: Acting
}

const scopes = new Map<string, DeliveryAuthority>()
const capacity = 512
const keyOf = (thread: ThreadId, turn: number) => `${thread}\u0000${turn}`
const decodeThread = Schema.decodeUnknownOption(ThreadId)
const decodeTurn = Schema.decodeUnknownOption(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
)

/** The acting Person arrives outside conversation text and remains bound to this delivery. */
export function recordScope(
  threadId: ThreadId,
  turn: number,
  scope: DeliveryScope,
): DeliveryAuthority {
  const authority = {
    acting: { threadId, personId: scope.acting },
  }
  scopes.set(keyOf(threadId, turn), authority)
  // Flue renders synchronously, so this projection needs a synchronous, oldest-out bound.
  // Evicted authority remains recoverable from the persisted Run on the next tool call.
  if (scopes.size > capacity) {
    const oldest = scopes.keys().next()
    if (!oldest.done) scopes.delete(oldest.value)
  }
  return authority
}

/** Only a positive turn number can refer to a server-recorded signal delivery. */
const turnOf = (delivery: DeliveredMessage) =>
  delivery.kind === 'signal' && delivery.attributes !== undefined
    ? decodeTurn(delivery.attributes.turn)
    : Option.none<number>()

/** Synchronous renders cannot do I/O: an unprepared signal renders empty context until a tool resolves it. */
export function cachedAuthority(
  thread: string,
  delivery: DeliveredMessage,
  origin: Option.Option<ThreadOrigin>,
): Option.Option<DeliveryAuthority> {
  return Option.flatMap(decodeThread(thread), (threadId) => {
    if (delivery.kind === 'user')
      return Option.map(origin, ({ creator }) => ({
        acting: { threadId, personId: creator },
      }))
    return Option.flatMap(turnOf(delivery), (turn) =>
      Option.fromUndefinedOr(scopes.get(keyOf(threadId, turn))),
    )
  })
}

/** Use the bare runtime credential, never an attributed client, to recover exactly one persisted delivery. */
const lookup = Effect.fn('Delivery.lookup')(function* (threadId: ThreadId, turn: number) {
  const rpc = yield* VividRpcClient
  return recordScope(threadId, turn, yield* rpc.GetDeliveryScope({ threadId, turn }))
})

/** Value equality lets separate renders share the same persisted turn lookup. */
class RecoveryKey extends Data.Class<{ readonly threadId: ThreadId; readonly turn: number }> {}

/** Bound recoveries and cache only successes; resolve services per lookup to avoid capturing a client. */
const makeRecoveries = () =>
  Cache.makeWith(
    (key: { readonly threadId: ThreadId; readonly turn: number }) => lookup(key.threadId, key.turn),
    {
      capacity,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      requireServicesAt: 'lookup',
    },
  )
let recoveries = Option.none<Effect.Success<ReturnType<typeof makeRecoveries>>>()

/** Cache construction is synchronous and happens once; no I/O can race the initial publication. */
const recoveryCache = Effect.fn('Delivery.recoveryCache')(function* () {
  if (Option.isSome(recoveries)) return recoveries.value
  const cache = yield* makeRecoveries()
  recoveries = Option.some(cache)
  return cache
})

/** Reuse successful authority and concurrent recovery, but retry a failed lookup on the next call. */
export const recoverAuthority = Effect.fn('Delivery.recover')(function* (
  threadId: ThreadId,
  turn: number,
) {
  return yield* Cache.get(yield* recoveryCache(), new RecoveryKey({ threadId, turn }))
})

/** Validate attribution before acquiring recovery transport. An unowned user message cannot
 * require server configuration or credentials merely to report that no Person can act. */
export const resolveAuthority = Effect.fn('Delivery.resolve')(function* <E, R>(
  thread: string,
  delivery: DeliveredMessage,
  origin: Option.Option<ThreadOrigin>,
  recover: (threadId: ThreadId, turn: number) => Effect.Effect<DeliveryAuthority, E, R>,
) {
  const prepared = cachedAuthority(thread, delivery, origin)
  if (Option.isSome(prepared)) return prepared.value
  const threadId = decodeThread(thread)
  const turn = turnOf(delivery)
  if (Option.isNone(threadId) || Option.isNone(turn))
    return yield* new NobodyToActFor({
      message: 'There is no Person behind this message to act for.',
    })
  return yield* recover(threadId.value, turn.value)
})

/** A new object is the Flue ingress: authority and transport keys cannot leak into history or model text. */
export function modelDelivery(delivery: RuntimeRunRequest) {
  if (Object.keys(delivery.attributes).length === 0)
    return {
      kind: 'user' as const,
      body: delivery.body,
      attachments: delivery.attachments === undefined ? [] : Array.from(delivery.attachments),
    }
  return {
    kind: 'signal' as const,
    type: delivery.type,
    tagName: delivery.type,
    body: delivery.body,
    attributes: delivery.attributes,
  }
}
