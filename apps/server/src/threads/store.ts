import { asc, desc, eq } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import {
  DatabaseFailure,
  type Thread,
  Thread as ThreadSchema,
  type ThreadId,
} from '@vivid/contracts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'
import { threads } from './tables.ts'

const ThreadRow = createSelectSchema(threads)

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

const threadRowDecoder = Schema.decodeUnknownEffect(ThreadRow)
const threadSchemaDecoder = Schema.decodeUnknownEffect(ThreadSchema)

const decodeThread = Effect.fn('ThreadStore.decode')(function* (
  value: typeof threads.$inferSelect,
) {
  const row = yield* threadRowDecoder(value).pipe(
    Effect.mapError(() => new DatabaseFailure({ message: 'Database returned an invalid Thread' })),
  )
  return yield* threadSchemaDecoder({
    ...row,
    preview: plainPreview(row.preview),
  }).pipe(
    Effect.mapError(() => new DatabaseFailure({ message: 'Database returned an invalid Thread' })),
  )
})

export interface ThreadStoreService {
  readonly list: () => Effect.Effect<ReadonlyArray<Thread>, DatabaseInfrastructureError>
  readonly get: (id: ThreadId) => Effect.Effect<Thread | undefined, DatabaseInfrastructureError>
  readonly put: (thread: Thread) => Effect.Effect<Thread, DatabaseInfrastructureError>
  readonly remove: (id: ThreadId) => Effect.Effect<boolean, DatabaseInfrastructureError>
}

export class ThreadStore extends Context.Service<ThreadStore, ThreadStoreService>()(
  'vivid/ThreadStore',
) {}

export const threadStoreLayer = Layer.effect(
  ThreadStore,
  Effect.gen(function* () {
    const database = yield* Database

    const list = Effect.fn('ThreadStore.list')(function* () {
      const rows = yield* database.run(
        database.select().from(threads).orderBy(desc(threads.updatedAt), asc(threads.id)),
      )
      return yield* Effect.forEach(rows, decodeThread)
    })

    const get = Effect.fn('ThreadStore.get')(function* (id: ThreadId) {
      const rows = yield* database.run(
        database.select().from(threads).where(eq(threads.id, id)).limit(1),
      )
      const row = rows[0]
      return row === undefined ? undefined : yield* decodeThread(row)
    })

    const put = Effect.fn('ThreadStore.put')(function* (thread: Thread) {
      // Built field by field: a Thread is an interface over a schema, and spreading it would copy
      // whatever else the caller's object happened to carry into the row.
      const normalized = {
        id: thread.id,
        title: thread.title,
        preview: plainPreview(thread.preview),
        updatedAt: thread.updatedAt,
        archived: thread.archived,
      }
      yield* database.run(
        database
          .insert(threads)
          .values(normalized)
          .onConflictDoUpdate({
            target: threads.id,
            set: {
              title: normalized.title,
              preview: normalized.preview,
              updatedAt: normalized.updatedAt,
              archived: normalized.archived,
            },
          }),
      )
      return normalized
    })

    const remove = Effect.fn('ThreadStore.remove')(function* (id: ThreadId) {
      const rows = yield* database.run(
        database.delete(threads).where(eq(threads.id, id)).returning({ id: threads.id }),
      )
      return rows.length > 0
    })

    return ThreadStore.of({ list, get, put, remove })
  }),
)
