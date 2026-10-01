import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import {
  Forbidden,
  Person,
  PersonSummary,
  Workspace,
  type Company,
  type CompanyId,
  type PersonId,
  type Role,
  type ThreadId,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { Database, decodeStored, type DatabaseInfrastructureError } from '../database/client.ts'
import { personTable } from './tables.ts'

/**
 * Who a product call acts for, and where.
 *
 * Two callers reach product logic: a signed-in Person, and Vivid in the middle of a Run. Vivid has
 * no identity of its own; it acts as the Person who asked, with exactly what that Person may do
 * (docs/22, rule 1). Handlers therefore read one `Actor` and never branch on which of the two is
 * calling, except where a rule is deliberately different for Vivid: `by` and `threadId` are there
 * for those, and for attribution.
 */
export interface Actor {
  readonly person: Person
  readonly workspace: Workspace
  readonly by: 'person' | 'vivid'
  /** The Thread Vivid is acting in. A Person's own call is not tied to one. */
  readonly threadId: Option.Option<ThreadId>
}

/** The Person or Vivid behind this call. The runtime itself, with no Person behind it, is refused. */
export const requireActor = Effect.fn('Access.requireActor')(function* () {
  const auth = yield* AuthContext
  return yield* AuthState.$match(auth, {
    Person: ({ person, workspace }) =>
      Effect.succeed<Actor>({ person, workspace, by: 'person', threadId: Option.none() }),
    Vivid: ({ person, workspace, threadId }) =>
      Effect.succeed<Actor>({ person, workspace, by: 'vivid', threadId: Option.some(threadId) }),
    Runtime: () => Effect.fail(new Forbidden({ message: 'This call needs a Person to act for' })),
  })
})

/**
 * A signed-in Person and nothing else. Used where Vivid must never act on its own: changing who is
 * in a Company, deciding an Approval, writing a rule, connecting an account.
 */
export const requirePerson = Effect.fn('Access.requirePerson')(function* () {
  const auth = yield* AuthContext
  if (!AuthState.$is('Person')(auth)) {
    return yield* Effect.fail(new Forbidden({ message: 'Only a signed-in Person can do this' }))
  }
  return auth
})

/** Vivid in a Run, and nothing else. Used by the calls only its tools make. */
export const requireVivid = Effect.fn('Access.requireVivid')(function* () {
  const auth = yield* AuthContext
  if (!AuthState.$is('Vivid')(auth)) {
    return yield* Effect.fail(new Forbidden({ message: 'Only Vivid in a Run can do this' }))
  }
  return auth
})

/** The Company a workspace is, with the caller's role there, or a refusal in a personal space. */
export const requireCompany = Effect.fn('Access.requireCompany')(function* (workspace: Workspace) {
  if (!Workspace.guards.Company(workspace)) {
    return yield* Effect.fail(new Forbidden({ message: 'This needs a Company workspace' }))
  }
  return { company: workspace.company, role: workspace.role }
})

/** Whether a role may manage people, Company rules and shared Connections. */
export const isAdmin = (role: Role) => role === 'owner' || role === 'admin'

/** The Company a workspace is, for an owner or admin of it. */
export const requireAdmin = Effect.fn('Access.requireAdmin')(function* (workspace: Workspace) {
  const { company, role } = yield* requireCompany(workspace)
  if (!isAdmin(role)) {
    return yield* Effect.fail(new Forbidden({ message: 'Only a Company admin can do this' }))
  }
  return { company, role }
})

/** The Company a workspace is, when it is one. */
export const companyOf = (workspace: Workspace): Option.Option<Company> =>
  Workspace.match(workspace, {
    Personal: () => Option.none(),
    Company: ({ company }) => Option.some(company),
  })

/**
 * The `company_id` a record made in this workspace carries: the Company's id, or SQL NULL in a
 * personal space. This is the one place the union becomes the nullable column.
 */
export const companyColumnOf = (workspace: Workspace): CompanyId | null =>
  Option.getOrNull(Option.map(companyOf(workspace), (company) => company.id))

/** The two ownership columns every product table declares (`database/owner.ts`). */
interface OwnerColumns {
  readonly personId: PgColumn
  readonly companyId: PgColumn
}

/**
 * Everything in the Actor's workspace: in a personal space, what they own with no Company; in a
 * Company, everything that Company holds. A domain that is narrower than the whole Company (a
 * private Thread, a personal Routine) adds its own condition on top.
 */
export const inWorkspace = (columns: OwnerColumns, actor: Actor): SQL =>
  Workspace.match(actor.workspace, {
    Personal: () => personal(columns, actor.person.id),
    Company: ({ company }) => eq(columns.companyId, company.id),
  })

/** What the Actor themselves owns in their workspace, whichever kind it is. */
export const ownedHere = (columns: OwnerColumns, actor: Actor): SQL =>
  Workspace.match(actor.workspace, {
    Personal: () => personal(columns, actor.person.id),
    Company: ({ company }) =>
      // `and` only returns undefined for an empty list, which this is not.
      and(eq(columns.companyId, company.id), eq(columns.personId, actor.person.id)) ??
      eq(columns.personId, actor.person.id),
  })

const personal = (columns: OwnerColumns, personId: PersonId): SQL =>
  and(eq(columns.personId, personId), isNull(columns.companyId)) ?? eq(columns.personId, personId)

/** What one Person shows another: a name and a face, never an email address. */
export const summaryOf = (person: Pick<Person, 'id' | 'name' | 'image'>): PersonSummary => ({
  id: person.id,
  name: person.name,
  image: Option.getOrNull(Option.fromNullishOr(person.image)),
})

/**
 * The summaries of a set of People, by id. A Person who has since been deleted is simply absent;
 * the rows that referenced them are gone with them, so a caller that cannot find one has a
 * database fault and says so.
 */
export const loadSummaries = Effect.fn('Access.loadSummaries')(function* (
  ids: ReadonlyArray<PersonId>,
): Effect.fn.Return<ReadonlyMap<PersonId, PersonSummary>, DatabaseInfrastructureError, Database> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ id: personTable.id, name: personTable.name, image: personTable.image })
      .from(personTable)
      .where(inArray(personTable.id, unique)),
  )
  const summaries = yield* Effect.forEach(rows, decodeSummary)
  return new Map(summaries.map((summary) => [summary.id, summary] as const))
})

const decodeSummary = decodeStored(PersonSummary, 'Person')

const decodePerson = decodeStored(Person, 'Person')

/** One Person by id: the identity a call, a Run or a record is attributed to. */
export const findPerson = Effect.fn('Access.findPerson')(function* (id: string) {
  const database = yield* Database
  const rows = yield* database.run(
    database.select().from(personTable).where(eq(personTable.id, id)).limit(1),
  )
  const row = rows[0]
  if (row === undefined) return Option.none<Person>()
  return Option.some(
    yield* decodePerson({ id: row.id, name: row.name, email: row.email, image: row.image }),
  )
})
