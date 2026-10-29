import * as NodeCrypto from 'node:crypto'
import {
  ArtifactContent,
  ArtifactFile,
  ArtifactInspectionId,
  ArtifactInspectionStale,
  ArtifactNotEditable,
  ArtifactPreview,
  ArtifactRenderReview,
  ArtifactSource,
  ArtifactAuthor,
  DatabaseFailure,
  InspectArtifactFileOutcome,
  InvalidRequest,
  NotFound,
  WriteDocumentOutcome,
  ArtifactId,
  type ArtifactFileRequest,
  type DocumentToolCallId,
  type InspectArtifactFileRequest,
  type PersonId,
  type PublishArtifactFileRequest,
  type RunId,
  type ThreadId,
} from '@vivid/contracts'
import { and, eq } from 'drizzle-orm'
import { Clock, Effect, Schema } from 'effect'
import { Database, decodeStored } from '../database/client.ts'
import { Changes, Topic } from '../live/changes.ts'
import { documentRun } from '../runtime/client.ts'
import { requireThread } from '../threads/access.ts'
import { decodeArtifact, lock, named, workingRun, type Transaction } from './history.ts'
import { captureArtifact, FileCapture, type CapturedArtifact } from './render.ts'
import { artifactFiles, artifactPreparations, artifacts, artifactVersions } from './tables.ts'

const decodeCapture = decodeStored(FileCapture, 'Artifact capture')
const decodeFile = decodeStored(ArtifactFile, 'Artifact file')
const decodePublication = decodeStored(WriteDocumentOutcome, 'Artifact publication')
const encodeCapture = Schema.encodeEffect(FileCapture)
const encodeContent = Schema.encodeEffect(ArtifactContent.cases.File)
const encodeAuthor = Schema.encodeEffect(ArtifactAuthor)
const encodeFile = Schema.encodeEffect(ArtifactFile)
const encodePublication = Schema.encodeEffect(WriteDocumentOutcome)
type Preparation = typeof artifactPreparations.$inferSelect
type FileContent = typeof ArtifactContent.cases.File.Type
interface InspectionAuthority {
  readonly personId: PersonId
  readonly threadId: ThreadId
  readonly runId: RunId
  readonly toolCallId: DocumentToolCallId
}

/** Persisted JSON failures name the record kind rather than exposing bytes or model arguments. */
const encodingFailure = () => new DatabaseFailure({ message: 'Artifact data could not be encoded' })

/** Required role metadata must have a corresponding immutable row before a file can be opened. */
export const loadFileContent = Effect.fn('Artifacts.fileContent')(function* (
  tx: Transaction,
  id: ArtifactId,
  number: number,
  content: FileContent | null,
) {
  if (content === null)
    return yield* new DatabaseFailure({ message: 'Artifact file content is missing' })
  const rows = yield* tx
    .select({ role: artifactFiles.role, metadata: artifactFiles.metadata })
    .from(artifactFiles)
    .where(and(eq(artifactFiles.artifactId, id), eq(artifactFiles.number, number)))
  const required = [{ role: 'output', file: content.output }]
  ArtifactSource.match(content.source, {
    Output: () => undefined,
    Separate: ({ file }) => {
      required.push({ role: 'source', file })
    },
  })
  ArtifactPreview.match(content.preview, {
    Output: () => undefined,
    Separate: ({ file }) => {
      required.push({ role: 'preview', file })
    },
  })
  for (const expected of required) {
    const row = rows.find((file) => file.role === expected.role)
    if (row === undefined)
      return yield* new DatabaseFailure({ message: 'Artifact version is missing a required file' })
    const stored = yield* decodeFile(row.metadata)
    if (stored.sha256 !== expected.file.sha256 || stored.byteLength !== expected.file.byteLength)
      return yield* new DatabaseFailure({ message: 'Artifact version file metadata disagrees' })
  }
  return content
})

/** Retry inspection returns the same captured picture, even when the Computer's path has changed. */
const inspected = Effect.fn('Artifacts.inspected')(function* (row: Preparation) {
  const capture = yield* decodeCapture(row.capture)
  const picture = ArtifactPreview.match(capture.preview, {
    Output: () => row.output,
    Separate: () => row.preview,
  })
  if (picture === null)
    return yield* new DatabaseFailure({ message: 'Artifact inspection preview is missing' })
  return InspectArtifactFileOutcome.make({ inspection: row.id, ...capture, picture })
})

