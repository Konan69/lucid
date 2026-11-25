import { and, asc, eq, lt, ne, or } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  CompanyId,
  PersonId,
  ConnectionId,
  Watch,
  DatabaseFailure,
  WatchArguments,
  WatchId,
  WatchState,
  WatchStopReason,
} from '@vivid/contracts'
import { ownedHere, type Actor } from '../auth/access.ts'
import { Database, decodeStored, returned } from '../database/client.ts'
import { accountNames, holdConnection } from './apps.ts'
import { watches } from './tables.ts'

/** A live Watch of this Person already has this name; Vivid stops Watches by name, so it must differ. */
export class WatchNameTaken extends Schema.TaggedError<WatchNameTaken>()(
  'WatchNameTaken',
  {},
  { title: 'Watch name taken' },
) {}

const common = {
  id: WatchId,
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
  name: Watch.fields.name,
  connectionId: ConnectionId,
  event: Schema.String,
  subscribedName: Schema.String,
  arguments: WatchArguments,
  instruction: Watch.fields.instruction,
  callbackUrl: Schema.String,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}
/** A stored row, one variant per state, so a decoded row cannot hold a contradictory state. */
const StoredWatch = Schema.Union([
  Schema.Struct({
    ...common,
    state: Schema.Literal('Pending'),
    refreshBefore: Schema.Null,
    stopReason: Schema.Null,
  }),
  Schema.Struct({
    ...common,
    state: Schema.Literal('Active'),
    refreshBefore: Schema.Finite,
    stopReason: Schema.Null,
  }),
  Schema.Struct({
    ...common,
    state: Schema.Literal('Stopped'),
    refreshBefore: Schema.NullOr(Schema.Finite),
    stopReason: WatchStopReason,
  }),
]).pipe(Schema.toTaggedUnion('state'))
type StoredWatch = typeof StoredWatch.Type
const decodeWatch = decodeStored(StoredWatch, 'Watch')

/**
 * A Watch with what only the server holds: whose it is and the exact subscription key sent to
 * Executor. Display names are added only for owner-facing reads.
 */
export interface WatchRecord {
  readonly watch: Omit<Watch, 'account'>
  readonly personId: PersonId
  readonly companyId: CompanyId | null
  readonly connectionId: ConnectionId
  /** `<app slug>.<event>`, as subscribed. */
  readonly subscribedName: string
  readonly callbackUrl: string
}

/** Decode once, then project the stored state into its wire variant. */
const record = Effect.fn('WatchStore.record')(function* (row: typeof watches.$inferSelect) {
  const stored: StoredWatch = yield* decodeWatch(row)
  const state = StoredWatch.match(stored, {
    Pending: () => WatchState.cases.Pending.make({}),
    Active: ({ refreshBefore }) => WatchState.cases.Active.make({ refreshBefore }),
    Stopped: ({ stopReason }) => WatchState.cases.Stopped.make({ reason: stopReason }),
  })
  return {
    watch: {
      id: stored.id,
      name: stored.name,
      event: stored.event,
      arguments: stored.arguments,
      instruction: stored.instruction,
      state,
      createdAt: stored.createdAt,
    },
    personId: stored.personId,
    companyId: stored.companyId,
    connectionId: stored.connectionId,
    subscribedName: stored.subscribedName,
    callbackUrl: stored.callbackUrl,
  } satisfies WatchRecord
})

/** A new Watch, before Executor has been asked. */
export interface NewWatch {
  readonly id: WatchId
  readonly personId: PersonId
  readonly companyId: CompanyId | null
  readonly connectionId: ConnectionId
  readonly name: string
  readonly event: string
  readonly subscribedName: string
  readonly arguments: WatchArguments
  readonly instruction: string
  readonly callbackUrl: string
}

/** The one row a keyed read or write found, if any. */
const first = <A>(all: ReadonlyArray<A>) => Option.fromUndefinedOr(all[0])

/** Live means not stopped: Pending and Active. */
const live = ne(watches.state, 'Stopped')

