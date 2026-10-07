import type * as DurableErrors from './errors.ts'
import type { Context } from '@earendil-works/chord'
import type {
  AgentEvent,
  ConversationId,
  Harness,
  SnapshotEvent,
  SubmissionId,
  LiveState,
} from '@earendil-works/pi-durable'
import type { UIMessageChunk } from 'ai'
import { Data, Effect, Exit, Option, Scope, Stream } from 'effect'

import { type Desk, emptyRound, needsDesk, parked, present, type Round } from './calls.ts'
import {
  initialRunState,
  replay,
  type RunState,
  type Step,
  type Rebuilt,
  translate,
} from './chunks.ts'
import { RunMissing, type PiFailed, type WatchClosed, type WatchOverflowed } from './errors.ts'
import { readDesk, noDesk, type Reader } from './desk.ts'
import * as Pi from './pi.ts'
import { captureRun, inputReplay, selectRun, type Prefix, type ResumeInput } from './resume.ts'
import {
  inputContent,
  inputLimit,
  type PartLimit,
  type InputPart,
  type InputOptions,
} from './input.ts'

/** A retried input retains its client request id and therefore Pi's submission identity. */
export type RunInput = {
  readonly conversationId: ConversationId
  readonly content: string | readonly InputPart[]
  readonly requestId: string
  readonly options?: InputOptions
}

/** The public optional wire policy is normalized before any watch or Pi admission. */
type PreparedInput = Omit<RunInput, 'options'> & { readonly options: PartLimit }

export type WatchFailure = PiFailed | WatchClosed | WatchOverflowed

type State = {
  readonly state: RunState
  readonly round: Round
  /** Only event settlement (or the captured snapshot) permits parking on a later live allocation. */
  readonly settled: boolean
}
type Written = State & { readonly chunks: readonly UIMessageChunk[]; readonly ended: boolean }

/** Parking completes the client's step and response, leaving Pi's durable run untouched. */
export function writeStep(current: State, step: Step, settled: boolean, desk: Desk): Written {
  const shown = present(current.round, step.chunks, desk)
  const ended = settled && parked(shown.round)
  const ending: readonly UIMessageChunk[] = ended
    ? [{ type: 'finish-step' }, { type: 'finish' }]
    : []
  return {
    state: step.state,
    round: shown.round,
    settled,
    chunks: [...shown.chunks, ...ending],
    ended,
  }
}

/** Text events avoid document reads; presentation chunks alone need the desk. */
const apply = Effect.fn('Durable.streamEvent')(function* (
  reader: Reader,
  current: State,
  event: AgentEvent,
) {
  const translated = translate(current.state, event)
  const needsRefresh =
    event.type === 'message_end' &&
    (current.round.withheld.size > 0 || current.round.inputs.size > 0)
  const desk =
    needsDesk(translated.chunks) || needsRefresh
      ? yield* readDesk(
          reader,
          {
            chunks: [
              ...translated.chunks,
              ...[...current.round.withheld.values()].flat(),
              ...current.round.inputs.values(),
            ],
            live: Option.none(),
            origins: new Map(),
          },
          current.round.holds,
        )
      : noDesk
  const roundSettled =
    event.type === 'turn_start'
      ? false
      : current.settled || event.type === 'message_end' || event.type === 'tool_execution_end'
  const written = writeStep(current, translated, roundSettled, desk)
  return { ...written, ended: written.ended || event.type === 'run_end' }
})

/** Internal trusted SDK signals need no second wire decoder. */
type Signal = Data.TaggedEnum<{
  Event: { readonly event: AgentEvent }
  Live: { readonly live: Readonly<LiveState> }
}>
const Signal = Data.taggedEnum<Signal>()

/** Only withheld calls need a live-frame read; text and unrelated document changes stay silent. */
const applyLive = Effect.fn('Durable.liveFrame')(function* (
  reader: Reader,
  current: State,
  live: Readonly<LiveState>,
) {
  if (current.round.withheld.size === 0 && current.round.inputs.size === 0)
    return { ...current, chunks: [], ended: false }
  const inputs = [...[...current.round.withheld.values()].flat(), ...current.round.inputs.values()]
  const desk = yield* readDesk(
    reader,
    { chunks: inputs, live: Option.some(live), origins: new Map() },
    current.round.holds,
  )
  const written = writeStep(current, { state: current.state, chunks: [] }, current.settled, desk)
  return written
})

/** Merge independently buffered watches; presentation owns input deduplication across both channels. */
function follow(
  reader: Reader,
  events: Stream.Stream<AgentEvent, WatchFailure>,
  live: Stream.Stream<Readonly<LiveState>, PiFailed | WatchClosed>,
  initial: State,
) {
  const signals = Stream.merge(
    Stream.map(events, (event) => Signal.Event({ event })),
    Stream.map(live, (document) => Signal.Live({ live: document })),
  )
  return signals.pipe(
    Stream.mapAccumEffect(
      () => initial,
      (current, signal) =>
        Signal.$match(signal, {
          Event: ({ event }) => apply(reader, current, event),
          Live: ({ live: document }) => applyLive(reader, current, document),
        }).pipe(Effect.map((written) => [written, [written]] as const)),
    ),
    Stream.takeUntil((written) => written.ended),
    Stream.flatMap((written) => Stream.fromIterable(written.chunks)),
  )
}

