import { and, desc, eq, ne } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  ForgetDone,
  ForgetRemaining,
  MemoryAddress,
  MemoryForgetId,
  MemoryForgetPlan,
  MemoryForgetReceipt,
  MemoryRevision,
  NotFound,
  type PersonId,
  ThreadId,
  type PlanMemoryForgetRequest,
} from '@vivid/contracts'
import { Database, decodeStored, encodeStored } from '../database/client.ts'
import { announce, Topic } from '../live/changes.ts'
import { runs } from '../threads/tables.ts'
import { memoryForgets } from './tables.ts'

/**
 * Where one forget stands, as stored. `Requested` is a Settings press Vivid has not planned yet;
 * `Planned` holds the plan the server checked; `Closed` is the outcome the closure read back.
 */
export const ForgetState = Schema.TaggedUnion({
  Requested: { address: MemoryAddress, expected: MemoryRevision },
  Planned: { plan: MemoryForgetPlan },
  Closed: {
    at: Schema.Finite,
    done: ForgetDone,
    remaining: Schema.Array(ForgetRemaining),
  },
})
export type ForgetState = typeof ForgetState.Type

const Row = Schema.Struct({
  id: MemoryForgetId,
  threadId: ThreadId,
  origin: Schema.Literals(['Settings', 'Conversation']),
  state: ForgetState,
})
const decodeRow = decodeStored(Row, 'memory forget')
const encodeState = encodeStored(ForgetState, 'memory forget state')

/** What a closed forget answers: Completed only when nothing that can bring it back remains. */
const closedReceipt = (id: MemoryForgetId, closed: Extract<ForgetState, { _tag: 'Closed' }>) => {
  const [first, ...rest] = closed.remaining
  return first === undefined
    ? MemoryForgetReceipt.cases.Completed.make({ id, at: closed.at, done: closed.done })
    : MemoryForgetReceipt.cases.Blocked.make({
        id,
        at: closed.at,
        done: closed.done,
        remaining: [first, ...rest],
      })
}

const nothingDone = ForgetDone.make({
  retracted: 0,
  rewritten: 0,
  watches: 0,
  owed: 0,
  learning: 0,
})

type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]
type Stored = typeof memoryForgets.$inferInsert.state

/** A Settings press, stored and announced in the caller's transaction; a repeat changes nothing. */
const insertRequest = Effect.fn('ForgetStore.insertRequest')(function* (
  tx: Transaction,
  input: { readonly id: MemoryForgetId; readonly person: PersonId; readonly threadId: ThreadId },
  state: Stored,
  now: number,
) {
  yield* tx
    .insert(memoryForgets)
    .values({
      id: input.id,
      personId: input.person,
      threadId: input.threadId,
      origin: 'Settings',
      state,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: memoryForgets.id })
  yield* announce(tx, [Topic.person(input.person)])
})

/**
 * The plan under the waiting Settings press's id when there is one (locked, so a second plan in
 * the same Run cannot take it too), or as a new conversation forget.
 */
const keepPlan = Effect.fn('ForgetStore.keepPlan')(function* (
  tx: Transaction,
  input: {
    readonly person: PersonId
    readonly threadId: ThreadId
    readonly request: PlanMemoryForgetRequest
    readonly shared: ReadonlyArray<ThreadId>
  },
  now: number,
) {
  const rows = yield* tx
    .select()
    .from(memoryForgets)
    .where(
      and(
        eq(memoryForgets.personId, input.person),
        eq(memoryForgets.threadId, input.threadId),
        eq(memoryForgets.origin, 'Settings'),
      ),
    )
    .orderBy(desc(memoryForgets.createdAt))
    .limit(1)
    .for('update')
  const waiting = yield* Effect.forEach(rows, decodeRow)
  const pressed = waiting.find((row) => ForgetState.guards.Requested(row.state))
  const id = pressed === undefined ? MemoryForgetId.make(crypto.randomUUID()) : pressed.id
  const made = MemoryForgetPlan.make({ id, ...input.request, shared: input.shared })
  const state = yield* encodeState(ForgetState.cases.Planned.make({ plan: made }))
  if (pressed === undefined)
    yield* tx.insert(memoryForgets).values({
      id,
      personId: input.person,
      threadId: input.threadId,
      origin: 'Conversation',
      state,
      createdAt: now,
      updatedAt: now,
    })
  else
    yield* tx.update(memoryForgets).set({ state, updatedAt: now }).where(eq(memoryForgets.id, id))
  yield* announce(tx, [Topic.person(input.person)])
  return made
})

