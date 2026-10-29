import { expect } from '@effect/vitest'
import {
  Company,
  CompanyId,
  DraftListResponse,
  Person,
  PersonId,
  SessionId,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { eq, inArray } from 'drizzle-orm'
import { Deferred, Effect, Fiber, Option, Queue, Stream } from 'effect'
import type { Actor } from '../auth/access.ts'
import { personTable, sessionTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { Changes, Topic, everyPart } from '../live/changes.ts'
import { threads } from '../threads/tables.ts'
import { draftHandlers } from './handlers.ts'

/** Handler authority is a real persisted session; live reloads can resolve its workspace. */
export interface Caller {
  readonly actor: Actor
  readonly session: SessionId
}

/** Supply decoded middleware context without replacing any persistence or live-query seam. */
export const signedIn = (caller: Caller) =>
  Effect.provideService(
    AuthContext,
    AuthState.Person({
      person: caller.actor.person,
      workspace: caller.actor.workspace,
      sessionId: caller.session,
    }),
  )

/** Cleanup failure must be visible while cascading owners removes all fixture product rows. */
const cleanup = Effect.fn('DraftTest.cleanup')(function* (
  database: Database['Service'],
  company: Company,
  people: ReadonlyArray<PersonId>,
) {
  yield* database.run(database.delete(companyTable).where(eq(companyTable.id, company.id)))
  yield* database.run(database.delete(personTable).where(inArray(personTable.id, people)))
})

/** A failed finalizer is a test failure, rather than silently leaving owner rows behind. */
const cleanupFailed = () => Effect.sync(() => expect.fail('Draft fixture cleanup failed'))

/** Every test uses isolated owners and registers their cascade cleanup before the first write. */
export const fixture = Effect.fn('DraftTest.fixture')(function* () {
  const database = yield* Database
  const owner = Person.make({
    id: PersonId.make(crypto.randomUUID()),
    name: 'Draft owner',
    email: `${crypto.randomUUID()}@draft.test`,
    image: null,
  })
  const other = Person.make({
    id: PersonId.make(crypto.randomUUID()),
    name: 'Other Person',
    email: `${crypto.randomUUID()}@draft.test`,
    image: null,
  })
  const company = Company.make({
    id: CompanyId.make(crypto.randomUUID()),
    name: 'Draft Company',
    slug: crypto.randomUUID(),
  })
  yield* Effect.addFinalizer(() =>
    cleanup(database, company, [owner.id, other.id]).pipe(Effect.catch(cleanupFailed)),
  )
  yield* database.run(database.insert(personTable).values([owner, other]))
  yield* database.run(database.insert(companyTable).values(company))
  yield* database.run(
    database.insert(membershipTable).values(
      [owner, other].map((person) => ({
        id: crypto.randomUUID(),
        companyId: company.id,
        userId: person.id,
        role: 'member',
      })),
    ),
  )
  /** Distinct session rows prove the same Person's separate devices share drafts. */
  const caller = Effect.fn('DraftTest.caller')(function* (person: Person, workspace: Workspace) {
    const session = SessionId.make(crypto.randomUUID())
    yield* database.run(
      database.insert(sessionTable).values({
        id: session,
        token: session,
        userId: person.id,
        activeCompanyId: Workspace.match(workspace, {
          Personal: () => null,
          Company: ({ company: selected }) => selected.id,
        }),
        expiresAt: new Date('2999-01-01T00:00:00Z'),
      }),
    )
    return {
      actor: {
        person,
        workspace,
        by: 'person',
        threadId: Option.none(),
        helper: Option.none(),
      } satisfies Actor,
      session,
    } satisfies Caller
  })
  const personal = yield* caller(owner, Workspace.cases.Personal.make({}))
  const second = yield* caller(owner, Workspace.cases.Personal.make({}))
  const member = yield* caller(owner, Workspace.cases.Company.make({ company, role: 'member' }))
  const foreign = yield* caller(other, Workspace.cases.Company.make({ company, role: 'member' }))
  return { personal, second, member, foreign, company }
})

/** Seed a Thread through its actual FK target; creation is outside the tested draft operation. */
export const thread = Effect.fn('DraftTest.thread')(function* (caller: Caller) {
  const id = ThreadId.make(crypto.randomUUID())
  yield* (yield* Database).run(
    (yield* Database).insert(threads).values({
      id,
      personId: caller.actor.person.id,
      companyId: Workspace.match(caller.actor.workspace, {
        Personal: () => null,
        Company: ({ company }) => company.id,
      }),
      title: 'Unsent work',
      titleSource: 'Person',
      updatedAt: 0,
    }),
  )
  return id
})

/** Open the real WatchDrafts handler and await its first emission before mutating. */
export const observing = Effect.fn('DraftTest.observing')(function* (caller: Caller) {
  const values = yield* Queue.unbounded<DraftListResponse>()
  const first = yield* Deferred.make<void>()
  const fiber = yield* draftHandlers.WatchDrafts().pipe(
    Stream.runForEach((value) =>
      Queue.offer(values, value).pipe(Effect.andThen(Deferred.succeed(first, undefined))),
    ),
    signedIn(caller),
    Effect.forkScoped,
  )
  yield* Effect.raceFirst(Deferred.await(first), Fiber.join(fiber))
  const initial = yield* Queue.take(values)
  const receipt = yield* (yield* Changes).subscribe(
    [Topic.person(caller.actor.person.id)],
    everyPart,
  )
  return { values, fiber, initial, receipt }
})

/** A fresh watch reads precisely the same loader as an already subscribed device. */
export const current = Effect.fn('DraftTest.current')(function* (caller: Caller) {
  const answer = yield* draftHandlers.WatchDrafts().pipe(Stream.runHead, signedIn(caller))
  return yield* Option.match(answer, {
    onNone: () => Effect.sync(() => expect.fail('WatchDrafts did not emit its initial list')),
    onSome: Effect.succeed,
  })
})

/**
 * Pause a real transaction before store SQL begins, to delete the Thread at the old pre-check
 * race point. Every query, driver, constraint and transaction remains the production adapter;
 * only this public authority seam's invocation ordering is controlled by the test.
 */
export const beforeTransaction = (database: Database['Service'], before: Effect.Effect<void>) =>
  Database.of({
    _: database._,
    query: database.query,
    $with: database.$with,
    $cache: database.$cache,
    $count: database.$count.bind(database),
    with: database.with.bind(database),
    select: database.select.bind(database),
    selectDistinct: database.selectDistinct.bind(database),
    selectDistinctOn: database.selectDistinctOn.bind(database),
    insert: database.insert.bind(database),
    update: database.update.bind(database),
    delete: database.delete.bind(database),
    refreshMaterializedView: database.refreshMaterializedView.bind(database),
    execute: database.execute.bind(database),
    run: database.run,
    transaction: (operation) =>
      database.transaction((tx) => before.pipe(Effect.andThen(operation(tx)))),
  })
