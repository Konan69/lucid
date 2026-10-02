import * as NodeCrypto from 'node:crypto'
import { it } from '@effect/vitest'
import {
  AuditEvent,
  Company,
  CompanyId,
  InvalidRequest,
  MemoryScope,
  NotFound,
  Person,
  PersonId,
  SessionId,
  ThreadId,
  Workspace,
  type Memory,
  type Role,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { eq, inArray } from 'drizzle-orm'
import { ConfigProvider, Effect, Layer, Option, Ref, Stream } from 'effect'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect } from 'vitest'
import { Audit } from '../audit/record.ts'
import { personTable, sessionTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { threads } from '../threads/tables.ts'
import { Embeddings, embeddingsLayer } from './embeddings.js'
import { MemoryCandidate, MemoryRelation, memoryExtractionLayer } from './extract.js'
import { memoryHandlers } from './handlers.js'
import { HelixMemory, helixMemoryLayer, MemoryPartition, MemoryScopeKey } from './helix.js'
import { MemoryAccess, memoryAccessLayer, MemoryStore, memoryStoreLayer } from './store.js'

const url = process.env['VIVID_TEST_HELIX_URL']
const enabled =
  testDatabaseConfigured && url !== undefined && process.env['OPENROUTER_API_KEY'] !== undefined
const adapters = Layer.mergeAll(helixMemoryLayer, embeddingsLayer, memoryExtractionLayer).pipe(
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(
    ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ VIVID_HELIX_URL: url }), {
      asPrimary: true,
    }),
  ),
)
const persistence = memoryStoreLayer.pipe(Layer.provideMerge(adapters))
const access = memoryAccessLayer.pipe(
  Layer.provideMerge(persistence),
  Layer.provideMerge(testDatabaseLayer),
)

/** Unique Persons and a Company use only disposable PostgreSQL; all cleanup is registered before setup writes. */
const fixtures = Effect.fn('MemoryTest.fixtures')(function* () {
  const database = yield* Database
  const helix = yield* HelixMemory
  const store = yield* MemoryStore
  const suffix = NodeCrypto.randomUUID()
  const people = ['Dami', 'Tola', 'Ada', 'Wale'].map((name) =>
    Person.make({
      id: PersonId.make(`${name}-${suffix}`),
      name,
      email: `${name}-${suffix}@example.test`,
    }),
  )
  const [person, member, admin, outsider] = people
  if (person === undefined || member === undefined || admin === undefined || outsider === undefined)
    return yield* Effect.die('Four Persons required')
  const company = new Company({
    id: CompanyId.make(`memory-${suffix}`),
    name: 'Memory Company',
    slug: `memory-${suffix}`,
  })
  const privateOne = ThreadId.make(`private-one-${suffix}`)
  const privateTwo = ThreadId.make(`private-two-${suffix}`)
  const companyPrivate = ThreadId.make(`company-private-${suffix}`)
  const room = ThreadId.make(`room-${suffix}`)
  const hiddenRoom = ThreadId.make(`hidden-${suffix}`)
  const partitions = people.map((value) => MemoryPartition.make(`p-${value.id}`))
  partitions.push(MemoryPartition.make(`c-${company.id}`))
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const partition of partitions) {
        const scopes = yield* helix.scopes(partition)
        const remaining = yield* store.list({ partition, scopes })
        yield* Effect.forEach(remaining, (memory) => store.forget({ partition, id: memory.id }))
      }
      yield* database.run(database.delete(companyTable).where(eq(companyTable.id, company.id)))
      yield* database.run(
        database.delete(personTable).where(
          inArray(
            personTable.id,
            people.map((value) => value.id),
          ),
        ),
      )
    }).pipe(
      Effect.match({
        onFailure: (failure) => expect.fail(`Cleanup failed: ${failure._tag}`),
        onSuccess: () => undefined,
      }),
    ),
  )
  yield* database.run(
    database
      .insert(personTable)
      .values(people.map((value) => ({ id: value.id, name: value.name, email: value.email }))),
  )
  yield* database.run(
    database
      .insert(companyTable)
      .values({ id: company.id, name: company.name, slug: company.slug }),
  )
  yield* database.run(
    database.insert(sessionTable).values({
      id: `session-${person.id}`,
      token: NodeCrypto.randomUUID(),
      userId: person.id,
      activeCompanyId: company.id,
      expiresAt: new Date(Date.UTC(2027, 0, 1)),
    }),
  )
  const memberships = [
    { value: person, role: 'member' },
    { value: member, role: 'member' },
    { value: admin, role: 'admin' },
  ]
  yield* database.run(
    database.insert(membershipTable).values(
      memberships.map(({ value, role }) => ({
        id: NodeCrypto.randomUUID(),
        companyId: company.id,
        userId: value.id,
        role,
      })),
    ),
  )
  yield* database.run(
    database.insert(threads).values([
      {
        id: privateOne,
        personId: person.id,
        companyId: null,
        title: 'First',
        updatedAt: 1,
        audience: 'private',
      },
      {
        id: privateTwo,
        personId: person.id,
        companyId: null,
        title: 'Second',
        updatedAt: 2,
        audience: 'private',
      },
      {
        id: companyPrivate,
        personId: person.id,
        companyId: company.id,
        title: 'Private at work',
        updatedAt: 3,
        audience: 'private',
      },
      {
        id: room,
        personId: person.id,
        companyId: company.id,
        title: 'Shared room',
        updatedAt: 4,
        audience: 'company',
      },
      {
        id: hiddenRoom,
        personId: member.id,
        companyId: company.id,
        title: 'Other people',
        updatedAt: 5,
        audience: 'people',
      },
    ]),
  )
  return {
    person,
    member,
    admin,
    outsider,
    company,
    privateOne,
    privateTwo,
    companyPrivate,
    room,
    hiddenRoom,
  }
})
type Fixtures = Effect.Success<ReturnType<typeof fixtures>>

