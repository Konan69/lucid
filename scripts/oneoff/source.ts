import { PersonId, ThreadId, RunFailure } from '../../packages/contracts/src/index.ts'
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from 'effect'
import { Pool, type PoolClient } from 'pg'

/**
 * Where the old conversations are read: the product database production's Vivid ran Flue 2.2.2
 * on (`VIVID_FLUE_DATABASE_URL`). Flue kept every Thread's conversation there as an event log
 * (`flue_conversation_streams`, `flue_conversation_stream_batches`, `flue_attachments`, created by
 * `@flue/postgres` 2.2.2), beside the product's own Thread table (`vivid_conversations`, the
 * server's `threads` in `apps/server/src/threads/tables.ts`). Nothing here writes: every
 * connection is read-only, and every read is one read-only transaction.
 */

/** One Flue stream, and the product Thread it belongs to when that Thread still exists. */
export interface Listed {
  readonly path: string
  readonly threadId: ThreadId
  /** The Thread's creator as the product records it (`vivid_conversations.person_id`). */
  readonly product: Option.Option<PersonId>
}

/** A file Flue kept for a stream, with the conversation it belongs to. */
interface StoredFile {
  readonly attachmentId: string
  readonly conversationId: string
  readonly mimeType: string
  readonly bytes: Uint8Array
}

/** One stream's log: each batch's `data` text in `seq` order, and its kept files. */
export interface Logged {
  readonly batches: ReadonlyArray<string>
  readonly files: ReadonlyArray<StoredFile>
  readonly failures: ReadonlyMap<string, RunFailure>
}

/** The source database could not be read. The cause stays in the process; it is never printed. */
class SourceUnavailable extends Schema.TaggedError<SourceUnavailable>()(
  'SourceUnavailable',
  { cause: Schema.Defect() },
  { title: 'Flue database is unavailable' },
) {}

/**
 * A stream whose identity is not a Vivid Thread's: Flue addressed every Thread as agent `vivid`,
 * instance the Thread id, at path `agents/vivid/<id>`. Listing stops: such a stream is not one
 * this import knows how to place.
 */
class StreamIdentityInvalid extends Schema.TaggedError<StreamIdentityInvalid>()(
  'StreamIdentityInvalid',
  { path: Schema.String },
  { title: 'Flue stream is not a Vivid Thread' },
) {}

export interface FlueSourceService {
  /** Every stream, ordered by path, each with its product Thread's creator when it exists. */
  readonly streams: Effect.Effect<ReadonlyArray<Listed>, SourceUnavailable | StreamIdentityInvalid>
  /** One stream's whole log and files, read in one snapshot. */
  readonly read: (path: string) => Effect.Effect<Logged, SourceUnavailable>
}

export class FlueSource extends Context.Service<FlueSource, FlueSourceService>()(
  'vivid/Runtime/FlueSource',
) {}

const Identity = Schema.fromJsonString(
  Schema.Struct({ agentName: Schema.Literal('vivid'), instanceId: ThreadId }),
)
const decodeIdentity = Schema.decodeUnknownOption(Identity)
const decodeStreams = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ path: Schema.String, identity_json: Schema.String })),
)
const decodeThreads = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: ThreadId, person_id: PersonId })),
)
const decodeBatches = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ data: Schema.String })),
)
const decodeFiles = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      attachment_id: Schema.String,
      conversation_id: Schema.String,
      mime_type: Schema.String,
      bytes: Schema.Uint8Array,
    }),
  ),
)

const decodeFailures = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ request_id: Schema.NonEmptyString, failure_reason: RunFailure })),
)

const unavailable = (cause: unknown) => new SourceUnavailable({ cause })

/**
 * Run `use` on a pooled connection inside one read-only transaction at REPEATABLE READ, so the
 * reads of one call see one snapshot even while production keeps writing. The transaction is
 * ended either way; nothing in it can have written.
 */
const snapshot = <A>(pool: Pool, use: (client: PoolClient) => Promise<A>) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => pool.connect(), catch: unavailable }),
    (client) =>
      Effect.tryPromise({
        try: () =>
          client
            .query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            .then(() => use(client))
            .then((value) => client.query('COMMIT').then(() => value)),
        catch: unavailable,
      }),
    (client) =>
      Effect.promise(() =>
        client.query('ROLLBACK').then(
          () => client.release(),
          (cause: Error) => client.release(cause),
        ),
      ),
  )

