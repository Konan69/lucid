import { BACKGROUND_CONTEXT, type Context as PiContext } from '@earendil-works/chord/context'
import {
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  UsageDoc,
  type ConversationId,
  type Extension,
  type Harness,
  type RunningTask,
  type Task,
  type TaskId,
  type TaskRuntime,
  type Submission,
  type ToolRegistration,
  type Tx,
} from '@earendil-works/pi-durable'
import {
  ChildEnding,
  ChildFailure,
  ChildReport,
  ChildUsage,
  RuntimeChildAnswer,
  RuntimeChildMessaged,
  RuntimeSettlement,
  WorkerKind,
  type ChildRun,
  type RuntimeChildMessage,
  type PersonId,
  type RunId,
  type ThreadId,
} from '@vivid/contracts'
import { Clock, Duration, Effect, Option, Schedule, Schema } from 'effect'
import { workerExtensions, workerInstructions } from './agents/worker.ts'
import { asActing, type Acting, type ProductService } from './client.ts'
import { HELPER_KEY, HelperAuthority, HelperCalls, helperOf } from './helper.ts'
import { settlement } from './response.ts'
import { conversationOf, pi, PiRejected } from './threads.ts'

/**
 * What the Thread's conversation keeps about one helper: the background task that owns its
 * work, its own conversation once created, its number in the Thread, and who claimed its result.
 * `claim` is `wait` when the parent asked for the result (`wait_runs`) and `wake` when the result
 * is delivered to the Thread instead, so the parent hears it once.
 */
interface Kept {
  [key: string]: TaskId | ConversationId | number | string | null
  anchor: TaskId
  number: number
  child: ConversationId | null
  claim: 'wait' | 'wake' | null
}

/**
 * Every helper of a Thread, in the Thread's conversation: by product id, and by number, the only
 * name the model has for one. It is written in the commit that starts a helper's task, so a
 * repeated tool call finds the helper instead of starting another.
 */
export const HelperIndex = defineDoc<{
  helpers: Record<string, Kept>
  byNumber: Record<string, RunId>
}>({
  kind: 'vivid.helpers',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ helpers: {}, byNumber: {} }),
})

/**
 * A helper's latest round after its first (`ChildTurn` in `@vivid/contracts`): its number, the
 * follow-up task carrying it, and who claimed its result, as `Kept.claim` does for the first.
 */
interface Round {
  [key: string]: TaskId | number | string | null
  round: number
  task: TaskId
  claim: 'wait' | 'wake' | null
}

/**
 * The helpers of a Thread that took a follow-up, in the Thread's conversation, by product id. A
 * document of its own beside `HelperIndex`, so a Thread whose index was written before helpers
 * took follow-ups reads none. Written in the commit that starts a round's task, so the same round
 * asked for again starts nothing.
 */
export const HelperRounds = defineDoc<{ rounds: Record<string, Round> }>({
  kind: 'vivid.helper.rounds',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ rounds: {} }),
})

/**
 * How a helper's work ended, as its task's result: its answer, or why it has none. A stop is
 * not here; it is the task's `aborted` outcome.
 */
const Answer = Schema.TaggedUnion({
  Completed: { text: Schema.String },
  Failed: { failure: ChildFailure },
})
type Answer = typeof Answer.Type
const AnswerJson = Schema.toCodecJson(Answer)
const encodeAnswer = Schema.encodeEffect(AnswerJson)
const decodeAnswer = Schema.decodeUnknownEffect(AnswerJson)

/** The task's input: everything it needs, fixed when the parent's tool call reserved it. */
interface Input {
  readonly runId: RunId
  readonly number: number
  readonly kind: WorkerKind
  readonly brief: string
  readonly seconds: number
  readonly toolCalls: number
  readonly threadId: ThreadId
  readonly personId: PersonId
  readonly timezone: string
  readonly at: number
}
type Step =
  | { readonly phase: 'open' }
  | { readonly phase: 'work'; readonly child: ConversationId; readonly startedAt: number }
  | { readonly phase: 'report'; readonly answer: Schema.Json }
