import * as NodeCrypto from 'node:crypto'
import { Company, CompanyId, Person, PersonId, ThreadId, Workspace } from '@vivid/contracts'
import { inArray } from 'drizzle-orm'
import { Clock, Effect, Option, Result } from 'effect'
import type { Actor } from '../src/auth/access.ts'
import { personTable } from '../src/auth/tables.ts'
import { companyTable, membershipTable } from '../src/companies/tables.ts'
import { Database } from '../src/database/client.ts'
import { threads } from '../src/threads/tables.ts'

/** Distinct identities and workspaces expose accidental use of the active Company as authority. */
const person = (name: string) =>
  new Person({
    id: PersonId.make(NodeCrypto.randomUUID()),
    name,
    email: `${NodeCrypto.randomUUID()}@example.test`,
    image: null,
  })

/** Company ids deliberately differ from both Person ids and the shared Thread id. */
const company = (name: string) =>
  new Company({ id: CompanyId.make(NodeCrypto.randomUUID()), name, slug: NodeCrypto.randomUUID() })

/** Human calls carry no ambient Thread; runtime authority must be supplied separately. */
const actor = (who: Person, workspace: Workspace): Actor => ({
  person: who,
  workspace,
  by: 'person',
  threadId: Option.none(),
})

/** Finalizers have no typed error channel; a failed cleanup must still fail its owning test. */
const cleanup = Effect.fn('Test.twoPeople.cleanup')(function* (
  database: Database['Service'],
  companies: ReadonlyArray<CompanyId>,
  people: ReadonlyArray<PersonId>,
) {
  const result = yield* Effect.result(
    Effect.gen(function* () {
      yield* database.run(database.delete(companyTable).where(inArray(companyTable.id, companies)))
      yield* database.run(database.delete(personTable).where(inArray(personTable.id, people)))
    }),
  )
  Result.getOrThrow(result)
})

/**
 * Two Persons share a Thread in the first Company. The second Person also owns another Company,
 * so tests can distinguish Thread reach, addressed requests, and the active workspace. Each
 * acquisition owns its rows and registers cleanup before writing, including during shrinking.
 */
export const twoPeople = Effect.fn('Test.twoPeople')(function* () {
  const database = yield* Database
  const first = person('Ada')
  const second = person('Bayo')
  const shared = company('Studio')
  const elsewhere = company('Elsewhere')
  const threadId = ThreadId.make(NodeCrypto.randomUUID())
  yield* Effect.addFinalizer(() =>
    cleanup(database, [shared.id, elsewhere.id], [first.id, second.id]),
  )
  yield* database.run(
    database.insert(personTable).values([
      { id: first.id, name: first.name, email: first.email },
      { id: second.id, name: second.name, email: second.email },
    ]),
  )
  yield* database.run(database.insert(companyTable).values([shared, elsewhere]))
  yield* database.run(
    database.insert(membershipTable).values([
      { id: NodeCrypto.randomUUID(), companyId: shared.id, userId: first.id, role: 'owner' },
      { id: NodeCrypto.randomUUID(), companyId: shared.id, userId: second.id, role: 'member' },
      { id: NodeCrypto.randomUUID(), companyId: elsewhere.id, userId: second.id, role: 'owner' },
    ]),
  )
  yield* database.run(
    database.insert(threads).values({
      id: threadId,
      title: 'Shared work',
      titleSource: 'Person',
      personId: first.id,
      companyId: shared.id,
      audience: 'company',
      updatedAt: yield* Clock.currentTimeMillis,
    }),
  )
  return {
    threadId,
    companies: { shared, elsewhere },
    first: actor(first, Workspace.cases.Company.make({ company: shared, role: 'owner' })),
    second: actor(second, Workspace.cases.Company.make({ company: shared, role: 'member' })),
    elsewhere: actor(second, Workspace.cases.Company.make({ company: elsewhere, role: 'owner' })),
  }
})
