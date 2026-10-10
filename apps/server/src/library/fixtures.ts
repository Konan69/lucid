import * as NodeCrypto from 'node:crypto'
import { inArray } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import {
  Company,
  CompanyId,
  LibraryItemId,
  Person,
  PersonId,
  SessionId,
  Workspace,
  type Role,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import type { Actor } from '../auth/access.ts'
import { personTable, sessionTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { WORK_TABLE } from '../database/work.ts'
import { libraryHandlers } from './handlers.ts'
import { INGESTION_QUEUE_NAME } from './ingestion.ts'

const decodeWork = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      state: Schema.Literals(['pending', 'completed', 'failed']),
      attempts: Schema.Int,
    }),
  ),
)
const decodePendingWork = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: LibraryItemId })),
)

/** Read-only SDK persistence ingress for proofs; production never inspects this table. */
export const storedWork = Effect.fn('LibraryTest.storedWork')(function* (id: LibraryItemId) {
  const sql = yield* SqlClient.SqlClient
  return yield* decodeWork(
    yield* sql`
      SELECT state, attempts FROM ${sql(WORK_TABLE)} WHERE queue_name = ${INGESTION_QUEUE_NAME} AND id = ${id}
    `,
  )
})

/** Detect older obligations before any fixture write; production never reads SDK-owned work. */
export const pendingWork = Effect.fn('LibraryTest.pendingWork')(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* decodePendingWork(
    yield* sql`
      SELECT id FROM ${sql(WORK_TABLE)} WHERE queue_name = ${INGESTION_QUEUE_NAME} AND state = 'pending'
    `,
  )
})

/** A real Company with two Members, an admin and a foreign Company; cleanup precedes writes. */
export const fixture = Effect.fn('LibraryTest.fixture')(function* () {
  const database = yield* Database
  const company = Company.make({
    id: CompanyId.make(NodeCrypto.randomUUID()),
    name: 'Library test',
    slug: NodeCrypto.randomUUID(),
  })
  const foreign = Company.make({
    id: CompanyId.make(NodeCrypto.randomUUID()),
    name: 'Other Library test',
    slug: NodeCrypto.randomUUID(),
  })
  /** Tuple construction makes the fixture's three identities total without a missing-index branch. */
  const makePerson = (index: number) =>
    Person.make({
      id: PersonId.make(NodeCrypto.randomUUID()),
      name: `Library reader ${index}`,
      email: `${NodeCrypto.randomUUID()}@example.test`,
      image: null,
    })
  const persons = [makePerson(0), makePerson(1), makePerson(2)] as const
  const personIds = persons.map((person) => person.id)
  yield* Effect.addFinalizer(() =>
    database
      .run(database.delete(companyTable).where(inArray(companyTable.id, [company.id, foreign.id])))
      .pipe(
        Effect.andThen(
          database.run(database.delete(personTable).where(inArray(personTable.id, personIds))),
        ),
        Effect.catch(() => Effect.logError('Library fixture cleanup failed')),
      ),
  )
  yield* database.run(database.insert(companyTable).values([company, foreign]))
  yield* database.run(database.insert(personTable).values([...persons]))
  /** Each Actor corresponds to a real Membership and a real cookie/bearer session. */
  const member = Effect.fn('LibraryTest.member')(function* (person: Person, role: Role) {
    const token = NodeCrypto.randomUUID()
    const sessionId = SessionId.make(NodeCrypto.randomUUID())
    yield* database.run(
      database
        .insert(membershipTable)
        .values({ id: NodeCrypto.randomUUID(), companyId: company.id, userId: person.id, role }),
    )
    yield* database.run(
      database.insert(sessionTable).values({
        id: sessionId,
        token,
        userId: person.id,
        activeCompanyId: company.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    )
    const actor: Actor = {
      person,
      workspace: Workspace.cases.Company.make({ company, role }),
      by: 'person',
      threadId: Option.none(),
    }
    return { actor, token, sessionId }
  })
  const [first, second, third] = persons
  return {
    owner: yield* member(first, 'member'),
    reader: yield* member(second, 'member'),
    admin: yield* member(third, 'admin'),
    company,
    foreign,
  }
})

/** RPC calls use the real handlers and request-local authority, without duplicating access rules. */
export const asPerson = (member: { readonly actor: Actor; readonly sessionId: SessionId }) => {
  const auth = AuthState.Person({
    person: member.actor.person,
    workspace: member.actor.workspace,
    sessionId: member.sessionId,
  })
  return {
    list: (query: Parameters<typeof libraryHandlers.ListLibrary>[0]) =>
      libraryHandlers.ListLibrary(query).pipe(Effect.provideService(AuthContext, auth)),
    get: (id: Parameters<typeof libraryHandlers.GetLibraryItem>[0]['id']) =>
      libraryHandlers.GetLibraryItem({ id }).pipe(Effect.provideService(AuthContext, auth)),
    remove: (id: Parameters<typeof libraryHandlers.DeleteLibraryItem>[0]['id']) =>
      libraryHandlers.DeleteLibraryItem({ id }).pipe(Effect.provideService(AuthContext, auth)),
    patch: (input: Parameters<typeof libraryHandlers.PatchLibraryItem>[0]) =>
      libraryHandlers.PatchLibraryItem(input).pipe(Effect.provideService(AuthContext, auth)),
    search: (query: string) =>
      libraryHandlers.SearchLibrary({ query }).pipe(Effect.provideService(AuthContext, auth)),
  }
}
