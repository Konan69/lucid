import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import type { InputEntry } from '@earendil-works/pi-durable'
import { VividRpcClient } from '@vivid/client-runtime'
import {
  DeliveryScope,
  ThreadId,
  type MessageAttachment,
  type RuntimeRunRequest,
  type ThreadOrigin,
} from '@vivid/contracts'
import { Cache, Data, Duration, Effect, Exit, Option, Schema } from 'effect'
import { NobodyToActFor, type Acting } from './client.ts'

/**
 * One delivery as the model is to meet it, with nothing that identifies a Person: a Person's own
 * words in a private Thread, or a signal the server delivers (a shared Thread's attributed
 * message, a Routine that came due, an approval's outcome, an answer). The shape is the one the
 * server has always built for the runtime, so its tests and this module agree on it.
 */
export type Delivered =
  | {
      readonly kind: 'user'
      readonly body: string
      readonly attachments?: ReadonlyArray<MessageAttachment>
    }
  | {
      readonly kind: 'signal'
      readonly type: string
      readonly tagName?: string
      readonly body: string
      readonly attributes?: Readonly<Record<string, string>>
    }

/**
 * What is kept of a delivery to find who it is for later: its kind, and a signal's attributes,
 * whose `turn` names the server's record of it. Words and pictures stay in the transcript only.
 */
export const Addressed = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('user') }),
  Schema.Struct({
    kind: Schema.Literal('signal'),
    attributes: Schema.Record(Schema.String, Schema.String),
  }),
])
export type Addressed = typeof Addressed.Type

/** The addressing part of a delivery; a signal without attributes has none to recover a turn from. */
export const addressed = (delivery: Delivered): Addressed =>
  delivery.kind === 'user'
    ? { kind: 'user' }
    : {
        kind: 'signal',
        attributes: delivery.attributes === undefined ? {} : { ...delivery.attributes },
      }

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
  // A plain oldest-out bound: evicted authority remains recoverable from the server's persisted
  // Run on the next tool call.
  if (scopes.size > capacity) {
    const oldest = scopes.keys().next()
    if (!oldest.done) scopes.delete(oldest.value)
  }
  return authority
}

/** Only a positive turn number can refer to a server-recorded signal delivery. */
const turnOf = (delivery: Delivered | Addressed) =>
  delivery.kind === 'signal' && delivery.attributes !== undefined
    ? decodeTurn(delivery.attributes.turn)
    : Option.none<number>()

/** What is known without asking the server: a private message's creator, or a signal recorded at admission. */
export function cachedAuthority(
  thread: string,
  delivery: Delivered | Addressed,
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
  delivery: Delivered | Addressed,
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

/** A new object is the ingress: authority and transport keys cannot leak into history or model text. */
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

/** The transcript kind of a placed signal. It is ours, so a screen draws it from its data. */
export const SIGNAL_ENTRY = 'vivid.signal'

/**
 * What a placed signal's entry carries beside its model text, for a screen to draw without
 * parsing. `key` is the sending client's own key when a client's send became this signal (a
 * message in a shared Thread); the model never reads an entry's data.
 */
export const SignalData = Schema.Struct({
  type: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
  key: Schema.optionalKey(Schema.String),
})
export interface SignalData extends Schema.Schema.Type<typeof SignalData> {}

/**
 * The transcript kind of a Person's own words when the client that sent them gave a key. Pi
 * places plain input as `pi.user`, which carries no data, and lets an input be placed as an entry
 * of another kind that does (Pi README, "Busy Conversations"); the model reads the same user
 * message either way. Words sent with no key stay `pi.user`.
 */
export const MESSAGE_ENTRY = 'vivid.message'
export const MessageData = Schema.Struct({ key: Schema.String })
export interface MessageData extends Schema.Schema.Type<typeof MessageData> {}

/** Whether an entry is a Person's own words, with or without a client's key. */
export const isPersonEntry = (kind: string) => kind === 'pi.user' || kind === MESSAGE_ENTRY

/** Whether an entry is a delivery: a Person's words, or a signal the server sent. */
export const isDeliveryEntry = (kind: string) => isPersonEntry(kind) || kind === SIGNAL_ENTRY

const escapeText = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const escapeAttribute = (value: string) => escapeText(value).replaceAll('"', '&quot;')

/** Render a signal with its type first, then its ordered attributes and escaped body.
 * Instructions describe shared messages using these tags, so the rendering is a prompt contract. */
export function signalText(signal: Extract<Delivered, { kind: 'signal' }>) {
  const tag = signal.tagName === undefined ? 'signal' : signal.tagName
  const named: ReadonlyArray<readonly [string, string]> = [
    ['type', signal.type],
    ...Object.entries(signal.attributes === undefined ? {} : signal.attributes),
  ]
  const attributes = named
    .map(([name, value]) => ` ${escapeAttribute(name)}="${escapeAttribute(value)}"`)
    .join('')
  return `<${tag}${attributes}>\n${escapeText(signal.body)}\n</${tag}>`
}

/** Place a Person's words and image bytes as user content, or a server delivery as
 * `vivid.signal` with its type, attributes and body. The model reads `signalText` for signals.
 * The sending client's key lives only in entry data and never reaches the model. */
export function placement(delivery: Delivered, clientKey: Option.Option<string>) {
  if (delivery.kind === 'signal') {
    const signal = {
      type: delivery.type,
      attributes: delivery.attributes === undefined ? {} : { ...delivery.attributes },
      body: delivery.body,
    }
    return {
      content: signalText(delivery),
      entry: Option.some<InputEntry>({
        kind: SIGNAL_ENTRY,
        data: Option.match(clientKey, {
          onNone: () => signal,
          onSome: (key) => ({ ...signal, key }),
        }),
      }),
    }
  }
  const entry = Option.map(clientKey, (key): InputEntry => ({ kind: MESSAGE_ENTRY, data: { key } }))
  const pictures = delivery.attachments === undefined ? [] : delivery.attachments
  if (pictures.length === 0) return { content: delivery.body, entry }
  const words: TextContent = { type: 'text', text: delivery.body }
  const images = pictures.map((picture): ImageContent => ({
    type: 'image',
    data: picture.data,
    mimeType: picture.mimeType,
  }))
  return { content: [words, ...images], entry }
}