type Runtime = TaskRuntime<Input, Step, Schema.Json, object>

/**
 * A later round's input, fixed when the server handed it over: the words for the helper, its
 * conversation, and the deadline's start and length. The helper's tool budget is raised in the
 * same commit that creates the task.
 */
interface FollowInput {
  readonly runId: RunId
  readonly round: number
  readonly content: string
  readonly child: ConversationId
  readonly seconds: number
  readonly threadId: ThreadId
  readonly personId: PersonId
  readonly at: number
}
type FollowStep =
  | { readonly phase: 'deliver' }
  | { readonly phase: 'report'; readonly answer: Schema.Json }
type FollowRuntime = TaskRuntime<FollowInput, FollowStep, Schema.Json, object>
type FollowAt<P extends FollowStep['phase']> = RunningTask<
  FollowInput,
  Extract<FollowStep, { phase: P }>,
  Schema.Json
>
type RecordAt<P extends Step['phase']> = RunningTask<
  Input,
  Extract<Step, { phase: P }>,
  Schema.Json
>

/** A helper's task broke in a way it has no name for. Content-free at the logging boundary. */
class HelperFailed extends Schema.TaggedError<HelperFailed>()(
  'HelperFailed',
  {},
  { title: 'Helper failed' },
) {}

/** The request id of a helper's one input: its product id, so a rerun finds the same submission. */
const requestOf = (runId: RunId) => `helper:${runId}`

/** Reports keep trying until the server answers; only a refusal of the helper itself is final. */
const FINAL: ReadonlySet<string> = new Set(['NotFound', 'Forbidden', 'NobodyToActFor'])
const REPORT_RETRY = Schedule.min([Schedule.exponential('1 second'), Schedule.spaced('30 seconds')])

const zero = ChildUsage.make({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
})

/** Sum every model bucket of the helper's own `pi.usage`. Failed and aborted attempts count. */
const usageOf = Effect.fn('Helpers.usage')(function* (
  harness: Harness,
  child: Option.Option<ConversationId>,
) {
  if (Option.isNone(child)) return zero
  const usage = yield* pi(() => harness.snapshot(UsageDoc, child.value, BACKGROUND_CONTEXT))
  if (usage === undefined) return zero
  return Object.values(usage.models).reduce(
    (total, bucket) =>
      ChildUsage.make({
        input: total.input + bucket.input,
        output: total.output + bucket.output,
        cacheRead: total.cacheRead + bucket.cacheRead,
        cacheWrite: total.cacheWrite + bucket.cacheWrite,
        totalTokens: total.totalTokens + bucket.totalTokens,
        cost: total.cost + bucket.cost.total,
      }),
    zero,
  )
})

/** A helper's later round, if it took a follow-up, read outside a commit. */
const latestOf = Effect.fn('Helpers.latest')(function* (
  harness: Harness,
  conversationId: ConversationId,
  runId: RunId,
) {
  const rounds = yield* pi(() =>
    harness.snapshot(HelperRounds, conversationId, BACKGROUND_CONTEXT),
  )
  return Option.fromUndefinedOr(rounds === undefined ? undefined : rounds.rounds[runId])
})

/** What the Thread keeps about one helper: its record, and its latest round after the first. */
interface Found {
  readonly kept: Kept
  readonly latest: Option.Option<Round>
}

/** The task carrying a helper's current or last round. */
const currentTask = (found: Found) =>
  Option.match(found.latest, { onNone: () => found.kept.anchor, onSome: (round) => round.task })

/** The Thread's record of one helper, found by its product id. */
const foundOf = Effect.fn('Helpers.found')(function* (
  harness: Harness,
  threadId: ThreadId,
  runId: RunId,
) {
  const conversation = yield* conversationOf(harness, threadId)
  if (Option.isNone(conversation)) return Option.none<Found>()
  const index = yield* pi(() =>
    harness.snapshot(HelperIndex, conversation.value.id, BACKGROUND_CONTEXT),
  )
  const kept = index === undefined ? undefined : index.helpers[runId]
  if (kept === undefined) return Option.none<Found>()
  const latest = yield* latestOf(harness, conversation.value.id, runId)
  return Option.some<Found>({ kept, latest })
})

