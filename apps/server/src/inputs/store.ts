import * as Exit from 'effect/Exit'
import {
  IntegrationAnswerOutcome,
  type AnswerIntegrationInputRequest,
  type AnswerIntegrationInputResponse,
  ProposedAction,
  InvalidRequest,
} from '@vivid/contracts'
import { IntegrationAnswers } from '../connections/answers.ts'
import { integrationAnswerText } from '../connections/asks.ts'
import * as NodeCrypto from 'node:crypto'
import { and, asc, eq, or, sql } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  Conflict,
  DatabaseFailure,
  InputAnswer,
  InputQuestion,
  InputRequest,
  InputRequestId,
  InputRequestState,
  NotFound,
  PersonId,
  RunId,
  SignalCue,
  ThreadId,
  type AnswerInputRequest,
  type AskInputRequest,
  type PersonSummary,
} from '@vivid/contracts'
import type { InputAnswerFailure } from '@vivid/contracts/rpc'
import { companyColumnOf, inWorkspace, loadSummaries, type Actor } from '../auth/access.ts'
import {
  Database,
  decodeStored,
  encodeStored,
  returned,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { changed, Changes, Topic } from '../live/changes.ts'
import { announceFeed } from '../feed/changes.ts'
import { Notifier } from '../notifications/notifier.ts'
import { readableBy, requireThread } from '../threads/access.ts'
import { threads } from '../threads/tables.ts'
import { Conversation, DeliveryMessage } from '../threads/conversation.ts'
import { Signal, encodeSignal } from '../approvals/signal.ts'
import { replaySignals, type SignalWriter } from '../approvals/replay.ts'
import { answerKey } from './answers.ts'
import { handoffSignals } from './handoff.ts'
import { inputRequests } from './tables.ts'
import { answerText } from './validation.ts'

/** Replay supplies the selection and fences; this domain owns both complete signal writes. */
const signalWriter: SignalWriter = {
  table: inputRequests,
  /** Claim and return the same bounded row set in one statement under the replay lease. */
  claim: Effect.fn('Inputs.claimSignals')(function* (
    database: Database['Service'],
    update: Parameters<SignalWriter['claim']>[1],
  ) {
    return yield* database.run(
      database
        .update(inputRequests)
        .set({ signalDueAt: update.leaseUntil, signalClaim: update.token })
        .where(update.where)
        .returning({
          id: inputRequests.id,
          threadId: inputRequests.threadId,
          personId: inputRequests.personId,
          signal: inputRequests.signal,
        }),
    )
  }),
  /** The row id and lease token prevent an expired claimant from acknowledging. */
  settle: Effect.fn('Inputs.settleSignal')(function* (
    database: Database['Service'],
    update: Parameters<SignalWriter['settle']>[1],
  ) {
    yield* database.run(
      database
        .update(inputRequests)
        .set({ signal: update.signal, signalDueAt: update.dueAt, signalClaim: null })
        .where(and(eq(inputRequests.id, update.id), eq(inputRequests.signalClaim, update.token))),
    )
  }),
}

const fields = createSelectSchema(inputRequests, {
  id: InputRequestId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  personId: PersonId,
  questions: Schema.NonEmptyArray(InputQuestion),
  signal: Signal,
  integration: Schema.NullOr(ProposedAction),
  integrationOutcome: Schema.NullOr(IntegrationAnswerOutcome),
}).fields
const Row = Schema.Union([
  Schema.Struct({
    ...fields,
    status: Schema.Literal('waiting'),
    answeredBy: Schema.Null,
    answers: Schema.Null,
    settledAt: Schema.Null,
  }),
  Schema.Struct({
    ...fields,
    status: Schema.Literal('answering'),
    answeredBy: Schema.Null,
    answers: Schema.Null,
    settledAt: Schema.Null,
  }),
  Schema.Struct({
    ...fields,
    status: Schema.Literal('answered'),
    answeredBy: PersonId,
    answers: Schema.NonEmptyArray(InputAnswer),
    settledAt: Schema.Finite,
  }),
  Schema.Struct({
    ...fields,
    status: Schema.Literal('expired'),
    answeredBy: Schema.Null,
    answers: Schema.Null,
    settledAt: Schema.Finite,
  }),
  Schema.Struct({
    ...fields,
    status: Schema.Literal('withdrawn'),
    answeredBy: Schema.Null,
    answers: Schema.Null,
    settledAt: Schema.Finite,
  }),
]).pipe(Schema.toTaggedUnion('status'))
const decodeRow = decodeStored(Row, 'Input request')
const encodeQuestions = encodeStored(InputRequest.fields.questions, 'Input questions')
const encodeAnswers = encodeStored(InputRequestState.cases.Answered.fields.answers, 'Input answers')

/** The addressed and answering Persons must still have real identities in persistence. */
const personSummary = (
  people: ReadonlyMap<PersonId, PersonSummary>,
  id: PersonId,
): Effect.Effect<PersonSummary, DatabaseFailure> => {
  const person = people.get(id)
  return person === undefined
    ? Effect.fail(new DatabaseFailure({ message: 'Input request Person is missing' }))
    : Effect.succeed(person)
}

/** State mapping has one owner so an inbox and its Thread always show the same answer. */
const stateOf = (
  row: typeof Row.Type,
  people: ReadonlyMap<PersonId, PersonSummary>,
): Effect.Effect<InputRequestState, DatabaseFailure> =>
  Row.match(row, {
    expired: (value) =>
      Effect.succeed(InputRequestState.cases.Expired.make({ expiredAt: value.settledAt })),
    waiting: () => Effect.succeed(InputRequestState.cases.Waiting.make({})),
    answering: () => Effect.succeed(InputRequestState.cases.Waiting.make({})),
    answered: (value) =>
      personSummary(people, value.answeredBy).pipe(
        Effect.map((answeredBy) =>
          InputRequestState.cases.Answered.make({
            answeredBy,
            answers: value.answers,
            answeredAt: value.settledAt,
          }),
        ),
      ),
    withdrawn: (value) =>
      Effect.succeed(InputRequestState.cases.Withdrawn.make({ withdrawnAt: value.settledAt })),
  })

/** Decodes stored questions and state exactly at ingress and batches identity reads. */
const view = Effect.fn('Inputs.view')(function* (
  values: ReadonlyArray<typeof inputRequests.$inferSelect>,
) {
  const rows = yield* Effect.forEach(values, decodeRow)
  const people = yield* loadSummaries(
    rows.flatMap((row) => [row.personId, ...Option.toArray(Option.fromNullishOr(row.answeredBy))]),
  )
  return yield* Effect.forEach(
    rows,
    Effect.fn('Inputs.viewOne')(function* (row) {
      return InputRequest.make({
        id: row.id,
        threadId: row.threadId,
        runId: row.runId,
        questions: row.questions,
        integration: row.integration,
        integrationOutcome: row.integrationOutcome,
        askedOf: yield* personSummary(people, row.personId),
        state: yield* stateOf(row, people),
        createdAt: row.createdAt,
      })
    }),
  )
})

/** Read the Thread history without capturing the execution services used to settle it. */
export const inThread = Effect.fn('InputStore.inThread')(function* (threadId: ThreadId) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select()
      .from(inputRequests)
      .where(eq(inputRequests.threadId, threadId))
      .orderBy(asc(inputRequests.createdAt), asc(inputRequests.id)),
  )
  return yield* view(rows)
})

