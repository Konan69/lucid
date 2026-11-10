import { and, asc, eq, lt, notInArray, or, sql } from 'drizzle-orm'
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
  WatchCondition,
  WatchPurpose,
  type TimerOperationKey,
  type RunId,
  type ReviseWatchFilters,
} from '@vivid/contracts'
import { ownedHere, type Actor } from '../auth/access.ts'
import { Database, decodeStored, encodeStored, returned } from '../database/client.ts'
import { accountNames, holdConnection, WatchConnectionRemoved } from './apps.ts'
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
  condition: WatchCondition,
  purpose: WatchPurpose,
  callbackUrl: Schema.String,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}
/** A stored row, one variant per state, so a decoded row cannot hold a contradictory state. */
const StoredWatch = Schema.Union([
  Schema.Struct({
    ...common,
    state: Schema.Literal('Pending'),
    stateData: Schema.Null,
    refreshBefore: Schema.Null,
    stopReason: Schema.Null,
  }),
  Schema.Struct({
    ...common,
    state: Schema.Literal('Active'),
    stateData: Schema.Null,
    refreshBefore: Schema.Finite,
    stopReason: Schema.Null,
  }),
  Schema.Struct({
    ...common,
    state: Schema.Literal('Paused'),
    stateData: WatchState.cases.Paused,
    refreshBefore: Schema.NullOr(Schema.Finite),
    stopReason: Schema.Null,
  }),
  Schema.Struct({
    ...common,
    state: Schema.Literal('Completed'),
    stateData: WatchState.cases.Completed,
    refreshBefore: Schema.NullOr(Schema.Finite),
    stopReason: Schema.Null,
  }),
  Schema.Struct({
    ...common,
    state: Schema.Literal('Stopped'),
    stateData: Schema.Null,
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

/** Subscription identity is reused unchanged by subscribe, renewal and terminal cleanup. */
export const subscriptionOf = (record: WatchRecord) => ({
  name: record.subscribedName,
  arguments: record.watch.arguments,
  url: record.callbackUrl,
})

/** Decode once, then project the stored state into its wire variant. */
const record = Effect.fn('WatchStore.record')(function* (row: typeof watches.$inferSelect) {
  const stored: StoredWatch = yield* decodeWatch(row)
  const state = StoredWatch.match(stored, {
    Pending: () => WatchState.cases.Pending.make({}),
    Active: ({ refreshBefore }) => WatchState.cases.Active.make({ refreshBefore }),
    Paused: ({ stateData }) => stateData,
    Completed: ({ stateData }) => stateData,
    Stopped: ({ stopReason }) => WatchState.cases.Stopped.make({ reason: stopReason }),
  })
  return {
    watch: {
      id: stored.id,
      name: stored.name,
      event: stored.event,
      arguments: stored.arguments,
      instruction: stored.instruction,
      condition: stored.condition,
      purpose: stored.purpose,
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
interface NewWatch {
  readonly id: WatchId
  readonly personId: PersonId
  readonly companyId: CompanyId | null
  readonly connectionId: ConnectionId
  readonly name: string
  readonly event: string
  readonly subscribedName: string
  readonly arguments: WatchArguments
  readonly instruction: string
  readonly condition: WatchCondition
  readonly purpose: WatchPurpose
  readonly callbackUrl: string
}

/** The one row a keyed read or write found, if any. */
const first = <A>(all: ReadonlyArray<A>) => Option.fromUndefinedOr(all[0])

/** Pending, Active and Paused reserve their names; both terminal states are history. */
const live = notInArray(watches.state, ['Stopped', 'Completed'])
const encodePurpose = encodeStored(WatchPurpose, 'Watch purpose')
const encodeCondition = encodeStored(WatchCondition, 'Watch condition')
const encodeState = encodeStored(WatchState, 'Watch state')

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
          .values({
            ...input,
            condition: yield* encodeCondition(input.condition),
            purpose: yield* encodePurpose(input.purpose),
            state: 'Pending',
            createdAt: now,
            updatedAt: now,
          })
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
        .where(
          and(eq(watches.id, id), notInArray(watches.state, ['Stopped', 'Completed', 'Paused'])),
        )
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
        .set({ state: 'Stopped', stateData: null, stopReason: reason, updatedAt: now })
        .where(and(eq(watches.id, id), live))
        .returning(),
    )
    return yield* Effect.forEach(rows, record).pipe(Effect.map(first))
  })

  /**
   * Compare the saved callback so a concurrent revision or stop cannot be overwritten. A Watch
   * paused for a sign-in stays paused under its revised filters; the Connection being Ready again
   * resumes it (`progress.ts`). Its condition and purpose are not part of a revision and stay.
   */
  const revise = Effect.fn('WatchStore.revise')(function* (
    previous: WatchRecord,
    request: ReviseWatchFilters,
    callbackUrl: string,
    refreshBefore: number,
  ) {
    const now = yield* Clock.currentTimeMillis
    const lifecycle = WatchState.guards.Paused(previous.watch.state)
      ? { state: 'Paused' as const, stateData: yield* encodeState(previous.watch.state) }
      : { state: 'Active' as const, stateData: null }
    const rows = yield* database.run(
      database
        .update(watches)
        .set({
          arguments: request.arguments,
          instruction: request.instruction,
          callbackUrl,
          ...lifecycle,
          refreshBefore,
          updatedAt: now,
        })
        .where(
          and(
            eq(watches.id, previous.watch.id),
            eq(watches.callbackUrl, previous.callbackUrl),
            live,
          ),
        )
        .returning(),
    )
    return yield* Effect.forEach(rows, record).pipe(Effect.map(first))
  })

  return {
    insertPending,
    activate,
    discard,
    stop,
    revise,
    ...makeProgressWrites(database),
    ...makePurposeWrites(database),
  }
}

/** A late receipt cannot confirm an operation that an update has replaced. */
const makePurposeWrites = (database: Database['Service']) => {
  const purpose = Effect.fn('WatchStore.purpose')(function* (
    id: WatchId,
    value: WatchPurpose,
    expected: Option.Option<TimerOperationKey>,
  ) {
    const predicate = Option.match(expected, {
      onNone: () => live,
      onSome: (key) => and(live, sql`${watches.purpose}->'arming'->>'operationKey' = ${key}`),
    })
    const rows = yield* database.run(
      database
        .update(watches)
        .set({ purpose: yield* encodePurpose(value), updatedAt: yield* Clock.currentTimeMillis })
        .where(and(eq(watches.id, id), predicate))
        .returning(),
    )
    return yield* Effect.forEach(rows, record).pipe(Effect.map(first))
  })
  /** Source closure is conditional on the timer key, so an old firing cannot finish a changed intent. */
  const completeCheckin = Effect.fn('WatchStore.completeCheckin')(function* (input: {
    readonly id: WatchId
    readonly operationKey: TimerOperationKey
    readonly runId: RunId
    readonly evidence: string
  }) {
    const at = yield* Clock.currentTimeMillis
    const rows = yield* database.run(
      database
        .update(watches)
        .set({
          state: 'Completed',
          stateData: yield* encodeState(
            WatchState.cases.Completed.make({ at, runId: input.runId, evidence: input.evidence }),
          ),
          updatedAt: at,
        })
        .where(
          and(
            eq(watches.id, input.id),
            live,
            sql`${watches.purpose}->'arming'->>'operationKey' = ${input.operationKey}`,
          ),
        )
        .returning(),
    )
    return yield* Effect.forEach(rows, record).pipe(Effect.map(first))
  })
  return { purpose, completeCheckin }
}

/** Terminal and authorization transitions share guarded writes over the persisted lifecycle. */
const makeProgressWrites = (database: Database['Service']) => {
  /** Completion is terminal even if unsubscribe never reaches Executor. */
  const complete = Effect.fn('WatchStore.complete')(function* (
    id: WatchId,
    runId: RunId,
    evidence: string,
  ) {
    const at = yield* Clock.currentTimeMillis
    const state = WatchState.cases.Completed.make({ at, runId, evidence })
    const rows = yield* database.run(
      database
        .update(watches)
        .set({ state: 'Completed', stateData: yield* encodeState(state), updatedAt: at })
        .where(and(eq(watches.id, id), live))
        .returning(),
    )
    return yield* Effect.forEach(rows, record).pipe(Effect.map(first))
  })

  /** Keep the subscription's expiry while authorization is missing; renewal cannot unpause it. */
  const pause = Effect.fn('WatchStore.pause')(
    function* (id: WatchId, connectionId: ConnectionId) {
      const at = yield* Clock.currentTimeMillis
      const state = WatchState.cases.Paused.make({ at, connectionId })
      return yield* database.transaction((tx) =>
        Effect.gen(function* () {
          if ((yield* holdConnection(tx, connectionId)) !== 'needs-authorization')
            return Option.none<WatchRecord>()
          const rows = yield* tx
            .update(watches)
            .set({ state: 'Paused', stateData: yield* encodeState(state), updatedAt: at })
            .where(
              and(
                eq(watches.id, id),
                notInArray(watches.state, ['Stopped', 'Completed', 'Paused']),
              ),
            )
            .returning()
          return yield* Effect.forEach(rows, record).pipe(Effect.map(first))
        }),
      )
    },
    (effect) => effect.pipe(Effect.catchTag('WatchConnectionRemoved', () => Effect.succeedNone)),
  )

  /** Renewal keeps Paused and only extends its subscription lease. */
  const renewPaused = Effect.fn('WatchStore.renewPaused')(function* (
    id: WatchId,
    refreshBefore: number,
  ) {
    yield* database.run(
      database
        .update(watches)
        .set({ refreshBefore })
        .where(and(eq(watches.id, id), eq(watches.state, 'Paused'))),
    )
  })

  /** Lock the same authorization row as sign-in writes; a late grant cannot undo a new auth loss. */
  const resume = Effect.fn('WatchStore.resume')(
    function* (id: WatchId, refreshBefore: number, connectionId: ConnectionId) {
      const now = yield* Clock.currentTimeMillis
      return yield* database.transaction((tx) =>
        Effect.gen(function* () {
          if ((yield* holdConnection(tx, connectionId)) !== 'ready')
            return Option.none<WatchRecord>()
          const rows = yield* tx
            .update(watches)
            .set({ state: 'Active', stateData: null, refreshBefore, updatedAt: now })
            .where(
              and(
                eq(watches.id, id),
                eq(watches.state, 'Paused'),
                sql`${watches.stateData}->>'connectionId' = ${connectionId}`,
              ),
            )
            .returning()
          return yield* Effect.forEach(rows, record).pipe(Effect.map(first))
        }),
      )
    },
    (effect) => effect.pipe(Effect.catchTag('WatchConnectionRemoved', () => Effect.succeedNone)),
  )

  return { complete, pause, renewPaused, resume }
}

/** Snapshot reads retain the Connection's name alongside every Watch that references it. */
const withAccount = (record: WatchRecord, names: ReadonlyMap<string, string>) => {
  const account = names.get(record.connectionId)
  if (account === undefined)
    return Effect.fail(new DatabaseFailure({ message: 'Watch Connection has no name' }))
  return Effect.succeed({ ...record, watch: Watch.make({ ...record.watch, account }) })
}

/** One inventory read names the entire result. */
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
  /**
   * Watch rows and the whole naming inventory must see the same committed state. Drizzle's
   * Effect adapter shares the transaction connection through fiber context, including the
   * Database queries in accountNames. A join restricted to Watches would lose name ordinals.
   */
  const snapshot = <A, E, R>(read: Effect.Effect<A, E, R>) =>
    database.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.setTransaction({ isolationLevel: 'repeatable read', accessMode: 'read only' })
        return yield* read
      }),
    )

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
  }, snapshot)

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
  }, snapshot)

  /** A Watch by id, whatever its state, for the receiver: the signature is its only authority. */
  const find = Effect.fn('WatchStore.find')(function* (id: WatchId) {
    const rows = yield* database.run(
      database.select().from(watches).where(eq(watches.id, id)).limit(1),
    )
    return yield* Effect.forEach(rows, record).pipe(Effect.map(first))
  })

  /** Authorization reconciliation includes Watches paused on a different service than their timer. */
  const allLive = Effect.fn('WatchStore.allLive')(function* () {
    return yield* Effect.forEach(
      yield* database.run(database.select().from(watches).where(live)),
      record,
    )
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
            and(
              or(eq(watches.state, 'Active'), eq(watches.state, 'Paused')),
              or(
                lt(watches.refreshBefore, input.activeBefore),
                sql`${watches.refreshBefore} is null`,
              ),
            ),
            and(eq(watches.state, 'Pending'), lt(watches.updatedAt, input.pendingBefore)),
          ),
        )
        .orderBy(asc(watches.createdAt), asc(watches.id)),
    )
    return yield* Effect.forEach(rows, record)
  })

  /** A display record, or removal when its Connection has left the current inventory. */
  const present = Effect.fn('WatchStore.present')(function* (actor: Actor, record: WatchRecord) {
    const names = yield* accountNames(actor).pipe(Effect.provideService(Database, database))
    const account = names.get(record.connectionId)
    if (account === undefined)
      return yield* new WatchConnectionRemoved({ connectionId: record.connectionId })
    return { ...record, watch: Watch.make({ ...record.watch, account }) }
  })

  return { list, named, find, due, present, allLive }
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