/** The task's terminal answer: none while it works; `Some(None)` when it was aborted. */
const settledAnswer = Effect.fn('Helpers.settledAnswer')(function* (
  harness: Harness,
  anchor: TaskId,
) {
  const task = yield* pi(() => harness.getTask(anchor, BACKGROUND_CONTEXT))
  if (task === undefined || task.state.status !== 'terminal') return Option.none()
  const outcome = task.state.outcome
  if (outcome.status === 'aborted') return Option.some(Option.none<Answer>())
  if (outcome.status !== 'completed')
    return Option.some(
      Option.some(Answer.cases.Failed.make({ failure: ChildFailure.cases.RuntimeFault.make({}) })),
    )
  const answer = yield* decodeAnswer(outcome.result).pipe(
    Effect.mapError((cause) => new PiRejected({ cause })),
  )
  return Option.some(Option.some(answer))
})

/** One helper's ending as the server reads it, with the spend its conversation measured. */
const answered = (answer: Option.Option<Answer>, usage: ChildUsage): RuntimeChildAnswer =>
  Option.match(answer, {
    onNone: () => RuntimeChildAnswer.cases.Aborted.make({ usage }),
    onSome: Answer.match({
      Completed: ({ text }): RuntimeChildAnswer =>
        RuntimeChildAnswer.cases.Completed.make({ text, usage }),
      Failed: ({ failure }): RuntimeChildAnswer =>
        RuntimeChildAnswer.cases.Failed.make({ failure, usage }),
    }),
  })

/**
 * How one helper stands, for the server's `GET .../children/:runId`. A helper the runtime never
 * started work for is `Absent`: a stop before its first step leaves that.
 */
export const answerOf: (
  harness: Harness,
  threadId: ThreadId,
  runId: RunId,
) => Effect.Effect<RuntimeChildAnswer, PiRejected> = Effect.fn('Helpers.answer')(function* (
  harness: Harness,
  threadId: ThreadId,
  runId: RunId,
) {
  const found = yield* foundOf(harness, threadId, runId)
  if (Option.isNone(found)) return RuntimeChildAnswer.cases.Absent.make({})
  const ended = yield* settledAnswer(harness, currentTask(found.value))
  if (Option.isNone(ended)) return RuntimeChildAnswer.cases.Running.make({})
  return answered(ended.value, yield* usageOf(harness, Option.fromNullOr(found.value.kept.child)))
})

/**
 * Aborts one helper's work for the server's `POST .../children/:runId/abort`, and answers once it
 * ended. Pi aborts bottom-up: the helper's conversation first, then its task's own abort. After a
 * follow-up the first round's task may have ended while the conversation it owns works on, so the
 * round's task, the first task and the conversation are each aborted.
 */
export const abortHelper: (
  harness: Harness,
  threadId: ThreadId,
  runId: RunId,
) => Effect.Effect<boolean, PiRejected> = Effect.fn('Helpers.abort')(function* (
  harness: Harness,
  threadId: ThreadId,
  runId: RunId,
) {
  const found = yield* foundOf(harness, threadId, runId)
  if (Option.isNone(found)) return false
  const { kept, latest } = found.value
  const task = currentTask(found.value)
  const marked = yield* pi(() => harness.abortTask(task, BACKGROUND_CONTEXT))
  if (Option.isSome(latest)) {
    yield* pi(() => harness.abortTask(kept.anchor, BACKGROUND_CONTEXT))
    const child = kept.child
    if (child !== null) {
      const conversation = yield* pi(() => harness.conversation(child, BACKGROUND_CONTEXT))
      if (conversation !== undefined) yield* pi(() => conversation.abort(BACKGROUND_CONTEXT))
    }
  }
  yield* pi(() => harness.waitForTask(task, BACKGROUND_CONTEXT))
  return marked === 'marked'
})