export interface InputStoreService {
  readonly expire: Effect.Effect<void, NotFound | DatabaseInfrastructureError, IntegrationAnswers>
  readonly replay: Effect.Effect<void, DatabaseInfrastructureError>
  readonly inThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<InputRequest>, DatabaseInfrastructureError>
  readonly inbox: (
    actor: Actor,
  ) => Effect.Effect<ReadonlyArray<InputRequest>, DatabaseInfrastructureError>
  readonly ask: (
    actor: Actor,
    request: AskInputRequest,
  ) => Effect.Effect<InputRequest, NotFound | DatabaseInfrastructureError>
  readonly askIntegration: (
    actor: Actor,
    action: ProposedAction,
  ) => Effect.Effect<InputRequest, NotFound | InvalidRequest | DatabaseInfrastructureError>
  readonly answerIntegration: (
    actor: Actor,
    request: AnswerIntegrationInputRequest,
  ) => Effect.Effect<
    AnswerIntegrationInputResponse,
    NotFound | InvalidRequest | Conflict | DatabaseInfrastructureError,
    IntegrationAnswers
  >
  readonly answer: (
    actor: Actor,
    request: AnswerInputRequest,
  ) => Effect.Effect<
    InputRequest,
    NotFound | Conflict | InputAnswerFailure | DatabaseInfrastructureError
  >
}
export class InputStore extends Context.Service<InputStore, InputStoreService>()(
  'vivid/InputStore',
) {}

/** A single notification previews the first question and names how much else needs an answer. */
const noticeBody = (request: AskInputRequest) => {
  const first = request.questions[0].question
  switch (request.questions.length) {
    case 1:
      return first
    case 2:
      return `${first} One more question.`
    case 3:
      return `${first} Two more questions.`
    default:
      return `${first} Three more questions.`
  }
}

