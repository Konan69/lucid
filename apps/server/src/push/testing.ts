import * as NodeCrypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Clock, Context, Effect, Layer, Option, Redacted, Ref } from 'effect'
import {
  Person,
  PersonId,
  PushDestination,
  PushOutcome,
  SessionId,
  ThreadId,
  Workspace,
  type PushPayload,
} from '@vivid/contracts'
import { AuthState } from '@vivid/contracts/auth'
import { personTable, sessionTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseLayer } from '../database/testdb.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { presenceLayer } from '../threads/presence.ts'
import { runStoreLayer } from '../threads/runs.ts'
import { threadStoreLayer } from '../threads/store.ts'
import { threads } from '../threads/tables.ts'
import { PushAdapter } from './adapter.ts'
import { PushConfig, type PushConfiguration } from './config.ts'
import { Push, pushLayer } from './delivery.ts'
import { PushAcceptance, PushTargetGone, PushUncertain } from './receipts.ts'
import { pushTargetsLayer } from './targets.ts'

/** Ephemeral keys exist only in this test fixture; no operator credentials are read. */
const curve = NodeCrypto.createECDH('prime256v1')
curve.generateKeys()
export const testPushConfig: PushConfiguration = {
  publicKey: curve.getPublicKey().toString('base64url'),
  privateKey: Redacted.make(curve.getPrivateKey().toString('base64url')),
  subject: 'mailto:push@example.test',
}

export interface PushProbeService {
  readonly sent: Ref.Ref<ReadonlyArray<PushPayload>>
  readonly mode: Ref.Ref<'Browser' | 'Phone' | 'Gone' | 'Uncertain'>
  readonly receipt: Ref.Ref<Option.Option<'Confirmed' | 'Gone' | 'Rejected'>>
}
export class PushProbe extends Context.Service<PushProbe, PushProbeService>()(
  'vivid/test/PushProbe',
) {}

/** Substitute only remote delivery; target/session/Notification/ledger operations remain real. */
const fakeAdapterLayer = Layer.effect(
  PushProbe,
  Effect.gen(function* () {
    return PushProbe.of({
      sent: yield* Ref.make<ReadonlyArray<PushPayload>>([]),
      mode: yield* Ref.make<'Browser' | 'Phone' | 'Gone' | 'Uncertain'>('Browser'),
      receipt: yield* Ref.make(Option.none<'Confirmed' | 'Gone' | 'Rejected'>()),
    })
  }),
).pipe(Layer.provideMerge(silentChangesLayer))

const adapterLayer = Layer.effect(
  PushAdapter,
  Effect.gen(function* () {
    const probe = yield* PushProbe
    return PushAdapter.of({
      send: Effect.fn('PushTest.send')(function* (_destination, payload) {
        yield* Ref.update(probe.sent, (sent) => [...sent, payload])
        const mode = yield* Ref.get(probe.mode)
        if (mode === 'Gone') return yield* new PushTargetGone({})
        if (mode === 'Uncertain') return yield* new PushUncertain({})
        return mode === 'Phone'
          ? PushAcceptance.cases.Phone.make({ ticket: NodeCrypto.randomUUID(), confirmed: false })
          : PushAcceptance.cases.Browser.make({})
      }),
      receipt: Effect.fn('PushTest.receipt')(() => Ref.get(probe.receipt)),
    })
  }),
).pipe(Layer.provideMerge(fakeAdapterLayer))

/** Database, silent changes and immutable push configuration may be shared across test cases. */
export const pushTestFoundation = Layer.mergeAll(
  testDatabaseLayer,
  silentChangesLayer,
  Layer.succeed(PushConfig, testPushConfig),
)
/** Only remote delivery is substituted; persistence and notification semantics remain real. */
const foundation = Layer.merge(pushTestFoundation, adapterLayer)
const stores = Layer.mergeAll(
  pushTargetsLayer,
  presenceLayer,
  threadStoreLayer,
  runStoreLayer,
).pipe(Layer.provideMerge(foundation))
export const pushTestLayer = pushLayer.pipe(Layer.provideMerge(stores))

/**
 * For suites whose claim is not push: a Notification is still recorded in the app, and delivery
 * answers as it does for a Person with no device registered, without a database or a network.
 */
export const silentPushLayer = Layer.succeed(
  Push,
  Push.of({
    deliver: Effect.fn('PushTest.silentDeliver')(() =>
      Effect.succeed(PushOutcome.cases.NoTargets.make({})),
    ),
    reconcile: Effect.void.pipe(Effect.withSpan('PushTest.silentReconcile')),
  }),
)

/** Unique People and scopes isolate every test; cascade cleanup is registered before writes. */
export const fixture = Effect.fn('PushTest.fixture')(function* () {
  const database = yield* Database
  const person = Person.make({
    id: PersonId.make(NodeCrypto.randomUUID()),
    name: 'Ada',
    email: `${NodeCrypto.randomUUID()}@push.test`,
    image: null,
  })
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(personTable).where(eq(personTable.id, person.id))).pipe(
      Effect.tapError((error) => Effect.logError('Push fixture cleanup failed', error._tag)),
      Effect.ignore,
    ),
  )
  yield* database.run(
    database.insert(personTable).values({ id: person.id, name: person.name, email: person.email }),
  )
  const sessionId = SessionId.make(NodeCrypto.randomUUID())
  const now = yield* Clock.currentTimeMillis
  yield* database.run(
    database.insert(sessionTable).values({
      id: sessionId,
      userId: person.id,
      token: NodeCrypto.randomUUID(),
      expiresAt: new Date(now + 86_400_000),
    }),
  )
  const threadId = ThreadId.make(NodeCrypto.randomUUID())
  yield* database.run(
    database.insert(threads).values({
      id: threadId,
      personId: person.id,
      title: 'Waiting reply',
      titleSource: 'Person',
      companyId: null,
      audience: 'private',
      updatedAt: now,
    }),
  )
  const auth = AuthState.Person({ person, sessionId, workspace: Workspace.cases.Personal.make({}) })
  const destination = PushDestination.cases.Phone.make({
    token: `ExpoPushToken[${NodeCrypto.randomUUID()}]`,
  })
  return { database, person, sessionId, threadId, auth, destination }
})
