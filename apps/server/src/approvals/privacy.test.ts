import { describe, expect, it } from '@effect/vitest'
import { AskInputRequest, SessionId, ShareThreadRequest, type ThreadId } from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { eq } from 'drizzle-orm'
import { Effect, Layer, Option } from 'effect'
import type { Actor } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { InputStore, inputStoreLayer } from '../inputs/store.ts'
import { inputRequests } from '../inputs/tables.ts'
import { changesLayer, topicsOf } from '../live/changes.ts'
import { nextValue, observing } from '../live/testing.ts'
import { ThreadStore, threadStoreLayer } from '../threads/store.ts'
import { threads } from '../threads/tables.ts'
import { approvalHandlers } from './handlers.ts'
import { ApprovalStore, approvalStoreLayer } from './store.ts'
import { approvals } from './tables.ts'
import { connectionAction, fixture, trustTestLayer } from './testing.ts'

/**
 * Retain the disposable fixture and unrelated ports, replacing its Changes with real LISTEN/NOTIFY.
 * Fresh store acquisition prevents memoized trust stores from retaining the recording Changes port.
 * rc.116 Layer.ts#provideMerge keeps this layer's service on overlap; #fresh uses a new memo map.
 */
const liveFoundation = Layer.merge(changesLayer, threadStoreLayer).pipe(
  Layer.provideMerge(trustTestLayer),
)
const testLayer = Layer.fresh(Layer.merge(approvalStoreLayer, inputStoreLayer)).pipe(
  Layer.provideMerge(liveFoundation),
)

const question = AskInputRequest.make({
  question: 'Which confidential launch date works?',
  options: [{ label: 'Monday', detail: 'Private launch plan' }],
  allowsOwnAnswer: true,
})

/** Use the public combined loader; observing exercises the exact production watch without sessions. */
const inbox = (actor: Actor) =>
  approvalHandlers.GetInbox().pipe(
    Effect.provideService(
      AuthContext,
      AuthState.Person({
        person: actor.person,
        workspace: actor.workspace,
        sessionId: SessionId.make(crypto.randomUUID()),
      }),
    ),
  )

/** Read every owned request column so visibility changes cannot silently settle or rewrite records. */
const records = Effect.fn('InboxPrivacy.records')(function* (threadId: ThreadId) {
  const database = yield* Database
  return {
    approvals: yield* database.run(
      database.select().from(approvals).where(eq(approvals.threadId, threadId)),
    ),
    requests: yield* database.run(
      database.select().from(inputRequests).where(eq(inputRequests.threadId, threadId)),
    ),
  }
})

/** L1 and C1 cross public combined loading, real SQL rows and the production share announcement. */
describe.skipIf(!testDatabaseConfigured)('Combined inbox Thread privacy', () => {
  it.effect(
    'L1 live share, unshare and re-share conceal both cards and preserve pending records',
    () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const threadStore = yield* ThreadStore
        yield* threadStore.share(
          test.member.person.id,
          test.companyId,
          ShareThreadRequest.cases.Company.make({}),
        )
        const addressed = {
          ...test.owner,
          by: 'vivid',
          threadId: Option.some(test.companyId),
        } satisfies Actor
        const approval = yield* (yield* ApprovalStore).raise(addressed, connectionAction)
        const request = yield* (yield* InputStore).ask(addressed, question)
        const before = yield* records(test.companyId)
        const load = inbox(test.owner)
        const expected = { approvals: [approval], requests: [request] }
        const observation = yield* observing(topicsOf(test.owner), load)
        expect(observation.initial).toEqual(expected)
        yield* threadStore.share(
          test.member.person.id,
          test.companyId,
          ShareThreadRequest.cases.Private.make({}),
        )
        // Baseline watch suppresses the unchanged leaked result: assert absence before waiting.
        expect(yield* load).toEqual({ approvals: [], requests: [] })
        expect(yield* records(test.companyId)).toEqual(before)
        expect(yield* nextValue(observation)).toEqual({ approvals: [], requests: [] })
        yield* threadStore.share(
          test.member.person.id,
          test.companyId,
          ShareThreadRequest.cases.People.make({ participants: [test.owner.person.id] }),
        )
        // Re-share must restore the original content and state before awaiting its live result too.
        expect(yield* load).toEqual(expected)
        expect(yield* nextValue(observation)).toEqual(expected)
        expect(yield* records(test.companyId)).toEqual(before)
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect(
    'C1 corrupt audiences hide both creator-addressed cards without failing the inbox',
    () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const approval = yield* (yield* ApprovalStore).raise(test.companyVivid, connectionAction)
        const request = yield* (yield* InputStore).ask(test.companyVivid, question)
        const load = inbox(test.member)
        expect(yield* load).toEqual({ approvals: [approval], requests: [request] })
        const before = yield* records(test.companyId)
        const database = yield* Database
        yield* database.run(
          database
            .update(threads)
            .set({ audience: 'everyone' })
            .where(eq(threads.id, test.companyId)),
        )
        expect(yield* load).toEqual({ approvals: [], requests: [] })
        expect(yield* records(test.companyId)).toEqual(before)
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )
})