/** Skip earlier busy runs until Pi starts the run containing our admitted submission. */
function matching(events: Stream.Stream<AgentEvent, WatchFailure>, submissionId: SubmissionId) {
  return events.pipe(
    Stream.dropWhile((event) => event.type !== 'run_start' || !event.inputs.includes(submissionId)),
  )
}

/**
 * Start the watch before admission, then process its buffered events after the submission id is
 * known. A consumer interruption closes observation only; it never aborts the durable run.
 */
export function streamRun(
  harness: Harness,
  input: RunInput,
  context: Context,
): Stream.Stream<UIMessageChunk, WatchFailure | Effect.Error<ReturnType<typeof prepareRun>>> {
  return Stream.unwrap(prepareRun(harness, input, context))
}

/**
 * Admit before returning a transport stream so missing conversations and submission failures reject
 * the Promise facade. The captured watch scope transfers to consumption, as in reconnection.
 */
export const prepareRun: (
  harness: Harness,
  input: RunInput,
  context: Context,
) => Effect.Effect<
  Stream.Stream<UIMessageChunk, WatchFailure>,
  | DurableErrors.ConversationMissing
  | DurableErrors.LimitInvalid
  | RunMissing
  | DurableErrors.PartTooLarge
  | DurableErrors.PartUnsupported
  | PiFailed
  | DurableErrors.TurnInvalid
> = Effect.fn('Durable.prepareRun')(function* (
  harness: Harness,
  input: RunInput,
  context: Context,
) {
  const options = yield* inputLimit(input.options === undefined ? {} : input.options)
  return yield* prepareInput(harness, { ...input, options }, context)
})

/** Already-decoded byte policy is carried explicitly throughout internal admission. */
export const prepareInput: (
  harness: Harness,
  input: PreparedInput,
  context: Context,
) => Effect.Effect<
  Stream.Stream<UIMessageChunk, WatchFailure>,
  Exclude<Effect.Error<ReturnType<typeof prepareRun>>, DurableErrors.LimitInvalid>
> = Effect.fn('Durable.prepareInput')(function* (
  harness: Harness,
  input: PreparedInput,
  context: Context,
) {
  const content = yield* inputContent(input.content, input.options)
  const scope = yield* Scope.make()
  return yield* Effect.gen(function* () {
    const conversation = yield* Pi.conversation(harness, input.conversationId, context)
    const watched = yield* Pi.watch(harness, input.conversationId, context).pipe(
      Scope.provide(scope),
    )
    const submission = yield* Pi.submit(
      conversation,
      { type: 'input', content, requestId: input.requestId },
      context,
    )
    const reader = { harness, conversation, context }
    const receipt = yield* Pi.status(submission, context)
    if (receipt.type !== 'input')
      return yield* Effect.die(new Error('Pi input admission returned a write'))
    const terminal = receipt.status === 'done' || receipt.status === 'unanswered'
    const existing =
      watched.snapshot.run !== undefined && watched.snapshot.run.inputs.includes(submission.id)
    if (terminal || existing) {
      const prefix = terminal
        ? yield* inputReplay(reader, receipt, watched.snapshot)
        : Option.getOrThrow(attachedPrefix(replay(yield* captureRun(reader, watched.snapshot))))
      const live = terminal
        ? Stream.empty
        : yield* Pi.watchLive(harness, input.conversationId, context).pipe(Scope.provide(scope))
      const stream = yield* resume(reader, watched, prefix, live)
      return stream.pipe(Stream.ensuring(Scope.close(scope, Exit.void)))
    }
    const live = yield* Pi.watchLive(harness, input.conversationId, context).pipe(
      Scope.provide(scope),
    )
    return follow(
      { harness, conversation, context },
      matching(watched.stream, submission.id),
      live,
      {
        state: initialRunState,
        round: emptyRound,
        settled: false,
      },
    ).pipe(Stream.ensuring(Scope.close(scope, Exit.void)))
  }).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))))
})

