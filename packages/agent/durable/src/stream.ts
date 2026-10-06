import type { Context } from '@earendil-works/chord'
import type {
  AgentEvent,
  Conversation,
  ConversationId,
  Harness,
  SnapshotEvent,
  SubmissionId,
} from '@earendil-works/pi-durable'
import { LiveDoc } from '@earendil-works/pi-durable'
import type { UIMessageChunk } from 'ai'
import { Effect, Exit, Option, Scope, Stream } from 'effect'

import { type Desk, emptyRound, needsDesk, parked, present, type Round } from './calls.ts'
import {
  initialRunState,
  replay,
  replayAfter,
  type RunState,
  type Step,
  translate,
} from './chunks.ts'
import { RunMissing, type PiFailed, type WatchClosed, type WatchOverflowed } from './errors.ts'
import { CallIdentity, CallLookup, identitiesFor, lookupSnapshots, Holds, planOf } from './holds.ts'
import * as Pi from './pi.ts'

/** A retried input retains its client request id and therefore Pi's submission identity. */
export type RunInput = {
  readonly conversationId: ConversationId
  readonly content: string
  readonly requestId: string
}

const noDesk: Desk = {
  plan: () => Option.none(),
  call: () => CallLookup.cases.Missing.make({}),
  hold: () => CallLookup.cases.Missing.make({}),
}

type WatchFailure = PiFailed | WatchClosed | WatchOverflowed

type Reader = {
  readonly harness: Harness
  readonly conversation: Conversation
  readonly context: Context
}
type State = { readonly state: RunState; readonly round: Round }
type Written = State & { readonly chunks: readonly UIMessageChunk[]; readonly ended: boolean }

/** Resolve tool plans at the point of presentation, since the registry can change between turns. */
const readDesk = Effect.fn('Durable.readDesk')(function* (
  reader: Reader,
  chunks: Step['chunks'],
  shownHolds: Round['holds'],
) {
  const agent = yield* Pi.agent(reader.conversation, reader.context)
  const plans = new Map(
    agent.tools.flatMap((tool) => {
      const plan = planOf(tool)
      return Option.isNone(plan) ? [] : [[tool.name, plan.value] as const]
    }),
  )
  const holds = yield* Pi.snapshot(reader.harness, Holds, reader.conversation.id, reader.context)
  const live = yield* Pi.snapshot(reader.harness, LiveDoc, reader.conversation.id, reader.context)
  const callIds = new Set(
    chunks.flatMap((chunk) => ('toolCallId' in chunk ? [chunk.toolCallId] : [])),
  )
  // A slot, an in-flight generation call, or the hold previously shown to this reader can
  // answer without a transcript scan. Only a truly missing completed call needs provenance.
  const calls = new Map(
    [...callIds].map((callId) => {
      const identity = CallIdentity.cases.Public.make({
        callId,
        resultTask: Option.none(),
        duplicate: false,
      })
      const direct = lookupSnapshots(live, holds, identity)
      const shownHold = shownHolds.get(callId)
      const found =
        CallLookup.guards.Missing(direct) && shownHold !== undefined
          ? lookupSnapshots(live, holds, CallIdentity.cases.Hold.make({ holdId: shownHold }))
          : direct
      return [callId, found] as const
    }),
  )
  const unresolved = [...calls].flatMap(([id, found]) =>
    CallLookup.guards.Missing(found) ? [id] : [],
  )
  if (unresolved.length > 0) {
    const identities = identitiesFor((yield* Pi.view(reader.conversation, reader.context)).entries)
    for (const callId of unresolved) {
      const identity = identities.get(callId)
      if (identity !== undefined) calls.set(callId, lookupSnapshots(live, holds, identity))
    }
  }
  return {
    plan: (toolName: string) => Option.fromNullishOr(plans.get(toolName)),
    call: (callId: string) => calls.get(callId) ?? CallLookup.cases.Missing.make({}),
    hold: (holdId: import('./errors.ts').HoldId) =>
      lookupSnapshots(live, holds, CallIdentity.cases.Hold.make({ holdId })),
  } satisfies Desk
})

/** Parking completes the client's step and response, leaving Pi's durable run untouched. */
function writeStep(current: State, step: Step, settled: boolean, desk: Desk): Written {
  const shown = present(current.round, step.chunks, desk)
  const ended = settled && parked(shown.round)
  const ending: readonly UIMessageChunk[] = ended
    ? [{ type: 'finish-step' }, { type: 'finish' }]
    : []
  return { state: step.state, round: shown.round, chunks: [...shown.chunks, ...ending], ended }
}

/** Text events avoid document reads; presentation chunks alone need the desk. */
const apply = Effect.fn('Durable.streamEvent')(function* (
  reader: Reader,
  current: State,
  event: AgentEvent,
) {
  const translated = translate(current.state, event)
  const needsRefresh = event.type === 'message_end' && current.round.unrequested.size > 0
  const desk =
    needsDesk(translated.chunks) || needsRefresh
      ? yield* readDesk(
          reader,
          [...translated.chunks, ...current.round.unrequested.values()],
          current.round.holds,
        )
      : noDesk
  const roundSettled = event.type === 'message_end' || event.type === 'tool_execution_end'
  const written = writeStep(current, translated, roundSettled, desk)
  return { ...written, ended: written.ended || event.type === 'run_end' }
})

