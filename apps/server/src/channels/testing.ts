import * as NodeCrypto from 'node:crypto'
import { RuntimeSubmissionId } from '@vivid/contracts'
import { expect } from '@effect/vitest'
import { eq, inArray } from 'drizzle-orm'
import {
  ChannelAddress,
  ChannelProviderFailed,
  Person,
  PersonId,
  RunId,
  SessionId,
  Workspace,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { Clock, Context, Deferred, Effect, Layer, Option, Queue, Ref, Stream } from 'effect'
import { HttpClientRequest, HttpClientResponse } from 'effect/http'
import { auditLayer } from '../audit/record.ts'
import { personTable, sessionTable } from '../auth/tables.ts'
import { type Actor } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { testDatabaseLayer } from '../database/testdb.ts'
import { changesLayer } from '../live/changes.ts'
import { silentLearningLayer } from '../memory/testing.ts'
import { Notifier } from '../notifications/notifier.ts'
import { Admission, Runtime, Settlement } from '../runtime/client.ts'
import { deliveryRunId } from '../threads/key.ts'
import { conversationLayer } from '../threads/delivery.ts'
import { ThreadTitles } from '../threads/generation.ts'
import { Presence } from '../threads/presence.ts'
import { runStoreLayer } from '../threads/runs.ts'
import { threadStoreLayer } from '../threads/store.ts'
import { threads } from '../threads/tables.ts'
import { ChannelReceiver, channelReceiverLayer } from './inbound.ts'
import { channelLedgerLayer } from './ledger.ts'
import {
  ChannelEnrolment,
  ChannelEnrolmentId,
  ChannelInbound,
  ChannelMessageId,
  ChannelProvider,
  ChannelDisconnected,
  ChannelRecipientMissing,
  ChannelSendUnknown,
} from './provider.ts'
import { ChannelReplies, channelRepliesLayer, type ChannelEnding } from './replies.ts'
import { channelStoreLayer } from './store.ts'
import { channelMessages } from './tables.ts'

type RuntimeInput = Parameters<Runtime['Service']['admit']>[0]
type Send = Parameters<ChannelProvider['Service']['send']>[0]

interface ChannelControlService {
  readonly endings: Queue.Queue<ChannelEnding>
  readonly sends: Ref.Ref<ReadonlyArray<Send>>
  readonly sending: Queue.Queue<Send>
  readonly dispatch: Ref.Ref<Effect.Effect<void, ChannelRecipientMissing | ChannelSendUnknown>>
  readonly connections: Queue.Queue<void>
  readonly disconnect: Ref.Ref<boolean>
  readonly enrols: Ref.Ref<ReadonlyArray<ChannelAddress>>
  readonly unenrols: Ref.Ref<ReadonlyArray<ChannelEnrolmentId>>
  readonly failure: Ref.Ref<Option.Option<ChannelProviderFailed>>
  readonly inbound: Queue.Queue<ChannelInbound>
  readonly admitted: Queue.Queue<RuntimeInput>
  readonly admissions: Ref.Ref<ReadonlyArray<RuntimeInput>>
  readonly finish: (id: RunId, settlement: Settlement) => Effect.Effect<void>
}
export class ChannelControl extends Context.Service<ChannelControl, ChannelControlService>()(
  'vivid/ChannelTestControl',
) {}

/** Only provider/runtime dependencies are replaced; link, Thread and Run persistence stay real. */
const ports = Layer.effectContext(
  Effect.gen(function* () {
    const endings = yield* Queue.unbounded<ChannelEnding>()
    const sends = yield* Ref.make<ReadonlyArray<Send>>([])
    const sending = yield* Queue.unbounded<Send>()
    const dispatch = yield* Ref.make<
      Effect.Effect<void, ChannelRecipientMissing | ChannelSendUnknown>
    >(Effect.void)
    const connections = yield* Queue.unbounded<void>()
    const disconnect = yield* Ref.make(false)
    const enrols = yield* Ref.make<ReadonlyArray<ChannelAddress>>([])
    const unenrols = yield* Ref.make<ReadonlyArray<ChannelEnrolmentId>>([])
    const failure = yield* Ref.make<Option.Option<ChannelProviderFailed>>(Option.none())
    const inbound = yield* Queue.unbounded<ChannelInbound>()
    const admitted = yield* Queue.unbounded<RuntimeInput>()
    const admissions = yield* Ref.make<ReadonlyArray<RuntimeInput>>([])
    const settlements = new Map<RunId, Deferred.Deferred<Settlement>>()
    const control = ChannelControl.of({
      endings,
      sends,
      sending,
      dispatch,
      connections,
      disconnect,
      enrols,
      unenrols,
      failure,
      inbound,
      admitted,
      admissions,
      finish: Effect.fn('Channels.test.finish')(function* (id, settlement) {
        const waiting = settlements.get(id)
        if (waiting === undefined)
          return yield* Effect.sync(() => expect.fail('No admitted Run to finish'))
        return yield* Deferred.succeed(waiting, settlement).pipe(Effect.asVoid)
      }),
    })
    const provider = ChannelProvider.of({
      channels: ['iMessage'],
      enrol: Effect.fn('Channels.test.enrol')(function* (_channel, address) {
        const refusal = yield* Ref.get(failure)
        if (Option.isSome(refusal)) return yield* refusal.value
        yield* Ref.update(enrols, (all) => [...all, address])
        return ChannelEnrolment.make({
          id: ChannelEnrolmentId.make(NodeCrypto.randomUUID()),
          textTo: ChannelAddress.make('+12025550100'),
        })
      }),
      unenrol: Effect.fn('Channels.test.unenrol')((_, id) =>
        Ref.update(unenrols, (all) => [...all, id]),
      ),
      inbound: Stream.unwrap(
        Effect.gen(function* () {
          yield* Queue.offer(connections, undefined)
          const drop = yield* Ref.getAndSet(disconnect, false)
          return drop
            ? Stream.fail(new ChannelDisconnected({ channel: 'iMessage' }))
            : Stream.fromQueue(inbound)
        }),
      ),
      send: Effect.fn('Channels.test.send')(function* (input) {
        yield* Queue.offer(sending, input)
        yield* yield* Ref.get(dispatch)
        yield* Ref.update(sends, (all) => [...all, input])
      }),
    })
    const runtime = Runtime.of({
      admit: Effect.fn('Channels.test.admit')(function* (input) {
        const id = deliveryRunId(input.threadId, input.idempotencyKey)
        const repeated = settlements.has(id)
        if (!repeated) settlements.set(id, yield* Deferred.make<Settlement>())
        yield* Ref.update(admissions, (all) => [...all, input])
        yield* Queue.offer(admitted, input)
        return Admission.make({
          runId: id,
          submissionId: RuntimeSubmissionId.make(input.turn),
          repeated,
        })
      }),
      settled: (_, id) => {
        const waiting = settlements.get(id)
        return waiting === undefined ? Effect.never : Deferred.await(waiting)
      },
      stop: () => Effect.succeed(false),
      watch: () => Stream.never,
      read: () =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            HttpClientRequest.get('http://runtime.test'),
            new Response('{}'),
          ),
        ),
    })
    return Context.make(ChannelControl, control).pipe(
      Context.add(ChannelProvider, provider),
      Context.add(Runtime, runtime),
      Context.add(Notifier, { notify: () => Effect.void }),
    )
  }),
)

