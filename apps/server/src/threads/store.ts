import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import * as Array from 'effect/Array'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import {
  AuditEvent,
  Conflict,
  DatabaseConstraintViolation,
  Forbidden,
  InvalidRequest,
  NotFound,
  type OpenFirstThreadResult,
  ShareThreadRequest,
  type CompanyId,
  type CreateThreadRequest,
  type PatchThreadRequest,
  type PersonId,
  type ProjectId,
  type Thread,
  type ThreadId,
} from '@vivid/contracts'
import { appendAudit, AuditAttribution } from '../audit/record.ts'
import { announce, Topic } from '../live/changes.ts'
import { companyColumnOf, inWorkspace, type Actor } from '../auth/access.ts'
import { membershipTable } from '../companies/tables.ts'
import { readThreadNotices } from '../notifications/store.ts'
import { Database, returned, type DatabaseInfrastructureError } from '../database/client.ts'
import { projectTable } from '../projects/tables.ts'
import {
  audienceTopics,
  canSee,
  decodeThread,
  findThread,
  reachedBy,
  type StoredAudience,
  type StoredThread,
} from './access.ts'
import { threadParticipants, threadReads, threads } from './tables.ts'
import { toWire } from './wire.ts'
import type { TitleSource } from './title.ts'
import { claimFirstThread, releaseFirstThread } from './first.ts'

type DatabaseService = Database['Service']
type Transaction = Parameters<Parameters<DatabaseService['transaction']>[0]>[0]
type ThreadStoreError = DatabaseInfrastructureError
type ThreadChangeError = ThreadStoreError | NotFound | Forbidden | InvalidRequest | Conflict

/** Removes Markdown syntax so list previews remain compact and readable. */
const plainPreview = (markdown: string) =>
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
  readonly companyId: CompanyId
}

export interface ThreadStoreService {
  /** Claims the first Thread once for a Person, independently of their current workspace. */
  readonly openFirst: (actor: Actor) => Effect.Effect<OpenFirstThreadResult, ThreadStoreError>
  /** Releases only a matching first-arrival receipt whose Thread has never had a Run. */
  readonly releaseFirst: (
    personId: PersonId,
    threadId: ThreadId,
  ) => Effect.Effect<void, ThreadStoreError>
  /** Every Thread the Actor can see in their workspace, newest activity first. */
  readonly list: (actor: Actor) => Effect.Effect<ReadonlyArray<Thread>, ThreadStoreError>
  /** One stored Thread as the given Person sees it. */
  readonly view: (
    thread: StoredThread,
    personId: PersonId,
  ) => Effect.Effect<Thread, ThreadStoreError>
  /**
   * A private Background Thread Vivid works in on its own (`place.ts`), created if absent.
   * It is never listed; an existing id must belong to the same Person and workspace.
   */
  readonly ensureBackground: (input: Ensured) => Effect.Effect<StoredThread, ThreadStoreError>
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
  /** Deletes a Thread for its creator, announcing its audience in the same transaction. */
  readonly remove: (personId: PersonId, id: ThreadId) => Effect.Effect<void, ThreadChangeError>
  readonly markRead: (personId: PersonId, id: ThreadId) => Effect.Effect<void, ThreadChangeError>
  /** Moves a Thread to the top of its list, with a new preview when there is something to show. */
  readonly touch: (
    id: ThreadId,
    preview: Option.Option<string>,
  ) => Effect.Effect<void, ThreadStoreError>
  /** Atomically accepts a generated title only while the generation's source/title guard still holds. */
  readonly generatedTitle: (
    id: ThreadId,
    title: string,
    previous: Option.Option<string>,
  ) => Effect.Effect<boolean, ThreadStoreError>
  /** The Members a `people` Thread is shared with, beside its creator. */
  readonly participants: (id: ThreadId) => Effect.Effect<ReadonlyArray<PersonId>, ThreadStoreError>
}

/** A server-opened Thread: its id, the name it starts with and whose it is. */
export interface Ensured {
  readonly id: ThreadId
  readonly title: string
  readonly titleSource: TitleSource
  readonly personId: PersonId
  readonly companyId: CompanyId | null
}

export class ThreadStore extends Context.Service<ThreadStore, ThreadStoreService>()(
  'vivid/ThreadStore',
) {}

/**
 * Workspace limits navigation; current Membership and audience limit reach even for a stale Actor.
 * Rows are decoded next, so reachedBy retains the creator's DatabaseFailure for corrupt audiences.
 * Only Conversations are listed: a Background Thread is reached through the Feed, by id (`place.ts`).
 * The list is what search, unread attention and recent Threads all read, so this one clause keeps
 * Background Threads out of each of them.
 */
