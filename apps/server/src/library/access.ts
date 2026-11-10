import { eq, sql } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  CompanyId,
  LibraryFolderId,
  LibraryShelf,
  PersonId,
  Workspace,
  NotFound,
  InvalidRequest,
} from '@vivid/contracts'
import {
  companyOf,
  inWorkspace,
  isAdmin,
  ownedHere,
  requireCompany,
  type Actor,
} from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { Topic } from '../live/changes.ts'
import { requireThread } from '../threads/access.ts'

/** A Company shelf cannot be selected in a personal workspace. */
export class LibraryShelfUnavailable extends Schema.TaggedError<LibraryShelfUnavailable>()(
  'LibraryShelfUnavailable',
  { shelf: LibraryShelf },
  { title: 'Library shelf unavailable' },
) {}
/** Read access to Company content does not confer edit authority. */
export class LibraryMutationDenied extends Schema.TaggedError<LibraryMutationDenied>()(
  'LibraryMutationDenied',
  { personId: PersonId, companyId: CompanyId },
  { title: 'Library mutation denied' },
) {}
/** Folder relations never move content between shelves. */
export class LibraryFolderMismatch extends Schema.TaggedError<LibraryFolderMismatch>()(
  'LibraryFolderMismatch',
  { folderId: LibraryFolderId, shelf: LibraryShelf },
  { title: 'Library folder shelf mismatch' },
) {}
/** A recursive folder tree must stay acyclic. */
export class LibraryFolderCycle extends Schema.TaggedError<LibraryFolderCycle>()(
  'LibraryFolderCycle',
  { folderId: LibraryFolderId },
  { title: 'Library folder cycle' },
) {}

interface ShelfColumns {
  readonly personId: PgColumn
  readonly companyId: PgColumn
}
export interface ShelfOwner {
  readonly personId: PersonId
  readonly companyId: CompanyId | null
}

/** Mine belongs to the Person across workspace switches; an admin never gains another Mine. */
const mineScope = (columns: ShelfColumns, actor: Actor) =>
  ownedHere(columns, { ...actor, workspace: Workspace.cases.Personal.make({}) })

/** The only possible shelf sets: Mine, both shelves, or Company alone. */
type LibraryReadScope = readonly ['Mine'] | readonly ['Mine', 'Company'] | readonly ['Company']

/**
 * A Person and Vivid in a private Thread read Mine plus the active Company's shelf. A shared
 * Thread can read only the Company shelf: private files must not enter its metadata or results.
 * Thread access and audience are read now, so changing sharing immediately changes every reader.
 */
const readScope = Effect.fn('Library.readScope')(function* (actor: Actor) {
  const ordinary = Workspace.match(actor.workspace, {
    Personal: (): LibraryReadScope => ['Mine'],
    Company: (): LibraryReadScope => ['Mine', 'Company'],
  })
  if (actor.by === 'person') return ordinary
  if (Option.isNone(actor.threadId))
    return yield* new InvalidRequest({ message: 'Vivid Library access requires a Thread' })
  const thread = yield* requireThread(actor.threadId.value, actor.person.id)
  if (thread.audience === 'private') return ordinary
  const company = companyOf(actor.workspace)
  if (Option.isNone(company) || thread.companyId !== company.value.id)
    return yield* new InvalidRequest({ message: 'Shared Thread must be in the active Company' })
  return ['Company'] as const
})

/** Applying the one read policy in SQL protects both metadata and content before they leave storage. */
export const readableScope = Effect.fn('Library.readableScope')(function* (
  database: Database['Service'],
  columns: ShelfColumns,
  actor: Actor,
) {
  const shelves = yield* readScope(actor).pipe(Effect.provideService(Database, database))
  return sql`(${sql.join(
    shelves.map((shelf) =>
      shelf === 'Mine' ? mineScope(columns, actor) : inWorkspace(columns, actor),
    ),
    sql` OR `,
  )})`
})

/** Company selection requires a Company workspace; bytes and RPC use the same refusal. */
export const shelfCompany = Effect.fn('Library.shelfCompany')(function* (
  actor: Actor,
  shelf: LibraryShelf,
) {
  if (shelf === 'Mine') return null
  const { company } = yield* requireCompany(actor.workspace).pipe(
    Effect.mapError(() => new LibraryShelfUnavailable({ shelf })),
  )
  return company.id
})

/** Selected-shelf conditions are SQL predicates, reused by list and digest deduplication. */
export const shelfScope = Effect.fn('Library.shelfScope')(function* (
  columns: ShelfColumns,
  actor: Actor,
  shelf: LibraryShelf,
) {
  const companyId = yield* shelfCompany(actor, shelf)
  return companyId === null ? mineScope(columns, actor) : eq(columns.companyId, companyId)
})

/** The nullable ownership column is the sole source of the public shelf vocabulary. */
export const shelfOf = (owner: Pick<ShelfOwner, 'companyId'>): LibraryShelf =>
  owner.companyId === null ? 'Mine' : 'Company'

/**
 * Stored ownership alone defines the audience: Mine is private to its Person, Company to Members.
 * mineScope above and auth/access.ts inWorkspace define these same read boundaries; an editor's
 * current workspace or attribution cannot widen them. database/owner.ts:16-28 brands both stored
 * columns, so this rule needs no reconstruction of an Actor or recasting of an identifier.
 */
export const shelfTopics = (owner: ShelfOwner): ReadonlyArray<Topic> =>
  owner.companyId === null ? [Topic.person(owner.personId)] : [Topic.company(owner.companyId)]

/** Reads establish visibility before this check, so Forbidden never reveals an unseen row. */
export const requireEditor = Effect.fn('Library.requireEditor')(function* (
  actor: Actor,
  owner: ShelfOwner,
) {
  if (owner.personId === actor.person.id) return undefined
  if (
    owner.companyId !== null &&
    Workspace.guards.Company(actor.workspace) &&
    owner.companyId === actor.workspace.company.id &&
    isAdmin(actor.workspace.role)
  )
    return undefined
  if (owner.companyId !== null) {
    return yield* new LibraryMutationDenied({
      personId: actor.person.id,
      companyId: owner.companyId,
    })
  }
  return yield* new NotFound({ message: 'Library record not found' })
})
