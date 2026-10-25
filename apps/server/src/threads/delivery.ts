import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
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
import { withdrawWaiting } from '../inputs/store.ts'
import { Changes, Topic } from '../live/changes.ts'
import { Learning } from '../memory/learn.ts'
import { Notifier } from '../notifications/notifier.ts'
import { deliveryRunId } from './key.ts'
import { recordRunFailure } from '../runtime/failure.ts'
import { AdmissionUncertain, Runtime, Settlement } from '../runtime/client.ts'
import { runLossAllowance } from '../runtime/settlement.ts'
import { audienceTopics, canSee, findThread, type StoredThread } from './access.ts'
import {
  Conversation,
  DeliveryMessage,
  DeliverySpeaker,
  movesThreadOn,
  Admitted,
  type AdmissionOutcome,
  type ConversationService,
  type Delivery,
  type ServerDelivery,
} from './conversation.ts'
import { notifiesFrom } from './place.ts'
import { withAdmission } from './admissions.ts'
import { runtimeMessage } from './message.ts'
import { Presence } from './presence.ts'
import {
  RunStore,
  RunEnding,
  TurnReservation,
  ReservationNotice,
  automaticallyNotifies,
  WorkingRun,
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
  readonly creator: PersonId
  readonly outcome: Effect.Effect<Settlement>
  readonly said: Option.Option<string>
}

/** The persisted receipt and creator identify the runtime observation; the speaker identifies attribution. */
const followed =
  (runtime: Runtime['Service']) =>
  (
    receipt: Admitted,
    thread: StoredThread,
    person: Person,
    said: Option.Option<string>,
  ): Followed => ({
    id: receipt.runId,
    threadId: thread.id,
    creator: thread.personId,
    person,
    outcome: runtime.settled(thread.personId, thread.id, receipt.submissionId),
    said,
  })

/**
 * Builds the observer of one Run: it waits for the Run to end and writes down how. It runs for as
 * long as the Run does, outside the request that started it, and acts only if it is the one that
 * moves the Run out of `working`, so a settlement observed twice is handled once.
 */