const visibleTo = (actor: Actor): SQL =>
  sql`(${inWorkspace(threads, actor)} and ${reachedBy(actor.person.id)} and ${eq(threads.place, 'Conversation')})`

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

/**
 * The inserted row owns its private audience. Announce in the insert transaction so failed runtime
 * admission cannot leave an unannounced Thread; an existing ownership receipt writes nothing.
 * A Watch id is predictable, so its presence never proves which Person may receive the work.
 */
const makeEnsureBackground = (database: DatabaseService) =>
  Effect.fn('ThreadStore.ensureBackground')(function* (input: Ensured) {
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const inserted = yield* tx
          .insert(threads)
          .values({
            id: input.id,
            title: input.title,
            titleSource: input.titleSource,
            updatedAt: now,
            personId: input.personId,
            companyId: input.companyId,
            place: 'Background',
          })
          .onConflictDoNothing({ target: threads.id })
          .returning()
        const row = inserted[0]
        if (row !== undefined) {
          const stored = yield* decodeThread(row)
          yield* announce(tx, audienceTopics(stored, []))
          return stored
        }
        const rows = yield* database.run(
          database.select().from(threads).where(eq(threads.id, input.id)).limit(1),
        )
        const stored = yield* decodeThread(yield* returned(rows, 'Thread'))
        // A predictable Watch id proves no ownership; sharing changes reach, never ownership.
        // A Conversation is never reused as a Background Thread.
        const theirs =
          stored.personId === input.personId &&
          stored.companyId === input.companyId &&
          stored.place === 'Background'
        return theirs
          ? stored
          : yield* new DatabaseConstraintViolation({ message: 'Database constraint was violated' })
      }),
    )
  })

/**
 * Lock before authorization so each read sees shares committed before the lock was granted.
 * Effect rc.116 unstable/sql/SqlClient.ts:162-171,285-300 resolves each statement's connection
 * from fiber context; Drizzle effect-postgres/session.js:14-29 installs it for the callback.
 * Existing Database readers therefore join this transaction without casting tx to Database or
 * replacing the transaction service with a captured context. Key share leaves touch unblocked:
 * it stops deletion and key changes only; today's sharing writers wait because they take FOR UPDATE.
 */
const lockThread = (database: DatabaseService) =>
  Effect.fn('ThreadStore.lock')(function* (
    tx: Transaction,
    personId: PersonId,
    id: ThreadId,
    mode: 'update' | 'key share',
  ) {
    const rows = yield* tx.select().from(threads).where(eq(threads.id, id)).limit(1).for(mode)
    const row = rows[0]
    if (row === undefined) return yield* new NotFound({ message: 'Thread not found' })
    const thread = yield* decodeThread(row)
    if (!(yield* canSee(thread.id, personId).pipe(Effect.provideService(Database, database))))
      return yield* new NotFound({ message: 'Thread not found' })
    return thread
  })

/** Company Project counts include private filed Threads (projects/store.ts filedIn). */
const filedTopics = (thread: StoredThread): ReadonlyArray<Topic> =>
  thread.companyId !== null && thread.projectId !== null ? [Topic.company(thread.companyId)] : []

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
  return rows.length === 0 ? yield* new NotFound({ message: 'Project not found' }) : projectId
})

/**
 * Key share protects authorization against deletion; receipt and Person notice commit together.
 * Reading a Thread also reads this Person's notifications about it: a notice says "go and look at
 * this Thread", and once they have, it is seen. Until 27 October 2026 a notice stayed unread in
 * Notifications after its Thread had been opened (the owner, on his iPhone). The notifications
 * part is announced only when a notice changed, so an ordinary read wakes only the activity lists.
 */
const makeMarkRead = (database: DatabaseService) =>
  Effect.fn('ThreadStore.markRead')(function* (personId: PersonId, id: ThreadId) {
    yield* database.transaction((tx) =>
      Effect.gen(function* () {
        yield* lockThread(database)(tx, personId, id, 'key share')
        const now = yield* Clock.currentTimeMillis
        yield* tx
          .insert(threadReads)
          .values({ threadId: id, personId, readAt: now })
          .onConflictDoUpdate({
            target: [threadReads.threadId, threadReads.personId],
            set: { readAt: now },
          })
        const seen = yield* readThreadNotices(tx, personId, id)
        const person = Topic.person(personId)
        const activity = Topic.part('activity')(person)
        // One notice per write, naming every part it moved.
        yield* announce(tx, seen > 0 ? [activity, Topic.part('notifications')(person)] : [activity])
      }),
    )
  })

const idTaken = () => Effect.fail(new Conflict({ message: 'That Thread id is taken' }))