/** What a settled submission of the helper's conversation says about its work. */
const answerFrom = (settled: RuntimeSettlement): Answer =>
  RuntimeSettlement.match(settled, {
    Done: ({ reply }): Answer => Answer.cases.Completed.make({ text: reply }),
    Failed: ({ failure }): Answer =>
      Answer.cases.Failed.make({ failure: ChildFailure.cases.Model.make({ reason: failure }) }),
    // The helper's task was not aborted (that interrupts this step), so something else stopped it.
    Stopped: (): Answer =>
      Answer.cases.Failed.make({ failure: ChildFailure.cases.RuntimeFault.make({}) }),
  })

const endingOf = (answer: Answer): ChildEnding =>
  Answer.match(answer, {
    Completed: (): ChildEnding => ChildEnding.cases.Completed.make({}),
    Failed: ({ failure }): ChildEnding => ChildEnding.cases.Failed.make({ failure }),
  })

/** The round a helper's later rounds have reached: one until it takes a follow-up. */
const latestRound = (harness: Harness, conversationId: ConversationId, runId: RunId) =>
  latestOf(harness, conversationId, runId).pipe(
    Effect.map(Option.match({ onNone: () => 1, onSome: (latest) => latest.round })),
  )

/**
 * Waits for one round's answer until its deadline. Past it the helper's conversation is stopped
 * and the answer is `DeadlinePassed`, unless a later round already took that conversation over:
 * that round's work and deadline are its own, and this round's ending is no longer heard.
 */
const answerWithin = Effect.fn('Helpers.answerWithin')(function* (
  harness: Harness,
  submission: Submission,
  round: {
    readonly thread: ConversationId
    readonly runId: RunId
    readonly round: number
    readonly deadline: number
    readonly stop: Effect.Effect<void, PiRejected>
  },
) {
  const now = yield* Clock.currentTimeMillis
  const settled = yield* settlement(harness, submission).pipe(
    Effect.timeoutOption(Duration.millis(Math.max(0, round.deadline - now))),
  )
  if (Option.isSome(settled)) return answerFrom(settled.value)
  if ((yield* latestRound(harness, round.thread, round.runId)) === round.round) yield* round.stop
  return Answer.cases.Failed.make({ failure: ChildFailure.cases.DeadlinePassed.make({}) })
})

/**
 * What a later round puts in the helper's conversation. Vivid's own words go as they are, as its
 * brief did; a Person's say whose they are, since the helper otherwise hears only from Vivid.
 */
const contentOf = (message: RuntimeChildMessage) =>
  message.by === 'Person'
    ? `The person you are working for sends this follow-up:\n\n${message.message}`
    : message.message

export type RunHelpers = <A, E>(program: Effect.Effect<A, E>, signal: AbortSignal) => Promise<A>

interface Wiring {
  readonly harness: Effect.Effect<Harness>
  readonly product: ProductService
  readonly worker: (kind: WorkerKind) => Extension
}

/** Who reports on which helper: both of a helper's tasks carry these. */
type Reporting = Pick<Input, 'runId' | 'threadId' | 'personId'>

/** Reports one step of a helper to the server as Vivid for its Person, until it is heard. */
const report = (product: ProductService, input: Reporting, body: ChildReport) =>
  Effect.gen(function* () {
    const acting: Acting = { threadId: input.threadId, personId: input.personId }
    return yield* asActing(product, Option.some(acting), (client) =>
      client.SettleChildRun({ id: input.runId, report: body }),
    )
  }).pipe(
    Effect.retry({ while: (error) => !FINAL.has(error._tag), schedule: REPORT_RETRY }),
    Effect.catch((error) =>
      Effect.logWarning('A helper report was refused', { reason: error._tag }),
    ),
    Effect.asVoid,
  )

/**
 * Step one, as one commit: the helper's own conversation, owned by this task, with only its
 * kind's tools and its frozen instruction, and the authority and budget its tools act under. Pi
 * copies the Thread conversation's model into it; nothing in the model's arguments chooses one.
 */
