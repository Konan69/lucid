import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import { Clock, Context, Effect, Layer, Schema } from 'effect'
import {
  CompanyId,
  Draft,
  DraftListResponse,
  DraftPlace,
  DraftSaved,
  PersonId,
  ThreadId,
  type SaveDraftRequest,
} from '@vivid/contracts'
import { companyColumnOf, ownedHere, type Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { Database, decodeStored, returned } from '../database/client.ts'
import { changed } from '../live/changes.ts'
import { readableThread, requireThread } from '../threads/access.ts'
import { drafts } from './tables.ts'

const fields = createSelectSchema(drafts, {
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
  text: Draft.fields.text,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}).fields
const StoredDraft = Schema.Union([
  Schema.Struct({
    ...fields,
    place: DraftPlace.cases.NewThread.fields._tag,
    threadId: Schema.Null,
  }),
  Schema.Struct({
    ...fields,
    place: DraftPlace.cases.InThread.fields._tag,
    threadId: ThreadId,
  }),
]).pipe(Schema.toTaggedUnion('place'))
const decode = decodeStored(StoredDraft, 'Draft')

/** Decode once at persistence ingress, then project the stored place into its wire variant. */
const wire = Effect.fn('DraftStore.wire')(function* (row: typeof drafts.$inferSelect) {
  const stored = yield* decode(row)
  const place = StoredDraft.match(stored, {
    NewThread: () => DraftPlace.cases.NewThread.make({}),
    InThread: ({ threadId }) => DraftPlace.cases.InThread.make({ thread: threadId }),
  })
  return Draft.make({
    place,
    text: stored.text,
    revision: stored.revision,
    savedAt: stored.savedAt,
    device: stored.device,
  })
})

/** Cross-workspace Thread links save in the Thread's workspace, as threads/access.ts requires. */
const location = Effect.fn('DraftStore.location')(function* (actor: Actor, place: DraftPlace) {
  return yield* DraftPlace.match<
    Effect.Effect<
      { readonly companyId: CompanyId | null; readonly threadId: ThreadId | null },
      Effect.Error<ReturnType<typeof requireThread>>,
      Database
    >
  >(place, {
    NewThread: () =>
      Effect.succeed({ companyId: companyColumnOf(actor.workspace), threadId: null }),
    InThread: Effect.fn('DraftStore.threadLocation')(function* ({ thread }) {
      const found = yield* requireThread(thread, actor.person.id)
      return { companyId: found.companyId, threadId: found.id }
    }),
  })
})

/** Match a real nullable workspace column; Company ownership never widens Person draft access. */
const scope = (actor: Actor, companyId: CompanyId | null) =>
  and(
    eq(drafts.personId, actor.person.id),
    companyId === null ? isNull(drafts.companyId) : eq(drafts.companyId, companyId),
  )

type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]

/** Keep at most fifty including hidden drafts; a deterministic key breaks equal-clock ties. */
const trim = Effect.fn('DraftStore.trim')(function* (
  tx: Transaction,
  actor: Actor,
  companyId: CompanyId | null,
) {
  const oldest = tx
    .select({ key: drafts.placeKey })
    .from(drafts)
    .where(scope(actor, companyId))
    .orderBy(desc(drafts.savedAt), desc(drafts.placeKey))
    .offset(50)
  yield* tx.delete(drafts).where(and(scope(actor, companyId), inArray(drafts.placeKey, oldest)))
})

/** The service owns durable unsent words and cap enforcement, not transport or client state. */
const makeStore = (database: Database['Service']) => {
  /** Visibility is checked before LIMIT, so hidden Threads cannot displace readable drafts. */
  const list = Effect.fn('DraftStore.list')(function* (actor: Actor) {
    const rows = yield* database.run(
      database
        .select()
        .from(drafts)
        .where(
          and(
            ownedHere(drafts, actor),
            or(isNull(drafts.threadId), readableThread(drafts.threadId, actor.person.id)),
          ),
        )
        .orderBy(desc(drafts.savedAt), desc(drafts.placeKey))
        .limit(50),
    )
    return DraftListResponse.make({ drafts: yield* Effect.forEach(rows, wire) })
  })

  /**
   * Serialize one Person's writes on their real owner row, including initially empty workspaces:
   * concurrent inserts for different places must not each miss the other's fifty-first draft.
   * The upsert increments revision in one statement. Trimming shares its transaction. The
   * receipt is published only after commit; no words enter logs or span attributes.
   */
  const save = Effect.fn('DraftStore.save')(function* (actor: Actor, request: SaveDraftRequest) {
    const where = yield* location(actor, request.place).pipe(
      Effect.provideService(Database, database),
    )
    const result = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx
          .select({ id: personTable.id })
          .from(personTable)
          .where(eq(personTable.id, actor.person.id))
          .for('update')
        if (request.text.trim().length === 0) {
          const place = DraftPlace.match(request.place, {
            NewThread: () => isNull(drafts.threadId),
            InThread: ({ thread }) => eq(drafts.threadId, thread),
          })
          yield* tx.delete(drafts).where(and(scope(actor, where.companyId), place))
          return DraftSaved.cases.Cleared.make({ place: request.place })
        }
        const savedAt = yield* Clock.currentTimeMillis
        const rows = yield* tx
          .insert(drafts)
          .values({
            personId: actor.person.id,
            companyId: where.companyId,
            place: request.place._tag,
            threadId: where.threadId,
            text: request.text,
            device: request.device,
            savedAt,
          })
          .onConflictDoUpdate({
            target: [drafts.personId, drafts.placeKey],
            set: {
              text: request.text,
              device: request.device,
              savedAt,
              revision: sql`${drafts.revision} + 1`,
            },
          })
          .returning()
        const draft = yield* wire(yield* returned(rows, 'Draft'))
        yield* trim(tx, actor, where.companyId)
        return DraftSaved.cases.Kept.make({ draft })
      }),
    )
    yield* changed(actor)
    return result
  })
  return { list, save }
}

export class DraftStore extends Context.Service<DraftStore, ReturnType<typeof makeStore>>()(
  'vivid/DraftStore',
) {}

/** Capture only SQL authority; Clock and publication stay scoped to each operation. */
export const draftStoreLayer = Layer.effect(
  DraftStore,
  Effect.gen(function* () {
    return DraftStore.of(makeStore(yield* Database))
  }),
)
