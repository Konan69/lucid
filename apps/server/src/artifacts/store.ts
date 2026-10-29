import * as NodeCrypto from 'node:crypto'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import {
  ApprovalInvalidation,
  ApprovalPrecondition,
  Artifact,
  ArtifactAuthor,
  ArtifactBody,
  ArtifactChanged,
  ArtifactDetail,
  ArtifactId,
  ArtifactKind,
  ArtifactNote,
  ArtifactTitle,
  ArtifactVersion,
  DatabaseFailure,
  Forbidden,
  NotFound,
  ReadDocumentOutcome,
  RunId,
  Role,
  WriteDocumentOutcome,
  type GetArtifactRequest,
  type Person,
  type PersonId,
  type ReadDocumentRequest,
  type ReviseArtifactRequest,
  ThreadId,
  type WriteDocumentRequest,
} from '@vivid/contracts'
import { Array, Clock, Context, Effect, Layer, Option, Schema } from 'effect'
import type { RuntimeUnavailable } from '@vivid/contracts/rpc'
import { isAdmin, summaryOf } from '../auth/access.ts'
import { membershipTable } from '../companies/tables.ts'
import {
  Database,
  decodeStored,
  returned,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { Changes, Topic } from '../live/changes.ts'
import { documentRun, Runtime } from '../runtime/client.ts'
import { requireThread } from '../threads/access.ts'
import { runs, threads } from '../threads/tables.ts'
import { artifacts, artifactVersions } from './tables.ts'
import { fillDocuments, namedDocuments } from './placeholder.ts'
import { contentDigest } from '../approvals/action.ts'
import { invalidatePending, sendingDocument } from '../approvals/stale.ts'

const Row = createSelectSchema(artifacts, {
  id: ArtifactId,
  threadId: ThreadId,
  kind: ArtifactKind,
  title: ArtifactTitle,
  version: Artifact.fields.version,
})
const VersionRow = createSelectSchema(artifactVersions, {
  artifactId: ArtifactId,
  number: ArtifactVersion.fields.number,
  body: ArtifactBody,
  note: Schema.NullOr(ArtifactNote),
  madeBy: ArtifactAuthor,
})
const decodeArtifact = decodeStored(Row, 'Artifact')
const decodeArtifactTitle = decodeStored(Schema.Struct({ title: ArtifactTitle }), 'Artifact title')
const decodeVersion = decodeStored(VersionRow, 'Artifact version')
const encodeAuthor = Schema.encodeEffect(ArtifactAuthor)
const decodeRole = decodeStored(Role, 'Membership role')
const decodeRun = decodeStored(Schema.Struct({ id: RunId }), 'document Run')
type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]
type AccessFailure = NotFound | Forbidden | DatabaseInfrastructureError