const open = (wiring: Wiring) =>
  Effect.fn('Helpers.open')(function* (
    record: RecordAt<'open'>,
    runtime: Runtime,
    context: PiContext,
  ) {
    const { input } = record
    const now = yield* Clock.currentTimeMillis
    const worker = wiring.worker(input.kind)
    yield* pi(() =>
      // @effect-diagnostics-next-line asyncFunction:off -- Pi owns the atomic child-creation callback.
      runtime.commit(async (tx: Tx) => {
        const child = await tx.createConversation({
          ownership: { kind: 'task', taskId: record.id },
        })
        await configure(tx, child.id, {
          extensions: [worker],
          tools: worker.tools,
          instructions: workerInstructions(input.kind, input.timezone, input.at),
        })
        await tx.doc(HelperAuthority, child.id, HELPER_KEY, {
          threadId: input.threadId,
          personId: input.personId,
          runId: input.runId,
          timezone: input.timezone,
        })
        const calls = await tx.doc(HelperCalls, child.id)
        calls.limit = input.toolCalls
        const index = await tx.doc(HelperIndex, runtime.conversationId)
        const kept = index.helpers[input.runId]
        if (kept !== undefined) kept.child = child.id
        return { status: 'running', checkpoint: { phase: 'work', child: child.id, startedAt: now } }
      }, context),
    )
  })

/**
 * Step two: submit the brief once (a rerun finds the same submission by its request id), tell the
 * server the work started, and wait for its answer until the budget's deadline. Past it the
 * helper's conversation is aborted and the answer is `DeadlinePassed`.
 */
const work = (wiring: Wiring) =>
  Effect.fn('Helpers.work')(function* (
    record: RecordAt<'work'>,
    runtime: Runtime,
    context: PiContext,
  ) {
    const { input } = record
    const { child: childId, startedAt } = record.state.checkpoint
    const harness = yield* wiring.harness
    const child = yield* pi(() => runtime.conversation(childId, context)).pipe(
      Effect.filterOrFail(
        (found) => found !== undefined,
        () => new HelperFailed(),
      ),
    )
    const submission = yield* pi(() =>
      child.submit(
        { type: 'input', content: input.brief, requestId: requestOf(input.runId) },
        context,
      ),
    )
    yield* report(
      wiring.product,
      input,
      ChildReport.cases.Started.make({
        receipt: { conversation: childId, submission: submission.id },
      }),
    )
    const answer = yield* answerWithin(harness, submission, {
      thread: runtime.conversationId,
      runId: input.runId,
      round: 1,
      deadline: startedAt + input.seconds * 1000,
      stop: pi(() => child.abort(context)),
    })
    const encoded = yield* encodeAnswer(answer).pipe(Effect.mapError(() => new HelperFailed()))
    yield* pi(() =>
      runtime.commit(
        () => ({ status: 'running', checkpoint: { phase: 'report', answer: encoded } }),
        context,
      ),
    )
  })

/**
 * Claims one round's result for a delivery unless the parent claimed it by waiting. One commit
 * decides. A round a later follow-up replaced claims nothing: the server hears only the latest.
 */
const claimWake = (
  runtime: Runtime | FollowRuntime,
  runId: RunId,
  round: number,
  context: PiContext,
) => {
  // The commit callback is the only place the claim can be read and written atomically.
  let wake = false
  return pi(() =>
    // @effect-diagnostics-next-line asyncFunction:off -- Pi owns the atomic claim.
    runtime.commit(async (tx) => {
      const later = (await tx.doc(HelperRounds, runtime.conversationId)).rounds[runId]
      if (later !== undefined) {
        if (later.round === round && later.claim === null) later.claim = 'wake'
        wake = later.round === round && later.claim === 'wake'
        return undefined
      }
      const kept = (await tx.doc(HelperIndex, runtime.conversationId)).helpers[runId]
      if (kept !== undefined && kept.claim === null) kept.claim = 'wake'
      wake = round === 1 && (kept === undefined || kept.claim === 'wake')
      return undefined
    }, context),
  ).pipe(Effect.map(() => wake))
}

