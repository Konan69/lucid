import { Activities, activitiesLayer } from '../activity/service.ts'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Schedule from 'effect/Schedule'
import {
  Conflict,
  NotFound,
  RuntimeUnavailable,
  ThreadAudience,
  type Person,
  type PersonId,
  type RunId,
  type ThreadId,
} from '@vivid/contracts'
import { findPerson } from '../auth/access.ts'
import { DeviceRegistry, deviceLayer } from '../computers/device.ts'
import { ChannelReplies } from '../channels/replies.ts'
import { Database } from '../database/client.ts'
import { claimWithdrawalsFor } from '../inputs/handoff.ts'
import { withdrawWaiting } from '../inputs/store.ts'
import { Changes, Topic } from '../live/changes.ts'
import { Notifier } from '../notifications/notifier.ts'
import { deliveryRunId } from '../threads/key.ts'
import { recordRunFailure } from '../runtime/failure.ts'
import { Runtime, Settlement } from '../runtime/client.ts'
import { audienceTopics, canSee, findThread, type StoredThread } from './access.ts'
import {
  Conversation,
  DeliveryMessage,
  DeliverySpeaker,
  movesThreadOn,
  type Admitted,
  type ConversationService,
  type Delivery,
  type ServerDelivery,
} from './conversation.ts'
import { keyedPermits } from '../runtime/keyed.ts'
import { runtimeMessage } from './message.ts'
import { notifiesFrom } from './place.ts'
import { Presence } from './presence.ts'
import {
  RunStore,
  RunEnding,
  TurnReservation,
  automaticallyNotifies,
  type WorkingRun,
} from './runs.ts'
import { ThreadTitles } from './generation.ts'
import { ThreadStore } from './store.ts'

/** What the delivery says, for the Thread's preview. Only a Person's own words are shown there. */
const previewOf = (message: DeliveryMessage) =>
  DeliveryMessage.match(message, {
    Said: ({ body }) => Option.some(body),
    ChannelText: ({ body }) => Option.some(body),
    Signal: () => Option.none<string>(),
    FirstConversation: () => Option.none<string>(),
  })

/** The runtime's classified failure stays attached through the single conditional settlement write. */
const endingOf = (settlement: Settlement): RunEnding =>
  Settlement.match(settlement, {
    Completed: ({ responseId }): RunEnding => RunEnding.cases.Completed.make({ responseId }),
    Failed: ({ reason }): RunEnding => RunEnding.cases.Failed.make({ reason }),
    Stopped: (): RunEnding => RunEnding.cases.Stopped.make({}),
    Unknown: (): RunEnding => RunEnding.cases.Unknown.make({}),
  })

/** A Run being watched to its end, and the Person it acts for. */
interface Followed {
  readonly id: RunId
  readonly threadId: ThreadId
  readonly person: Person
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
  const activities = yield* Activities
  const notifier = yield* Notifier
  const presence = yield* Presence
  const titles = yield* ThreadTitles
  const channels = yield* ChannelReplies
  const devices = yield* DeviceRegistry
  const scope = yield* Effect.scope

  /**
   * Tells the Person Vivid worked for that it is done, unless they are watching it happen or it
   * happened in a Background Thread, which speaks to them only through the Feed (`place.ts`).
   */
  const announce = Effect.fn('Conversation.announce')(function* (
    thread: StoredThread,
    personId: PersonId,
    settlement: Settlement,
  ) {
    if (Settlement.guards.Stopped(settlement)) return
    if (!notifiesFrom(thread.place)) return
    if (yield* presence.watching(thread.id, personId)) return
    // A Run can outlast its Person's place in the Thread. The notice quotes the title and the
    // reply, so it is only written for someone who may still read them.
    const reach = canSee(thread.id, personId).pipe(Effect.provideService(Database, database))
    if (!(yield* reach)) return
    yield* notifier.notify({
      personId,
      companyId: thread.companyId,
      kind: 'finished',
      title: thread.title,
      body: Settlement.guards.Completed(settlement)
        ? settlement.reply.slice(0, 240)
        : 'Vivid could not finish this.',
      threadId: thread.id,
    })
  })

  /** Owes the notice a settled Run earns; a completion whose origin is quiet (`automaticallyNotifies`) earns none. */
  const owe = Effect.fn('Conversation.owe')(function* (
    run: Followed,
    settlement: Settlement,
    thread: StoredThread,
  ) {
    const quiet =
      Settlement.guards.Completed(settlement) &&
      !(yield* automaticallyNotifies(run.id).pipe(Effect.provideService(Database, database)))
    if (!quiet) yield* announce(thread, run.person.id, settlement)
  })