/** Vivid asks only in its authenticated Thread and addresses the acting Person. */
const ask = Effect.fn('Inputs.ask')(function* (
  actor: Actor,
  request: AskInputRequest,
  integration: ProposedAction | null,
) {
  if (actor.by !== 'vivid' || Option.isNone(actor.threadId))
    return yield* new NotFound({ message: 'Input request needs a Vivid Thread' })
  const threadId = actor.threadId.value
  const thread = yield* requireThread(threadId, actor.person.id)
  if (thread.companyId !== companyColumnOf(actor.workspace))
    return yield* new NotFound({ message: 'Thread not found in workspace' })
  const database = yield* Database
  const questions = yield* encodeQuestions(request.questions)
  const rows = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const written = yield* tx
        .insert(inputRequests)
        .values({
          id: NodeCrypto.randomUUID(),
          threadId,
          personId: actor.person.id,
          runId: null,
          questions,
          integration:
            integration === null
              ? null
              : yield* encodeStored(ProposedAction, 'Integration input')(integration),
          status: 'waiting',
          createdAt: yield* Clock.currentTimeMillis,
        })
        .returning()
      if (written.length > 0) yield* announceFeed(tx, [threadId])
      return written
    }),
  )
  const input = yield* returned(yield* view(rows), 'Input request')
  yield* changed(actor, Topic.thread(threadId))
  // A question waits on the Person wherever it was asked. One asked in a Background Thread is
  // shown on the Feed, and its notice opens the Feed (`opensAt`, `threads/place.ts`).
  yield* (yield* Notifier).notify({
    personId: actor.person.id,
    companyId: thread.companyId,
    kind: 'needs-you',
    title: 'Vivid has a question',
    body: noticeBody(request),
    threadId,
    approvalId: null,
  })
  return input
})

/** A visible shared Thread may be answered once; continuation keeps the addressed Person's authority. */
const answer = Effect.fn('Inputs.answer')(function* (actor: Actor, request: AnswerInputRequest) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ request: inputRequests })
      .from(inputRequests)
      .innerJoin(threads, eq(threads.id, inputRequests.threadId))
      .where(and(eq(inputRequests.id, request.id), inWorkspace(threads, actor)))
      .limit(1),
  )
  const value = rows[0]
  if (value === undefined) return yield* new NotFound({ message: 'Input request not found' })
  const row = yield* decodeRow(value.request)
  yield* requireThread(row.threadId, actor.person.id)
  if (row.integration !== null)
    return yield* new Conflict({ message: 'Answer this Integration using its typed form.' })
  const body = yield* answerText(row.questions, request)
  const answers = yield* encodeAnswers(request.answers)
  const now = yield* Clock.currentTimeMillis
  const signal = Signal.cases.Owed.make({
    idempotencyKey: answerKey(request.id),
    deciderId: actor.person.id,
    message: DeliveryMessage.cases.Signal.make({ cue: SignalCue.cases.Answer.make({ body }) }),
  })
  const updated = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const written = yield* tx
        .update(inputRequests)
        .set({
          status: 'answered',
          answeredBy: actor.person.id,
          answers,
          settledAt: now,
          signal: yield* encodeSignal(signal),
          signalDueAt: now,
        })
        .where(and(eq(inputRequests.id, request.id), eq(inputRequests.status, 'waiting')))
        .returning()
      if (written.length > 0) yield* announceFeed(tx, [row.threadId])
      return written
    }),
  )
  if (updated.length === 0)
    return yield* new Conflict({ message: 'Input request already answered' })
  const input = yield* returned(yield* view(updated), 'Input request')
  yield* changed(actor, Topic.thread(row.threadId))
  yield* replaySignals(signalWriter, Option.some([request.id])).pipe(
    Effect.catch(() => Effect.logError('Input answer replay failed', { requestId: request.id })),
  )
  return input
}, Effect.uninterruptible)

/**
 * Admission has already checked this Person's reach and the runtime has accepted their message.
 * One conditional write settles every question addressed to them in this Thread; an answer racing
 * it keeps whichever terminal state won. Export the operation without capturing Conversation:
 * InputStore uses Conversation to deliver answers, while admission must also close questions.
 */
