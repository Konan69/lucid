import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { and, eq, inArray } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import {
  Company,
  CompanyId,
  DatabaseFailure,
  OccurrenceId,
  PersonSummary,
  Run,
  RunOrigin,
  RunState,
  Person,
  PersonId,
  RoutineId,
  RoutineTrigger,
  RuntimeUnavailable,
  RunId,
  Workspace,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database, decodeStored, returned } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { Conversation, StoredRunOrigin, type Delivery } from '../threads/conversation.ts'
import { threadStoreLayer } from '../threads/store.ts'
import { runs } from '../threads/tables.ts'
import { routines } from './tables.ts'
import { RoutineStore, RoutineMissing, RoutineWebhookRequired, routineStoreLayer } from './store.ts'
import { RoutineScheduler, routineSchedulerServiceLayer } from './scheduler.ts'
import { routineWebhookRoutes } from './webhook.ts'
import { InvalidRoutineSchedule } from './timing.ts'
import { hashKey } from './keys.ts'

/** The delivery authority records calls while storing real Runs, so history joins remain real. */
class Deliveries extends Context.Service<Deliveries, Ref.Ref<ReadonlyArray<Delivery>>>()(
  'test/RoutineDeliveries',
) {}

const decodePersonSummary = decodeStored(PersonSummary, 'Test Person')
const encodeOrigin = Schema.encodeSync(StoredRunOrigin)

/** The recording authority creates durable Runs and exposes delivery counts to behavior tests. */
const recordedConversationLayer = Layer.effectContext(
  Effect.gen(function* () {
    const database = yield* Database
    const delivered = yield* Ref.make<ReadonlyArray<Delivery>>([])
    const conversation = Conversation.of({
      /** Routine tests never use the gateway's receipt path; a call there must fail visibly. */
      admit: Effect.fn('Test.RoutineConversation.admit')(function* () {
        return yield* Effect.fail(
          new RuntimeUnavailable({ message: 'Gateway admission is outside Routine tests' }),
        )
      }),
      /** A Run exists durably before delivery returns, just as the production authority promises. */
      deliver: Effect.fn('Test.RoutineConversation.deliver')(function* (delivery) {
        const id = RunId.make(NodeCrypto.randomUUID())
        const now = yield* Clock.currentTimeMillis
        if (!StoredRunOrigin.guards.Routine(delivery.origin)) {
          return yield* Effect.fail(
            new DatabaseFailure({ message: 'Test expected a Routine delivery' }),
          )
        }
        const people = yield* database.run(
          database
            .select({ id: personTable.id, name: personTable.name, image: personTable.image })
            .from(personTable)
            .where(eq(personTable.id, delivery.personId)),
        )
        const person = yield* decodePersonSummary(yield* returned(people, 'Test Person'))
        yield* database.run(
          database.insert(runs).values({
            id,
            threadId: delivery.threadId,
            personId: delivery.personId,
            origin: encodeOrigin(delivery.origin),
            state: 'working',
            startedAt: now,
            finishedAt: null,
          }),
        )
        const stored = Run.make({
          id,
          threadId: delivery.threadId,
          origin: RunOrigin.cases.Routine.make({
            person,
            routineName: delivery.origin.routineName,
          }),
          state: RunState.cases.Working.make({}),
          startedAt: now,
        })
        yield* Ref.update(delivered, (previous) => [...previous, delivery])
        return stored
      }),
    })
    return Context.make(Conversation, conversation).pipe(Context.add(Deliveries, delivered))
  }),
)

const storesLayer = Layer.mergeAll(routineStoreLayer, threadStoreLayer).pipe(
  Layer.provideMerge(testDatabaseLayer),
  Layer.provide(testConfigLayer),
)
const authoritiesLayer = recordedConversationLayer.pipe(
  Layer.provideMerge(storesLayer),
  Layer.provideMerge(silentChangesLayer),
)
const testLayer = routineSchedulerServiceLayer.pipe(Layer.provideMerge(authoritiesLayer))