/** Auth fixtures use the same Actor-producing context as real calls, including explicit workspace and Thread attribution. */
function personAuth(person: Person, workspace: Workspace) {
  return AuthState.Person({ person, workspace, sessionId: SessionId.make(`session-${person.id}`) })
}

/** The role reflects a real fixture Membership, not a way into somebody else's private Thread. */
function companyWorkspace(fixture: Fixtures, role: Role) {
  return Workspace.cases.Company.make({ company: fixture.company, role })
}

/** Caller substitution changes only auth; the seam under test uses the production memory and database adapters. */
function callAs<A, E, R>(auth: AuthState, operation: Effect.Effect<A, E, R>) {
  return operation.pipe(Effect.provideService(AuthContext, auth))
}

/** A private preference follows its Person into a Company but cannot be recalled in a room or by another Person. */
const privacy = Effect.fn('MemoryTest.privacy')(function* (fixture: Fixtures) {
  const personal = Workspace.cases.Personal.make({})
  const company = companyWorkspace(fixture, 'member')
  const first = AuthState.Vivid({
    person: fixture.person,
    workspace: personal,
    threadId: fixture.privateOne,
  })
  const saved = yield* callAs(
    first,
    memoryHandlers.Remember({
      kind: 'preference',
      content: 'Dami uses the private meeting password iridiumwillow943.',
      forCompany: false,
    }),
  )
  expect(MemoryScope.guards.Person(saved.memory.scope)).toBe(true)
  expect(saved.memory.learnedIn).toBe(fixture.privateOne)
  const recall = memoryHandlers.Recall({ query: 'iridiumwillow943', limit: 10 })
  const second = yield* callAs(
    AuthState.Vivid({ person: fixture.person, workspace: personal, threadId: fixture.privateTwo }),
    recall,
  )
  expect(second.memories.map((memory) => memory.id)).toContain(saved.memory.id)
  const atWork = yield* callAs(
    AuthState.Vivid({
      person: fixture.person,
      workspace: company,
      threadId: fixture.companyPrivate,
    }),
    recall,
  )
  expect(atWork.memories.map((memory) => memory.id)).toContain(saved.memory.id)
  const shared = yield* callAs(
    AuthState.Vivid({ person: fixture.person, workspace: company, threadId: fixture.room }),
    recall,
  )
  expect(shared.memories.map((memory) => memory.id)).not.toContain(saved.memory.id)
  const other = yield* callAs(personAuth(fixture.member, company), recall)
  expect(other.memories.map((memory) => memory.id)).not.toContain(saved.memory.id)
  const refusal = yield* callAs(
    personAuth(fixture.member, company),
    memoryHandlers.ForgetMemory({ id: saved.memory.id }),
  ).pipe(Effect.flip)
  expect(refusal).toBeInstanceOf(NotFound)
  const sharedRefusal = yield* callAs(
    AuthState.Vivid({ person: fixture.person, workspace: company, threadId: fixture.room }),
    memoryHandlers.CorrectMemory({
      id: saved.memory.id,
      content: 'Private replacement must not be visible in this room.',
    }),
  ).pipe(Effect.flip)
  expect(sharedRefusal).toBeInstanceOf(NotFound)
  return saved.memory
})