/**
 * The last step of either task: tell the server how this round ended, and whether the Thread still
 * has to hear it, then end with the answer as the task's result.
 */
const finish = (wiring: Wiring) =>
  Effect.fn('Helpers.finish')(function* (
    runtime: Runtime | FollowRuntime,
    reporting: Reporting,
    round: number,
    encoded: Schema.Json,
    context: PiContext,
  ) {
    const answer = yield* decodeAnswer(encoded).pipe(Effect.mapError(() => new HelperFailed()))
    const wake = yield* claimWake(runtime, reporting.runId, round, context)
    yield* report(
      wiring.product,
      reporting,
      ChildReport.cases.Ended.make({ ending: endingOf(answer), wake, round }),
    )
    yield* pi(() =>
      runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: encoded } }),
        context,
      ),
    )
  })

/** Moves a broken helper on to its report step with a `RuntimeFault` answer. */
const reportFault = Effect.fn('Helpers.reportFault')(
  function* (runtime: Runtime | FollowRuntime, context: PiContext) {
    yield* Effect.logWarning('HelperFailed')
    const answer = yield* encodeAnswer(
      Answer.cases.Failed.make({ failure: ChildFailure.cases.RuntimeFault.make({}) }),
    )
    yield* pi(() =>
      runtime.commit(
        () => ({ status: 'running', checkpoint: { phase: 'report', answer } }),
        context,
      ),
    )
  },
  (effect) => Effect.ignore(effect),
)

/**
 * A step that broke goes on to report a fault, so the server never keeps a helper working that
 * the runtime gave up on. A stopped invocation cannot commit, so Pi resumes its old step instead.
 */
const faulted =
  (runtime: Runtime | FollowRuntime, context: PiContext) =>
  <A, E>(program: Effect.Effect<A, E>) =>
    program.pipe(Effect.catch(() => reportFault(runtime, context)))