/** The document authority serves Person edits and runtime writes through the same immutable history. */
export interface ArtifactStoreService {
  readonly list: (
    personId: PersonId,
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<Artifact>, AccessFailure>
  readonly get: (
    personId: PersonId,
    request: typeof GetArtifactRequest.Type,
  ) => Effect.Effect<ArtifactDetail, AccessFailure>
  readonly revise: (
    person: Person,
    request: typeof ReviseArtifactRequest.Type,
  ) => Effect.Effect<Artifact, AccessFailure | ArtifactChanged>
  readonly remove: (personId: PersonId, id: ArtifactId) => Effect.Effect<void, AccessFailure>
  readonly write: (
    personId: PersonId,
    threadId: ThreadId,
    request: WriteDocumentRequest,
  ) => Effect.Effect<typeof WriteDocumentOutcome.Type, AccessFailure | RuntimeUnavailable>
  readonly read: (
    personId: PersonId,
    threadId: ThreadId,
    request: typeof ReadDocumentRequest.Type,
  ) => Effect.Effect<ReadDocumentOutcome, AccessFailure>
}
/** Persistence, authorization and version ordering have one owner across every transport. */
export class ArtifactStore extends Context.Service<ArtifactStore, ArtifactStoreService>()(
  'vivid/ArtifactStore',
) {}

/** Nullable SQL notes become genuinely absent wire keys; first versions never have a change note. */
function versionOf(row: typeof VersionRow.Type): ArtifactVersion {
  const fields = { number: row.number, madeBy: row.madeBy, at: row.at }
  return row.note === null
    ? ArtifactVersion.make(fields)
    : ArtifactVersion.make({ ...fields, note: row.note })
}

/** Missing references remain not-found, without letting an inaccessible Artifact disclose its Thread. */
const find = Effect.fn('Artifacts.find')(function* (id: ArtifactId) {
  const database = yield* Database
  const [row] = yield* database.run(database.select().from(artifacts).where(eq(artifacts.id, id)))
  if (row === undefined) return yield* new NotFound({ message: 'Artifact not found' })
  return yield* decodeArtifact(row)
})

/** A Thread row lock serializes new case-insensitive titles, revision CAS and removal together. */
const lock = Effect.fn('Artifacts.lock')(function* (
  tx: Transaction,
  threadId: ThreadId,
  personId: PersonId,
) {
  const [row] = yield* tx
    .select({ id: threads.id })
    .from(threads)
    .where(eq(threads.id, threadId))
    .for('update')
  if (row === undefined) return yield* new NotFound({ message: 'Thread not found' })
  return yield* requireThread(threadId, personId)
})

/**
 * Append bodies only after acquiring the Thread lock; the summary pointer advances in the same
 * transaction. A new version, by the Person or by Vivid, also closes every pending Approval that
 * carries an older version's text, in that transaction: what it would send is no longer the
 * document.
 */
const append = Effect.fn('Artifacts.append')(function* (
  tx: Transaction,
  artifact: Artifact,
  input: {
    readonly body: string
    readonly note: Option.Option<string>
    readonly author: ArtifactAuthor
  },
) {
  const now = yield* Clock.currentTimeMillis
  const number = artifact.version + 1
  const madeBy = yield* encodeAuthor(input.author).pipe(
    Effect.mapError(() => new DatabaseFailure({ message: 'Artifact author could not be encoded' })),
  )
  yield* tx.insert(artifactVersions).values({
    artifactId: artifact.id,
    number,
    body: input.body,
    note: Option.getOrNull(input.note),
    madeBy,
    at: now,
  })
  const rows = yield* tx
    .update(artifacts)
    .set({ version: number, updatedAt: now })
    .where(eq(artifacts.id, artifact.id))
    .returning()
  yield* invalidatePending(
    tx,
    sendingDocument(artifact.id),
    ApprovalInvalidation.cases.ContentChanged.make({ artifactId: artifact.id, version: number }),
  )
  return yield* decodeArtifact(yield* returned(rows, 'Artifact'))
})

/** Creation stores version one and its pointer together; the supplied note cannot describe a nonexistent prior version. */
const create = Effect.fn('Artifacts.create')(function* (
  tx: Transaction,
  threadId: ThreadId,
  input: { readonly title: string; readonly body: string; readonly author: ArtifactAuthor },
) {
  const now = yield* Clock.currentTimeMillis
  const id = ArtifactId.make(NodeCrypto.randomUUID())
  const madeBy = yield* encodeAuthor(input.author).pipe(
    Effect.mapError(() => new DatabaseFailure({ message: 'Artifact author could not be encoded' })),
  )
  const rows = yield* tx
    .insert(artifacts)
    .values({
      id,
      threadId,
      kind: 'document',
      title: input.title,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  yield* tx
    .insert(artifactVersions)
    .values({ artifactId: id, number: 1, body: input.body, note: null, madeBy, at: now })
  return yield* decodeArtifact(yield* returned(rows, 'Artifact'))
})

/** The SQL lower comparison is also the unique-index expression, including non-ASCII PostgreSQL casing. */
const named = (threadId: ThreadId, title: string) =>
  and(eq(artifacts.threadId, threadId), sql`lower(${artifacts.title}) = lower(${title})`)

/** Lock the exact response's admitted Run; unrelated working rows cannot change authorship. */
const workingRun = Effect.fn('Artifacts.workingRun')(function* (
  tx: Transaction,
  author: { readonly threadId: ThreadId; readonly personId: PersonId; readonly runId: RunId },
) {
  const [run] = yield* tx
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.id, author.runId),
        eq(runs.threadId, author.threadId),
        eq(runs.personId, author.personId),
        eq(runs.state, 'working'),
        isNotNull(runs.admittedAt),
      ),
    )
    .for('update')
  if (run === undefined) return yield* new NotFound({ message: 'Working Run not found' })
  return (yield* decodeRun(run)).id
})