  /**
   * The conditional Run ending and its notice debt commit together, so a notice is owed exactly
   * when the Run ends. Owing runs in its own savepoint: a notice that cannot be owed rolls back to
   * it and is logged, and the Run still ends. Without the savepoint a failed owe rolled back the
   * ending too, and the Run stayed Working through every restart that tried again.
   */
  const end = Effect.fn('Conversation.end')(function* (run: Followed, settlement: Settlement) {
    const changed = yield* runs.end(run.id, endingOf(settlement))
    if (!changed) return false
    const thread = yield* findThread(run.threadId).pipe(Effect.provideService(Database, database))
    if (Option.isNone(thread)) return true
    yield* database
      .transaction(() => owe(run, settlement, thread.value))
      .pipe(
        Effect.withErrorReporting,
        Effect.catch((error) =>
          Effect.logError('A settled Run could not owe its notice', {
            runId: run.id,
            reason: error._tag,
          }),
        ),
      )
    return true
  })

  return Effect.fn('Conversation.observe')(function* (run: Followed) {
    const updates = yield* changes.subscribe(
      [Topic.thread(run.threadId), Topic.person(run.person.id)],
      ['activity', 'notifications'],
    )
    const refresh = activities
      .refresh(run.person.id)
      .pipe(Effect.catch(() => Effect.logWarning('Live Activity refresh failed')))
    yield* updates.pipe(
      Stream.runForEach(() => refresh),
      Effect.forkScoped,
    )
    yield* activities
      .refresh(run.person.id)
      .pipe(Effect.catch(() => Effect.logWarning('Live Activity refresh failed')))
    const settlement = yield* runtime.settled(run.threadId, run.id)
    const changed = yield* database.transaction(() => end(run, settlement))
    yield* activities
      .refresh(run.person.id)
      .pipe(Effect.catch(() => Effect.logWarning('Live Activity refresh failed')))
    // The conditional write owns reporting too: replay and restart observers cannot count twice.
    if (changed && Settlement.guards.Failed(settlement))
      yield* recordRunFailure({
        threadId: run.threadId,
        runId: run.id,
        reason: settlement.reason,
        status: Option.fromUndefinedOr(settlement.providerStatus),
      })
    yield* devices.ended(run.id)
    if (!changed) return
    // Naming lives in the server scope as its own fiber; even a stalled model cannot hold settlement open.
    yield* titles.afterRun(run.threadId).pipe(Effect.forkIn(scope))
    const thread = yield* findThread(run.threadId).pipe(Effect.provideService(Database, database))
    if (Option.isNone(thread)) return
    const reply = Settlement.guards.Completed(settlement)
      ? Option.some(settlement.reply)
      : Option.none<string>()
    yield* threads.touch(
      run.threadId,
      Option.filter(reply, (text) => text.trim().length > 0),
    )
    // A settled Run moved the Thread's activity and nothing else of its audience's data: what the
    // Run made (an Artifact, a question, a notification) is announced by the store that wrote it.
    yield* changes.publish(
      audienceTopics(thread.value, yield* threads.participants(thread.value.id)).map(
        Topic.part('activity'),
      ),
    )
    // A reply transport failure must not prevent Thread state or notifications from settling.
    yield* channels.ended({ runId: run.id, threadId: run.threadId, settlement }).pipe(
      Effect.withErrorReporting,
      Effect.catch((error) =>
        Effect.logWarning('A channel reply could not be sent', { reason: error._tag }),
      ),
    )
  }, Effect.scoped)
})

const threadMissing = () => Effect.fail(new NotFound({ message: 'Thread not found' }))

/** Retry uncertain admissions with the same durable key. Cell activation has no server deadline. */
const admitRuntime = Effect.fn('Conversation.admitRuntime')(
  (runtime: Runtime['Service'], input: Parameters<Runtime['Service']['admit']>[0]) =>
    runtime.admit(input).pipe(
      Effect.retry({
        while: (error) => Predicate.isTagged(error, 'AdmissionUncertain'),
        schedule: Schedule.exponential('1 second').pipe(Schedule.upTo({ times: 2 })),
      }),
      Effect.catchTag(['AdmissionRefused', 'AdmissionUncertain'], () =>
        Effect.fail(RuntimeUnavailable.make({ message: 'Vivid could not be reached' })),
      ),
    ),
)