/** Each test owns fresh People and a Company; cascade cleanup is registered before any write. */
const fixture = Effect.fn('Test.Routines.fixture')(function* () {
  const database = yield* Database
  const company = new Company({
    id: CompanyId.make(NodeCrypto.randomUUID()),
    name: 'Routine tests',
    slug: NodeCrypto.randomUUID(),
  })
  const people = [0, 1, 2].map(
    (index) =>
      new Person({
        id: PersonId.make(NodeCrypto.randomUUID()),
        name: `Person ${index}`,
        email: `${NodeCrypto.randomUUID()}@routines.test`,
        image: null,
      }),
  )
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* database.run(database.delete(companyTable).where(eq(companyTable.id, company.id)))
      yield* database.run(
        database.delete(personTable).where(
          inArray(
            personTable.id,
            people.map((person) => person.id),
          ),
        ),
      )
    }).pipe(
      Effect.tapError((error) => Effect.logError('Routine fixture cleanup failed', error)),
      Effect.ignore,
    ),
  )
  yield* database.run(
    database.insert(personTable).values(
      people.map((person) => ({
        id: person.id,
        name: person.name,
        email: person.email,
        image: null,
      })),
    ),
  )
  yield* database.run(
    database
      .insert(companyTable)
      .values({ id: company.id, name: company.name, slug: company.slug }),
  )
  yield* database.run(
    database.insert(membershipTable).values(
      people.map((person) => ({
        id: NodeCrypto.randomUUID(),
        companyId: company.id,
        userId: person.id,
        role: 'admin',
      })),
    ),
  )
  const actors: ReadonlyArray<Actor> = people.map((person) => ({
    person,
    workspace: Workspace.cases.Company.make({ company, role: 'admin' }),
    by: 'person',
    threadId: Option.none(),
  }))
  const owner = actors[0]
  const colleague = actors[1]
  const other = actors[2]
  if (owner === undefined || colleague === undefined || other === undefined)
    return yield* Effect.fail(new DatabaseFailure({ message: 'Test People are missing' }))
  yield* Ref.set(yield* Deliveries, [])
  return {
    owner,
    colleague,
    outside: {
      person: other.person,
      workspace: Workspace.cases.Personal.make({}),
      by: 'person',
      threadId: Option.none(),
    } satisfies Actor,
  }
})

/** Routes and services share the test's authority; requests exercise the real HTTP body reader. */
const client = Effect.fn('Test.Routines.client')(function* () {
  const context = yield* Effect.context<RoutineScheduler | RoutineStore>()
  return yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        routineWebhookRoutes.pipe(Layer.provideMerge(Layer.succeedContext(context))),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  )
})

/** The only Promise seam is the framework's in-process Web handler, with a real Request body. */
const post = Effect.fn('Test.Routines.post')(function* (input: {
  readonly web: Effect.Success<ReturnType<typeof client>>
  readonly id: RoutineId
  readonly key: Redacted.Redacted
  readonly body: string
}) {
  return yield* Effect.tryPromise({
    try: () =>
      input.web.handler(
        new Request(`http://routines.test/api/hooks/routines/${input.id}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${Redacted.value(input.key)}` },
          body: input.body,
        }),
      ),
    catch: (cause) => new Error('Webhook HTTP adapter failed', { cause }),
  })
})

const decodeReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ occurrenceId: OccurrenceId })),
)

/** Response bytes are decoded at the consumer boundary, rather than asserting response.json types. */
const receipt = Effect.fn('Test.Routines.receipt')(function* (response: Response) {
  const text = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new Error('Webhook response could not be read', { cause }),
  })
  return yield* decodeReceipt(text)
})

const schedule = RoutineTrigger.cases.Schedule.make({ cron: '* * * * *', timezone: 'UTC' })
const webhook = RoutineTrigger.cases.Webhook.make({})

