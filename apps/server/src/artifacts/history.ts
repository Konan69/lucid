import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import {
  Artifact,
  ArtifactId,
  ArtifactKind,
  ArtifactTitle,
  NotFound,
  RunId,
  ThreadId,
  type PersonId,
} from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import { Database, decodeStored } from '../database/client.ts'
import { requireThread } from '../threads/access.ts'
import { runs, threads } from '../threads/tables.ts'
import { artifacts } from './tables.ts'

export type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]
const Row = createSelectSchema(artifacts, {
  id: ArtifactId,
  threadId: ThreadId,
  kind: ArtifactKind,
  title: ArtifactTitle,
  version: Artifact.fields.version,
})
export const decodeArtifact = decodeStored(Row, 'Artifact')
const decodeRun = decodeStored(Schema.Struct({ id: RunId }), 'Artifact Run')

/** Missing references remain not-found, without letting an inaccessible Artifact disclose its Thread. */
export const find = Effect.fn('Artifacts.find')(function* (id: ArtifactId) {
  const database = yield* Database
  const [row] = yield* database.run(database.select().from(artifacts).where(eq(artifacts.id, id)))
  if (row === undefined) return yield* new NotFound({ message: 'Artifact not found' })
  return yield* decodeArtifact(row)
})

/** A Thread row lock serializes new case-insensitive titles, revision CAS and removal together. */
export const lock = Effect.fn('Artifacts.lock')(function* (
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

/** The SQL lower comparison is also the unique-index expression, including non-ASCII PostgreSQL casing. */
export const named = (threadId: ThreadId, title: string) =>
  and(eq(artifacts.threadId, threadId), sql`lower(${artifacts.title}) = lower(${title})`)

/** Lock the exact response's admitted Run; unrelated working rows cannot change authorship. */
export const workingRun = Effect.fn('Artifacts.workingRun')(function* (
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
