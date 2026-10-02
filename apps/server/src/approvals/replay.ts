import * as NodeCrypto from 'node:crypto'
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { PersonId, ThreadId } from '@vivid/contracts'
import { Database, decodeStored } from '../database/client.ts'
import type { inputRequests } from '../inputs/tables.ts'
import { canSee, findThread } from '../threads/access.ts'
import { Conversation, DeliverySpeaker, StoredRunOrigin } from '../threads/conversation.ts'
import { Signal, encodeSignal } from './signal.ts'
import type { approvals } from './tables.ts'

type SignalTable = typeof approvals | typeof inputRequests
const Claimed = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  personId: PersonId,
  signal: Signal.cases.Owed,
})
const decodeClaimed = decodeStored(Claimed, 'owed signal')

/**
 * Claim at most 16 rows under SKIP LOCKED, then admit outside the transaction. All claims run
 * concurrently: admission has 30 seconds and each complete attempt has 60, inside a two-minute
 * lease. The token fences stale writes.
 * A dead process leaves an owed row, reclaimable after its lease. Runtime keys cover the crash
 * after admission but before acknowledgement, including a late response from an expired owner.
 */
export const replaySignals = Effect.fn('Signals.replay')(function* (
  table: SignalTable,
  ids: Option.Option<ReadonlyArray<string>>,
) {
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
  const rows = yield* database.run(
    database
      .update(table)
      .set({ signalDueAt: now + 120_000, signalClaim: token })
      .where(inArray(table.id, due))
      .returning({
        id: table.id,
        threadId: table.threadId,
        personId: table.personId,
        signal: table.signal,
      }),
  )
  yield* Effect.forEach(
    rows,
    (value) =>
      replayOne(table, token, value).pipe(
        Effect.interruptible,
        Effect.timeoutOption('60 seconds'),
        Effect.asVoid,
      ),
    { concurrency: 16, discard: true },
  )
})

/** Terminal reach loss is recorded once; outages and busy Threads retain their original key. */
const replayOne = Effect.fn('Signals.replayOne')(function* (
  table: SignalTable,
  token: string,
  value: Pick<SignalTable['$inferSelect'], 'id' | 'threadId' | 'personId' | 'signal'>,
) {
  const database = yield* Database
  const row = yield* decodeClaimed(value)
  const now = yield* Clock.currentTimeMillis
  const thread = yield* findThread(row.threadId)
  const stop = (reason: 'ThreadDeleted' | 'AccessLost') =>
    Signal.cases.Stopped.make({ idempotencyKey: row.signal.idempotencyKey, stoppedAt: now, reason })
  let ending: Signal
  if (Option.isNone(thread)) ending = stop('ThreadDeleted')
  else if (
    !(yield* canSee(thread.value, row.personId)) ||
    (row.signal.deciderId !== null && !(yield* canSee(thread.value, row.signal.deciderId)))
  )
    ending = stop('AccessLost')
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
        Effect.timeoutOption('30 seconds'),
        Effect.catch(() => Effect.succeed(Option.none())),
      )
    ending = Option.isSome(admitted)
      ? Signal.cases.Delivered.make({
          idempotencyKey: row.signal.idempotencyKey,
          deliveredAt: yield* Clock.currentTimeMillis,
        })
      : row.signal
  }
  yield* database.run(
    database
      .update(table)
      .set({ signal: encodeSignal(ending), signalDueAt: now + 30_000, signalClaim: null })
      .where(and(eq(table.id, row.id), eq(table.signalClaim, token))),
  )
})
