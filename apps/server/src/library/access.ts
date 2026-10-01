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
} from '@vivid/contracts'
import {
  companyOf,
  inWorkspace,
  isAdmin,
  ownedHere,
  requireCompany,
  type Actor,
} from '../auth/access.ts'

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
  readonly personId: string
  readonly companyId: string | null
}

/** Mine belongs to the Person across workspace switches; an admin never gains another Mine. */
export const mineScope = (columns: ShelfColumns, actor: Actor) =>
  ownedHere(columns, { ...actor, workspace: Workspace.cases.Personal.make({}) })

/** Readable shelves are the Person's Mine plus the active Company's rows. */
export const readableScope = (columns: ShelfColumns, actor: Actor) => {
  const mine = mineScope(columns, actor)
  return Option.isNone(companyOf(actor.workspace))
    ? mine
    : sql`(${mine} OR ${inWorkspace(columns, actor)})`
}

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
    return yield* Effect.fail(
      new LibraryMutationDenied({
        personId: actor.person.id,
        companyId: CompanyId.make(owner.companyId),
      }),
    )
  }
  return yield* Effect.fail(new NotFound({ message: 'Library record not found' }))
})