/** Producers keep durable receipts and retry on their own schedule; Busy never waits in-process. */
const makeDeliver = (admit: ConversationService['admit'], runs: RunStore['Service']) =>
  Effect.fn('Conversation.deliver')(function* (delivery: ServerDelivery) {
    const admitted = yield* admit(delivery)
    const recorded = yield* runs.list(delivery.threadId)
    const run = recorded.find((candidate) => candidate.id === admitted.runId)
    return run === undefined ? yield* threadMissing() : run
  })

/** Resolve attribution at the persistence boundary; a missing Person cannot start a Run. */
const resolvePerson = (database: Database['Service']) => {
  /** The Person a delivery is for, who must exist; otherwise the delivery has nobody behind it. */
  return Effect.fn('Conversation.personOf')(function* (personId: PersonId) {
    const person = yield* findPerson(personId).pipe(Effect.provideService(Database, database))
    return Option.isNone(person) ? yield* threadMissing() : person.value
  })
}

/** Resolve signal speech independently from the Person whose authority the continuation carries. */
const resolveSpeaker = (database: Database['Service']) => {
  const personOf = resolvePerson(database)
  const withDatabase = Effect.provideService(Database, database)
  /**
   * A decision continues the Run under the Person it started for, including their Connections.
   * The decider speaks in the signal and must independently still be able to see the Thread;
   * approving or answering never lends the decider's authority to that continuation.
   */
  return Effect.fn('Conversation.speakerName')(function* (
    delivery: Delivery,
    thread: StoredThread,
    acting: Person,
  ) {
    return yield* DeliverySpeaker.match(delivery.speaker, {
      Acting: () => Effect.succeed(acting.name),
      Vivid: () => Effect.succeed('Vivid'),
      Decider: Effect.fn('Conversation.decider')(function* ({ personId }) {
        if (!(yield* canSee(thread.id, personId).pipe(withDatabase))) return yield* threadMissing()
        return (yield* personOf(personId)).name
      }),
    })
  })
}