/** Captured bytes enter one transaction only after rendering. This seam also accepts real SSH fixture bytes. */
export const keepInspection = Effect.fn('Artifacts.keepInspection')(function* (
  authority: InspectionAuthority,
  captured: CapturedArtifact,
) {
  const database = yield* Database
  const capture = yield* encodeCapture(captured.capture).pipe(Effect.mapError(encodingFailure))
  return yield* database.transaction((tx) =>
    Effect.gen(function* () {
      yield* lock(tx, authority.threadId, authority.personId)
      yield* workingRun(tx, authority)
      const [existing] = yield* tx
        .select()
        .from(artifactPreparations)
        .where(
          and(
            eq(artifactPreparations.threadId, authority.threadId),
            eq(artifactPreparations.runId, authority.runId),
            eq(artifactPreparations.inspectCall, authority.toolCallId),
          ),
        )
      if (existing !== undefined) return yield* inspected(existing)
      const [row] = yield* tx
        .insert(artifactPreparations)
        .values({
          id: ArtifactInspectionId.make(NodeCrypto.randomUUID()),
          threadId: authority.threadId,
          personId: authority.personId,
          runId: authority.runId,
          inspectCall: authority.toolCallId,
          capture,
          output: captured.output,
          source: captured.source,
          preview: captured.preview,
        })
        .returning()
      if (row === undefined)
        return yield* new DatabaseFailure({ message: 'Artifact inspection was not stored' })
      return yield* inspected(row)
    }),
  )
})

/** Attribution and access are checked before Computer I/O and again when saving its result. */
export const inspectArtifactFile = Effect.fn('Artifacts.inspect')(function* (
  personId: PersonId,
  threadId: ThreadId,
  request: InspectArtifactFileRequest,
) {
  yield* requireThread(threadId, personId)
  const runId = yield* documentRun(threadId, request.toolCallId, 'inspect_file')
  const authority = { personId, threadId, runId, toolCallId: request.toolCallId }
  const database = yield* Database
  const existing = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      yield* lock(tx, threadId, personId)
      yield* workingRun(tx, authority)
      return yield* tx
        .select()
        .from(artifactPreparations)
        .where(
          and(
            eq(artifactPreparations.threadId, threadId),
            eq(artifactPreparations.runId, runId),
            eq(artifactPreparations.inspectCall, request.toolCallId),
          ),
        )
    }),
  )
  const [row] = existing
  if (row !== undefined) return yield* inspected(row)
  const captured = yield* captureArtifact(personId, request)
  return yield* keepInspection(authority, captured)
})

/** Each separate source or preview is required by the capture variant; missing bytes refuse publication. */
const versionFiles = Effect.fn('Artifacts.versionFiles')(function* (
  tx: Transaction,
  reference: { readonly id: ArtifactId; readonly version: number },
  row: Preparation,
) {
  const capture = yield* decodeCapture(row.capture)
  const stored: {
    role: 'output' | 'source' | 'preview'
    metadata: ArtifactFile
    bytes: Uint8Array
  }[] = [{ role: 'output', metadata: capture.output, bytes: row.output }]
  const source = ArtifactSource.match(capture.source, {
    Output: () => null,
    Separate: ({ file }) => file,
  })
  const preview = ArtifactPreview.match(capture.preview, {
    Output: () => null,
    Separate: ({ file }) => file,
  })
  const separate: {
    role: 'source' | 'preview'
    metadata: ArtifactFile | null
    bytes: Uint8Array | null
  }[] = [
    { role: 'source', metadata: source, bytes: row.source },
    { role: 'preview', metadata: preview, bytes: row.preview },
  ]
  for (const file of separate) {
    if (file.metadata === null) continue
    if (file.bytes === null)
      return yield* new DatabaseFailure({ message: 'Artifact capture is missing required bytes' })
    stored.push({ role: file.role, metadata: file.metadata, bytes: file.bytes })
  }
  for (const file of stored) {
    yield* tx.insert(artifactFiles).values({
      artifactId: reference.id,
      number: reference.version,
      role: file.role,
      metadata: yield* encodeFile(file.metadata).pipe(Effect.mapError(encodingFailure)),
      bytes: file.bytes,
    })
  }
})