/**
 * Ids the server mints for the Threads it opens itself (Watch arrivals, Settings forgets, Dreamer
 * runs). A client may not claim one.
 */
const RESERVED = /^(?:watch|forget|dream)-/u

/**
 * Insert, Membership check, creator read receipt and notice commit together. The inserted row
 * owns the audience; a refusal rolls it back, while a same-owner retry writes and announces nothing.
 * Clients mint ids for optimistic creation, so retries must recheck current access before returning
 * the existing metadata. An inaccessible id keeps the prior Conflict refusal and reveals no view.
 * The wire view reads this transaction's insert and receipt before committing (announcements case1).
 */
const makeCreate = (database: DatabaseService) =>
  Effect.fn('ThreadStore.create')(function* (actor: Actor, request: CreateThreadRequest) {
    const companyId = companyColumnOf(actor.workspace)
    const personId = actor.person.id
    if (RESERVED.test(request.id)) {
      return yield* new InvalidRequest({ message: 'That Thread id is reserved' })
    }
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        if (request.projectId !== null) {
          yield* requireProject(database, request.projectId, { companyId, personId })
        }
        const now = yield* Clock.currentTimeMillis
        const inserted = yield* tx
          .insert(threads)
          .values({
            id: request.id,
            title: request.title,
            titleSource: 'Seed',
            updatedAt: now,
            personId,
            companyId,
            projectId: request.projectId,
          })
          .onConflictDoNothing({ target: threads.id })
          .returning()
        const row = inserted[0]
        if (row === undefined) {
          const existing = yield* findThread(request.id).pipe(
            Effect.provideService(Database, database),
          )
          if (
            Option.isNone(existing) ||
            existing.value.personId !== personId ||
            existing.value.companyId !== companyId
          )
            return yield* idTaken()
          if (
            !(yield* canSee(existing.value.id, personId).pipe(
              Effect.provideService(Database, database),
            ))
          )
            return yield* idTaken()
          return yield* makeView(database)(existing.value, personId)
        }
        const stored = yield* decodeThread(row)
        if (!(yield* canSee(stored.id, personId).pipe(Effect.provideService(Database, database))))
          return yield* new Forbidden({ message: 'You are not a Member of this Company' })
        yield* tx.insert(threadReads).values({ threadId: stored.id, personId, readAt: now })
        yield* announce(tx, Array.dedupe([...audienceTopics(stored, []), ...filedTopics(stored)]))
        return yield* makeView(database)(stored, personId)
      }),
    )
  })

/**
 * Hold the Thread update lock through authorization and audience reads. The write and notice
 * commit together; moves also name both Project count owners, including private Company Threads.
 */
const makePatch = (database: DatabaseService) =>
  Effect.fn('ThreadStore.patch')(function* (
    personId: PersonId,
    id: ThreadId,
    change: PatchThreadRequest,
  ) {
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const thread = yield* lockThread(database)(tx, personId, id, 'update')
        if (change.projectId !== undefined && change.projectId !== null) {
          yield* requireProject(database, change.projectId, thread)
        }
        // Preserve unnamed fields so concurrent edits to different fields both survive.
        const rows = yield* tx
          .update(threads)
          .set({
            titleSource: change.title === undefined ? sql`${threads.titleSource}` : 'Person',
            title: change.title === undefined ? sql`${threads.title}` : change.title,
            archived: change.archived === undefined ? sql`${threads.archived}` : change.archived,
            projectId:
              change.projectId === undefined ? sql`${threads.projectId}` : change.projectId,
          })
          .where(eq(threads.id, id))
          .returning()
        const stored = yield* decodeThread(yield* returned(rows, 'Thread'))
        const people = yield* makeParticipants(database)(id)
        const counts =
          change.projectId === undefined ? [] : [...filedTopics(thread), ...filedTopics(stored)]
        yield* announce(tx, Array.dedupe([...audienceTopics(stored, people), ...counts]))
        return yield* makeView(database)(stored, personId)
      }),
    )
  })

/**
 * T3 apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#regenerateThreadTitle/canReplaceThreadTitle:
 * conditional SQL closes the rename race. None is automatic Seed-only; Some is explicit regeneration.
 * UPDATE holds the Thread lock while its returned current audience and notice join the title commit,
 * avoiding the generation caller's stale pre-model snapshot. A failed guard announces nothing.
 */
