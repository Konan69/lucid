import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ConversationId, Cursor } from '@earendil-works/pi-durable'
import { RuntimePersonId, type PersonId } from '@vivid/contracts'
import { Effect, Option, Redacted, Schema } from 'effect'
import { Pool } from 'pg'
import { RuntimeSettings } from '../settings.ts'
import type { PostgresStore } from '../storage/store.ts'
import { Stores } from '../storage/stores.ts'
import { ThreadConversation } from '../threads.ts'

/** Mapping failure leaves committed imports intact. The operator can rerun `import:flue --map`. */
export class MappingFailed extends Schema.TaggedError<MappingFailed>()(
  'MappingFailed',
  { cause: Schema.Defect() },
  { title: 'Imported submission mapping failed' },
) {}

const failed = (cause: unknown) => new MappingFailed({ cause })
const sql = <A>(call: () => Promise<A>) => Effect.tryPromise({ try: call, catch: failed })
const decodePersons = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ person_id: RuntimePersonId })),
)
const isId = Schema.is(Schema.Int.check(Schema.isGreaterThan(0)))
const decodeThread = Schema.decodeUnknownEffect(
  Schema.Struct({
    conversationId: Schema.declare<ConversationId>((value): value is ConversationId => isId(value)),
  }),
)

/**
 * Read committed receipts through the existing Pi storage port. Only imported inputs use raw
 * `sub_` request ids; native inputs use `delivery:` and display writes use `vivid.`.
 */
const mapConversation = Effect.fn('Flue.mapConversation')(function* (
  pool: Pool,
  store: PostgresStore,
  personId: PersonId,
  conversationId: ConversationId,
) {
  let cursor = Option.none<Cursor>()
  let mapped = 0
  do {
    const page = yield* sql(() =>
      store.scanSubmissions(
        { conversationId },
        100,
        Option.getOrUndefined(cursor),
        BACKGROUND_CONTEXT,
      ),
    )
    for (const submission of page.items) {
      if (
        submission.type !== 'input' ||
        submission.requestId === undefined ||
        !submission.requestId.startsWith('sub_')
      )
        continue
      yield* sql(() =>
        pool.query(
          `INSERT INTO runtime.imported_submissions (person_id, flue_submission_id, submission_id)
           VALUES ($1, $2, $3) ON CONFLICT (person_id, flue_submission_id)
           DO UPDATE SET submission_id = excluded.submission_id
           WHERE imported_submissions.submission_id <> excluded.submission_id`,
          [personId, submission.requestId, String(submission.id)],
        ),
      )
      mapped++
    }
    cursor = Option.fromUndefinedOr(page.next)
  } while (Option.isSome(cursor))
  return mapped
})

/** Only current Thread pointers count. Superseded import conversations cannot win an upsert. */
const mapPerson = Effect.fn('Flue.mapPerson')(function* (pool: Pool, personId: PersonId) {
  const store = yield* (yield* Stores).open(personId)
  yield* Effect.addFinalizer(() => Effect.promise(() => store.close(BACKGROUND_CONTEXT)))
  let cursor = Option.none<Cursor>()
  let mapped = 0
  do {
    const page = yield* sql(() =>
      store.scanDocuments(
        { scope: { kind: 'session' }, at: 'current', kind: ThreadConversation.definition.kind },
        100,
        Option.getOrUndefined(cursor),
        BACKGROUND_CONTEXT,
      ),
    )
    for (const record of page.items) {
      const document = yield* sql(() => store.document(record.id, 'current', BACKGROUND_CONTEXT))
      if (document === undefined)
        return yield* failed(new Error('Current Thread document is missing'))
      const thread = yield* decodeThread(document.value).pipe(Effect.mapError(failed))
      mapped += yield* mapConversation(pool, store, personId, thread.conversationId)
    }
    cursor = Option.fromUndefinedOr(page.next)
  } while (Option.isSome(cursor))
  return mapped
})

/**
 * Derive cutover output after Pi's commits, independently of Flue availability. Stores retains
 * the runtime's exclusive authority for this pass, including when `--map` runs alone.
 */
export const mapSubmissions = Effect.fn('Flue.mapSubmissions')(function* () {
  const settings = yield* RuntimeSettings
  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: Redacted.value(settings.databaseUrl), max: 1 })),
    (opened) => Effect.promise(() => opened.end()),
  )
  const rows = yield* sql(() =>
    pool
      .query('SELECT person_id FROM runtime.stores ORDER BY person_id')
      .then((result) => result.rows),
  )
  const persons = yield* decodePersons(rows).pipe(Effect.mapError(failed))
  let mapped = 0
  for (const person of persons) mapped += yield* mapPerson(pool, person.person_id)
  return mapped
}, Effect.scoped)
