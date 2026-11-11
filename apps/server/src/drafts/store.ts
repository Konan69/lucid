import { and, desc, eq, exists, inArray, isNull, or, sql } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import { Clock, Context, Effect, Layer, Schema } from 'effect'
import {
  CompanyId,
  Draft,
  DraftListResponse,
  DraftPlace,
  DraftSaved,
  DraftWorkspace,
  PersonId,
  ThreadId,
  Workspace,
  type SaveDraftRequest,
} from '@vivid/contracts'
import { companyColumnOf, ownedHere, type Actor } from '../auth/access.ts'
import { Database, decodeStored, returned } from '../database/client.ts'
import { Changes, Topic } from '../live/changes.ts'
import { readableThread, requireThread } from '../threads/access.ts'
import { threads } from '../threads/tables.ts'
import { draftGenerations, drafts } from './tables.ts'

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
const decodeGeneration = decodeStored(
  Schema.Struct({ generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  'Draft generation',
)

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

/**
 * Lock the Thread against deletion before checking reach on the writing connection. A delete
 * that won first becomes NotFound; a later delete waits for commit instead of causing an FK
 * failure. Archived Threads remain writable, matching threads/gateway.ts#admitted and
 * threads/access.ts#requireThread, which admit messages by reach without an archive restriction.
 */
const location = Effect.fn('DraftStore.location')(function* (
  tx: Transaction,
  actor: Actor,
  place: DraftPlace,
) {
  return yield* DraftPlace.match(place, {
    NewThread: () =>
      Effect.succeed({
        companyId: companyColumnOf(actor.workspace),
        threadId: null,
      }),
    InThread: Effect.fn('DraftStore.threadLocation')(function* ({ thread }) {
      yield* tx
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.id, thread))
        .for('key share')
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

/**
 * Drizzle generates schema DDL, not a data backfill. Legacy local rows therefore contribute
 * their maximum revision across ALL workspaces until the Person's first generation is stored.
 * SQL zero denotes genuine absence of both counters and drafts, never an invented identity.
 */
const generationAt = Effect.fn('DraftStore.generationAt')(function* (
  tx: Transaction,
  person: PersonId,
) {
  const rows = yield* tx
    .select({
      generation: sql`greatest(
        coalesce((select ${draftGenerations.generation} from ${draftGenerations}
          where ${draftGenerations.personId} = ${person}), 0),
        coalesce(max(${drafts.revision}), 0))`.mapWith(Number),
    })
    .from(drafts)
    .where(eq(drafts.personId, person))
  return (yield* decodeGeneration(yield* returned(rows, 'Draft generation'))).generation
})

/**
 * The single upsert's row lock serializes every save/clear by this Person until commit, including
 * cap pruning. A newly created counter starts above legacy revisions; conflicts advance the
 * stored counter by exactly one even when concurrent inserts saw the same initial maximum.
 */
const advance = Effect.fn('DraftStore.advance')(function* (tx: Transaction, person: PersonId) {
  const rows = yield* tx
    .insert(draftGenerations)
    .values({
      personId: person,
      generation: sql`(select coalesce(max(${drafts.revision}), 0) + 1
        from ${drafts} where ${drafts.personId} = ${person})`,
    })
    .onConflictDoUpdate({
      target: draftGenerations.personId,
      set: { generation: sql`${draftGenerations.generation} + 1` },
    })
    .returning({ generation: draftGenerations.generation })
  return (yield* decodeGeneration(yield* returned(rows, 'Draft generation'))).generation
})

/** Archived rows survive but occupy no list or cap slot; hidden, unarchived rows still count. */
const unarchived = or(
  isNull(drafts.threadId),
  exists(
    sql`(select 1 from ${threads} where ${threads.id} = ${drafts.threadId} and ${threads.archived} = false)`,
  ),
)

/**
 * Keep the fifty highest revisions among active rows; the serialized save is always newest.
 * Clock may tie or move backwards without changing order, since savedAt is display metadata.
 * Read archive status in the pruning statement: a concurrent archive must not turn a remembered
 * active flag into an unnecessary deletion of another place.
 * Archived drafts are untouched so unarchiving restores their unsent words.
 */
const trim = Effect.fn('DraftStore.trim')(function* (
  tx: Transaction,
  actor: Actor,
  kept: typeof drafts.$inferSelect,
) {
  const oldest = tx
    .select({ key: drafts.placeKey })
    .from(drafts)
    .where(and(scope(actor, kept.companyId), unarchived))
    .orderBy(desc(drafts.revision))
    .offset(50)
  yield* tx
    .delete(drafts)
    .where(and(scope(actor, kept.companyId), inArray(drafts.placeKey, oldest)))
})

/** The service owns durable unsent words and cap enforcement, not transport or client state. */
const makeStore = (database: Database['Service']) => {
  /**
   * REPEATABLE READ fixes one snapshot for the counter and rows, so neither can be newer than
   * the other even when a write commits between queries. The writer commits both atomically.
   * setTransaction is public in pinned Drizzle pg-core/effect/session.js. Visibility precedes
   * LIMIT so hidden Threads cannot displace readable drafts. Workspace comes from real authority.
   */
  const list = Effect.fn('DraftStore.list')(function* (actor: Actor) {
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.setTransaction({ isolationLevel: 'repeatable read', accessMode: 'read only' })
        const generation = yield* generationAt(tx, actor.person.id)
        const rows = yield* tx
          .select()
          .from(drafts)
          .where(
            and(
              ownedHere(drafts, actor),
              unarchived,
              or(isNull(drafts.threadId), readableThread(drafts.threadId, actor.person.id)),
            ),
          )
          .orderBy(desc(drafts.revision))
          .limit(50)
        const workspace = Workspace.match(actor.workspace, {
          Personal: () => DraftWorkspace.cases.Personal.make({}),
          Company: ({ company }) => DraftWorkspace.cases.Company.make({ company: company.id }),
        })
        return DraftListResponse.make({
          workspace,
          generation,
          drafts: yield* Effect.forEach(rows, wire),
        })
      }),
    )
  })

  /**
   * The generation upsert replaces the former FOR NO KEY UPDATE lock on the auth user row:
   * its own row lock serializes all of the Person's writes, including empty workspaces and clears.
   * A kept revision is that generation; clearing deletes the row, while its order survives in
   * the counter. Generation, mutation and trimming share one transaction. The
   * receipt is published only to this Person after commit. Installed Effect Statement.ts:1334
   * traces parameterized SQL, not bindings; makeWithDefaults uses Drizzle's no-op logger
   * (effect-core/logger.js:34). Draft text is never logged or attached to a span.
   */
  const save = Effect.fn('DraftStore.save')(function* (actor: Actor, request: SaveDraftRequest) {
    const result = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const generation = yield* advance(tx, actor.person.id)
        const where = yield* location(tx, actor, request.place).pipe(
          Effect.provideService(Database, database),
        )
        if (request.text.trim().length === 0) {
          const place = DraftPlace.match(request.place, {
            NewThread: () => isNull(drafts.threadId),
            InThread: ({ thread }) => eq(drafts.threadId, thread),
          })
          yield* tx.delete(drafts).where(and(scope(actor, where.companyId), place))
          return DraftSaved.cases.Cleared.make({ place: request.place, generation })
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
            revision: generation,
          })
          .onConflictDoUpdate({
            target: [drafts.personId, drafts.placeKey],
            set: {
              text: request.text,
              device: request.device,
              savedAt,
              revision: generation,
            },
          })
          .returning()
        const row = yield* returned(rows, 'Draft')
        const draft = yield* wire(row)
        yield* trim(tx, actor, row)
        return DraftSaved.cases.Kept.make({ draft, generation })
      }),
    )
    yield* (yield* Changes).publish([Topic.part('drafts')(Topic.person(actor.person.id))])
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