const makeGeneratedTitle = (database: DatabaseService): ThreadStoreService['generatedTitle'] =>
  Effect.fn('ThreadStore.generatedTitle')(function* (id, title, previous) {
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const guard = Option.match(previous, {
          onNone: () => eq(threads.titleSource, 'Seed'),
          onSome: (before) => eq(threads.title, before),
        })
        const rows = yield* tx
          .update(threads)
          .set({ title, titleSource: 'Generated' })
          .where(and(eq(threads.id, id), guard))
          .returning()
        const row = rows[0]
        if (row === undefined) return false
        const thread = yield* decodeThread(row)
        const people = yield* makeParticipants(database)(id)
        yield* announce(tx, audienceTopics(thread, people))
        return true
      }),
    )
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
    : yield* new InvalidRequest({
        message: 'A Thread can only be shared with Members of its Company',
      })
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

/** The audit words name the reach, never disclose the named People. */
const audienceName = (audience: ShareThreadRequest) =>
  ShareThreadRequest.match(audience, {
    Private: () => 'only its creator',
    People: () => 'named people',
    Company: () => 'the whole Company',
  })

/** Every replacement participant carries the same locked Thread and share timestamp. */
const participantRows = (id: ThreadId, people: ReadonlyArray<PersonId>, now: number) =>
  people.map((personId) => ({ threadId: id, personId, addedAt: now }))

/**
 * Authorize and replace participants under the Thread update lock. Audit uses the locked Thread's
 * Company, not the session workspace. Announce both old and new audiences so People losing access
 * also reload; the Company topic refreshes its audit. Every refusal rolls back without a notice.
 */
const makeShare = (database: DatabaseService) =>
  Effect.fn('ThreadStore.share')(function* (
    personId: PersonId,
    id: ThreadId,
    audience: ShareThreadRequest,
  ) {
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const thread = yield* lockThread(database)(tx, personId, id, 'update')
        if (thread.personId !== personId) {
          return yield* new Forbidden({ message: 'Only its creator can share a Thread' })
        }
        if (thread.companyId === null) {
          return yield* new InvalidRequest({
            message: 'A Thread in your own space has nobody to be shared with',
          })
        }
        // Watch work belongs to one Person even when its Thread id is predictable.
        if (RESERVED.test(thread.id)) {
          return yield* new InvalidRequest({
            message: 'Vivid opened this thread for its own work, so it stays private',
          })
        }
        const sharing = sharingOf(audience, personId)
        const people = yield* requireMembers(database, thread.companyId, sharing.people)
        const before = yield* makeParticipants(database)(id)
        const now = yield* Clock.currentTimeMillis
        yield* tx.delete(threadParticipants).where(eq(threadParticipants.threadId, id))
        if (people.length > 0)
          yield* tx.insert(threadParticipants).values(participantRows(id, people, now))
        const rows = yield* tx
          .update(threads)
          .set({ audience: sharing.stored })
          .where(eq(threads.id, id))
          .returning()
        const after = yield* decodeThread(yield* returned(rows, 'Thread'))
        yield* appendAudit(
          tx,
          AuditAttribution.make({
            personId,
            companyId: thread.companyId,
            by: 'person',
            threadId: null,
          }),
          AuditEvent.cases.ThreadShared.make({
            title: thread.title,
            audience: audienceName(audience),
          }),
          now,
        )
        yield* announce(
          tx,
          Array.dedupe([
            ...audienceTopics(thread, before),
            ...audienceTopics(after, people),
            Topic.company(thread.companyId),
          ]),
        )
        return {
          thread: yield* makeView(database)(after, personId),
          companyId: thread.companyId,
          added: Array.difference(people, before),
        }
      }),
    )
  })

/** Capture the deleted audience under the update lock; deletion and its notice commit together. */
const makeRemove = (database: DatabaseService) =>
  Effect.fn('ThreadStore.remove')(function* (personId: PersonId, id: ThreadId) {
    yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const thread = yield* lockThread(database)(tx, personId, id, 'update')
        if (thread.personId !== personId) {
          return yield* new Forbidden({ message: 'Only its creator can delete a Thread' })
        }
        const people = yield* makeParticipants(database)(id)
        yield* tx.delete(threads).where(eq(threads.id, id))
        yield* announce(
          tx,
          Array.dedupe([...audienceTopics(thread, people), ...filedTopics(thread)]),
        )
        return undefined
      }),
    )
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
      openFirst: (actor) => claimFirstThread(actor).pipe(Effect.provideService(Database, database)),
      releaseFirst: (personId, threadId) =>
        releaseFirstThread(personId, threadId).pipe(Effect.provideService(Database, database)),
      list: makeList(database),
      view: makeView(database),
      ensureBackground: makeEnsureBackground(database),
      create: makeCreate(database),
      patch: makePatch(database),
      share: makeShare(database),
      remove: makeRemove(database),
      markRead: makeMarkRead(database),
      touch: makeTouch(database),
      participants: makeParticipants(database),
      generatedTitle: makeGeneratedTitle(database),
    })
  }),
)
