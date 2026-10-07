import type { Scope } from 'effect'
import type { Op } from '@earendil-works/chord/delta'
import type { SnapshotEvent } from '@earendil-works/pi-durable'
import type { Context, Draft } from '@earendil-works/chord'
import type {
  Conversation,
  ConversationDocToken,
  ConversationId,
  DocumentReader,
  Harness,
  JsonObject,
  LiveState,
  Tx,
  AgentEvent,
  WatchHandle,
  Submission,
  SubmissionRecord,
  SubmissionId,
  Cursor,
} from '@earendil-works/pi-durable'
import { watchEvents, LiveDoc } from '@earendil-works/pi-durable'
import { Cause, Effect, Option, Queue, Stream } from 'effect'

import { ConversationMissing, PiFailed, WatchClosed, WatchOverflowed } from './errors.ts'

/** Absence is a domain failure, distinct from rejection of Harness.conversation itself. */
export const conversation: (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) => Effect.Effect<Conversation, ConversationMissing | PiFailed> = Effect.fn(
  'Durable.conversation',
)(function* (harness: Harness, conversationId: ConversationId, context: Context) {
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

/** Settlement admission reads its live slot and hold document on Pi's serialized transaction line. */
export const commitWithLive = <T extends JsonObject, A>(
  owner: Pick<Conversation, 'commit'>,
  mutation: {
    readonly token: ConversationDocToken<T>
    readonly conversationId: ConversationId
    readonly change: (document: Draft<T>, live: Readonly<LiveState>) => A
  },
  context: Context,
) =>
  Effect.tryPromise({
    try: () => owner.commit(changeLiveDoc(mutation, context.abortSignal), context),
    catch: (cause) => new PiFailed({ operation: 'commit', cause }),
  })

/** Both document reads belong to the same commit; return only detached domain values from change. */
function changeLiveDoc<T extends JsonObject, A>(
  mutation: {
    readonly token: ConversationDocToken<T>
    readonly conversationId: ConversationId
    readonly change: (document: Draft<T>, live: Readonly<LiveState>) => A
  },
  signal: Context['abortSignal'],
) {
  return function change(tx: Tx) {
    return runForPi(
      Effect.gen(function* () {
        const live = yield* doc(tx, LiveDoc, mutation.conversationId)
        const document = yield* doc(tx, mutation.token, mutation.conversationId)
        return mutation.change(document, live)
      }),
      signal,
    )
  }
}

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
const stop = (events: Pick<WatchHandle<never>, 'stop'>) => Effect.promise(() => events.stop())

/** Never suspend Pi delivery on an HTTP reader: its bounded pending frames otherwise overflow. */
function batchForPi(queue: Queue.Queue<AgentEvent, PiFailed | WatchClosed | Cause.Done>) {
  return function deliver(batch: readonly AgentEvent[], context: Context) {
    return runForPi(
      Effect.sync(() => {
        Queue.offerAllUnsafe(queue, batch)
      }),
      context.abortSignal,
    )
  }
}

/** Pi settles closed even on cancellation; listener failures retain their watch operation context. */
const closed = (events: Pick<WatchHandle<never>, 'closed'>) => Effect.promise(() => events.closed)

/** End the queue when Pi closes observation so a consumer never waits for an event that cannot arrive. */
const finishWatch = Effect.fn('Durable.finishWatch')(function* <A>(
  events: Pick<WatchHandle<never>, 'closed'>,
  queue: Queue.Queue<A, PiFailed | WatchClosed | Cause.Done>,
  conversationId: ConversationId,
) {
  const end = yield* closed(events)
  if (end.reason === 'listener_error')
    yield* Queue.fail(queue, new PiFailed({ operation: 'watch', cause: end.error }))
  else if (end.reason === 'cancelled' || end.reason === 'session_closed')
    yield* Queue.fail(queue, new WatchClosed({ conversationId, reason: end.reason }))
  else yield* Queue.end(queue)
})

/**
 * Own one observation in the consumer's scope. Buffer independently of consumption, matching the
 * former controller.enqueue behavior. A replacement snapshot signals lost incremental frames;
 * reconnect rather than translate an incomplete history. Detaching never aborts the durable run.
 */
export const watch: (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) => Effect.Effect<
  {
    snapshot: SnapshotEvent
    stream: Stream.Stream<
      Exclude<AgentEvent, SnapshotEvent>,
      PiFailed | WatchClosed | WatchOverflowed
    >
  },
  PiFailed,
  Scope.Scope
> = Effect.fn('Durable.watch')(function* (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) {
  const queue = yield* Queue.unbounded<AgentEvent, PiFailed | WatchClosed | Cause.Done>()
  const events = yield* Effect.acquireRelease(
    openWatch(harness, conversationId, context),
    (opened) => Queue.shutdown(queue).pipe(Effect.andThen(stop(opened))),
  )
  yield* Effect.sync(() => events.start(batchForPi(queue)))
  yield* finishWatch(events, queue, conversationId).pipe(Effect.forkScoped)
  return { snapshot: events.snapshot, stream: observed(conversationId, Stream.fromQueue(queue)) }
})

/** Pi harness-events.test.ts replaces overflowed delivery with a snapshot, not incremental events. */
export function observed<E>(conversationId: ConversationId, events: Stream.Stream<AgentEvent, E>) {
  return events.pipe(
    Stream.mapEffect((event) =>
      event.type === 'snapshot'
        ? Effect.fail(new WatchOverflowed({ conversationId }))
        : Effect.succeed(event),
    ),
  )
}

/** Pi withdraws queued inputs, interrupts ordinary live work, and waits for durable settlement. */
export const abort = (owner: Conversation, context: Context) =>
  Effect.tryPromise({
    try: () => owner.abort(context),
    catch: (cause) => new PiFailed({ operation: 'abort', cause }),
  })

/** The live document carries sequential task allocations that watchEvents intentionally omits. */
export const watchLive: (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) => Effect.Effect<
  Stream.Stream<Readonly<LiveState>, PiFailed | WatchClosed>,
  PiFailed,
  Scope.Scope
> = Effect.fn('Durable.watchLive')(function* (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) {
  const queue = yield* Queue.unbounded<Readonly<LiveState>, PiFailed | WatchClosed | Cause.Done>()
  const document = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => harness.watchDoc(LiveDoc, conversationId, context),
      catch: (cause) => new PiFailed({ operation: 'watch', cause }),
    }),
    (opened) =>
      Queue.shutdown(queue).pipe(Effect.andThen(opened === undefined ? Effect.void : stop(opened))),
  )
  // Admission opens this watch after submit creates LiveDoc; an idle reconnect needs no live tail.
  if (document === undefined) return Stream.empty
  yield* Effect.sync(() => document.start(liveForPi(queue)))
  yield* finishWatch(document, queue, conversationId).pipe(Effect.forkScoped)
  return document.value === null
    ? Stream.fromQueue(queue)
    : Stream.concat(Stream.succeed(document.value), Stream.fromQueue(queue))
})