/** A stream's Thread id, read from its identity and checked against its path. */
const threadOf = (path: string, identity: string) =>
  Option.filter(
    Option.map(decodeIdentity(identity), (decoded) => decoded.instanceId),
    (threadId) => path === `agents/vivid/${threadId}`,
  )

/**
 * List every stream with its product Thread. Thread ids are matched against
 * `vivid_conversations.id`, archived Threads included; a stream whose Thread was deleted lists
 * with no creator.
 */
const list = Effect.fn('FlueSource.streams')(function* (pool: Pool) {
  const rows = yield* snapshot(pool, (client) =>
    client
      .query('SELECT path, identity_json FROM flue_conversation_streams ORDER BY path')
      .then((result) => result.rows),
  )
  const streams = yield* decodeStreams(rows).pipe(Effect.mapError(unavailable))
  const named: Array<{ readonly path: string; readonly threadId: ThreadId }> = []
  for (const stream of streams) {
    const threadId = threadOf(stream.path, stream.identity_json)
    if (Option.isNone(threadId)) return yield* new StreamIdentityInvalid({ path: stream.path })
    named.push({ path: stream.path, threadId: threadId.value })
  }
  const found = yield* snapshot(pool, (client) =>
    client
      .query('SELECT id, person_id FROM vivid_conversations WHERE id = ANY($1::text[])', [
        named.map((stream) => stream.threadId),
      ])
      .then((result) => result.rows),
  )
  const threads = yield* decodeThreads(found).pipe(Effect.mapError(unavailable))
  const creators = new Map<string, PersonId>(threads.map((row) => [row.id, row.person_id]))
  return named.map((stream): Listed => ({
    path: stream.path,
    threadId: stream.threadId,
    product: Option.fromUndefinedOr(creators.get(stream.threadId)),
  }))
})

/** Read one stream's batches in `seq` order and the files kept under its path. */
const readStream = Effect.fn('FlueSource.read')(function* (pool: Pool, path: string) {
  // One client runs its queries in order, so both are read in the one snapshot.
  const read = yield* snapshot(pool, (client) =>
    Promise.all([
      client.query(
        'SELECT data FROM flue_conversation_stream_batches WHERE path = $1 ORDER BY seq',
        [path],
      ),
      client.query(
        `SELECT attachment_id, conversation_id, mime_type, bytes FROM flue_attachments
         WHERE stream_path = $1 ORDER BY attachment_id`,
        [path],
      ),
      client.query(
        "SELECT receipt->>'runId' AS request_id, failure_reason FROM vivid_runs WHERE thread_id=$1 AND failure_reason IS NOT NULL AND receipt IS NOT NULL",
        [path.slice('agents/vivid/'.length)],
      ),
    ]).then(([batches, files, failures]) => ({
      batches: batches.rows,
      files: files.rows,
      failures: failures.rows,
    })),
  )
  const batches = yield* decodeBatches(read.batches).pipe(Effect.mapError(unavailable))
  const files = yield* decodeFiles(read.files).pipe(Effect.mapError(unavailable))
  const failures = yield* decodeFailures(read.failures).pipe(Effect.mapError(unavailable))
  return {
    batches: batches.map((batch) => batch.data),
    failures: new Map(failures.map((run) => [run.request_id, run.failure_reason])),
    files: files.map((file) => ({
      attachmentId: file.attachment_id,
      conversationId: file.conversation_id,
      mimeType: file.mime_type,
      bytes: file.bytes,
    })),
  } satisfies Logged
})

/** An idle pooled connection that dies is dropped; the next read gets a fresh one. */
const idleFailure = (_cause: Error) => {}

/**
 * The source, for the life of the scope. Every connection is opened with
 * `default_transaction_read_only` on, so even a statement outside `snapshot` cannot write. One
 * connection is enough: the import reads one Thread at a time.
 */
export const flueSourceLayer = Layer.effect(
  FlueSource,
  Effect.gen(function* () {
    const url = yield* Config.Redacted('VIVID_FLUE_DATABASE_URL')
    const pool = yield* Effect.acquireRelease(
      Effect.sync(() =>
        new Pool({
          connectionString: Redacted.value(url),
          max: 1,
          options: '-c default_transaction_read_only=on',
        }).on('error', idleFailure),
      ),
      (made) => Effect.promise(() => made.end()),
    )
    return FlueSource.of({ streams: list(pool), read: (path) => readStream(pool, path) })
  }),
)
