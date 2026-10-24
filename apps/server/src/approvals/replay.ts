import * as NodeCrypto from 'node:crypto'
import { and, asc, inArray, lte, sql, type SQL } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { PersonId, ThreadId } from '@vivid/contracts'
import { Database, decodeStored, type DatabaseInfrastructureError } from '../database/client.ts'
import type { inputRequests } from '../inputs/tables.ts'
import { canSee, findThread } from '../threads/access.ts'
import { Conversation, DeliverySpeaker, StoredRunOrigin } from '../threads/conversation.ts'
import { Signal, encodeSignal } from './signal.ts'
import type { approvals } from './tables.ts'

type SignalTable = typeof approvals | typeof inputRequests
/** Owners execute each complete query on the current database; builders never leave the domain. */
export interface SignalWriter {
  readonly table: SignalTable
  readonly claim: (
    database: Database['Service'],
    update: { readonly where: SQL; readonly leaseUntil: number; readonly token: string },
  ) => Effect.Effect<
    ReadonlyArray<Pick<SignalTable['$inferSelect'], 'id' | 'threadId' | 'personId' | 'signal'>>,
    DatabaseInfrastructureError
  >
  readonly settle: (
    database: Database['Service'],
    update: {
      readonly id: string
      readonly token: string
      readonly signal: Effect.Success<ReturnType<typeof encodeSignal>>
      readonly dueAt: number
    },
  ) => Effect.Effect<void, DatabaseInfrastructureError>
}
const Claimed = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  personId: PersonId,
  signal: Signal.cases.Owed,
})
const decodeClaimed = decodeStored(Claimed, 'owed signal')

/**
 * Claim at most 16 rows under SKIP LOCKED, then admit outside the transaction. All claims run
 * concurrently under a two-minute claim lease. Admission owns its receipt deadline; replay
 * awaits that typed outcome instead of imposing a second deadline. The token fences stale writes. Each domain executes its own complete queries.
 * Claim and acknowledgement run on the replay's own Database, never a caller's transaction.
 * A dead process leaves an owed row, reclaimable after its lease. Runtime keys cover the crash
 * after admission but before acknowledgement, including a late response from an expired owner.
 */
export const replaySignals = Effect.fn('Signals.replay')(function* (
  write: SignalWriter,
  ids: Option.Option<ReadonlyArray<string>>,
) {
  const { table } = write
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const token = NodeCrypto.randomUUID()
  const selected = Option.match(ids, {
    onNone: () => sql`true`,
    onSome: (values) => inArray(table.id, values),
  })
  const due = database
    .select({ id: table.id })
    .from(table)
    .where(and(selected, sql`${table.signal}->>'_tag' = 'Owed'`, lte(table.signalDueAt, now)))
    .orderBy(asc(table.signalDueAt), asc(table.id))
    .limit(16)
    .for('update', { skipLocked: true })
  const rows = yield* write.claim(database, {
    where: inArray(table.id, due),
    leaseUntil: now + 120_000,
    token,
  })
  yield* Effect.forEach(
    rows,
    (value) =>
      replayOne(write, token, value).pipe(
        Effect.interruptible,
        // A corrupt debt or unexpected infrastructure/authority failure stays leased for retry.
        // Log one safe diagnostic per attempt; never expose the signal body or SDK error message.
        Effect.catch((error) =>
          Effect.logError('Decision signal replay failed', {
            id: value.id,
            threadId: value.threadId,
            failure: error._tag,
          }),
        ),
        Effect.asVoid,
      ),
    { concurrency: 16, discard: true },
  )
})

/** Terminal reach loss is recorded once; outages and busy Threads retain their original key. */
const replayOne = Effect.fn('Signals.replayOne')(function* (
  write: SignalWriter,
  token: string,
  value: Pick<SignalTable['$inferSelect'], 'id' | 'threadId' | 'personId' | 'signal'>,
) {
  const database = yield* Database
  const row = yield* decodeClaimed(value)
  const now = yield* Clock.currentTimeMillis
  const thread = yield* findThread(row.threadId)
  // The cascade also removes a claimed debt if its Thread disappears during admission.
  if (Option.isNone(thread)) return
  const stop = () =>
    Signal.cases.Stopped.make({
      idempotencyKey: row.signal.idempotencyKey,
      stoppedAt: now,
      reason: 'AccessLost',
    })
  let ending: Signal
  if (
    !(yield* canSee(thread.value.id, row.personId)) ||
    (row.signal.deciderId !== null && !(yield* canSee(thread.value.id, row.signal.deciderId)))
  )
    ending = stop()
  else {
    const admitted = yield* (yield* Conversation)
      .admit({
        threadId: row.threadId,
        personId: row.personId,
        speaker:
          row.signal.deciderId === null
            ? DeliverySpeaker.cases.Vivid.make({})
            : DeliverySpeaker.cases.Decider.make({ personId: row.signal.deciderId }),
        message: row.signal.message,
        origin: StoredRunOrigin.cases.Decision.make({}),
        idempotencyKey: row.signal.idempotencyKey,
      })
      .pipe(
        Effect.interruptible,
        Effect.asSome,
        Effect.catchTag(['Conflict', 'RuntimeUnavailable'], () => Effect.succeedNone),
      )
    ending = Option.isSome(admitted)
      ? Signal.cases.Delivered.make({
          idempotencyKey: row.signal.idempotencyKey,
          deliveredAt: yield* Clock.currentTimeMillis,
        })
      : row.signal
  }
  yield* write.settle(database, {
    id: row.id,
    token,
    signal: yield* encodeSignal(ending),
    dueAt: now + 30_000,
  })
})