const foundation = Layer.mergeAll(ports, silentLearningLayer).pipe(
  Layer.provideMerge(testDatabaseLayer),
)
const stores = Layer.mergeAll(changesLayer, runStoreLayer, threadStoreLayer, auditLayer).pipe(
  Layer.provideMerge(foundation),
)
const links = Layer.mergeAll(
  channelStoreLayer,
  channelLedgerLayer,
  Layer.succeed(Presence, {
    hold: () => Effect.void,
    here: () => Effect.succeed([]),
    watching: () => Effect.succeed(true),
    present: () => Effect.succeed(false),
  }),
).pipe(Layer.provideMerge(stores))
const replies = channelRepliesLayer.pipe(Layer.provideMerge(links))
/** Observe actual reply handling with a typed receipt so tests never poll Run or ledger state. */
const observedReplies = Layer.effect(
  ChannelReplies,
  Effect.gen(function* () {
    const actual = yield* ChannelReplies
    const control = yield* ChannelControl
    return ChannelReplies.of({
      ended: Effect.fn('Channels.test.observedReply')((event) =>
        actual
          .ended(event)
          .pipe(Effect.ensuring(Queue.offer(control.endings, event).pipe(Effect.asVoid))),
      ),
    })
  }),
).pipe(Layer.provideMerge(replies))
const conversation = conversationLayer.pipe(
  Layer.provide(Layer.mock(ThreadTitles, { afterRun: () => Effect.void })),
  Layer.provideMerge(observedReplies),
)
export const channelTestLayer = channelReceiverLayer.pipe(Layer.provideMerge(conversation))

