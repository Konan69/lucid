import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import {
  Conflict,
  NotFound,
  type Person,
  type PersonId,
  type RunId,
  type ThreadId,
} from '@vivid/contracts'
import { findPerson } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { Changes } from '../live/changes.ts'
import { Learning } from '../memory/learn.ts'
import { Notifier } from '../notifications/notifier.ts'
import { submissionId } from '../runtime/identity.ts'
import { Runtime, Settlement } from '../runtime/client.ts'
import { audienceTopics, canSee, findThread, type StoredThread } from './access.ts'
import {
  Conversation,
  DeliveryMessage,
  DeliverySpeaker,
  type Admitted,
  type ConversationService,
  type Delivery,
  type SignalDelivery,
} from './conversation.ts'
import { serializeAdmissions } from './admissions.ts'
import { flueMessage } from './message.ts'
import { Presence } from './presence.ts'
import { RunStore, RunEnding, TurnReservation, type WorkingRun } from './runs.ts'
import { ThreadStore } from './store.ts'

/** What the delivery says, for the Thread's preview. Only a Person's own words are shown there. */
const previewOf = (message: DeliveryMessage) =>
  DeliveryMessage.match(message, {
    Said: ({ body }) => Option.some(body),
    Signal: () => Option.none<string>(),
  })

/** The runtime's classified failure stays attached through the single conditional settlement write. */
const endingOf = (settlement: Settlement): RunEnding =>
  Settlement.match(settlement, {
    Completed: (): RunEnding => RunEnding.cases.Completed.make({}),
    Failed: ({ reason }) => RunEnding.cases.Failed.make({ reason }),
    Stopped: () => RunEnding.cases.Stopped.make({}),
    Unknown: () => RunEnding.cases.Unknown.make({}),
  })

/** A Run being watched to its end, with the Person's words that started it when there were any. */
interface Followed {
  readonly id: RunId
  readonly threadId: ThreadId
  readonly person: Person
  readonly said: Option.Option<string>
}

/**
 * Builds the observer of one Run: it waits for the Run to end and writes down how. It runs for as
 * long as the Run does, outside the request that started it, and acts only if it is the one that
 * moves the Run out of `working`, so a settlement observed twice is handled once.
 */
const makeObserve = Effect.fn('Conversation.makeObserve')(function* () {
  const database = yield* Database
  const runtime = yield* Runtime
  const threads = yield* ThreadStore
  const runs = yield* RunStore
  const changes = yield* Changes
  const notifier = yield* Notifier
  const presence = yield* Presence
  const learning = yield* Learning

  /** Tells the Person Vivid worked for that it is done, unless they are watching it happen. */
  const announce = Effect.fn('Conversation.announce')(function* (
    thread: StoredThread,
    personId: PersonId,
    settlement: Settlement,
  ) {
    if (Settlement.guards.Stopped(settlement)) return
    if (yield* presence.watching(thread.id, personId)) return
    // A Run can outlast its Person's place in the Thread. The notice quotes the title and the
    // reply, so it is only written for someone who may still read them.
    const reach = canSee(thread, personId).pipe(Effect.provideService(Database, database))
    if (!(yield* reach)) return
    yield* notifier.notify({
      personId,
      companyId: thread.companyId,
      kind: 'finished',
      title: thread.title,
      body: Settlement.guards.Completed(settlement)
        ? settlement.reply.slice(0, 240)
        : 'Vivid could not finish this.',
      taskId: null,
      threadId: thread.id,
    })
  })

  return Effect.fn('Conversation.observe')(function* (run: Followed) {
    const settlement = yield* runtime.settled(run.threadId, run.id)
    if (!(yield* runs.end(run.id, endingOf(settlement)))) return
    const thread = yield* findThread(run.threadId).pipe(Effect.provideService(Database, database))
    if (Option.isNone(thread)) return
    const reply = Settlement.guards.Completed(settlement)
      ? Option.some(settlement.reply)
      : Option.none<string>()
    yield* threads.touch(
      run.threadId,
      Option.filter(reply, (text) => text.trim().length > 0),
    )
    yield* changes.publish(
      audienceTopics(thread.value, yield* threads.participants(thread.value.id)),
    )
    yield* announce(thread.value, run.person.id, settlement)
    if (Option.isSome(reply) && Option.isSome(run.said)) {
      yield* learning.afterRun({
        thread: thread.value,
        person: run.person,
        said: run.said.value,
        replied: reply.value,
        runId: run.id,
      })
    }
  })
})

const threadMissing = () => Effect.fail(new NotFound({ message: 'Thread not found' }))

/** Producers keep durable receipts and retry on their own schedule; Busy never waits in-process. */
const makeDeliver = (admit: ConversationService['admit'], runs: RunStore['Service']) =>
  Effect.fn('Conversation.deliver')(function* (delivery: SignalDelivery) {
    const admitted = yield* admit(delivery)
    const recorded = yield* runs.list(delivery.threadId)
    const run = recorded.find((candidate) => candidate.id === admitted.runId)
    return run === undefined ? yield* threadMissing() : run
  })