/** Non-suspending delivery keeps Pi's pending frame limit independent of the HTTP reader. */
function liveForPi(queue: Queue.Queue<Readonly<LiveState>, PiFailed | WatchClosed | Cause.Done>) {
  return function deliverLive(
    live: Readonly<LiveState> | null,
    _ops: readonly Op[],
    context: Context,
  ) {
    return runForPi(
      Effect.sync(() => {
        if (live !== null) Queue.offerUnsafe(queue, live)
      }),
      context.abortSignal,
    )
  }
}

/** Raw fork-aware pages retain person history even when model context was compacted or edited. */
export const entries = (
  owner: Conversation,
  page: {
    readonly query: Parameters<Conversation['entries']>[0]
    readonly limit: number
    readonly cursor: Option.Option<Cursor>
  },
  context: Context,
) =>
  Effect.tryPromise({
    try: () => owner.entries(page.query, page.limit, Option.getOrUndefined(page.cursor), context),
    catch: (cause) => new PiFailed({ operation: 'entries', cause }),
  })

/** Known live-run inputs and admitted late answers have public submission handles; no scan is needed. */
export const submission = (harness: Harness, id: SubmissionId, context: Context) =>
  Effect.tryPromise({
    try: () => harness.submission(id, context),
    catch: (cause) => new PiFailed({ operation: 'submission', cause }),
  }).pipe(Effect.map(Option.fromNullishOr))

/** Placement is the durable receipt that a submitted input reached the transcript. */
export const status = (input: Submission, context: Context) =>
  Effect.tryPromise({
    try: () => input.status(context),
    catch: (cause) => new PiFailed({ operation: 'status', cause }),
  })

/** Conversation.submit admits only inputs, but Pi's generic handle also types write receipts. Narrow
 * at this SDK read boundary; an incompatible receipt is a Pi status-contract failure, not a defect. */
export const inputStatus: (
  input: Submission,
  context: Context,
) => Effect.Effect<Extract<SubmissionRecord, { type: 'input' }>, PiFailed> = (input, context) =>
  Effect.tryPromise({
    try: () => input.status(context),
    catch: (cause) => new PiFailed({ operation: 'status', cause }),
  }).pipe(
    Effect.flatMap((record) =>
      record.type === 'input'
        ? Effect.succeed(record)
        : Effect.fail(
            new PiFailed({
              operation: 'status',
              cause: new Error('Input admission returned a write receipt'),
            }),
          ),
    ),
  )

/** Exact host request lookup uses Pi's public transaction surface (types.d.ts:677), not a Storage
 * dependency or scan. The read-only commit returns the authoritative immutable receipt. */
export const request: (
  owner: Conversation,
  requestId: string,
  context: Context,
) => Effect.Effect<Option.Option<SubmissionRecord>, PiFailed> = Effect.fn('Durable.request')(
  function* (owner, requestId, context) {
    return yield* Effect.tryPromise({
      try: () => owner.commit(requestForPi(owner.id, requestId, context.abortSignal), context),
      catch: (cause) => new PiFailed({ operation: 'commit', cause }),
    }).pipe(Effect.map(Option.fromNullishOr))
  },
)

/** The Promise-only transaction callback delegates exactly one typed Pi receipt lookup. */
function requestForPi(
  conversationId: ConversationId,
  requestId: string,
  signal: Context['abortSignal'],
) {
  return function readRequest(tx: Tx) {
    return runForPi(
      Effect.tryPromise({
        try: () => tx.submissionByRequest(conversationId, requestId),
        catch: (cause) => new PiFailed({ operation: 'submission', cause }),
      }),
      signal,
    )
  }
}