/** Cleanup failure is a failing test, never a warning hiding leaked fixtures. */
const cleanupFailed = () => Effect.sync(() => expect.fail('Channel fixture cleanup failed'))

/** Fixtures own unique addresses and register cleanup before their first write, including replay receipts for unlinked senders. */
export const fixture = Effect.fn('Channels.test.fixture')(function* () {
  const database = yield* Database
  const person = Person.make({
    id: PersonId.make(NodeCrypto.randomUUID()),
    name: 'Channel test',
    email: `${NodeCrypto.randomUUID()}@example.test`,
    image: null,
  })
  const sessionId = SessionId.make(NodeCrypto.randomUUID())
  const address = ChannelAddress.make(`+1202${NodeCrypto.randomInt(1000000, 9999999)}`)
  const messageIds = yield* Ref.make<ReadonlyArray<ChannelMessageId>>([])
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* database.run(
        database
          .delete(channelMessages)
          .where(inArray(channelMessages.providerId, yield* Ref.get(messageIds))),
      )
      yield* database.run(database.delete(threads).where(eq(threads.personId, person.id)))
      yield* database.run(database.delete(personTable).where(eq(personTable.id, person.id)))
    }).pipe(Effect.catch(cleanupFailed)),
  )
  yield* database.run(database.insert(personTable).values(person))
  yield* database.run(
    database.insert(sessionTable).values({
      id: sessionId,
      token: NodeCrypto.randomUUID(),
      userId: person.id,
      expiresAt: new Date('2100-01-01'),
    }),
  )
  const actor: Actor = {
    person,
    workspace: Workspace.cases.Personal.make({}),
    by: 'person',
    threadId: Option.none(),
  }
  const auth = AuthState.Person({ person, workspace: actor.workspace, sessionId })
  const receiver = yield* ChannelReceiver
  /** Every test message uses the production decoded envelope seam and captures teardown authority first. */
  const message = Effect.fn('Channels.test.message')(function* (text: string) {
    const id = ChannelMessageId.make(NodeCrypto.randomUUID())
    yield* Ref.update(messageIds, (all) => [...all, id])
    return ChannelInbound.make({
      id,
      channel: 'iMessage',
      sender: address,
      text,
      receivedAt: yield* Clock.currentTimeMillis,
    })
  })
  const receive = Effect.fn('Channels.test.receive')(function* (text: string) {
    yield* receiver.receive(yield* message(text))
  })
  /** Wait on the real observer's reply receipt, including app Runs which correctly send nothing. */
  const finish = Effect.fn('Channels.test.observedFinish')(function* (id: RunId, reply: string) {
    const control = yield* ChannelControl
    yield* control.finish(id, Settlement.cases.Completed.make({ reply, responseId: id }))
    const event = yield* Queue.take(control.endings)
    expect(event.runId).toBe(id)
    return event
  })
  return {
    actor,
    address,
    auth,
    signedIn: Effect.provideService(AuthContext, auth),
    message,
    receive,
    finish,
  }
})
