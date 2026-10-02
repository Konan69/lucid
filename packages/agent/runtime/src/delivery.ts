import type { DeliveredMessage } from '@flue/runtime'
import { VividRpcClient } from '@vivid/client-runtime'
import {
  DeliveryScope,
  LibraryFolderId,
  ThreadId,
  type RuntimeRunRequest,
  type ThreadOrigin,
} from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import { NobodyToActFor, type Acting } from './client.ts'

export interface DeliveryAuthority {
  readonly acting: Acting
  readonly folder: Option.Option<LibraryFolderId>
}

const scopes = new Map<string, DeliveryAuthority>()
const lookups = new Map<string, ReturnType<typeof lookup>>()
const keyOf = (thread: ThreadId, turn: number) => `${thread}\u0000${turn}`
const decodeThread = Schema.decodeUnknownOption(ThreadId)
const decodeTurn = Schema.decodeUnknownOption(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
)
const decodeFolder = Schema.decodeUnknownOption(
  LibraryFolderId.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu),
  ),
)

/** Scope arrives outside conversation text; malformed confinement is absent, never an invalid search filter. */
export function recordScope(
  threadId: ThreadId,
  turn: number,
  scope: DeliveryScope,
): DeliveryAuthority {
  const authority = {
    acting: { threadId, personId: scope.acting },
    folder: decodeFolder(scope.libraryFolder),
  }
  scopes.set(keyOf(threadId, turn), authority)
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
        folder: Option.none<LibraryFolderId>(),
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

/** The cached Effect shares concurrent recovery calls and remembers the server's answer across tool calls. */
export const resolveAuthority = Effect.fn('Delivery.resolve')(function* (
  thread: string,
  delivery: DeliveredMessage,
  origin: Option.Option<ThreadOrigin>,
) {
  const prepared = cachedAuthority(thread, delivery, origin)
  if (Option.isSome(prepared)) return prepared.value
  const threadId = decodeThread(thread)
  const turn = turnOf(delivery)
  if (Option.isNone(threadId) || Option.isNone(turn))
    return yield* Effect.fail(
      new NobodyToActFor({ message: 'There is no Person behind this message to act for.' }),
    )
  const key = keyOf(threadId.value, turn.value)
  let recover = lookups.get(key)
  if (recover === undefined) {
    recover = yield* Effect.cached(lookup(threadId.value, turn.value))
    lookups.set(key, recover)
  }
  return yield* recover
})

/** A new object is the Flue ingress: authority and transport keys cannot leak into history or model text. */
export function modelDelivery(delivery: RuntimeRunRequest) {
  if (Object.keys(delivery.attributes).length === 0)
    return { kind: 'user' as const, body: delivery.body }
  return {
    kind: 'signal' as const,
    type: delivery.type,
    tagName: delivery.type,
    body: delivery.body,
    attributes: delivery.attributes,
  }
}