const makeObserve = Effect.fn('Conversation.makeObserve')(function* () {
  const database = yield* Database
  const threads = yield* ThreadStore
  const runs = yield* RunStore
  const changes = yield* Changes
  const notifier = yield* Notifier
  const presence = yield* Presence
  const learning = yield* Learning
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

  return Effect.fn('Conversation.observe')(function* (run: Followed) {
    const settlement = yield* run.outcome
    const changed = yield* runs.end(run.id, endingOf(settlement))
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
    // A reply transport failure must not prevent Thread state, notifications, or learning from settling.
    yield* channels
      .ended({ runId: run.id, threadId: run.threadId, settlement })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning('A channel reply could not be sent', { reason: error._tag }),
        ),
      )
    const quiet =
      Settlement.guards.Completed(settlement) &&
      !(yield* automaticallyNotifies(run.id).pipe(Effect.provideService(Database, database)))
    if (!quiet) yield* announce(thread.value, run.person.id, settlement)
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
  Effect.fn('Conversation.deliver')(function* (delivery: ServerDelivery) {
    const admitted = yield* admit(delivery)
    return yield* runs.get(admitted.runId)
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

/** A linked personal channel never widens its reach into a Company or a shared Thread. */
const deliveryThread = Effect.fn('Conversation.thread')(function* (
  database: Database['Service'],
  threads: ThreadStore['Service'],
  delivery: Delivery,
) {
  const withDatabase = Effect.provideService(Database, database)
  const found = yield* findThread(delivery.threadId).pipe(withDatabase)
  if (Option.isNone(found)) return yield* threadMissing()
  const thread = found.value
  if (DeliveryMessage.guards.ChannelText(delivery.message)) {
    const visible = yield* threads.view(thread, delivery.personId)
    if (thread.companyId !== null || !ThreadAudience.guards.Private(visible.audience))
      return yield* threadMissing()
  }
  if (!(yield* canSee(thread.id, delivery.personId).pipe(withDatabase)))
    return yield* threadMissing()
  return thread
})

/** Admission receives server-owned authorities once; it does not own observer lifetime. */
interface AdmissionServices {
  readonly lossAllowance: number
  readonly database: Database['Service']
  readonly runtime: Runtime['Service']
  readonly threads: ThreadStore['Service']
  readonly runs: RunStore['Service']
  readonly changes: Changes['Service']
  readonly follow: (run: Followed) => Effect.Effect<void>
}

/** A locked reservation carries the identities and attribution already resolved at ingress. */
interface ReservedDelivery {
  readonly delivery: Delivery
  readonly thread: StoredThread
  readonly speaker: Person
  readonly creator: Person
  readonly from: string
  readonly id: RunId
  readonly turn: number
  readonly said: Option.Option<string>
}

/** Only a reservation rechecked under the gate may reach Pi; no database transaction spans I/O. */
const submitReserved = Effect.fn('Conversation.submitReserved')(
  function* (services: AdmissionServices, reserved: ReservedDelivery) {
    const { database, runtime, threads, runs, changes, follow } = services
    const { delivery, thread, speaker, creator, from, id, turn, said } = reserved
    const withDatabase = Effect.provideService(Database, database)
    const addressed = {
      threadId: thread.id,
      message: runtimeMessage(thread.audience, from, delivery.message, turn),
      origin: { creator: creator.id, creatorName: creator.name },
      idempotencyKey: delivery.idempotencyKey,
      turn,
      scope: yield* runs.scope({ threadId: thread.id, turn }),
    }
    const input =
      delivery.clientKey === undefined ? addressed : { ...addressed, clientKey: delivery.clientKey }
    const deadline = (yield* Clock.currentTimeMillis) + services.lossAllowance
    let attempts = 0
    /** All attempts share a key, an absolute loss deadline and a maximum of three calls.
     * Interruption runs the remaining attempts in this request's finalizer, never a follower. */
    const submit = Effect.gen(function* () {
      const remaining = deadline - (yield* Clock.currentTimeMillis)
      if (remaining <= 0 || attempts === 3)
        return yield* AdmissionUncertain.make({ threadId: thread.id, reason: 'Interrupted' })
      const admission = yield* Effect.suspend(() => {
        attempts += 1
        return runtime.admit(input)
      }).pipe(
        Effect.retry({
          while: (error) => Predicate.isTagged(error, 'AdmissionUncertain') && attempts < 3,
        }),
        Effect.timeoutOrElse({
          duration: remaining,
          orElse: () =>
            Effect.fail(AdmissionUncertain.make({ threadId: thread.id, reason: 'TimedOut' })),
        }),
      )
      const receipt = Admitted.make({ runId: id, submissionId: admission.submissionId })
      yield* runs.admitted(receipt)
      if (movesThreadOn(delivery))
        yield* withdrawWaiting(thread.id, speaker.id).pipe(
          withDatabase,
          Effect.provideService(Changes, changes),
        )
      yield* threads.touch(thread.id, said)
      yield* threads
        .markRead(speaker.id, thread.id)
        .pipe(
          Effect.catchTag(['NotFound', 'Forbidden', 'InvalidRequest', 'Conflict'], threadMissing),
        )
      yield* changes.publish(
        audienceTopics(thread, yield* threads.participants(thread.id)).map(Topic.part('activity')),
      )
      yield* follow(followed(runtime)(receipt, thread, speaker, said))
      return receipt
    }).pipe(
      Effect.mapError((error) =>
        Predicate.isTagged(error, 'AdmissionRefused') ||
        Predicate.isTagged(error, 'AdmissionUncertain')
          ? RuntimeUnavailable.make({ message: 'Vivid could not be reached' })
          : error,
      ),
    )
    return yield* submit.pipe(
      Effect.onInterrupt(() =>
        submit.pipe(Effect.catchTag('RuntimeUnavailable', () => Effect.void)),
      ),
    )
  },
  // Cleanup covers the scope read and every admission write, including a failed interruption
  // retry. Only receiptless work belongs to this request; admitted work retains its recovery receipt.
  (effect, services, reserved) =>
    effect.pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.gen(function* () {
              const run = yield* services.runs.get(reserved.id)
              if (run.submissionId === undefined)
                yield* services.runs.end(
                  reserved.id,
                  RunEnding.cases.Failed.make({ reason: 'Delivery' }),
                )
            }),
      ),
    ),
)

/** Read Busy and replays before waiting; reserve under the admission gate and SQL Thread lock.
 * Pi may hold and answer a delivery even if retries end Failed('Delivery'). The state link then
 * shows the reply with no Run attached. A client retry must keep its original key. */
function makeAdmit(services: AdmissionServices): ConversationService['admit'] {
  const { database, runtime, threads, runs, follow } = services
  const personOf = resolvePerson(database)
  const speakerName = resolveSpeaker(database)
  /**
   * The server never joins a different Person's delivery into a response in progress. The locked
   * reservation refuses it with the first Person's name before any message or signal reaches Pi.
   */
  return Effect.fn('Conversation.admit')(function* (delivery: Delivery) {
    const thread = yield* deliveryThread(database, threads, delivery)
    const speaker = yield* personOf(delivery.personId)
    const from = yield* speakerName(delivery, thread, speaker)
    const creator = yield* personOf(thread.personId)
    const id = deliveryRunId(thread.id, delivery.idempotencyKey)
    const said = previewOf(delivery.message)
    const input = {
      id,
      threadId: thread.id,
      personId: speaker.id,
      origin: delivery.origin,
    }
    /** Replays and refusals are read-only outcomes; only Reserved reaches the runtime. */
    const replay = (notice: ReservationNotice): Effect.Effect<AdmissionOutcome, Conflict> =>
      ReservationNotice.match(notice, {
        Unfollowed: ({ runId }) => Effect.succeed({ runId }),
        Replayed: (replayed) =>
          follow(followed(runtime)(replayed.receipt, thread, speaker, said)).pipe(
            Effect.as(replayed.receipt),
          ),
        Busy: ({ person }) =>
          Effect.fail(
            Conflict.make({
              message: `Vivid is still answering ${person.name}. Send this again when it has finished.`,
            }),
          ),
      })
    const notice = yield* runs.check(input)
    if (Option.isSome(notice)) return yield* replay(notice.value)
    // The preflight writes nothing, so canceling a queued request cannot strand a reservation.
    // Start checks again under the gate and SQL lock, after any preceding admission or Stop.
    return yield* withAdmission(
      Effect.gen(function* () {
        const reservation = yield* runs.start(input)
        return yield* TurnReservation.match<ReturnType<ConversationService['admit']>>(reservation, {
          Reserved: ({ turn }) =>
            submitReserved(services, { delivery, thread, speaker, creator, from, id, turn, said }),
          Unfollowed: replay,
          Replayed: replay,
          Busy: replay,
        })
      }),
      thread.id,
    )
  })
}

/** Admission owns reservation, runtime acceptance, input settlement and scoped Run observation. */
const makeConversation = Effect.fn('Conversation.make')(function* () {
  const database = yield* Database
  const runtime = yield* Runtime
  const lossAllowance = yield* runLossAllowance
  const threads = yield* ThreadStore
  const runs = yield* RunStore
  const changes = yield* Changes
  const scope = yield* Effect.scope
  const observe = yield* makeObserve()
  // Serialize reservation through Flue receipt, never the response itself. Pending admissions
  // recheck under one Thread permit; SQL still protects turn allocation without spanning runtime I/O.
  const withDatabase = Effect.provideService(Database, database)

  // Runs with an observer in this process. A delivery Pi recognises as a repeat does not mean
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

  const personOf = resolvePerson(database)

  const services = { database, runtime, threads, runs, changes, follow, lossAllowance }
  const admit = makeAdmit(services)

  const deliver: ConversationService['deliver'] = makeDeliver(admit, runs)

  // A server restarting while Runs are in progress picks each one back up: Pi still knows
  // how they ended, or says it does not, and either way the row stops claiming it is working.
  yield* Effect.forEach(yield* runs.working, resume, { discard: true })

  /** Reattach only admitted work; RunStore.working has already ended legacy and receiptless work. */
  function resume(run: WorkingRun) {
    return Effect.gen(function* () {
      const person = yield* personOf(run.personId)
      const thread = yield* findThread(run.threadId).pipe(withDatabase)
      if (Option.isNone(thread)) return yield* threadMissing()
      const found = thread.value
      return yield* follow({
        id: run.id,
        threadId: run.threadId,
        person,
        creator: found.personId,
        outcome: runtime.settled(found.personId, found.id, run.submissionId),
        said: Option.none(),
      })
    }).pipe(Effect.catch(() => Effect.logWarning('A working Run has nobody behind it any more')))
  }

  /** Observation and Stop share the conditional write and every settlement effect. */
  const stopped: ConversationService['stopped'] = Effect.fn('Conversation.stopped')(
    function* (ids) {
      yield* Effect.forEach(
        ids,
        Effect.fn('Conversation.stopRun')(function* (id) {
          const run = yield* runs.get(id)
          const person = yield* personOf(run.origin.person.id)
          const thread = yield* findThread(run.threadId).pipe(withDatabase)
          if (Option.isNone(thread)) return yield* threadMissing()
          return yield* observe({
            id,
            threadId: run.threadId,
            person,
            creator: thread.value.personId,
            outcome: Effect.succeed(Settlement.cases.Stopped.make({})),
            said: Option.none(),
          })
        }),
        { discard: true },
      )
    },
  )
  return Conversation.of({ deliver, admit, stopped })
})

/** Needs a `Scope`: the Runs it observes live as long as the server does. */
export const conversationLayer = Layer.effect(Conversation, makeConversation()).pipe(
  Layer.provideMerge(deviceLayer),
)