/** Writes that move a Watch through its states. */
const makeWrites = (database: Database['Service']) => {
  /** Insert Pending after checking the name; the partial unique index guards a racing twin. */
  const insertPending = Effect.fn('WatchStore.insertPending')(function* (input: NewWatch) {
    const taken = yield* database.run(
      database
        .select({ id: watches.id })
        .from(watches)
        .where(and(eq(watches.personId, input.personId), eq(watches.name, input.name), live))
        .limit(1),
    )
    if (taken.length > 0) return yield* new WatchNameTaken({})
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        yield* holdConnection(tx, input.connectionId)
        return yield* tx
          .insert(watches)
          .values({ ...input, state: 'Pending', createdAt: now, updatedAt: now })
          .returning()
      }),
    )
    return yield* record(yield* returned(rows, 'Watch'))
  })

  /** Executor granted (or renewed) the subscription; a Watch stopped meanwhile stays stopped. */
  const activate = Effect.fn('WatchStore.activate')(function* (id: WatchId, refreshBefore: number) {
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.run(
      database
        .update(watches)
        .set({
          state: 'Active',
          refreshBefore,
          updatedAt: now,
        })
        .where(and(eq(watches.id, id), live))
        .returning(),
    )
    return yield* Effect.forEach(rows, record).pipe(Effect.map(first))
  })

  /** Executor refused the subscription: a Watch that never became Active leaves no trace. */
  const discard = Effect.fn('WatchStore.discard')(function* (id: WatchId) {
    yield* database.run(
      database.delete(watches).where(and(eq(watches.id, id), eq(watches.state, 'Pending'))),
    )
  })

  /** Stop a live Watch for good; its background Threads stay. */
  const stop = Effect.fn('WatchStore.stop')(function* (id: WatchId, reason: WatchStopReason) {
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.run(
      database
        .update(watches)
        .set({ state: 'Stopped', stopReason: reason, updatedAt: now })
        .where(and(eq(watches.id, id), live))
        .returning(),
    )
    return yield* Effect.forEach(rows, record).pipe(Effect.map(first))
  })

  return { insertPending, activate, discard, stop }
}

/** Missing names violate the Connection FK's promise; never invent an account label. */
const withAccount = (record: WatchRecord, names: ReadonlyMap<string, string>) => {
  const account = names.get(record.connectionId)
  if (account === undefined)
    return Effect.fail(new DatabaseFailure({ message: 'Watch Connection has no name' }))
  return Effect.succeed({ ...record, watch: Watch.make({ ...record.watch, account }) })
}

/** One inventory read names the entire result; receiver and renewal never call this projection. */
const presentAll = Effect.fn('WatchStore.presentAll')(function* (
  actor: Actor,
  records: ReadonlyArray<WatchRecord>,
) {
  if (records.length === 0) return []
  const names = yield* accountNames(actor)
  return yield* Effect.forEach(records, (record) => withAccount(record, names))
})

/** Reads of Watch rows, for their owner, for the receiver and for renewal. */
const makeReads = (database: Database['Service']) => {
  /** The Actor's own live Watches in their workspace, oldest first. */
  const list = Effect.fn('WatchStore.list')(function* (actor: Actor) {
    const rows = yield* database.run(
      database
        .select()
        .from(watches)
        .where(and(ownedHere(watches, actor), live))
        .orderBy(asc(watches.createdAt), asc(watches.id)),
    )
    return yield* presentAll(actor, yield* Effect.forEach(rows, record)).pipe(
      Effect.provideService(Database, database),
    )
  })

  /** One of the Actor's live Watches by its name. */
  const named = Effect.fn('WatchStore.named')(function* (actor: Actor, name: string) {
    const rows = yield* database.run(
      database
        .select()
        .from(watches)
        .where(and(ownedHere(watches, actor), live, eq(watches.name, name)))
        .limit(1),
    )
    return yield* presentAll(actor, yield* Effect.forEach(rows, record)).pipe(
      Effect.provideService(Database, database),
      Effect.map(first),
    )
  })

  /** A Watch by id, whatever its state, for the receiver: the signature is its only authority. */
  const find = Effect.fn('WatchStore.find')(function* (id: WatchId) {
    const rows = yield* database.run(
      database.select().from(watches).where(eq(watches.id, id)).limit(1),
    )
    return yield* Effect.forEach(rows, record).pipe(Effect.map(first))
  })

  /**
   * The Watches the renewal pass owes a subscribe call, oldest first: Active ones whose
   * subscription expires before `activeBefore`, expired ones included, and Pending ones not
   * touched since `pendingBefore`, which a creation left behind (epoch milliseconds both).
   */
  const due = Effect.fn('WatchStore.due')(function* (input: {
    readonly activeBefore: number
    readonly pendingBefore: number
  }) {
    const rows = yield* database.run(
      database
        .select()
        .from(watches)
        .where(
          or(
            and(eq(watches.state, 'Active'), lt(watches.refreshBefore, input.activeBefore)),
            and(eq(watches.state, 'Pending'), lt(watches.updatedAt, input.pendingBefore)),
          ),
        )
        .orderBy(asc(watches.createdAt), asc(watches.id)),
    )
    return yield* Effect.forEach(rows, record)
  })

  /** Creation returns a display record only after Executor has answered. */
  const present = Effect.fn('WatchStore.present')(function* (actor: Actor, record: WatchRecord) {
    const names = yield* accountNames(actor).pipe(Effect.provideService(Database, database))
    return yield* withAccount(record, names)
  })

  return { list, named, find, due, present }
}

/** The service owns Watch rows; Executor and delivery stay with the caller. */
const makeStore = (database: Database['Service']) => ({
  ...makeWrites(database),
  ...makeReads(database),
})

export class WatchStore extends Context.Service<WatchStore, ReturnType<typeof makeStore>>()(
  'vivid/WatchStore',
) {}

export const watchStoreLayer = Layer.effect(
  WatchStore,
  Effect.gen(function* () {
    return WatchStore.of(makeStore(yield* Database))
  }),
)
