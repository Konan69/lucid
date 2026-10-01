import { and, asc, desc, eq, exists, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import {
  Conflict,
  DatabaseConstraintViolation,
  Forbidden,
  InvalidRequest,
  NotFound,
  ShareThreadRequest,
  Workspace,
  type CompanyId,
  type CreateThreadRequest,
  type PatchThreadRequest,
  type PersonId,
  type ProjectId,
  type Thread,
  type ThreadId,
} from '@vivid/contracts'
import { companyColumnOf, inWorkspace, type Actor } from '../auth/access.ts'
import { membershipTable } from '../companies/tables.ts'
import { Database, returned, type DatabaseInfrastructureError } from '../database/client.ts'
import { projectTable } from '../projects/tables.ts'
import { decodeThread, requireThread, type StoredAudience, type StoredThread } from './access.ts'
import { threadParticipants, threadReads, threads } from './tables.ts'
import { toWire } from './wire.ts'

type DatabaseService = Database['Service']
type ThreadStoreError = DatabaseInfrastructureError
type ThreadChangeError = ThreadStoreError | NotFound | Forbidden | InvalidRequest | Conflict

/** Removes Markdown syntax so list previews remain compact and readable. */
export const plainPreview = (markdown: string) =>
  markdown
    .replace(/```[\s\S]*?```/gu, ' code ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+\.)\s+/gmu, '')
    .replace(/[*_~`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 240)

/** What sharing changed, so the caller can tell exactly the People it affected. */
export interface Shared {
  readonly thread: Thread
  readonly added: ReadonlyArray<PersonId>
  readonly removed: ReadonlyArray<PersonId>
}

export interface ThreadStoreService {
  /** Every Thread the Actor can see in their workspace, newest activity first. */
  readonly list: (actor: Actor) => Effect.Effect<ReadonlyArray<Thread>, ThreadStoreError>
  /** One stored Thread as the given Person sees it. */
  readonly view: (
    thread: StoredThread,
    personId: PersonId,
  ) => Effect.Effect<Thread, ThreadStoreError>
  /**
   * The private Thread with this id, owned by this Person in this workspace, created if it does not
   * exist. For the Threads the server itself opens: a Routine's, a Task's.
   */
  readonly ensure: (input: {
    readonly id: ThreadId
    readonly title: string
    readonly personId: PersonId
    readonly companyId: CompanyId | null
  }) => Effect.Effect<StoredThread, ThreadStoreError>
  readonly create: (
    actor: Actor,
    request: CreateThreadRequest,
  ) => Effect.Effect<Thread, ThreadChangeError>
  readonly patch: (
    personId: PersonId,
    id: ThreadId,
    patch: PatchThreadRequest,
  ) => Effect.Effect<Thread, ThreadChangeError>
  readonly share: (
    personId: PersonId,
    id: ThreadId,
    audience: ShareThreadRequest,
  ) => Effect.Effect<Shared, ThreadChangeError>
  /** Deletes a Thread for its creator and returns what it was, for telling whoever could see it. */
  readonly remove: (
    personId: PersonId,
    id: ThreadId,
  ) => Effect.Effect<StoredThread, ThreadChangeError>
  readonly markRead: (personId: PersonId, id: ThreadId) => Effect.Effect<void, ThreadChangeError>
  /** Moves a Thread to the top of its list, with a new preview when there is something to show. */
  readonly touch: (
    id: ThreadId,
    preview: Option.Option<string>,
  ) => Effect.Effect<void, ThreadStoreError>
  /** The Members a `people` Thread is shared with, beside its creator. */
  readonly participants: (id: ThreadId) => Effect.Effect<ReadonlyArray<PersonId>, ThreadStoreError>
}

export class ThreadStore extends Context.Service<ThreadStore, ThreadStoreService>()(
  'vivid/ThreadStore',
) {}

/**
 * The SQL form of `canSee` for a whole list. It must say exactly what `threads/access.ts` says for
 * one Thread: in a personal space only the creator's own; in a Company, shared with everyone,
 * created by the Person, or shared with them by name.
 */
const visibleTo = (actor: Actor): SQL => {
  const me = actor.person.id
  const scope = inWorkspace(threads, actor)
  if (!Workspace.guards.Company(actor.workspace)) return scope
  const participates = exists(
    sql`(select 1 from ${threadParticipants} where ${threadParticipants.threadId} = ${threads.id} and ${threadParticipants.personId} = ${me})`,
  )
  const reach = or(eq(threads.audience, 'company'), eq(threads.personId, me), participates)
  // `and` only returns undefined for an empty list, which this is not.
  return and(scope, reach) ?? scope
}

const makeList = (database: DatabaseService) =>
  Effect.fn('ThreadStore.list')(function* (actor: Actor) {
    const rows = yield* database.run(
      database
        .select()
        .from(threads)
        .where(visibleTo(actor))
        .orderBy(desc(threads.updatedAt), asc(threads.id))
        .limit(500),
    )
    const stored = yield* Effect.forEach(rows, decodeThread)
    return yield* toWire(database, stored, actor.person.id)
  })

const makeView = (database: DatabaseService) =>
  Effect.fn('ThreadStore.view')(function* (thread: StoredThread, personId: PersonId) {
    return yield* returned(yield* toWire(database, [thread], personId), 'Thread')
  })

const makeEnsure = (database: DatabaseService) =>
  Effect.fn('ThreadStore.ensure')(function* (input: {
    readonly id: ThreadId
    readonly title: string
    readonly personId: PersonId
    readonly companyId: CompanyId | null
  }) {
    const now = yield* Clock.currentTimeMillis
    yield* database.run(
      database
        .insert(threads)
        .values({
          id: input.id,
          title: input.title,
          updatedAt: now,
          personId: input.personId,
          companyId: input.companyId,
        })
        .onConflictDoNothing({ target: threads.id }),
    )
    const rows = yield* database.run(
      database.select().from(threads).where(eq(threads.id, input.id)).limit(1),
    )
    const stored = yield* decodeThread(yield* returned(rows, 'Thread'))
    // The id is predictable (`routine-<id>`, `task-<id>`), so a row already being there proves
    // nothing about whose it is. Only this Person's Thread in this workspace is handed back;
    // sharing changes audience, not ownership. Never deliver a Routine into a Thread
    // someone else created to receive it.
    const theirs = stored.personId === input.personId && stored.companyId === input.companyId
    return theirs
      ? stored
      : yield* Effect.fail(
          new DatabaseConstraintViolation({ message: 'Database constraint was violated' }),
        )
  })

/** A Project may hold a Thread only when both are in the same workspace. */
const requireProject = Effect.fn('ThreadStore.requireProject')(function* (
  database: DatabaseService,
  projectId: ProjectId,
  owner: { readonly companyId: CompanyId | null; readonly personId: PersonId },
) {
  const scope =
    owner.companyId === null
      ? and(isNull(projectTable.companyId), eq(projectTable.createdBy, owner.personId))
      : eq(projectTable.companyId, owner.companyId)
  const rows = yield* database.run(
    database
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(and(eq(projectTable.id, projectId), scope))
      .limit(1),
  )
  return rows.length === 0
    ? yield* Effect.fail(new NotFound({ message: 'Project not found' }))
    : projectId
})

const makeMarkRead = (database: DatabaseService) =>
  Effect.fn('ThreadStore.markRead')(function* (personId: PersonId, id: ThreadId) {
    yield* requireThread(id, personId).pipe(Effect.provideService(Database, database))
    const now = yield* Clock.currentTimeMillis
    yield* database.run(
      database
        .insert(threadReads)
        .values({ threadId: id, personId, readAt: now })
        .onConflictDoUpdate({
          target: [threadReads.threadId, threadReads.personId],
          set: { readAt: now },
        }),
    )
  })

const idTaken = () => Effect.fail(new Conflict({ message: 'That Thread id is taken' }))

/** Ids the server mints for the Threads it opens itself. A client may not claim one. */
const RESERVED = /^(?:routine|task)-/u

const makeCreate = (database: DatabaseService) =>
  Effect.fn('ThreadStore.create')(function* (actor: Actor, request: CreateThreadRequest) {
    const companyId = companyColumnOf(actor.workspace)
    const personId = actor.person.id
    if (RESERVED.test(request.id)) {
      return yield* Effect.fail(new InvalidRequest({ message: 'That Thread id is reserved' }))
    }
    if (request.projectId !== null) {
      yield* requireProject(database, request.projectId, { companyId, personId })
    }
    const now = yield* Clock.currentTimeMillis
    // The id is the client's so it can draw the Thread before the server answers. A retry of the
    // same create is therefore expected and returns the Thread. Anything else under that id, even
    // a Thread this Person can see, is a conflict: creating is not a way to open someone else's.
    const inserted = yield* database.run(
      database
        .insert(threads)
        .values({
          id: request.id,
          title: request.title,
          updatedAt: now,
          personId,
          companyId,
          projectId: request.projectId,
        })
        .onConflictDoNothing({ target: threads.id })
        .returning({ id: threads.id }),
    )
    const stored = yield* requireThread(request.id, personId).pipe(
      Effect.provideService(Database, database),
      Effect.catchTag('NotFound', idTaken),
    )
    if (stored.personId !== personId || stored.companyId !== companyId) return yield* idTaken()
    if (inserted.length > 0) yield* makeMarkRead(database)(personId, request.id)
    return yield* makeView(database)(stored, personId)
  })

const makePatch = (database: DatabaseService) =>
  Effect.fn('ThreadStore.patch')(function* (
    personId: PersonId,
    id: ThreadId,
    change: PatchThreadRequest,
  ) {
    const thread = yield* requireThread(id, personId).pipe(
      Effect.provideService(Database, database),
    )
    if (change.projectId !== undefined && change.projectId !== null) {
      yield* requireProject(database, change.projectId, thread)
    }
    // Only the fields the caller named are written, so two People changing different things at
    // the same moment (one renames, one archives) both keep their change.
    const rows = yield* database.run(
      database
        .update(threads)
        .set({
          title: change.title === undefined ? sql`${threads.title}` : change.title,
          archived: change.archived === undefined ? sql`${threads.archived}` : change.archived,
          projectId: change.projectId === undefined ? sql`${threads.projectId}` : change.projectId,
        })
        .where(eq(threads.id, id))
        .returning(),
    )
    const stored = yield* decodeThread(yield* returned(rows, 'Thread'))
    return yield* makeView(database)(stored, personId)
  })

const makeParticipants = (database: DatabaseService) =>
  Effect.fn('ThreadStore.participants')(function* (id: ThreadId) {
    const rows = yield* database.run(
      database
        .select({ personId: threadParticipants.personId })
        .from(threadParticipants)
        .where(eq(threadParticipants.threadId, id)),
    )
    return rows.map((row) => row.personId)
  })

/** The People a share names beside the creator, who must all be Members of the Thread's Company. */
const requireMembers = Effect.fn('ThreadStore.requireMembers')(function* (
  database: DatabaseService,
  companyId: CompanyId,
  people: ReadonlyArray<PersonId>,
) {
  if (people.length === 0) return people
  const rows = yield* database.run(
    database
      .select({ personId: membershipTable.userId })
      .from(membershipTable)
      .where(
        and(eq(membershipTable.companyId, companyId), inArray(membershipTable.userId, people)),
      ),
  )
  const members = new Set(rows.map((row) => row.personId))
  return people.every((person) => members.has(person))
    ? people
    : yield* Effect.fail(
        new InvalidRequest({ message: 'A Thread can only be shared with Members of its Company' }),
      )
})

/** The audience as its row stores it, and the People it names beside the creator. */
interface Sharing {
  readonly stored: StoredAudience
  readonly people: ReadonlyArray<PersonId>
}

const sharingOf = (audience: ShareThreadRequest, creator: PersonId): Sharing => {
  if (ShareThreadRequest.guards.People(audience)) {
    const named = [...new Set(audience.participants)]
    return { stored: 'people', people: named.filter((person) => person !== creator) }
  }
  return { stored: ShareThreadRequest.guards.Company(audience) ? 'company' : 'private', people: [] }
}

const makeShare = (database: DatabaseService) =>
  Effect.fn('ThreadStore.share')(function* (
    personId: PersonId,
    id: ThreadId,
    audience: ShareThreadRequest,
  ) {
    const provide = Effect.provideService(Database, database)
    const thread = yield* requireThread(id, personId).pipe(provide)
    if (thread.personId !== personId) {
      return yield* Effect.fail(new Forbidden({ message: 'Only its creator can share a Thread' }))
    }
    if (thread.companyId === null) {
      return yield* Effect.fail(
        new InvalidRequest({ message: 'A Thread in your own space has nobody to be shared with' }),
      )
    }
    // A Routine's or a Task's own Thread is where Vivid reports to one Person. Sharing it would
    // put that Person's Routine in front of other people and stop the server from opening it.
    if (RESERVED.test(thread.id)) {
      return yield* Effect.fail(
        new InvalidRequest({
          message: 'This thread belongs to a routine or a task and stays private',
        }),
      )
    }
    const sharing = sharingOf(audience, personId)
    const people = yield* requireMembers(database, thread.companyId, sharing.people)
    const now = yield* Clock.currentTimeMillis
    const rows = people.map((person) => ({ threadId: id, personId: person, addedAt: now }))
    // The Thread's row is locked for the whole replacement. Without it two shares racing could
    // each clear the list and then each add their own People, leaving the union of both: reach
    // nobody asked for.
    const present = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.select({ id: threads.id }).from(threads).where(eq(threads.id, id)).for('update')
        const listed = yield* tx
          .select({ personId: threadParticipants.personId })
          .from(threadParticipants)
          .where(eq(threadParticipants.threadId, id))
        yield* tx.delete(threadParticipants).where(eq(threadParticipants.threadId, id))
        if (rows.length > 0) yield* tx.insert(threadParticipants).values(rows)
        yield* tx.update(threads).set({ audience: sharing.stored }).where(eq(threads.id, id))
        return listed
      }),
    )
    const before = present.map((row) => row.personId)
    const after = yield* requireThread(id, personId).pipe(provide)
    return {
      thread: yield* makeView(database)(after, personId),
      added: people.filter((person) => !before.includes(person)),
      removed: before.filter((person) => !people.includes(person)),
    }
  })

const makeRemove = (database: DatabaseService) =>
  Effect.fn('ThreadStore.remove')(function* (personId: PersonId, id: ThreadId) {
    const thread = yield* requireThread(id, personId).pipe(
      Effect.provideService(Database, database),
    )
    if (thread.personId !== personId) {
      return yield* Effect.fail(new Forbidden({ message: 'Only its creator can delete a Thread' }))
    }
    yield* database.run(database.delete(threads).where(eq(threads.id, id)))
    return thread
  })

const makeTouch = (database: DatabaseService) =>
  Effect.fn('ThreadStore.touch')(function* (id: ThreadId, preview: Option.Option<string>) {
    const now = yield* Clock.currentTimeMillis
    const change = Option.match(preview, {
      onNone: () => ({ updatedAt: now }),
      onSome: (text) => ({ updatedAt: now, preview: plainPreview(text) }),
    })
    yield* database.run(database.update(threads).set(change).where(eq(threads.id, id)))
  })

export const threadStoreLayer = Layer.effect(
  ThreadStore,
  Effect.gen(function* () {
    const database = yield* Database
    return ThreadStore.of({
      list: makeList(database),
      view: makeView(database),
      ensure: makeEnsure(database),
      create: makeCreate(database),
      patch: makePatch(database),
      share: makeShare(database),
      remove: makeRemove(database),
      markRead: makeMarkRead(database),
      touch: makeTouch(database),
      participants: makeParticipants(database),
    })
  }),
)