/** Integration tests are gated only by the isolated test database setting. */
describe.skipIf(!testDatabaseConfigured)('personal Routines', () => {
  layer(testLayer)((it) => {
    it.effect('conceals and refuses another Person’s Routine, including Company admins', () =>
      Effect.gen(function* () {
        const { owner, colleague, outside } = yield* fixture()
        const store = yield* RoutineStore
        const scheduler = yield* RoutineScheduler
        const routine = yield* store.create(owner, {
          name: 'Private work',
          prompt: 'Summarize updates',
          trigger: schedule,
        })
        for (const other of [colleague, outside]) {
          expect(yield* store.list(other)).toEqual([])
          expect(yield* store.get(other, routine.id).pipe(Effect.flip)).toBeInstanceOf(
            RoutineMissing,
          )
          expect(yield* scheduler.run(other, routine.id).pipe(Effect.flip)).toBeInstanceOf(
            RoutineMissing,
          )
          expect(
            yield* store.patch(other, routine.id, { name: 'Changed' }).pipe(Effect.flip),
          ).toBeInstanceOf(RoutineMissing)
          expect(yield* store.remove(other, routine.id).pipe(Effect.flip)).toBeInstanceOf(
            RoutineMissing,
          )
          expect(yield* store.issueWebhook(other, routine.id).pipe(Effect.flip)).toBeInstanceOf(
            RoutineMissing,
          )
        }
        expect(yield* Ref.get(yield* Deliveries)).toEqual([])
        expect((yield* store.list(owner)).map((item) => item.id)).toEqual([routine.id])
        const vivid = { ...owner, by: 'vivid' } satisfies Actor
        const run = yield* scheduler.run(vivid, routine.id)
        expect(run.submissionId).not.toBeNull()
        expect((yield* Ref.get(yield* Deliveries)).map((delivery) => delivery.personId)).toEqual([
          owner.person.id,
        ])
      }),
    )

    it.effect(
      'accepts exactly one webhook delivery; wrong, missing and disabled are identical',
      () =>
        Effect.gen(function* () {
          const { owner } = yield* fixture()
          const store = yield* RoutineStore
          const routine = yield* store.create(owner, {
            name: 'Webhook work',
            prompt: 'Handle incoming update',
            trigger: webhook,
          })
          const issued = yield* store.issueWebhook(owner, routine.id)
          const web = yield* client()
          const accepted = yield* post({ web, id: routine.id, key: issued.key, body: 'New update' })
          expect(accepted.status).toBe(202)
          const acceptedReceipt = yield* receipt(accepted)
          const delivered = yield* Ref.get(yield* Deliveries)
          expect(delivered).toHaveLength(1)
          expect(delivered[0]).toMatchObject({
            personId: owner.person.id,
            idempotencyKey: acceptedReceipt.occurrenceId,
            message: {
              body: 'Handle incoming update\n\nPayload:\nNew update',
              attributes: { routine: routine.id, name: routine.name },
            },
          })
          const wrong = yield* post({
            web,
            id: routine.id,
            key: Redacted.make('x'.repeat(43)),
            body: 'Update',
          })
          const missing = yield* post({
            web,
            id: RoutineId.make(NodeCrypto.randomUUID()),
            key: issued.key,
            body: 'Update',
          })
          yield* store.patch(owner, routine.id, { enabled: false })
          const disabled = yield* post({ web, id: routine.id, key: issued.key, body: 'Update' })
          expect([wrong.status, missing.status, disabled.status]).toEqual([404, 404, 404])
          const bodies = yield* Effect.forEach([wrong, missing, disabled], (response) =>
            Effect.promise(() => response.text()),
          )
          expect(new Set(bodies).size).toBe(1)
          expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
          expect((yield* store.list(owner))[0]).toMatchObject({
            runs: [{ id: acceptedReceipt.occurrenceId, status: 'running' }],
          })
        }),
    )

    it.effect('rotates webhook authority and clears it when switching triggers', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const routine = yield* store.create(owner, {
          name: 'Rotating work',
          prompt: 'Check update',
          trigger: webhook,
        })
        const first = yield* store.issueWebhook(owner, routine.id)
        const second = yield* store.issueWebhook(owner, routine.id)
        expect(first.address).toBe(second.address)
        expect(hashKey(first.key)).not.toBe(hashKey(second.key))
        const database = yield* Database
        const stored = yield* database.run(
          database.select().from(routines).where(eq(routines.id, routine.id)),
        )
        expect(stored[0]).toMatchObject({
          webhookKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        })
        expect(JSON.stringify(stored).includes(Redacted.value(second.key))).toBe(false)
        const web = yield* client()
        expect((yield* post({ web, id: routine.id, key: first.key, body: 'Update' })).status).toBe(
          404,
        )
        expect((yield* post({ web, id: routine.id, key: second.key, body: 'Update' })).status).toBe(
          202,
        )
        yield* store.patch(owner, routine.id, { trigger: schedule })
        expect(yield* store.issueWebhook(owner, routine.id).pipe(Effect.flip)).toBeInstanceOf(
          RoutineWebhookRequired,
        )
        yield* store.patch(owner, routine.id, { trigger: webhook })
        const cleared = yield* store.get(owner, routine.id)
        expect(cleared.webhookKeyHash).toBeNull()
        expect(cleared.routine.nextExpectedAt).toBeNull()
        expect((yield* post({ web, id: routine.id, key: second.key, body: 'Update' })).status).toBe(
          404,
        )
        expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
      }),
    )

    it.effect('bounds streaming bytes at 64 KiB and authorizes before reading the body', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const routine = yield* store.create(owner, {
          name: 'Bounded work',
          prompt: 'Read payload',
          trigger: webhook,
        })
        const issued = yield* store.issueWebhook(owner, routine.id)
        const web = yield* client()
        expect(
          (yield* post({ web, id: routine.id, key: issued.key, body: 'x'.repeat(64 * 1024) }))
            .status,
        ).toBe(202)
        expect(
          (yield* post({ web, id: routine.id, key: issued.key, body: 'x'.repeat(64 * 1024 + 1) }))
            .status,
        ).toBe(413)
        expect(
          (yield* post({
            web,
            id: routine.id,
            key: Redacted.make('x'.repeat(43)),
            body: 'x'.repeat(64 * 1024 + 1),
          })).status,
        ).toBe(404)
        expect(
          (yield* post({ web, id: routine.id, key: issued.key, body: 'é'.repeat(32 * 1024 + 1) }))
            .status,
        ).toBe(413)
        expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
      }),
    )

    it.effect('claims due schedules once using TestClock and derives outcomes from Runs', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const scheduler = yield* RoutineScheduler
        const database = yield* Database
        yield* TestClock.setTime(0)
        const routine = yield* store.create(owner, {
          name: 'Scheduled work',
          prompt: 'Summarize updates',
          trigger: schedule,
        })
        expect(routine.nextRunAt).toBe(60_000)
        yield* scheduler.runDue()
        expect(yield* Ref.get(yield* Deliveries)).toEqual([])
        yield* TestClock.setTime(60_000)
        yield* Effect.all([scheduler.runDue(), scheduler.runDue()], { concurrency: 2 })
        expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
        const stored = yield* store.list(owner)
        expect(stored[0]).toMatchObject({
          nextRunAt: 120_000,
          runs: [{ status: 'running', finishedAt: null }],
        })
        const latest = stored[0]
        if (latest === undefined)
          return yield* Effect.fail(new DatabaseFailure({ message: 'Scheduled Routine missing' }))
        const occurrence = latest.runs[0]
        if (occurrence === undefined || occurrence.submissionId === null)
          return yield* Effect.fail(new DatabaseFailure({ message: 'Scheduled Run missing' }))
        yield* TestClock.setTime(61_000)
        yield* database.run(
          database
            .update(runs)
            .set({ state: 'completed', finishedAt: 61_000 })
            .where(eq(runs.id, RunId.make(occurrence.submissionId))),
        )
        expect((yield* store.list(owner))[0]).toMatchObject({
          runs: [{ status: 'succeeded', finishedAt: 61_000 }],
        })
        yield* store.patch(owner, routine.id, { enabled: false })
        yield* TestClock.setTime(180_000)
        yield* scheduler.runDue()
        expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
        return yield* Effect.void
      }),
    )

    it.effect('uses every durable Run outcome instead of legacy Occurrence status', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const scheduler = yield* RoutineScheduler
        const database = yield* Database
        const routine = yield* store.create(owner, {
          name: 'Outcome work',
          prompt: 'Do work',
          trigger: webhook,
        })
        const occurrence = yield* scheduler.run(owner, routine.id)
        if (occurrence.submissionId === null)
          return yield* Effect.fail(new DatabaseFailure({ message: 'Test Run missing' }))
        const id = RunId.make(occurrence.submissionId)
        for (const state of ['failed', 'stopped', 'unknown']) {
          yield* database.run(
            database.update(runs).set({ state, finishedAt: 42 }).where(eq(runs.id, id)),
          )
          expect((yield* store.list(owner))[0]).toMatchObject({
            runs: [{ status: 'failed', finishedAt: 42 }],
          })
        }
        return yield* Effect.void
      }),
    )

    it.effect('rejects contradictory persisted trigger columns and invalid schedules', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const database = yield* Database
        expect(
          yield* store
            .create(owner, {
              name: 'Bad schedule',
              prompt: 'Do work',
              trigger: RoutineTrigger.cases.Schedule.make({ cron: 'invalid', timezone: 'UTC' }),
            })
            .pipe(Effect.flip),
        ).toBeInstanceOf(InvalidRoutineSchedule)
        expect(yield* store.list(owner)).toEqual([])
        const routine = yield* store.create(owner, {
          name: 'Corrupt work',
          prompt: 'Do work',
          trigger: webhook,
        })
        yield* database.run(
          database
            .update(routines)
            .set({ cron: '* * * * *' })
            .where(and(eq(routines.id, routine.id), eq(routines.personId, owner.person.id))),
        )
        expect(yield* store.list(owner).pipe(Effect.flip)).toBeInstanceOf(DatabaseFailure)
      }),
    )
  })
})
