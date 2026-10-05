import type { Context, Draft } from '@earendil-works/chord'
import type {
  Conversation,
  ConversationDocToken,
  ConversationId,
  DocumentReader,
  Harness,
  JsonObject,
  Tx,
  AgentEvent,
  AgentEventStream,
} from '@earendil-works/pi-durable'
import { watchEvents } from '@earendil-works/pi-durable'
import { Effect, Option, Queue, Stream } from 'effect'

import { ConversationMissing, PiFailed } from './errors.ts'

/** Absence is a domain failure, distinct from rejection of Harness.conversation itself. */
export const conversation = Effect.fn('Durable.conversation')(function* (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) {
  const found = yield* Effect.tryPromise({
    try: () => harness.conversation(conversationId, context),
    catch: (cause) => new PiFailed({ operation: 'conversation', cause }),
  })
  if (found === undefined) return yield* new ConversationMissing({ conversationId })
  return found
})

/** A document genuinely may not exist yet; preserve that absence for the domain caller. */
export const snapshot = <T extends JsonObject>(
  reader: DocumentReader,
  token: ConversationDocToken<T>,
  conversationId: ConversationId,
  context: Context,
) =>
  Effect.tryPromise({
    try: () => reader.snapshot(token, conversationId, context),
    catch: (cause) => new PiFailed({ operation: 'snapshot', cause }),
  }).pipe(Effect.map(Option.fromNullishOr))

/** The transaction receives a pure document mutation; only this Pi adapter owns its Promise callback. */
export const commit = <T extends JsonObject, A>(
  owner: Pick<Conversation, 'commit'>,
  mutation: {
    readonly token: ConversationDocToken<T>
    readonly conversationId: ConversationId
    readonly change: (document: Draft<T>) => A
  },
  context: Context,
) =>
  Effect.tryPromise({
    try: () => owner.commit(changeDoc(mutation, context.abortSignal), context),
    catch: (cause) => new PiFailed({ operation: 'commit', cause }),
  })

/** Pi owns transaction reads; this narrow adapter retains their typed rejection. */
const doc = <T extends JsonObject>(
  tx: Tx,
  token: ConversationDocToken<T>,
  conversationId: ConversationId,
) =>
  Effect.tryPromise({
    try: () => tx.doc(token, conversationId),
    catch: (cause) => new PiFailed({ operation: 'doc', cause }),
  })

/** Pi awaits its transaction callback; the pure mutation runs after its document read. */
function changeDoc<T extends JsonObject, A>(
  mutation: {
    readonly token: ConversationDocToken<T>
    readonly conversationId: ConversationId
    readonly change: (document: Draft<T>) => A
  },
  signal: Context['abortSignal'],
) {
  return function change(tx: Tx) {
    return runForPi(
      doc(tx, mutation.token, mutation.conversationId).pipe(Effect.map(mutation.change)),
      signal,
    )
  }
}

/** Admission is the idempotent Pi operation; consumers select the returned submission id. */
export const submit = (
  owner: Conversation,
  input: Parameters<Conversation['submit']>[0],
  context: Context,
) =>
  Effect.tryPromise({
    try: () => owner.submit(input, context),
    catch: (cause) => new PiFailed({ operation: 'submit', cause }),
  })

/** Resolve the current registry snapshot on each read, because tools can change between turns. */
export const agent = (owner: Conversation, context: Context) =>
  Effect.tryPromise({
    try: () => owner.agent(context),
    catch: (cause) => new PiFailed({ operation: 'agent', cause }),
  })

/** Pi owns transcript selection and context assembly; callers consume its typed view. */
export const view = (owner: Conversation, context: Context) =>
  Effect.tryPromise({
    try: () => owner.context(context),
    catch: (cause) => new PiFailed({ operation: 'context', cause }),
  })

/**
 * Pi 1.0.4 only accepts Promise callbacks. Like code/worker.ts invokeTool, this single ingress
 * runs an Effect and forwards Pi's cancellation signal; every Pi callback shares this boundary.
 */
export function runForPi<A, E>(effect: Effect.Effect<A, E>, signal: Context['abortSignal']) {
  // oxlint-disable-next-line vivid/no-runpromise-in-library -- Pi's public Promise-only callback ingress forwards its abort signal into the Effect core.
  return Effect.runPromise(effect, { signal })
}

/** Attachment and snapshot are atomic in Pi's harness/events.ts watchEvents. */
const openWatch = (harness: Harness, conversationId: ConversationId, context: Context) =>
  Effect.tryPromise({
    try: () => watchEvents(harness, conversationId, context),
    catch: (cause) => new PiFailed({ operation: 'watch', cause }),
  })

/** Pi's session/observation.ts CommittedWatch.stop always resolves WatchEnd; rejection is a defect. */
const stop = (events: AgentEventStream) => Effect.promise(() => events.stop())

/** Awaiting the bounded offer is Pi's delivery backpressure, not a fire-and-forget notification. */
function batchForPi(queue: Queue.Queue<AgentEvent>) {
  return (batch: readonly AgentEvent[], context: Context) =>
    runForPi(Queue.offerAll(queue, batch).pipe(Effect.asVoid), context.abortSignal)
}

/**
 * Own one observation in the consumer's scope. Pi already limits pending delivery to 100 frames
 * (session/observation.ts MAX_PENDING_WATCH_FRAMES); this queue also bounds local event buffering.
 * Closing the queue releases an in-flight offer before stopping observation. Nothing aborts the run.
 */
export const watch = Effect.fn('Durable.watch')(function* (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) {
  const queue = yield* Queue.bounded<AgentEvent>(100)
  const events = yield* Effect.acquireRelease(
    openWatch(harness, conversationId, context),
    (opened) => Queue.shutdown(queue).pipe(Effect.andThen(stop(opened))),
  )
  yield* Effect.sync(() => events.start(batchForPi(queue)))
  return { snapshot: events.snapshot, stream: Stream.fromQueue(queue) }
})