/** The closed outcome, written and announced in the caller's transaction. */
const writeClosed = Effect.fn('ForgetStore.writeClosed')(function* (
  tx: Transaction,
  input: {
    readonly person: PersonId
    readonly id: MemoryForgetId
    readonly state: Stored
    readonly at: number
  },
) {
  yield* tx
    .update(memoryForgets)
    .set({ state: input.state, updatedAt: input.at })
    .where(and(eq(memoryForgets.id, input.id), eq(memoryForgets.personId, input.person)))
  yield* announce(tx, [Topic.person(input.person)])
})

const makeForgetStore = Effect.fn('ForgetStore.make')(function* () {
  const database = yield* Database

  /** Whether the forget's background Run has ended: a Settings forget it left open is Unplanned. */
  const ended = Effect.fn('ForgetStore.ended')(function* (threadId: ThreadId) {
    const rows = yield* database.run(
      database
        .select({ state: runs.state })
        .from(runs)
        .where(and(eq(runs.threadId, threadId), ne(runs.state, 'working')))
        .limit(1),
    )
    return rows.length > 0
  })

  /**
   * The receipt one forget answers now. A forget not closed yet is Pending, except a Settings
   * forget whose background Run already ended: nothing will carry it out, so it says so.
   */
  const receipt = Effect.fn('ForgetStore.receipt')(function* (
    person: PersonId,
    id: MemoryForgetId,
  ) {
    const rows = yield* database.run(
      database
        .select()
        .from(memoryForgets)
        .where(and(eq(memoryForgets.id, id), eq(memoryForgets.personId, person)))
        .limit(1),
    )
    const [row] = yield* Effect.forEach(rows, decodeRow)
    if (row === undefined) return yield* new NotFound({ message: 'Forget not found' })
    if (ForgetState.guards.Closed(row.state)) return closedReceipt(row.id, row.state)
    if (row.origin === 'Settings' && (yield* ended(row.threadId)))
      return MemoryForgetReceipt.cases.Blocked.make({
        id: row.id,
        at: yield* Clock.currentTimeMillis,
        done: nothingDone,
        remaining: [ForgetRemaining.cases.Unplanned.make({})],
      })
    return MemoryForgetReceipt.cases.Pending.make({ id: row.id })
  })

  /** Record a Settings press against the background Thread its Run will plan in. */
  const request = Effect.fn('ForgetStore.request')(function* (input: {
    readonly id: MemoryForgetId
    readonly person: PersonId
    readonly threadId: ThreadId
    readonly address: MemoryAddress
    readonly expected: MemoryRevision
  }) {
    const now = yield* Clock.currentTimeMillis
    const state = yield* encodeState(
      ForgetState.cases.Requested.make({ address: input.address, expected: input.expected }),
    )
    yield* database.transaction((tx) => insertRequest(tx, input, state, now))
  })

  /**
   * Keep a checked plan. A Settings press waiting in this Thread takes the plan under its own id,
   * so its receipt follows; otherwise the plan is a new conversation forget.
   */
  const plan = Effect.fn('ForgetStore.plan')(function* (input: {
    readonly person: PersonId
    readonly threadId: ThreadId
    readonly request: PlanMemoryForgetRequest
    readonly shared: ReadonlyArray<ThreadId>
  }) {
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction((tx) => keepPlan(tx, input, now))
  })

  /** The newest plan in this Thread that has not been carried out. */
  const planned = Effect.fn('ForgetStore.planned')(function* (
    person: PersonId,
    threadId: ThreadId,
  ) {
    const rows = yield* database.run(
      database
        .select()
        .from(memoryForgets)
        .where(and(eq(memoryForgets.personId, person), eq(memoryForgets.threadId, threadId)))
        .orderBy(desc(memoryForgets.createdAt))
        .limit(1),
    )
    const [row] = yield* Effect.forEach(rows, decodeRow)
    return row !== undefined && ForgetState.guards.Planned(row.state)
      ? Option.some(row.state.plan)
      : Option.none<MemoryForgetPlan>()
  })

  /**
   * Write what the closure read back. A closed forget has no plan left in its Thread
   * (`planned`), so it is carried out and closed once.
   */
  const close = Effect.fn('ForgetStore.close')(function* (
    person: PersonId,
    id: MemoryForgetId,
    closed: Extract<ForgetState, { _tag: 'Closed' }>,
  ) {
    const state = yield* encodeState(closed)
    yield* database.transaction((tx) => writeClosed(tx, { person, id, state, at: closed.at }))
    return closedReceipt(id, closed)
  })

  return { receipt, request, plan, planned, close }
})

export class ForgetStore extends Context.Service<
  ForgetStore,
  Effect.Success<ReturnType<typeof makeForgetStore>>
>()('vivid/ForgetStore') {}

export const forgetStoreLayer = Layer.effect(ForgetStore, makeForgetStore())