const makeConversation = Effect.fn('Conversation.make')(function* () {
  const database = yield* Database
  const runtime = yield* Runtime
  const threads = yield* ThreadStore
  const runs = yield* RunStore
  const changes = yield* Changes
  const scope = yield* Effect.scope
  const observe = yield* makeObserve()
  const withAdmission = serializeAdmissions()
  const withDatabase = Effect.provideService(Database, database)

  // Runs with an observer in this process. A delivery Flue recognises as a repeat does not mean
  // someone is watching it: the first attempt may have failed between admission and observation.
  // Whether to observe is decided by this set, never by what the runtime says about repeats.
  const observed = new Set<RunId>()

  /** Observes a Run in the background for the life of the server, logging what it cannot do. */
  const follow = (run: Followed) => {
    if (observed.has(run.id)) return Effect.void
    observed.add(run.id)
    return observe(run).pipe(
      Effect.catch((error) => Effect.logError('A Run could not be settled', error._tag)),
      Effect.ensuring(Effect.sync(() => observed.delete(run.id))),
      Effect.forkIn(scope),
      Effect.asVoid,
    )
  }

  /** The Person a delivery is for, who must exist; otherwise the delivery has nobody behind it. */
  const personOf = Effect.fn('Conversation.personOf')(function* (personId: PersonId) {
    const person = yield* findPerson(personId).pipe(withDatabase)
    return Option.isNone(person) ? yield* threadMissing() : person.value
  })

  /**
   * A decision continues the Run under the Person it started for, including their Connections.
   * The decider speaks in the signal and must independently still be able to see the Thread;
   * approving or answering never lends the decider's authority to that continuation.
   */
  const speakerName = Effect.fn('Conversation.speakerName')(function* (
    delivery: Delivery,
    thread: StoredThread,
    acting: Person,
  ) {
    return yield* DeliverySpeaker.match(delivery.speaker, {
      Acting: () => Effect.succeed(acting.name),
      Vivid: () => Effect.succeed('Vivid'),
      Decider: Effect.fn('Conversation.decider')(function* ({ personId }) {
        if (!(yield* canSee(thread, personId).pipe(withDatabase))) return yield* threadMissing()
        return (yield* personOf(personId)).name
      }),
    })
  })

  /**
   * The server never joins a different Person's delivery into a response in progress. The locked
   * reservation refuses it with the first Person's name before any message or signal reaches Flue.
   */
  const admit: ConversationService['admit'] = Effect.fn('Conversation.admit')(
    function* (delivery: Delivery) {
      const found = yield* findThread(delivery.threadId).pipe(withDatabase)
      if (Option.isNone(found)) return yield* threadMissing()
      const thread = found.value
      if (!(yield* canSee(thread, delivery.personId).pipe(withDatabase)))
        return yield* threadMissing()
      const speaker = yield* personOf(delivery.personId)
      const from = yield* speakerName(delivery, thread, speaker)
      const creator = yield* personOf(thread.personId)
      const id = submissionId(thread.id, delivery.idempotencyKey)
      const reservation = yield* runs.start({
        id,
        threadId: thread.id,
        personId: speaker.id,
        origin: delivery.origin,
        libraryFolder: delivery.libraryFolder === undefined ? null : delivery.libraryFolder,
      })
      const said = previewOf(delivery.message)
      if (TurnReservation.guards.Replayed(reservation)) {
        yield* follow({ id, threadId: thread.id, person: speaker, said })
        return reservation.receipt
      }
      const turn = yield* TurnReservation.match<Effect.Effect<number, Conflict>>(reservation, {
        Reserved: (reserved) => Effect.succeed(reserved.turn),
        Replayed: (replayed) => Effect.succeed(replayed.turn),
        Busy: ({ person }) =>
          Effect.fail(
            Conflict.make({
              message: `Vivid is still answering ${person.name}. Send this again when it has finished.`,
            }),
          ),
      })
      const admission = yield* Effect.gen(function* () {
        const deliveryScope = yield* runs.scope({ threadId: thread.id, turn })
        return yield* runtime.admit({
          threadId: thread.id,
          message: flueMessage(thread.audience, from, delivery.message, turn),
          origin: { creator: creator.id, creatorName: creator.name },
          idempotencyKey: delivery.idempotencyKey,
          turn,
          scope: deliveryScope,
        })
      }).pipe(
        Effect.tapError(() => runs.end(id, RunEnding.cases.Failed.make({ reason: 'Delivery' }))),
        Effect.onInterrupt(() => runs.end(id, RunEnding.cases.Failed.make({ reason: 'Delivery' }))),
      )
      yield* runs.admitted(admission)
      yield* threads.touch(thread.id, said)
      // What a Person just sent is not unread for them. They were just shown to be able to see the
      // Thread, so the only failures left here are the database's own.
      yield* threads
        .markRead(speaker.id, thread.id)
        .pipe(
          Effect.catchTag(['NotFound', 'Forbidden', 'InvalidRequest', 'Conflict'], threadMissing),
        )
      yield* changes.publish(audienceTopics(thread, yield* threads.participants(thread.id)))
      yield* follow({ id: admission.runId, threadId: thread.id, person: speaker, said })
      return {
        runId: admission.runId,
        offset: admission.offset,
        incarnation: admission.incarnation,
      } satisfies Admitted
    },
    (effect, delivery) => withAdmission(effect, delivery.threadId),
  )

  const deliver: ConversationService['deliver'] = makeDeliver(admit, runs)

  // A server that restarts while Runs are in progress picks each one back up: Flue still knows
  // how they ended, or says it does not, and either way the row stops claiming it is working.
  const unfinished = yield* runs.working()
  yield* Effect.forEach(unfinished, (run) => resume(run), { discard: true })

  function resume(run: WorkingRun) {
    return personOf(run.personId).pipe(
      Effect.flatMap((person) =>
        follow({ id: run.id, threadId: run.threadId, person, said: Option.none() }),
      ),
      Effect.catch(() => Effect.logWarning('A working Run has nobody behind it any more')),
    )
  }

  return Conversation.of({ deliver, admit })
})

/** Needs a `Scope`: the Runs it observes live as long as the server does. */
export const conversationLayer = Layer.effect(Conversation, makeConversation())
