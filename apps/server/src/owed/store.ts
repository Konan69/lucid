import { and, desc, eq, sql } from 'drizzle-orm'
import { Clock, Context, Effect, Layer, Struct } from 'effect'
import {
  Conflict,
  NotFound,
  Owed,
  OwedId,
  OwedState,
  type TrackOwedRequest,
  type UpdateOwedRequest,
  type NudgedOwedRequest,
  type ResolveOwedRequest,
  type DropOwedRequest,
} from '@vivid/contracts'
import { companyColumnOf, ownedHere, type Actor } from '../auth/access.ts'
import { Database, decodeStored, encodeStored, returned } from '../database/client.ts'
import { changed } from '../live/changes.ts'
import { requireThread } from '../threads/access.ts'
import { owed } from './tables.ts'

const decodeOwed = decodeStored(Owed, 'owed record')
const encodeState = encodeStored(OwedState, 'owed state')

/** The Person owns the list even in a Company. Terminal records retain their closure evidence. */
const makeStore = (database: Database['Service']) => {
  /** Open work comes first by deadline; closed records follow by most recent change. */
  const list = Effect.fn('OwedStore.list')(function* (actor: Actor) {
    const active = sql`${owed.state}->>'_tag' in ('Open', 'Nudged')`
    const rows = yield* database.run(
      database
        .select()
        .from(owed)
        .where(ownedHere(owed, actor))
        .orderBy(
          sql`case when ${active} then 0 else 1 end`,
          sql`case when ${active} then ${owed.due} end asc nulls last`,
          desc(owed.updatedAt),
        ),
    )
    return yield* Effect.forEach(rows, decodeOwed)
  })

  /** Thread access and workspace agree before assigning ownership to the calling Person. */
  const track = Effect.fn('OwedStore.track')(function* (actor: Actor, request: TrackOwedRequest) {
    const thread = yield* requireThread(request.threadId, actor.person.id)
    const companyId = companyColumnOf(actor.workspace)
    if (thread.companyId !== companyId) return yield* new NotFound({ message: 'Thread not found' })
    const state = yield* encodeState(OwedState.cases.Open.make({}))
    const rows = yield* database.run(
      database
        .insert(owed)
        .values({
          id: OwedId.make(crypto.randomUUID()),
          personId: actor.person.id,
          companyId,
          threadId: request.threadId,
          what: request.what,
          from: request.from,
          since: request.since,
          due: request.due,
          blockedOn: null,
          nextStep: request.nextStep,
          state,
          updatedAt: yield* Clock.currentTimeMillis,
        })
        .returning(),
    )
    const record = yield* decodeOwed(yield* returned(rows, 'owed record'))
    yield* changed(actor)
    return record
  })

  /** Lock the scoped row so two nudges count twice and a racing closure can never reopen it. */
  const write = Effect.fn('OwedStore.write')(function* (
    actor: Actor,
    id: OwedId,
    change: (record: Owed, now: number) => Owed,
  ) {
    const record = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const condition = and(eq(owed.id, id), ownedHere(owed, actor))
        const rows = yield* tx.select().from(owed).where(condition).for('update')
        const row = rows[0]
        if (row === undefined) return yield* new NotFound({ message: 'Owed record not found' })
        const before = yield* decodeOwed(row)
        if (OwedState.isAnyOf(['Resolved', 'Dropped'])(before.state))
          return yield* new Conflict({ message: 'This owed record is already closed' })
        const now = yield* Clock.currentTimeMillis
        const after = change(before, now)
        const state = yield* encodeState(after.state)
        const updated = yield* tx
          .update(owed)
          .set({
            due: after.due,
            blockedOn: after.blockedOn,
            nextStep: after.nextStep,
            state,
            updatedAt: now,
          })
          .where(condition)
          .returning()
        return yield* decodeOwed(yield* returned(updated, 'owed record'))
      }),
    )
    yield* changed(actor)
    return record
  })

  /** Only current knowledge changes; updating never resets the nudge history. */
  const update = Effect.fn('OwedStore.update')(function* (
    actor: Actor,
    request: UpdateOwedRequest,
  ) {
    return yield* write(actor, request.id, (record) =>
      Owed.make(
        Struct.assign(record, {
          due: request.due,
          blockedOn: request.blockedOn,
          nextStep: request.nextStep,
        }),
      ),
    )
  })
  /** A confirmed nudge adds one to the persisted count, at its supplied sending time. */
  const nudged = Effect.fn('OwedStore.nudged')(function* (
    actor: Actor,
    request: NudgedOwedRequest,
  ) {
    return yield* write(actor, request.id, (record) =>
      Owed.make(
        Struct.assign(record, {
          state: OwedState.cases.Nudged.make({
            lastAt: request.at,
            count: OwedState.guards.Nudged(record.state) ? record.state.count + 1 : 1,
          }),
        }),
      ),
    )
  })
  /** Resolution preserves the evidence of what arrived. */
  const resolve = Effect.fn('OwedStore.resolve')(function* (
    actor: Actor,
    request: ResolveOwedRequest,
  ) {
    return yield* write(actor, request.id, (record, at) =>
      Owed.make(
        Struct.assign(record, { state: OwedState.cases.Resolved.make({ at, how: request.how }) }),
      ),
    )
  })
  /** Dropping retains the reason so the same commitment is not silently tracked again. */
  const drop = Effect.fn('OwedStore.drop')(function* (actor: Actor, request: DropOwedRequest) {
    return yield* write(actor, request.id, (record, at) =>
      Owed.make(
        Struct.assign(record, { state: OwedState.cases.Dropped.make({ at, why: request.why }) }),
      ),
    )
  })
  return { list, track, update, nudged, resolve, drop }
}

export class OwedStore extends Context.Service<OwedStore, ReturnType<typeof makeStore>>()(
  'vivid/OwedStore',
) {}

/** PostgreSQL owns owed records; live notices use the calling operation's Changes service. */
export const owedStoreLayer = Layer.effect(
  OwedStore,
  Effect.gen(function* () {
    return OwedStore.of(makeStore(yield* Database))
  }),
)