export const withdrawWaiting = Effect.fn('Inputs.withdrawWaiting')(function* (
  threadId: ThreadId,
  personId: PersonId,
) {
  const database = yield* Database
  const rows = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const written = yield* tx
        .update(inputRequests)
        .set({ status: 'withdrawn', settledAt: yield* Clock.currentTimeMillis })
        .where(
          and(
            eq(inputRequests.threadId, threadId),
            eq(inputRequests.personId, personId),
            eq(inputRequests.status, 'waiting'),
          ),
        )
        .returning()
      if (written.length > 0) yield* announceFeed(tx, [threadId])
      return written
    }),
  )
  const withdrawn = yield* view(rows)
  if (withdrawn.length > 0)
    yield* (yield* Changes).publish([Topic.person(personId), Topic.thread(threadId)])
  return withdrawn
}, Effect.uninterruptible)

/** Stores own the conditional transition; handlers share it with Vivid's tool entry point. */
/** A tool's form remains attached to the existing Input request, with its ordinary delivery. */
const askIntegration = Effect.fn('Inputs.askIntegration')(function* (
  actor: Actor,
  action: ProposedAction,
) {
  if (action.continuation === null)
    return yield* new InvalidRequest({ message: 'Integration question has no saved call.' })
  return yield* ask(
    actor,
    {
      questions: [
        {
          question: action.continuation.pause.form.message,
          options: [],
          selection: 'One',
          allowsOwnAnswer: true,
        },
      ],
    },
    action,
  )
})

/** Claim before resuming. A duplicate answer never resends the continuation, even after response loss. */
const answerIntegration = Effect.fn('Inputs.answerIntegration')(
  function* (actor: Actor, request: AnswerIntegrationInputRequest) {
    const database = yield* Database
    const rows = yield* database.run(
      database
        .select({ request: inputRequests })
        .from(inputRequests)
        .innerJoin(threads, eq(threads.id, inputRequests.threadId))
        .where(and(eq(inputRequests.id, request.id), inWorkspace(threads, actor)))
        .limit(1),
    )
    const value = rows[0]
    if (value === undefined) return yield* new NotFound({ message: 'Input request not found' })
    const row = yield* decodeRow(value.request)
    yield* requireThread(row.threadId, actor.person.id)
    if (row.personId !== actor.person.id || row.integration === null)
      return yield* new NotFound({ message: 'Integration input request not found' })
    const claimed = yield* database.run(
      database
        .update(inputRequests)
        .set({
          status: 'answering',
          integrationOutcome: yield* encodeStored(
            IntegrationAnswerOutcome,
            'Integration answer',
          )(IntegrationAnswerOutcome.cases.Uncertain.make({})),
        })
        .where(and(eq(inputRequests.id, request.id), eq(inputRequests.status, 'waiting')))
        .returning(),
    )
    if (claimed.length === 0)
      return yield* new Conflict({
        message: 'Integration question already answered or being answered.',
      })
    const action = row.integration
    const held = yield* decodeRow(yield* returned(claimed, 'Claimed Input request'))
    const addressed: Actor = { ...actor, by: 'vivid', threadId: Option.some(row.threadId) }
    const ending = yield* Effect.gen(function* () {
      const outcome = yield* (yield* IntegrationAnswers).answer(addressed, action, request.response)
      const input = yield* finishIntegrationInput(held, outcome, actor.person.id)
      return { request: input, outcome }
    }).pipe(
      Effect.catch(
        Effect.fnUntraced(function* () {
          const outcome = IntegrationAnswerOutcome.cases.Uncertain.make({})
          yield* (yield* IntegrationAnswers).settle(action, outcome)
          return { request: yield* finishIntegrationInput(held, outcome, actor.person.id), outcome }
        }),
      ),
    )

    yield* changed(actor, Topic.thread(row.threadId))
    yield* replaySignals(signalWriter, Option.some([request.id])).pipe(
      Effect.catch(() =>
        Effect.logError('Integration answer delivery failed', { requestId: request.id }),
      ),
    )
    return ending
  },
  (effect, _actor, request) =>
    effect.pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? recoverIntegrationInput(request.id) : Effect.void,
      ),
      Effect.uninterruptible,
    ),
)

/** A defect or interrupted owner has the same once-only uncertain ending as an expected failure. */
const recoverIntegrationInput = Effect.fn('Inputs.recoverIntegration')(function* (
  id: InputRequestId,
) {
  const database = yield* Database
  const values = yield* database.run(
    database
      .select()
      .from(inputRequests)
      .where(and(eq(inputRequests.id, id), eq(inputRequests.status, 'answering')))
      .limit(1),
  )
  const value = values[0]
  if (value === undefined) return
  const row = yield* decodeRow(value)
  if (row.integration === null) return
  const outcome = IntegrationAnswerOutcome.cases.Uncertain.make({})
  yield* (yield* IntegrationAnswers).settle(row.integration, outcome)
  yield* finishIntegrationInput(row, outcome, row.personId)
})