/** Admission owns reservation, runtime acceptance, input settlement and scoped Run observation. */
const makeConversation = Effect.fn('Conversation.make')(function* () {
  const database = yield* Database
  const runtime = yield* Runtime
  const threads = yield* ThreadStore
  const runs = yield* RunStore
  const changes = yield* Changes
  const scope = yield* Effect.scope
  const observe = yield* makeObserve()
  // Serialize reservation through the runtime receipt, never the response itself. Pending admissions
  // recheck under one Thread permit; SQL still protects turn allocation without spanning runtime I/O.
  const admissions = keyedPermits<ThreadId>()
  const withDatabase = Effect.provideService(Database, database)

  // Runs with an observer in this process. A delivery the runtime recognises as a repeat does not mean
  // someone is watching it: the first attempt may have failed between admission and observation.
  // Whether to observe is decided by this set, never by what the runtime says about repeats.
  const observed = new Set<RunId>()

  /** Observes a Run in the background for the life of the server, logging what it cannot do. */
  const follow = (run: Followed) => {
    if (observed.has(run.id)) return Effect.void
    observed.add(run.id)
    return observe(run).pipe(
      Effect.withErrorReporting,
      Effect.catch((error) => Effect.logError('A Run could not be settled', error._tag)),
      Effect.ensuring(Effect.sync(() => observed.delete(run.id))),
      Effect.forkIn(scope),
      Effect.asVoid,
    )
  }

  const personOf = resolvePerson(database)

  const speakerName = resolveSpeaker(database)

  /**
   * The server never joins a different Person's delivery into a response in progress. The locked
   * reservation refuses it with the first Person's name before any message or signal reaches the runtime.
   */
  const admit: ConversationService['admit'] = Effect.fn('Conversation.admit')(
    function* (delivery: Delivery) {
      const found = yield* findThread(delivery.threadId).pipe(withDatabase)
      if (Option.isNone(found)) return yield* threadMissing()
      const thread = found.value
      // A channel can never widen phone ownership into a Company or shared Thread's authority.
      if (DeliveryMessage.guards.ChannelText(delivery.message)) {
        const visible = yield* threads.view(thread, delivery.personId)
        if (thread.companyId !== null || !ThreadAudience.guards.Private(visible.audience))
          return yield* threadMissing()
      }
      if (!(yield* canSee(thread.id, delivery.personId).pipe(withDatabase)))
        return yield* threadMissing()
      const speaker = yield* personOf(delivery.personId)
      const from = yield* speakerName(delivery, thread, speaker)
      const creator = yield* personOf(thread.personId)
      const id = deliveryRunId(thread.id, delivery.idempotencyKey)
      const reservation = yield* runs.start({
        id,
        threadId: thread.id,
        personId: speaker.id,
        origin: delivery.origin,
      })
      const said = previewOf(delivery.message)
      // Replay completes inside the reservation match; only a new reserved turn reaches the runtime.
      const turn = yield* TurnReservation.match<Effect.Effect<number | Admitted, Conflict>>(
        reservation,
        {
          Reserved: (reserved) => Effect.succeed(reserved.turn),
          Replayed: (replayed) =>
            follow({ id, threadId: thread.id, person: speaker }).pipe(Effect.as(replayed.receipt)),
          Busy: ({ person }) =>
            Effect.fail(
              Conflict.make({
                message: `Vivid is still answering ${person.name}. Send this again when it has finished.`,
              }),
            ),
        },
      )
      if (!Predicate.isNumber(turn)) return turn
      const admission = yield* Effect.gen(function* () {
        const deliveryScope = yield* runs.scope({ threadId: thread.id, turn })
        return yield* admitRuntime(runtime, {
          threadId: thread.id,
          message: runtimeMessage(thread.audience, from, delivery.message, turn),
          origin: { creator: creator.id, creatorName: creator.name },
          idempotencyKey: delivery.idempotencyKey,
          clientKey: delivery.clientKey,
          turn,
          scope: deliveryScope,
        })
      }).pipe(
        Effect.tapError(() => runs.end(id, RunEnding.cases.Failed.make({ reason: 'Delivery' }))),
        Effect.onInterrupt(() => runs.end(id, RunEnding.cases.Failed.make({ reason: 'Delivery' }))),
      )
      // Replays returned above. Only a newly reserved ordinary message accepted by the runtime
      // closes questions and handoffs; refusals and every server-produced delivery leave them.
      // A handoff's withdrawal is only claimed here; `sendToThread` empties its fields.
      if (movesThreadOn(delivery)) {
        yield* withdrawWaiting(thread.id, speaker.id).pipe(
          withDatabase,
          Effect.provideService(Changes, changes),
        )
        yield* claimWithdrawalsFor(thread.id, speaker.id).pipe(withDatabase)
      }
      yield* runs.admitted(admission)
      yield* threads.touch(thread.id, said)
      // What a Person just sent is not unread for them. They were just shown to be able to see the
      // Thread, so the only failures left here are the database's own.
      yield* threads
        .markRead(speaker.id, thread.id)
        .pipe(
          Effect.catchTag(['NotFound', 'Forbidden', 'InvalidRequest', 'Conflict'], threadMissing),
        )
      // A message admitted: a Run, the Thread's last words and the speaker's read mark.
      yield* changes.publish(
        audienceTopics(thread, yield* threads.participants(thread.id)).map(Topic.part('activity')),
      )
      yield* follow({ id: admission.runId, threadId: thread.id, person: speaker })
      return {
        runId: admission.runId,
        submissionId: admission.submissionId,
      } satisfies Admitted
    },
    (effect, delivery) => admissions.withPermit(delivery.threadId, effect),
  )

  const deliver: ConversationService['deliver'] = makeDeliver(admit, runs)

  // A server restarting while Runs are in progress picks each one back up: the runtime still knows
  // how they ended, or says it does not, and either way the row stops claiming it is working.
  yield* Effect.forEach(yield* runs.working, resume, { discard: true })

  function resume(run: WorkingRun) {
    return personOf(run.personId).pipe(
      Effect.flatMap((person) => follow({ id: run.id, threadId: run.threadId, person })),
      Effect.withErrorReporting,
      Effect.catch(() => Effect.logWarning('A working Run has nobody behind it any more')),
    )
  }

  return Conversation.of({ deliver, admit })
})

/** Needs a `Scope`: the Runs it observes live as long as the server does. */
export const conversationLayer = Layer.effect(Conversation, makeConversation()).pipe(
  Layer.provideMerge(deviceLayer),
  Layer.provide(activitiesLayer),
)
