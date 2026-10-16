import * as NodeCrypto from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
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
import { Notifier } from '../notifications/notifier.ts'
import { readableBy, requireThread } from '../threads/access.ts'
import { notifiesFrom } from '../threads/place.ts'
import { threads } from '../threads/tables.ts'
import { Conversation, DeliveryMessage } from '../threads/conversation.ts'
import { Signal, encodeSignal } from '../approvals/signal.ts'
import { replaySignals } from '../approvals/replay.ts'
import { answerKey } from './answers.ts'
import { inputRequests } from './tables.ts'
import { answerText } from './validation.ts'

const fields = createSelectSchema(inputRequests, {
  id: InputRequestId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  personId: PersonId,
  questions: Schema.NonEmptyArray(InputQuestion),
  signal: Signal,
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
    status: Schema.Literal('answered'),
    answeredBy: PersonId,
    answers: Schema.NonEmptyArray(InputAnswer),
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
    waiting: () => Effect.succeed(InputRequestState.cases.Waiting.make({})),
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
        askedOf: yield* personSummary(people, row.personId),
        state: yield* stateOf(row, people),
        createdAt: row.createdAt,
      })
    }),
  )
})

export interface InputStoreService {
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
const ask = Effect.fn('Inputs.ask')(function* (actor: Actor, request: AskInputRequest) {
  if (actor.by !== 'vivid' || Option.isNone(actor.threadId))
    return yield* new NotFound({ message: 'Input request needs a Vivid Thread' })
  const threadId = actor.threadId.value
  const thread = yield* requireThread(threadId, actor.person.id)
  if (thread.companyId !== companyColumnOf(actor.workspace))
    return yield* new NotFound({ message: 'Thread not found in workspace' })
  const database = yield* Database
  const questions = yield* encodeQuestions(request.questions)
  const rows = yield* database.run(
    database
      .insert(inputRequests)
      .values({
        id: NodeCrypto.randomUUID(),
        threadId,
        personId: actor.person.id,
        runId: null,
        questions,
        status: 'waiting',
        createdAt: yield* Clock.currentTimeMillis,
      })
      .returning(),
  )
  const input = yield* returned(yield* view(rows), 'Input request')
  yield* changed(actor, Topic.thread(threadId))
  // A question asked in a Background Thread is shown by the Feed, never as a notification.
  if (!notifiesFrom(thread.place)) return input
  yield* (yield* Notifier).notify({
    personId: actor.person.id,
    companyId: thread.companyId,
    kind: 'needs-you',
    title: 'Vivid has a question',
    body: noticeBody(request),
    threadId,
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
  const body = yield* answerText(row.questions, request)
  const answers = yield* encodeAnswers(request.answers)
  const now = yield* Clock.currentTimeMillis
  const signal = Signal.cases.Owed.make({
    idempotencyKey: answerKey(request.id),
    deciderId: actor.person.id,
    message: DeliveryMessage.cases.Signal.make({
      type: 'answer',
      body,
      attributes: { request: request.id },
    }),
  })
  const updated = yield* database.run(
    database
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
      .returning(),
  )
  if (updated.length === 0)
    return yield* new Conflict({ message: 'Input request already answered' })
  const input = yield* returned(yield* view(updated), 'Input request')
  yield* changed(actor, Topic.thread(row.threadId))
  yield* replaySignals(inputRequests, Option.some([request.id])).pipe(
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
  const rows = yield* database.run(
    database
      .update(inputRequests)
      .set({ status: 'withdrawn', settledAt: yield* Clock.currentTimeMillis })
      .where(
        and(
          eq(inputRequests.threadId, threadId),
          eq(inputRequests.personId, personId),
          eq(inputRequests.status, 'waiting'),
        ),
      )
      .returning(),
  )
  const withdrawn = yield* view(rows)
  if (withdrawn.length > 0)
    yield* (yield* Changes).publish([Topic.person(personId), Topic.thread(threadId)])
  return withdrawn
}, Effect.uninterruptible)

/** Stores own the conditional transition; handlers share it with Vivid's tool entry point. */
export const inputStoreLayer = Layer.effect(
  InputStore,
  Effect.gen(function* () {
    const database = yield* Database
    const context = yield* Effect.context<Database | Changes | Notifier | Conversation>()
    const run = <A, E>(effect: Effect.Effect<A, E, Database | Changes | Notifier | Conversation>) =>
      Effect.provide(effect, context)
    return InputStore.of({
      /** ThreadStore already checked access before loading complete oldest-first request history. */
      inThread: Effect.fn('InputStore.inThread')(function* (threadId) {
        const rows = yield* database.run(
          database
            .select()
            .from(inputRequests)
            .where(eq(inputRequests.threadId, threadId))
            .orderBy(asc(inputRequests.createdAt), asc(inputRequests.id)),
        )
        return yield* run(view(rows))
      }),
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
      ask: (actor, request) => run(ask(actor, request)),
      answer: (actor, request) => run(answer(actor, request)),
      replay: run(replaySignals(inputRequests, Option.none())),
    })
  }),
)