/** Only the authenticated Thread's working Run can author a version; missing or ambiguous attribution writes nothing. */
const write = Effect.fn('Artifacts.write')(function* (
  personId: PersonId,
  threadId: ThreadId,
  request: WriteDocumentRequest,
) {
  const database = yield* Database
  const changes = yield* Changes
  // Check access before reading runtime history; repeat it under the lock before any write.
  yield* requireThread(threadId, personId)
  // Network lookup precedes the transaction and must still cancel if the tool leaves its response.
  const runId = yield* documentRun(threadId, request.toolCallId).pipe(Effect.interruptible)
  const result = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      yield* lock(tx, threadId, personId)
      const author = ArtifactAuthor.cases.Vivid.make({
        runId: yield* workingRun(tx, { threadId, personId, runId }),
      })
      const [row] = yield* tx.select().from(artifacts).where(named(threadId, request.title))
      if (row === undefined) {
        const artifact = yield* create(tx, threadId, {
          title: request.title,
          body: request.body,
          author,
        })
        return { artifact, created: true, changed: true }
      }
      const artifact = yield* decodeArtifact(row)
      const [latest] = yield* tx
        .select()
        .from(artifactVersions)
        .where(
          and(
            eq(artifactVersions.artifactId, artifact.id),
            eq(artifactVersions.number, artifact.version),
          ),
        )
      if (latest === undefined)
        return yield* new DatabaseFailure({ message: 'Newest Artifact version is missing' })
      const version = yield* decodeVersion(latest)
      if (version.body === request.body) return { artifact, created: false, changed: false }
      const revised = yield* append(tx, artifact, {
        body: request.body,
        note: Option.fromUndefinedOr(request.note),
        author,
      })
      return { artifact: revised, created: false, changed: true }
    }),
  )
  if (result.changed) yield* changes.publish([Topic.thread(threadId)])
  return WriteDocumentOutcome.make({
    title: result.artifact.title,
    version: result.artifact.version,
    created: result.created,
    changed: result.changed,
  })
}, Effect.uninterruptible)

/** Person revisions must start from the newest version; the lock makes concurrent editors a single winner. */
const revise = Effect.fn('Artifacts.revise')(function* (
  person: Person,
  request: typeof ReviseArtifactRequest.Type,
) {
  const initial = yield* find(request.id)
  const database = yield* Database
  const artifact = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      yield* lock(tx, initial.threadId, person.id)
      const current = yield* find(request.id)
      if (current.version !== request.from)
        return yield* new ArtifactChanged({ id: current.id, version: current.version })
      return yield* append(tx, current, {
        body: request.body,
        note: Option.fromUndefinedOr(request.note),
        author: ArtifactAuthor.cases.Person.make({ person: summaryOf(person) }),
      })
    }),
  )
  yield* (yield* Changes).publish([Topic.thread(artifact.threadId)])
  return artifact
}, Effect.uninterruptible)

/** An Integration call named a document this Thread does not have. `titles` is what it does have. */
export class DocumentNotFound extends Schema.TaggedError<DocumentNotFound>()('DocumentNotFound', {
  title: Schema.String,
  titles: Schema.Array(ArtifactTitle),
}) {}

/**
 * Copies the newest text of every Thread document an Integration call names (`placeholder.ts`)
 * into the call, and says which version of each it copied.
 *
 * Titles resolve in the acting Thread alone, by the same case-blind comparison its unique index
 * uses, so a title names at most one document and there is nothing to guess between. A title the
 * Thread has no document for refuses the call with `DocumentNotFound`; nothing is sent with a
 * reference left in it. The reads share the Thread lock with every write here, so each body and
 * the version recorded beside it are from the same moment.
 */
export const bindDocuments = Effect.fn('Artifacts.bindDocuments')(function* (
  personId: PersonId,
  threadId: ThreadId,
  input: Schema.Json,
) {
  const titles = namedDocuments(input)
  if (titles.length === 0) return { input, preconditions: [] }
  const database = yield* Database
  const found = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      yield* lock(tx, threadId, personId)
      return yield* Effect.forEach(
        titles,
        Effect.fn('Artifacts.bindOne')(function* (title) {
          const [row] = yield* tx.select().from(artifacts).where(named(threadId, title))
          if (row === undefined) {
            const documents = yield* tx
              .select({ title: artifacts.title })
              .from(artifacts)
              .where(eq(artifacts.threadId, threadId))
            return yield* new DocumentNotFound({
              title,
              titles: (yield* Effect.forEach(documents, decodeArtifactTitle)).map(
                (document) => document.title,
              ),
            })
          }
          const artifact = yield* decodeArtifact(row)
          const [latest] = yield* tx
            .select()
            .from(artifactVersions)
            .where(
              and(
                eq(artifactVersions.artifactId, artifact.id),
                eq(artifactVersions.number, artifact.version),
              ),
            )
          if (latest === undefined)
            return yield* new DatabaseFailure({ message: 'Newest Artifact version is missing' })
          const version = yield* decodeVersion(latest)
          return { title, artifact, body: version.body }
        }),
      )
    }),
  )
  return {
    input: fillDocuments(input, new Map(found.map((entry) => [entry.title, entry.body]))),
    preconditions: Array.dedupeWith(
      found.map((entry) =>
        ApprovalPrecondition.cases.ArtifactVersion.make({
          artifactId: entry.artifact.id,
          version: entry.artifact.version,
          contentDigest: contentDigest(entry.body),
        }),
      ),
      (left, right) => left.artifactId === right.artifactId,
    ),
  }
})