/** Replay the captured state, then either follow the same live run or finish the stored run. */
const resume = Effect.fn('Durable.resumeStream')(function* (
  reader: Reader,
  watched: Effect.Success<ReturnType<typeof Pi.watch>>,
  prefix: Prefix,
  live: Stream.Stream<Readonly<LiveState>, PiFailed | WatchClosed>,
) {
  // Presentation uses the atomic event snapshot, rather than a later live state that may have
  // already advanced a sequential slot. The live tail will admit subsequent allocations.
  const captured = watched.snapshot
  const desk = needsDesk(prefix.step.chunks)
    ? yield* readDesk(
        reader,
        { chunks: prefix.step.chunks, live: Option.some(captured), origins: prefix.origins },
        emptyRound.holds,
      )
    : noDesk
  const settled =
    watched.snapshot.generation === undefined || watched.snapshot.generation.message === undefined
  const written = writeStep(
    { state: initialRunState, round: { ...emptyRound, muted: prefix.known }, settled: false },
    prefix.step,
    settled,
    desk,
  )
  const head = Stream.fromIterable(written.chunks)
  if (written.ended) return head
  const tail = prefix.live
    ? follow(reader, watched.stream, live, written)
    : Stream.succeed<UIMessageChunk>({ type: 'finish' })
  return Stream.concat(head, tail)
})

/**
 * Reconnection must capture its snapshot before returning the Effect's result. Its one-observer
 * scope transfers to the returned Stream and closes on completion, cancellation, idle, or failure.
 * This bridges the two-phase API without closing the watch before consumption begins.
 */
function reconnect<E>(
  harness: Harness,
  conversationId: ConversationId,
  select: (snapshot: SnapshotEvent, reader: Reader) => Effect.Effect<Option.Option<Prefix>, E>,
  context: Context,
) {
  return Effect.gen(function* () {
    const scope = yield* Scope.make()
    return yield* Effect.gen(function* () {
      const conversation = yield* Pi.conversation(harness, conversationId, context)
      const watched = yield* Pi.watch(harness, conversationId, context).pipe(Scope.provide(scope))
      const prefix = yield* select(watched.snapshot, { harness, conversation, context })
      if (Option.isNone(prefix)) {
        yield* Scope.close(scope, Exit.void)
        return Option.none<Stream.Stream<UIMessageChunk, WatchFailure>>()
      }
      const live = yield* Pi.watchLive(harness, conversationId, context).pipe(Scope.provide(scope))
      const stream = yield* resume({ harness, conversation, context }, watched, prefix.value, live)
      return Option.some(stream.pipe(Stream.ensuring(Scope.close(scope, Exit.void))))
    }).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))))
  })
}

/** Idle returns None. The one-shot Stream replays the atomic snapshot; its watch is already open. */
function attachedPrefix(found: Option.Option<Rebuilt>): Option.Option<Prefix> {
  return Option.map(found, (prefix) => ({
    step: prefix,
    live: true,
    known: new Set<string>(),
    origins: prefix.origins,
  }))
}

/** Whole-run attachment owns one snapshot prefix and the subsequent live tail. */
export const attachRun: (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) => Effect.Effect<
  Option.Option<Stream.Stream<UIMessageChunk, WatchFailure>>,
  DurableErrors.ConversationMissing | PiFailed | RunMissing
> = Effect.fn('Durable.attachRun')(function* (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) {
  return yield* reconnect(
    harness,
    conversationId,
    (snapshot, reader) =>
      captureRun(reader, snapshot).pipe(Effect.map(replay), Effect.map(attachedPrefix)),
    context,
  )
})

/** A resume names an assistant entry or fails RunMissing. Its one-shot Stream has an already-open watch. */
export const continueRun: (
  harness: Harness,
  conversationId: ConversationId,
  input: ResumeInput,
  context: Context,
) => Effect.Effect<
  Stream.Stream<UIMessageChunk, WatchFailure>,
  DurableErrors.ConversationMissing | PiFailed | RunMissing
> = Effect.fn('Durable.continueRun')(function* (
  harness: Harness,
  conversationId: ConversationId,
  input: ResumeInput,
  context: Context,
) {
  return yield* continueWith(harness, conversationId, { input, intent: 'Replay' }, context)
})

/** A request without settlements may acknowledge a stored terminal message with an empty step. */
export const completeTurn: (
  harness: Harness,
  conversationId: ConversationId,
  input: ResumeInput,
  context: Context,
) => Effect.Effect<
  Stream.Stream<UIMessageChunk, WatchFailure>,
  DurableErrors.ConversationMissing | PiFailed | RunMissing
> = Effect.fn('Durable.completeTurn')(function* (
  harness: Harness,
  conversationId: ConversationId,
  input: ResumeInput,
  context: Context,
) {
  return yield* continueWith(harness, conversationId, { input, intent: 'Complete' }, context)
})

/** Share observation ownership and exact-run validation for continuation and terminal acknowledgement. */
const continueWith = Effect.fn('Durable.continueWith')(function* (
  harness: Harness,
  conversationId: ConversationId,
  selection: { readonly input: ResumeInput; readonly intent: 'Replay' | 'Complete' },
  context: Context,
) {
  const found = yield* reconnect(
    harness,
    conversationId,
    (snapshot, reader) => selectRun(reader, selection.input, snapshot, selection.intent),
    context,
  )
  if (Option.isNone(found)) return yield* new RunMissing({ conversationId })
  return found.value
})