/** Extending readable Company knowledge creates a room note without requiring or changing ownership of the Company fact. */
const extension = Effect.fn('MemoryTest.extension')(function* (
  fixture: Fixtures,
  original: Memory,
) {
  const accessService = yield* MemoryAccess
  const store = yield* MemoryStore
  const helix = yield* HelixMemory
  const partition = MemoryPartition.make(`c-${fixture.company.id}`)
  const saved = yield* accessService.learn(
    {
      person: fixture.member,
      workspace: companyWorkspace(fixture, 'member'),
      by: 'vivid',
      threadId: Option.some(fixture.room),
    },
    MemoryCandidate.make({
      shouldStore: true,
      kind: 'decision',
      content: 'The shared room is preparing the Company launch code citrinecedar672.',
      aliases: [],
      forCompany: false,
      relation: MemoryRelation.cases.extends.make({ id: original.id }),
    }),
  )
  if (Option.isNone(saved)) expect.fail('An extension must create a room record')
  expect(MemoryScope.guards.Thread(saved.value.scope)).toBe(true)
  expect(saved.value.id).not.toBe(original.id)
  const neighbors = yield* helix.expand({
    partition,
    scopes: [MemoryScopeKey.make('company'), MemoryScopeKey.make(`thread:${fixture.room}`)],
    ids: [saved.value.id],
    limit: 5,
  })
  expect(neighbors.map((record) => record.memory.id)).toContain(original.id)
  expect(yield* store.get({ partition, id: original.id })).toEqual(Option.some(original))
  yield* store.forget({ partition, id: saved.value.id })
})

/** Company sharing is explicit, everyone inside recalls it, and only the teacher or an admin can remove it. */
const companyOwnership = Effect.fn('MemoryTest.company')(function* (fixture: Fixtures) {
  const workspace = companyWorkspace(fixture, 'member')
  const teacher = personAuth(fixture.person, workspace)
  const saved = yield* callAs(
    teacher,
    memoryHandlers.Remember({
      kind: 'fact',
      content: 'The Company launch code is citrinecedar672.',
      forCompany: true,
    }),
  )
  expect(MemoryScope.guards.Company(saved.memory.scope)).toBe(true)
  yield* extension(fixture, saved.memory)
  const recall = memoryHandlers.Recall({ query: 'citrinecedar672', limit: 10 })
  for (const auth of [
    teacher,
    personAuth(fixture.member, workspace),
    personAuth(fixture.admin, companyWorkspace(fixture, 'admin')),
  ]) {
    expect((yield* callAs(auth, recall)).memories.map((memory) => memory.id)).toContain(
      saved.memory.id,
    )
  }
  const outsider = personAuth(fixture.outsider, Workspace.cases.Personal.make({}))
  expect((yield* callAs(outsider, recall)).memories).toHaveLength(0)
  expect(
    yield* callAs(outsider, memoryHandlers.ForgetMemory({ id: saved.memory.id })).pipe(Effect.flip),
  ).toBeInstanceOf(NotFound)
  const denied = yield* callAs(
    AuthState.Vivid({ person: fixture.member, workspace, threadId: fixture.room }),
    memoryHandlers.ForgetMemory({ id: saved.memory.id }),
  ).pipe(Effect.flip)
  expect(denied).toBeInstanceOf(NotFound)
  const deniedCorrection = yield* callAs(
    AuthState.Vivid({ person: fixture.member, workspace, threadId: fixture.room }),
    memoryHandlers.CorrectMemory({
      id: saved.memory.id,
      content: 'A member cannot replace a fact they did not teach.',
    }),
  ).pipe(Effect.flip)
  expect(deniedCorrection).toBeInstanceOf(NotFound)
  expect((yield* callAs(teacher, recall)).memories.map((memory) => memory.id)).toContain(
    saved.memory.id,
  )
  yield* callAs(
    AuthState.Vivid({
      person: fixture.admin,
      workspace: companyWorkspace(fixture, 'admin'),
      threadId: fixture.room,
    }),
    memoryHandlers.ForgetMemory({ id: saved.memory.id }),
  )
  expect((yield* callAs(teacher, recall)).memories.map((memory) => memory.id)).not.toContain(
    saved.memory.id,
  )
  expect(
    yield* callAs(
      outsider,
      memoryHandlers.Remember({ kind: 'fact', content: 'No Company here.', forCompany: true }),
    ).pipe(Effect.flip),
  ).toBeInstanceOf(InvalidRequest)
})