/** Admin authority is read from the Thread's Company, never the caller's active workspace. Visibility is required first. */
const remove = Effect.fn('Artifacts.remove')(function* (personId: PersonId, id: ArtifactId) {
  const initial = yield* find(id)
  const database = yield* Database
  yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const thread = yield* lock(tx, initial.threadId, personId)
      if (thread.personId !== personId) {
        if (thread.companyId === null)
          return yield* new Forbidden({ message: 'Only the Thread owner can remove an Artifact' })
        const [membership] = yield* tx
          .select({ role: membershipTable.role })
          .from(membershipTable)
          .where(
            and(
              eq(membershipTable.userId, personId),
              eq(membershipTable.companyId, thread.companyId),
            ),
          )
        if (membership === undefined || !isAdmin(yield* decodeRole(membership.role)))
          return yield* new Forbidden({
            message: 'Only the Thread owner or a Company admin can remove an Artifact',
          })
      }
      const deleted = yield* tx
        .delete(artifacts)
        .where(eq(artifacts.id, id))
        .returning({ id: artifacts.id })
      if (deleted.length === 0) return yield* new NotFound({ message: 'Artifact not found' })
      // A pending send of its text would send a document that no longer exists.
      yield* invalidatePending(
        tx,
        sendingDocument(id),
        ApprovalInvalidation.cases.ContentChanged.make({ artifactId: id, version: null }),
      )
      return undefined
    }),
  )
  yield* (yield* Changes).publish([Topic.thread(initial.threadId)])
}, Effect.uninterruptible)

/** Read the pointer and immutable history under one Thread lock so concurrent writes cannot mix snapshots. */
const loadDetail = Effect.fn('Artifacts.detail')(function* (
  tx: Transaction,
  artifact: Artifact,
  number: number,
) {
  const rows = yield* tx
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifact.id))
    .orderBy(desc(artifactVersions.number))
  const versions = yield* Effect.forEach(rows, decodeVersion)
  const shown = versions.find((version) => version.number === number)
  if (shown === undefined) return yield* new NotFound({ message: 'Artifact version not found' })
  return ArtifactDetail.make({
    artifact,
    shown: versionOf(shown),
    body: shown.body,
    versions: versions.map(versionOf),
  })
})

/** Detail reads retain every author snapshot and serve either the newest body or an explicitly named historic version. */
const get = Effect.fn('Artifacts.get')(function* (
  personId: PersonId,
  request: typeof GetArtifactRequest.Type,
) {
  const initial = yield* find(request.id)
  const database = yield* Database
  return yield* database.transaction((tx) =>
    Effect.gen(function* () {
      yield* lock(tx, initial.threadId, personId)
      const artifact = yield* find(request.id)
      return yield* loadDetail(
        tx,
        artifact,
        request.version === undefined ? artifact.version : request.version,
      )
    }),
  )
})

/** Authority is acquired once; pure request data stays explicit, and the PostgreSQL adapter retains its transaction context. */
export const artifactStoreLayer = Layer.effect(
  ArtifactStore,
  Effect.gen(function* () {
    const database = yield* Database
    const context = yield* Effect.context<Database | Changes | Runtime>()
    const provide = <A, E>(program: Effect.Effect<A, E, Database | Changes | Runtime>) =>
      Effect.provide(program, context)
    const list = Effect.fn('ArtifactStore.list')(function* (
      personId: PersonId,
      threadId: ThreadId,
    ) {
      yield* requireThread(threadId, personId)
      const rows = yield* database.run(
        database
          .select()
          .from(artifacts)
          .where(eq(artifacts.threadId, threadId))
          .orderBy(desc(artifacts.updatedAt), desc(artifacts.id)),
      )
      return yield* Effect.forEach(rows, decodeArtifact)
    })
    return ArtifactStore.of({
      list: (personId, threadId) => provide(list(personId, threadId)),
      get: (personId, request) => provide(get(personId, request)),
      revise: (person, request) => provide(revise(person, request)),
      remove: (personId, id) => provide(remove(personId, id)),
      write: (personId, threadId, request) => provide(write(personId, threadId, request)),
      /** A missing title names only this visible Thread's documents, never a cross-Thread search. */
      read: Effect.fn('ArtifactStore.read')(function* (personId, threadId, request) {
        const documents = yield* provide(list(personId, threadId))
        const [row] = yield* database.run(
          database.select().from(artifacts).where(named(threadId, request.title)),
        )
        if (row === undefined)
          return ReadDocumentOutcome.cases.Missing.make({
            titles: documents.map((document) => document.title),
          })
        const detail = yield* provide(get(personId, { id: row.id }))
        return ReadDocumentOutcome.cases.Found.make({
          title: detail.artifact.title,
          version: detail.shown.number,
          body: detail.body,
        })
      }),
    })
  }),
)