/** Accumulate translator and tool-round state, including the terminal event's chunks before stopping. */
function follow(reader: Reader, events: Stream.Stream<AgentEvent, WatchFailure>, initial: State) {
  return events.pipe(
    Stream.mapAccumEffect(
      () => initial,
      (current, event) =>
        apply(reader, current, event).pipe(Effect.map((written) => [written, [written]] as const)),
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
export function streamRun(harness: Harness, input: RunInput, context: Context) {
  return Stream.unwrap(prepareRun(harness, input, context))
}

/**
 * Admit before returning a transport stream so missing conversations and submission failures reject
 * the Promise facade. The captured watch scope transfers to consumption, as in reconnection.
 */
export const prepareRun = Effect.fn('Durable.prepareRun')(function* (
  harness: Harness,
  input: RunInput,
  context: Context,
) {
  const scope = yield* Scope.make()
  return yield* Effect.gen(function* () {
    const conversation = yield* Pi.conversation(harness, input.conversationId, context)
    const watched = yield* Pi.watch(harness, input.conversationId, context).pipe(
      Scope.provide(scope),
    )
    const submission = yield* Pi.submit(
      conversation,
      { type: 'input', content: input.content, requestId: input.requestId },
      context,
    )
    return follow({ harness, conversation, context }, matching(watched.stream, submission.id), {
      state: initialRunState,
      round: emptyRound,
    }).pipe(Stream.ensuring(Scope.close(scope, Exit.void)))
  }).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))))
})

type Prefix = { readonly step: Step; readonly live: boolean }

/** Replay the captured state, then either follow the same live run or finish the stored run. */
const resume = Effect.fn('Durable.resumeStream')(function* (
  reader: Reader,
  watched: Effect.Success<ReturnType<typeof Pi.watch>>,
  prefix: Prefix,
) {
  const desk = needsDesk(prefix.step.chunks)
    ? yield* readDesk(reader, prefix.step.chunks, emptyRound.holds)
    : noDesk
  const settled =
    watched.snapshot.generation === undefined || watched.snapshot.generation.message === undefined
  const written = writeStep(
    { state: initialRunState, round: emptyRound },
    prefix.step,
    settled,
    desk,
  )
  const head = Stream.fromIterable(written.chunks)
  if (written.ended) return head
  const tail = prefix.live
    ? follow(reader, watched.stream, written)
    : Stream.succeed<UIMessageChunk>({ type: 'finish' })
  return Stream.concat(head, tail)
})

/**
 * Reconnection must capture its snapshot before returning the Effect's result. Its one-observer
 * scope transfers to the returned Stream and closes on completion, cancellation, idle, or failure.
 * This bridges the two-phase API without closing the watch before consumption begins.
 */
const reconnect = Effect.fn('Durable.reconnect')(function* (
  harness: Harness,
  conversationId: ConversationId,
  select: (snapshot: SnapshotEvent) => Effect.Effect<Option.Option<Prefix>, RunMissing>,
  context: Context,
) {
  const scope = yield* Scope.make()
  return yield* Effect.gen(function* () {
    const conversation = yield* Pi.conversation(harness, conversationId, context)
    const watched = yield* Pi.watch(harness, conversationId, context).pipe(Scope.provide(scope))
    const prefix = yield* select(watched.snapshot)
    if (Option.isNone(prefix)) {
      yield* Scope.close(scope, Exit.void)
      return Option.none<Stream.Stream<UIMessageChunk, WatchFailure>>()
    }
    const stream = yield* resume({ harness, conversation, context }, watched, prefix.value)
    return Option.some(stream.pipe(Stream.ensuring(Scope.close(scope, Exit.void))))
  }).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))))
})

/** Idle returns None. The one-shot Stream replays the atomic snapshot; its watch is already open. */
export const attachRun = Effect.fn('Durable.attachRun')(function* (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) {
  return yield* reconnect(
    harness,
    conversationId,
    (snapshot) =>
      Effect.succeed(replay(snapshot).pipe(Option.map((prefix) => ({ step: prefix, live: true })))),
    context,
  )
})

/** A resume names an assistant entry or fails RunMissing. Its one-shot Stream has an already-open watch. */
export const continueRun = Effect.fn('Durable.continueRun')(function* (
  harness: Harness,
  conversationId: ConversationId,
  known: ReadonlySet<string>,
  context: Context,
) {
  const found = yield* reconnect(
    harness,
    conversationId,
    (snapshot) => {
      const prefix = replayAfter(snapshot, known)
      return Option.isSome(prefix)
        ? Effect.succeed(prefix)
        : Effect.fail(new RunMissing({ conversationId }))
    },
    context,
  )
  // The selector cannot return None: retaining that invariant here keeps the shared idle path honest.
  if (Option.isNone(found)) return yield* new RunMissing({ conversationId })
  return found.value
})