/** A room can use its own brief and a Person can recall visible rooms; another room and a narrowed audience cannot leak them. */
const sharedKnowledge = Effect.fn('MemoryTest.shared')(function* (
  fixture: Fixtures,
  privateMemory: Memory,
) {
  const workspace = companyWorkspace(fixture, 'member')
  const vivid = AuthState.Vivid({ person: fixture.person, workspace, threadId: fixture.room })
  const saved = yield* callAs(
    vivid,
    memoryHandlers.Remember({
      kind: 'decision',
      content: 'The shared room chose violetbamboo581 as its launch slogan.',
      forCompany: false,
    }),
  )
  expect(MemoryScope.guards.Thread(saved.memory.scope)).toBe(true)
  const recall = memoryHandlers.Recall({ query: 'violetbamboo581', limit: 10 })
  const member = personAuth(fixture.member, workspace)
  expect((yield* callAs(member, recall)).memories.map((memory) => memory.id)).toContain(
    saved.memory.id,
  )
  const otherRoom = AuthState.Vivid({
    person: fixture.member,
    workspace,
    threadId: fixture.hiddenRoom,
  })
  expect((yield* callAs(otherRoom, recall)).memories.map((memory) => memory.id)).not.toContain(
    saved.memory.id,
  )
  const brief = yield* callAs(vivid, memoryHandlers.GetMemoryBrief())
  expect(brief.text).toMatch(/violetbamboo581/)
  expect(brief.text).not.toMatch(/iridiumwillow943/)
  const corrected = yield* callAs(
    member,
    memoryHandlers.CorrectMemory({
      id: saved.memory.id,
      content: 'The shared room chose amberpapyrus412 as its launch slogan.',
    }),
  )
  expect(corrected.memory.id).not.toBe(saved.memory.id)
  expect(corrected.memory.learnedFrom.id).toBe(fixture.member.id)
  expect(corrected.memory.learnedIn).toBeNull()
  yield* callAs(member, memoryHandlers.ForgetMemory({ id: corrected.memory.id }))
  const accessService = yield* MemoryAccess
  const privateRoomNote = yield* accessService.remember(
    { person: fixture.person, workspace, by: 'vivid', threadId: Option.some(fixture.room) },
    {
      kind: 'decision',
      content: 'The shared room chose violetbamboo581 as its launch slogan.',
      forCompany: false,
    },
  )
  const database = yield* Database
  yield* database.run(
    database.update(threads).set({ audience: 'private' }).where(eq(threads.id, fixture.room)),
  )
  expect(
    yield* callAs(member, memoryHandlers.ForgetMemory({ id: privateRoomNote.id })).pipe(
      Effect.flip,
    ),
  ).toBeInstanceOf(NotFound)
  yield* accessService.forget(
    { person: fixture.person, workspace, by: 'person', threadId: Option.none() },
    privateRoomNote.id,
  )
  const listed = yield* callAs(personAuth(fixture.person, workspace), memoryHandlers.ListMemory())
  expect(listed.memories.map((memory) => memory.id)).toContain(privateMemory.id)
  expect(listed.memories.map((memory) => memory.id)).not.toContain(corrected.memory.id)
  expect(listed.brief.text).toMatch(/iridiumwillow943/)
  const watched = yield* callAs(
    personAuth(fixture.person, workspace),
    Stream.runHead(memoryHandlers.WatchMemory()),
  )
  expect(watched).toEqual(Option.some(listed))
})

/** One real fixture pass keeps model requests few while proving the full privacy and ownership matrix. */
describe.skipIf(!enabled)('Memory calls with real Helix and disposable PostgreSQL', () => {
  it.effect(
    'follows personal notes, confines room recall, and enforces Company ownership',
    () =>
      Effect.gen(function* () {
        const events = yield* Ref.make<ReadonlyArray<AuditEvent>>([])
        const audit = Audit.of({
          record: (_actor, event) => Ref.update(events, (previous) => [...previous, event]),
        })
        yield* Effect.gen(function* () {
          // One real provider batch keeps this privacy matrix below the free endpoint's request limit.
          yield* (yield* Embeddings).embed([
            'Dami uses the private meeting password iridiumwillow943.',
            'iridiumwillow943',
            'The Company launch code is citrinecedar672.',
            'The shared room is preparing the Company launch code citrinecedar672.',
            'citrinecedar672',
            'The shared room chose violetbamboo581 as its launch slogan.',
            'violetbamboo581',
            'The shared room chose amberpapyrus412 as its launch slogan.',
          ])
          const fixture = yield* fixtures()
          const privateMemory = yield* privacy(fixture)
          yield* companyOwnership(fixture)
          yield* sharedKnowledge(fixture, privateMemory)
          const recorded = yield* Ref.get(events)
          expect(
            recorded.filter(AuditEvent.guards.MemorySaved).map((event) => event.scope),
          ).toEqual(['Person', 'Company', 'Thread', 'Thread'])
          expect(
            recorded.filter(AuditEvent.guards.MemoryForgotten).map((event) => event.scope),
          ).toEqual(['Company', 'Thread'])
        }).pipe(Effect.provideService(Audit, audit))
      }).pipe(Effect.scoped, Effect.provide(access), Effect.provide(silentChangesLayer)),
    { timeout: 120000 },
  )
})
