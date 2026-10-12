import * as Effect from 'effect/Effect'
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
import { submissionId } from '../runtime/identity.ts'
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
import { serializeAdmissions } from './admissions.ts'
import { flueMessage } from './message.ts'
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
  const titles = yield* ThreadTitles
  const channels = yield* ChannelReplies
  const devices = yield* DeviceRegistry
  const scope = yield* Effect.scope

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
    const settlement = yield* runtime.settled(run.threadId, run.id)
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

/** The current Conversation wire contract maps precise admission errors until durable observation owns uncertainty. */
const admitRuntime = Effect.fn('Conversation.admitRuntime')(
  (runtime: Runtime['Service'], input: Parameters<Runtime['Service']['admit']>[0]) =>
    runtime
      .admit(input)
      .pipe(
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

  const personOf = resolvePerson(database)

  const speakerName = resolveSpeaker(database)

  /**
   * The server never joins a different Person's delivery into a response in progress. The locked
   * reservation refuses it with the first Person's name before any message or signal reaches Flue.
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
      const id = submissionId(thread.id, delivery.idempotencyKey)
      const reservation = yield* runs.start({
        id,
        threadId: thread.id,
        personId: speaker.id,
        origin: delivery.origin,
        libraryFolder: delivery.libraryFolder === undefined ? null : delivery.libraryFolder,
      })
      const said = previewOf(delivery.message)
      // Replay completes inside the reservation match; only a new reserved turn reaches Flue.
      const turn = yield* TurnReservation.match<Effect.Effect<number | Admitted, Conflict>>(
        reservation,
        {
          Reserved: (reserved) => Effect.succeed(reserved.turn),
          Replayed: (replayed) =>
            follow({ id, threadId: thread.id, person: speaker, said }).pipe(
              Effect.as(replayed.receipt),
            ),
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
      // Replays returned above. Only a newly reserved ordinary message accepted by the runtime
      // closes questions; refusals and every server-produced delivery leave them waiting.
      if (movesThreadOn(delivery))
        yield* withdrawWaiting(thread.id, speaker.id).pipe(
          withDatabase,
          Effect.provideService(Changes, changes),
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
      // A message admitted: a Run, the Thread's last words and the speaker's read mark.
      yield* changes.publish(
        audienceTopics(thread, yield* threads.participants(thread.id)).map(Topic.part('activity')),
      )
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

  // A server restarting while Runs are in progress picks each one back up: Flue still knows
  // how they ended, or says it does not, and either way the row stops claiming it is working.
  yield* Effect.forEach(yield* runs.working, resume, { discard: true })

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
export const conversationLayer = Layer.effect(Conversation, makeConversation()).pipe(
  Layer.provideMerge(deviceLayer),
)