/** A file title may advance only another file. Reserve the next summary pointer under the caller's Thread lock. */
const advance = Effect.fn('Artifacts.advanceFile')(function* (
  tx: Transaction,
  threadId: ThreadId,
  title: string,
) {
  const [existing] = yield* tx.select().from(artifacts).where(named(threadId, title))
  const now = yield* Clock.currentTimeMillis
  if (existing === undefined) {
    const artifact = {
      id: ArtifactId.make(NodeCrypto.randomUUID()),
      threadId,
      kind: 'file' as const,
      title,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    yield* tx.insert(artifacts).values(artifact)
    return { artifact, created: true }
  }
  const current = yield* decodeArtifact(existing)
  if (current.kind !== 'file')
    return yield* new InvalidRequest({
      message: 'That title belongs to a Markdown document. Use a different file title.',
    })
  const artifact = { ...current, version: current.version + 1, updatedAt: now }
  yield* tx
    .update(artifacts)
    .set({ version: artifact.version, updatedAt: now })
    .where(eq(artifacts.id, artifact.id))
  return { artifact, created: false }
})

/** A Thread lock serializes publication and title creation. Replays return the persisted receipt before checking working state. */
const publish = Effect.fn('Artifacts.publish')(function* (
  tx: Transaction,
  authority: InspectionAuthority,
  request: PublishArtifactFileRequest,
) {
  yield* lock(tx, authority.threadId, authority.personId)
  const [replayed] = yield* tx
    .select()
    .from(artifactPreparations)
    .where(
      and(
        eq(artifactPreparations.threadId, authority.threadId),
        eq(artifactPreparations.runId, authority.runId),
        eq(artifactPreparations.personId, authority.personId),
        eq(artifactPreparations.publishCall, request.toolCallId),
      ),
    )
  if (replayed !== undefined && replayed.publication !== null)
    return yield* decodePublication(replayed.publication)
  yield* workingRun(tx, authority)
  const [prepared] = yield* tx
    .select()
    .from(artifactPreparations)
    .where(
      and(
        eq(artifactPreparations.id, request.inspection),
        eq(artifactPreparations.threadId, authority.threadId),
        eq(artifactPreparations.personId, authority.personId),
        eq(artifactPreparations.runId, authority.runId),
      ),
    )
  if (prepared === undefined || prepared.publication !== null)
    return yield* new ArtifactInspectionStale({ inspection: request.inspection })
  const capture = yield* decodeCapture(prepared.capture)
  const content = ArtifactContent.cases.File.make({
    ...capture,
    review: ArtifactRenderReview.make({
      outputDigest: capture.output.sha256,
      runId: authority.runId,
      toolCallId: prepared.inspectCall,
      summary: request.review,
    }),
  })
  const { artifact: current, created } = yield* advance(tx, authority.threadId, request.title)
  const id = current.id
  const number = current.version
  yield* tx.insert(artifactVersions).values({
    artifactId: id,
    number,
    body: null,
    file: yield* encodeContent(content).pipe(Effect.mapError(encodingFailure)),
    note: created || request.note === undefined ? null : request.note,
    madeBy: yield* encodeAuthor(ArtifactAuthor.cases.Vivid.make({ runId: authority.runId })).pipe(
      Effect.mapError(encodingFailure),
    ),
    at: current.updatedAt,
  })
  const artifact = { id, version: number }
  yield* versionFiles(tx, artifact, prepared)
  const outcome = WriteDocumentOutcome.make({
    artifact,
    title: current.title,
    version: number,
    created,
    changed: true,
  })
  yield* tx
    .update(artifactPreparations)
    .set({
      publishCall: request.toolCallId,
      publication: yield* encodePublication(outcome).pipe(Effect.mapError(encodingFailure)),
    })
    .where(eq(artifactPreparations.id, prepared.id))
  return outcome
})

/** Publication reads no Computer path and performs no network calls while its SQL transaction is open. */
export const publishArtifactFile = Effect.fn('Artifacts.publishFile')(function* (
  personId: PersonId,
  threadId: ThreadId,
  request: PublishArtifactFileRequest,
) {
  yield* requireThread(threadId, personId)
  const runId = yield* documentRun(threadId, request.toolCallId, 'publish_file').pipe(
    Effect.interruptible,
  )
  const database = yield* Database
  const outcome = yield* database.transaction((tx) =>
    publish(tx, { personId, threadId, runId, toolCallId: request.toolCallId }, request),
  )
  yield* (yield* Changes).publish([Topic.thread(threadId)])
  return outcome
}, Effect.uninterruptible)

/** Cookie/bearer downloads use exactly GetArtifact's Thread authority. Aliased roles return original output bytes. */
export const downloadArtifactFile = Effect.fn('Artifacts.download')(function* (
  personId: PersonId,
  request: ArtifactFileRequest,
) {
  const database = yield* Database
  const [artifact] = yield* database.run(
    database.select().from(artifacts).where(eq(artifacts.id, request.id)),
  )
  if (artifact === undefined) return yield* new NotFound({ message: 'Artifact not found' })
  yield* requireThread(artifact.threadId, personId)
  const [version] = yield* database.run(
    database
      .select()
      .from(artifactVersions)
      .where(
        and(
          eq(artifactVersions.artifactId, request.id),
          eq(artifactVersions.number, request.version),
        ),
      ),
  )
  if (version === undefined) return yield* new NotFound({ message: 'Artifact version not found' })
  if (version.file === null) return yield* new ArtifactNotEditable({ id: request.id })
  const content = yield* decodeStored(
    ArtifactContent.cases.File,
    'Artifact file version',
  )(version.file)
  let role = request.role
  if (role === 'source' && ArtifactSource.guards.Output(content.source)) role = 'output'
  if (role === 'preview' && ArtifactPreview.guards.Output(content.preview)) role = 'output'
  const [row] = yield* database.run(
    database
      .select()
      .from(artifactFiles)
      .where(
        and(
          eq(artifactFiles.artifactId, request.id),
          eq(artifactFiles.number, request.version),
          eq(artifactFiles.role, role),
        ),
      ),
  )
  if (row === undefined)
    return yield* new DatabaseFailure({ message: 'Artifact version file is missing' })
  return { file: yield* decodeFile(row.metadata), bytes: row.bytes }
})