/** The helper's task, the background boundary that owns its conversation. */
const helperTask = (wiring: Wiring, run: RunHelpers): Task<Input, Step, Schema.Json, object> =>
  defineTask<Input, Step, Schema.Json>({
    name: 'vivid.helper',
    version: 1,
    initial: () => ({ phase: 'open' }),
    phases: {
      open: (record, runtime, context) =>
        run(open(wiring)(record, runtime, context).pipe(faulted(runtime, context)), runtime.signal),
      work: (record, runtime, context) =>
        run(work(wiring)(record, runtime, context).pipe(faulted(runtime, context)), runtime.signal),
      report: (record, runtime, context) =>
        run(
          finish(wiring)(runtime, record.input, 1, record.state.checkpoint.answer, context).pipe(
            Effect.ignore,
          ),
          runtime.signal,
        ),
    },
    abort: (_record, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })

/**
 * A later round's first step: the follow-up goes into the helper's own conversation once (its
 * request id is the helper's and the round's), as a steer, so a helper at work takes it after its
 * current tool round and one that finished starts its next turn with everything it knew (Pi's
 * background subagent example, `test/examples/23-subagent-background.ts`, `Reporter.deliver`).
 * Its answer is the round's, waited for until the round's deadline.
 */
const followDeliver = (wiring: Wiring) =>
  Effect.fn('Helpers.followDeliver')(function* (
    record: FollowAt<'deliver'>,
    runtime: FollowRuntime,
    context: PiContext,
  ) {
    const { input } = record
    const harness = yield* wiring.harness
    const child = yield* pi(() => runtime.conversation(input.child, context)).pipe(
      Effect.filterOrFail(
        (found) => found !== undefined,
        () => new HelperFailed(),
      ),
    )
    const submission = yield* pi(() =>
      child.submit(
        {
          type: 'input',
          content: input.content,
          requestId: `${requestOf(input.runId)}:${input.round}`,
          whenBusy: 'steer',
        },
        context,
      ),
    )
    const answer = yield* answerWithin(harness, submission, {
      thread: runtime.conversationId,
      runId: input.runId,
      round: input.round,
      deadline: input.at + input.seconds * 1000,
      stop: pi(() => child.abort(context)),
    })
    const encoded = yield* encodeAnswer(answer).pipe(Effect.mapError(() => new HelperFailed()))
    yield* pi(() =>
      runtime.commit(
        () => ({ status: 'running', checkpoint: { phase: 'report', answer: encoded } }),
        context,
      ),
    )
  })

/**
 * One later round of a helper, as a background task of the Thread's conversation like the
 * helper's own: the Thread's Stop and idle waits leave it alone, and it reports its round's ending
 * to the server as the first round does.
 */
const followTask = (
  wiring: Wiring,
  run: RunHelpers,
): Task<FollowInput, FollowStep, Schema.Json, object> =>
  defineTask<FollowInput, FollowStep, Schema.Json>({
    name: 'vivid.helper.round',
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: (record, runtime, context) =>
        run(
          followDeliver(wiring)(record, runtime, context).pipe(faulted(runtime, context)),
          runtime.signal,
        ),
      report: (record, runtime, context) =>
        run(
          finish(wiring)(
            runtime,
            record.input,
            record.input.round,
            record.state.checkpoint.answer,
            context,
          ).pipe(Effect.ignore),
          runtime.signal,
        ),
    },
    abort: (_record, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })

/** A helper the Thread's conversation knows, by the number the model calls it. */
export interface Named {
  readonly runId: RunId
  /** The task carrying its current or last round: what a wait waits for. */
  readonly current: TaskId
  readonly child: Option.Option<ConversationId>
}

export interface Helpers {
  /** The task and the four kinds' tool sets, installed with the Person's Harness. */
  readonly extensions: ReadonlyArray<Extension>
  /**
   * Starts the helper the server reserved, in one commit with its record and number. A repeated
   * call finds the record and starts nothing.
   */
  readonly start: (
    tx: Tx,
    conversationId: ConversationId,
    run: ChildRun,
    origin: { readonly acting: Acting; readonly timezone: string; readonly at: number },
  ) => Promise<void>
  /** The Thread's helper with this number, if it has one. */
  readonly named: (
    conversationId: ConversationId,
    number: number,
  ) => Effect.Effect<Option.Option<Named>, PiRejected>
  /**
   * The parent waits on these helpers itself: their results are claimed for its wait (unless a
   * delivery claimed one first), so they come back once.
   */
  readonly claimWait: (
    tx: Tx,
    conversationId: ConversationId,
    runIds: ReadonlyArray<RunId>,
  ) => Promise<void>
  /** A finished helper's answer for the parent's wait, as the server would read it. */
  readonly answer: (named: Named) => Effect.Effect<RuntimeChildAnswer, PiRejected>
  /**
   * Starts the next round the server recorded for one helper (`POST .../children/:runId/messages`).
   * A round already started is not started again. `Absent` when the Thread has no helper whose
   * own conversation exists to continue.
   */
  readonly message: (
    threadId: ThreadId,
    runId: RunId,
    message: RuntimeChildMessage,
  ) => Effect.Effect<RuntimeChildMessaged, PiRejected>
}

/** Pi owns durability and deduplication; the Person owns the Effect callback bridge. */
export function helpers(input: {
  readonly harness: Effect.Effect<Harness>
  readonly product: ProductService
  readonly run: RunHelpers
  readonly tools: ReadonlyArray<ToolRegistration>
}): Helpers {
  const worker = workerExtensions(input.tools)
  const wiring: Wiring = { harness: input.harness, product: input.product, worker }
  const task = helperTask(wiring, input.run)
  const round = followTask(wiring, input.run)
  return {
    extensions: [
      defineExtension({ name: 'vivid-helpers', tasks: [task, round] }),
      ...WorkerKind.literals.map(worker),
    ],
    // @effect-diagnostics-next-line asyncFunction:off -- Pi owns the commit this callback runs in.
    start: async (tx, conversationId, run, origin) => {
      const index = await tx.doc(HelperIndex, conversationId)
      if (index.helpers[run.id] !== undefined) return
      const anchor = await tx.createTask(
        task,
        {
          runId: run.id,
          number: run.number,
          kind: run.kind,
          brief: run.brief,
          seconds: run.budget.seconds,
          toolCalls: run.budget.toolCalls,
          threadId: origin.acting.threadId,
          personId: origin.acting.personId,
          timezone: origin.timezone,
          at: origin.at,
        },
        { ownership: { kind: 'conversation' }, background: true, conversationId },
      )
      index.helpers[run.id] = { anchor, number: run.number, child: null, claim: null }
      index.byNumber[String(run.number)] = run.id
    },
    named: Effect.fn('Helpers.named')(function* (conversationId, number) {
      const harness = yield* input.harness
      const index = yield* pi(() =>
        harness.snapshot(HelperIndex, conversationId, BACKGROUND_CONTEXT),
      )
      if (index === undefined) return Option.none()
      const runId = index.byNumber[String(number)]
      const kept = runId === undefined ? undefined : index.helpers[runId]
      if (runId === undefined || kept === undefined) return Option.none()
      const latest = yield* latestOf(harness, conversationId, runId)
      return Option.some({
        runId,
        current: currentTask({ kept, latest }),
        child: Option.fromNullOr(kept.child),
      })
    }),
    // @effect-diagnostics-next-line asyncFunction:off -- Pi owns the commit this callback runs in.
    claimWait: async (tx, conversationId, runIds) => {
      const index = await tx.doc(HelperIndex, conversationId)
      const rounds = (await tx.doc(HelperRounds, conversationId)).rounds
      for (const runId of runIds) {
        // A helper that took a follow-up is waited on for its latest round.
        const claimed = rounds[runId] === undefined ? index.helpers[runId] : rounds[runId]
        if (claimed !== undefined && claimed.claim === null) claimed.claim = 'wait'
      }
    },
    answer: Effect.fn('Helpers.answerFor')(function* (named) {
      const harness = yield* input.harness
      const ended = yield* settledAnswer(harness, named.current)
      if (Option.isNone(ended)) return RuntimeChildAnswer.cases.Running.make({})
      return answered(ended.value, yield* usageOf(harness, named.child))
    }),
    message: Effect.fn('Helpers.message')(function* (threadId, runId, message) {
      const harness = yield* input.harness
      const absent = RuntimeChildMessaged.cases.Absent.make({})
      const conversation = yield* conversationOf(harness, threadId)
      if (Option.isNone(conversation)) return absent
      const conversationId = conversation.value.id
      const found = yield* foundOf(harness, threadId, runId)
      const child = Option.flatMap(found, ({ kept }) => Option.fromNullOr(kept.child))
      if (Option.isNone(child)) return absent
      // The Person and Thread its rounds report for are the ones its conversation acts for.
      const scope = yield* helperOf(harness, child.value)
      if (Option.isNone(scope)) return absent
      const at = yield* Clock.currentTimeMillis
      const followUp: FollowInput = {
        runId,
        round: message.round,
        content: contentOf(message),
        child: child.value,
        seconds: message.budget.seconds,
        threadId: scope.value.acting.threadId,
        personId: scope.value.acting.personId,
        at,
      }
      yield* pi(() =>
        // @effect-diagnostics-next-line asyncFunction:off -- Pi owns the commit that starts a round.
        harness.commit(async (tx) => {
          const rounds = await tx.doc(HelperRounds, conversationId)
          const latest = rounds.rounds[runId]
          if (latest !== undefined && latest.round >= message.round) return
          // Each round works within the helper's tool budget again.
          const calls = await tx.doc(HelperCalls, followUp.child)
          calls.limit = calls.counted.length + message.budget.toolCalls
          const task = await tx.createTask(round, followUp, {
            ownership: { kind: 'conversation' },
            background: true,
            conversationId,
          })
          rounds.rounds[runId] = { round: message.round, task, claim: null }
        }, BACKGROUND_CONTEXT),
      )
      return RuntimeChildMessaged.cases.Started.make({})
    }),
  }
}