/** Every claimed input has a terminal row and an owed signal, including a failed or expired continuation. */
const finishIntegrationInput = Effect.fn('Inputs.finishIntegration')(function* (
  row: typeof Row.Type,
  outcome: IntegrationAnswerOutcome,
  answeredBy: PersonId | null,
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const body = integrationAnswerText(outcome)
  const expired = answeredBy === null
  const signal = Signal.cases.Owed.make({
    idempotencyKey: answerKey(row.id),
    deciderId: answeredBy,
    message: DeliveryMessage.cases.Signal.make({ cue: SignalCue.cases.Answer.make({ body }) }),
  })
  const updated = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const written = yield* tx
        .update(inputRequests)
        .set({
          status: expired ? 'expired' : 'answered',
          answeredBy,
          answers: expired
            ? null
            : yield* encodeAnswers([InputAnswer.cases.Written.make({ words: body })]),
          settledAt: now,
          integrationOutcome: yield* encodeStored(
            IntegrationAnswerOutcome,
            'Integration answer',
          )(outcome),
          signal: yield* encodeSignal(signal),
          signalDueAt: now,
        })
        .where(and(eq(inputRequests.id, row.id), eq(inputRequests.status, row.status)))
        .returning()
      yield* announceFeed(tx, [row.threadId])
      return written
    }),
  )
  return yield* returned(yield* view(updated), 'Settled Input request')
})

/** Unanswered pauses expire at the upstream deadline. An interrupted answer is uncertain and is never resumed by recovery. */
const expireIntegrationInputs = Effect.fn('Inputs.expireIntegration')(function* () {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const values = yield* database.run(
    database
      .select()
      .from(inputRequests)
      .where(
        and(
          or(eq(inputRequests.status, 'waiting'), eq(inputRequests.status, 'answering')),
          sql`(${inputRequests.integration}->'continuation'->'pause'->>'expiresAt')::numeric <= ${now}`,
        ),
      ),
  )
  for (const value of values) {
    const row = yield* decodeRow(value)
    if (row.integration === null) continue
    const outcome =
      row.status === 'answering'
        ? IntegrationAnswerOutcome.cases.Uncertain.make({})
        : IntegrationAnswerOutcome.cases.Expired.make({})
    yield* (yield* IntegrationAnswers).settle(row.integration, outcome)
    yield* finishIntegrationInput(row, outcome, row.status === 'answering' ? row.personId : null)
    yield* (yield* Changes).publish([Topic.person(row.personId), Topic.thread(row.threadId)])
  }
})

export const inputStoreLayer = Layer.effect(
  InputStore,
  Effect.gen(function* () {
    const database = yield* Database
    const context = Context.omit(IntegrationAnswers)(
      yield* Effect.context<Database | Changes | Notifier | Conversation>(),
    )
    const run = <A, E, R>(
      effect: Effect.Effect<A, E, R | Database | Changes | Notifier | Conversation>,
    ) => Effect.provide(effect, context)
    return InputStore.of({
      /** ThreadStore already checked access before loading complete oldest-first request history. */
      inThread: (threadId) => run(inThread(threadId)),
      /**
       * Workspace scope comes from the joined Thread; roles never broaden the addressee.
       * Filter current reach before projection, including corrupt audiences; keep waiting rows.
       */
      inbox: Effect.fn('InputStore.inbox')(function* (actor) {
        const rows = yield* database.run(
          database
            .select({ request: inputRequests })
            .from(inputRequests)
            .innerJoin(threads, eq(threads.id, inputRequests.threadId))
            .where(
              and(
                eq(inputRequests.personId, actor.person.id),
                eq(inputRequests.status, 'waiting'),
                inWorkspace(threads, actor),
                readableBy(actor.person.id),
              ),
            )
            .orderBy(asc(inputRequests.createdAt), asc(inputRequests.id)),
        )
        return yield* run(view(rows.map((row) => row.request)))
      }),
      expire: run(expireIntegrationInputs()),
      ask: (actor, request) => run(ask(actor, request, null)),
      askIntegration: (actor, action) => run(askIntegration(actor, action)),
      answerIntegration: (actor, request) => run(answerIntegration(actor, request)),
      answer: (actor, request) => run(answer(actor, request)),
      // A finished handoff owes its signal the way an answer does; both are retried together.
      replay: run(
        replaySignals(signalWriter, Option.none()).pipe(
          Effect.andThen(replaySignals(handoffSignals, Option.none())),
        ),
      ),
    })
  }),
)
