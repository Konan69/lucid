import { and, eq, isNull, sql } from 'drizzle-orm'
import { Effect, Option, Schema } from 'effect'
import { ArtifactFile } from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { Database, decodeStored } from '../database/client.ts'
import { artifacts, artifactFiles } from '../artifacts/tables.ts'
import { libraryDocuments } from '../library/tables.ts'
import { threads } from '../threads/tables.ts'

const FileReference = Schema.Struct({
  $file: Schema.Struct({
    source: Schema.Literals(['artifact', 'library']),
    name: Schema.String.check(Schema.isNonEmpty()),
  }),
})
const decodeReference = Schema.decodeUnknownEffect(FileReference)
const isObject = Schema.is(Schema.JsonObject)
const isArray = Schema.is(Schema.Array(Schema.Json))
const MAX_BYTES = 5 * 1024 * 1024

export class IntegrationFileUnavailable extends Schema.TaggedError<IntegrationFileUnavailable>()(
  'IntegrationFileUnavailable',
  { name: Schema.String },
  { title: 'Integration file unavailable' },
) {}
export class IntegrationFileTooLarge extends Schema.TaggedError<IntegrationFileTooLarge>()(
  'IntegrationFileTooLarge',
  { limit: Schema.Int },
  { title: 'Integration file too large' },
) {}
export class IntegrationFileReferenceInvalid extends Schema.TaggedError<IntegrationFileReferenceInvalid>()(
  'IntegrationFileReferenceInvalid',
  {},
  { title: 'Integration file reference invalid' },
) {}

/** Resolve names only on the Person's own shelf or in their own acting Thread. Duplicate
 * Library names refuse rather than guessing which private bytes should leave Vivid. */
const loadFile = Effect.fn('Connections.loadFile')(function* (
  actor: Actor,
  reference: typeof FileReference.Type,
) {
  const database = yield* Database
  const { source, name } = reference.$file
  if (source === 'library') {
    const rows = yield* database.run(
      database
        .select()
        .from(libraryDocuments)
        .where(
          and(
            eq(libraryDocuments.personId, actor.person.id),
            isNull(libraryDocuments.companyId),
            eq(libraryDocuments.name, name),
          ),
        )
        .limit(2),
    )
    const [row] = rows
    if (rows.length !== 1 || row === undefined)
      return yield* new IntegrationFileUnavailable({ name })
    return { name: row.name, mimeType: row.mimeType, bytes: row.bytes }
  }
  if (Option.isNone(actor.threadId)) return yield* new IntegrationFileUnavailable({ name })
  const [row] = yield* database.run(
    database
      .select({
        metadata: artifactFiles.metadata,
        bytes: artifactFiles.bytes,
      })
      .from(artifacts)
      .innerJoin(threads, eq(threads.id, artifacts.threadId))
      .innerJoin(
        artifactFiles,
        and(
          eq(artifactFiles.artifactId, artifacts.id),
          eq(artifactFiles.number, artifacts.version),
          eq(artifactFiles.role, 'output'),
        ),
      )
      .where(
        and(
          eq(threads.personId, actor.person.id),
          eq(artifacts.threadId, actor.threadId.value),
          sql`lower(${artifacts.title}) = lower(${name})`,
        ),
      ),
  )
  if (row === undefined) return yield* new IntegrationFileUnavailable({ name })
  const file = yield* decodeStored(ArtifactFile, 'Integration Artifact file')(row.metadata)
  return { name: file.name, mimeType: file.mimeType, bytes: row.bytes }
})

/** An exact one-key reference becomes a JSON file envelope. The aggregate cap includes
 * repeated references, bounding the bytes sent through Executor and retained for approval. */
export const bindFiles = Effect.fn('Connections.bindFiles')(function* (
  actor: Actor,
  input: Schema.Json,
) {
  let total = 0
  const fill = (
    value: Schema.Json,
  ): Effect.Effect<
    Schema.Json,
    | IntegrationFileUnavailable
    | IntegrationFileTooLarge
    | IntegrationFileReferenceInvalid
    | import('../database/client.ts').DatabaseInfrastructureError,
    Database
  > =>
    Effect.gen(function* () {
      if (isObject(value) && Object.keys(value).length === 1 && '$file' in value) {
        const reference = yield* decodeReference(value).pipe(
          Effect.mapError(() => new IntegrationFileReferenceInvalid({})),
        )
        const file = yield* loadFile(actor, reference)
        total += file.bytes.byteLength
        if (total > MAX_BYTES) return yield* new IntegrationFileTooLarge({ limit: MAX_BYTES })
        return {
          name: file.name,
          mimeType: file.mimeType,
          base64: Buffer.from(file.bytes).toString('base64'),
        }
      }
      if (isArray(value)) return yield* Effect.forEach(value, fill)
      if (isObject(value)) {
        const entries: [string, Schema.Json][] = []
        for (const [key, item] of Object.entries(value)) entries.push([key, yield* fill(item)])
        return Object.fromEntries(entries)
      }
      return value
    })
  return yield* fill(input)
})
