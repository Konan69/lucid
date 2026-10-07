import * as NodeCrypto from 'node:crypto'
import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import { Clock, Context, Effect, Layer, Option, Schedule, Schema } from 'effect'
import {
  CompanyId,
  NotFound,
  NotificationId,
  PersonId,
  PushOutcome,
  PushPayload,
  ThreadId,
  type PushTarget,
} from '@vivid/contracts'
import { Database, decodeStored, returned } from '../database/client.ts'
import { notifications } from '../notifications/tables.ts'
import { observeFailures } from '../observability/failure.ts'
import { canSee, findThread } from '../threads/access.ts'
import { Presence } from '../threads/presence.ts'
import { PushAdapter } from './adapter.ts'
import { PushAcceptance, PushReceipt } from './receipts.ts'
import { pushDeliveries } from './tables.ts'
import { PushTargets } from './targets.ts'
import { untraced } from '../observability/quiet.ts'

const NoticeRow = createSelectSchema(notifications, {
  id: NotificationId,
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
  conversationId: Schema.NullOr(ThreadId),
})
const decodeNotice = decodeStored(NoticeRow, 'push Notification')
const decodeReceipt = decodeStored(PushReceipt, 'push receipt')
const encodeReceipt = Schema.encodeSync(PushReceipt)
const encodePayload = Schema.encodeSync(Schema.fromJsonString(PushPayload))

/** Push quotes only an existing Notification, with the recipient's current Thread access checked. */
const readable = Effect.fn('Push.readable')(function* (notice: typeof NoticeRow.Type) {
  if (notice.conversationId === null) return true
  const thread = yield* findThread(notice.conversationId)
  return Option.isSome(thread) && (yield* canSee(thread.value.id, notice.personId))
})

interface DeliveryServices {
  readonly database: Database['Service']
  readonly adapter: PushAdapter['Service']
  readonly targets: PushTargets['Service']
  readonly presence: Presence['Service']
}

/** A target's physical address never changes the unique logical send identity. */
const keyOf = (notificationId: NotificationId, target: PushTarget) =>
  and(eq(pushDeliveries.notificationId, notificationId), eq(pushDeliveries.targetId, target.id))

/** A committed claim survives interruption, loss of its response and reconstruction of the Layer. */
const claim = Effect.fn('Push.claim')(function* (
  database: Database['Service'],
  payload: PushPayload,
  target: PushTarget,
) {
  const now = yield* Clock.currentTimeMillis
  const body = encodePayload(payload)
  const claimed = yield* database.run(
    database
      .insert(pushDeliveries)
      .values({
        notificationId: payload.notificationId,
        targetId: target.id,
        bodyHash: NodeCrypto.createHash('sha256').update(body).digest('hex'),
        bodyLength: Buffer.byteLength(body),
        receipt: encodeReceipt(PushReceipt.cases.Queued.make({})),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ targetId: pushDeliveries.targetId }),
  )
  return claimed.length > 0
})

/** The send boundary cannot atomically commit with an external provider; uncertain sends stop here. */
const makeAttempt = (services: DeliveryServices) =>
  Effect.fn('Push.attempt')(function* (
    notice: typeof NoticeRow.Type,
    payload: PushPayload,
    target: PushTarget,
  ) {
    const active = (yield* services.targets.active(notice.personId)).find(
      (row) => row.id === target.id,
    )
    if (active === undefined) return PushReceipt.cases.Failed.make({ reason: 'SessionEnded' })
    if (yield* services.presence.present(notice.personId))
      return PushReceipt.cases.Failed.make({ reason: 'Present' })
    if (!(yield* readable(notice).pipe(Effect.provideService(Database, services.database))))
      return PushReceipt.cases.Failed.make({ reason: 'AccessLost' })
    return yield* services.adapter.send(active.destination, payload).pipe(
      Effect.map((acceptance) => PushReceipt.cases.Sent.make({ acceptance })),
      Effect.catchTags({
        PushTargetGone: () =>
          services.targets
            .remove(notice.personId, target.id)
            .pipe(Effect.as(PushReceipt.cases.Failed.make({ reason: 'Gone' }))),
        PushRejected: () => Effect.succeed(PushReceipt.cases.Failed.make({ reason: 'Rejected' })),
        PushUncertain: () => Effect.succeed(PushReceipt.cases.Failed.make({ reason: 'Uncertain' })),
      }),
    )
  })

/** Replays inspect the durable receipt; they never repeat the provider call, including Queued rows. */
const makeSend = (services: DeliveryServices) => {
  const attempt = makeAttempt(services)
  return Effect.fn('Push.sendTarget')(function* (
    notice: typeof NoticeRow.Type,
    payload: PushPayload,
    target: PushTarget,
  ) {
    const database = services.database
    if (!(yield* claim(database, payload, target))) {
      const previous = yield* database.run(
        database
          .select({ receipt: pushDeliveries.receipt })
          .from(pushDeliveries)
          .where(keyOf(notice.id, target)),
      )
      return yield* decodeReceipt((yield* returned(previous, 'push receipt')).receipt)
    }
    const receipt = yield* attempt(notice, payload, target)
    const now = yield* Clock.currentTimeMillis
    yield* database.run(
      database
        .update(pushDeliveries)
        .set({ receipt: encodeReceipt(receipt), updatedAt: now })
        .where(keyOf(notice.id, target)),
    )
    return receipt
  })
}

/** Counts provider acceptance separately from unresolved claims; neither promises device display. */
const summarize = (receipts: ReadonlyArray<PushReceipt>) =>
  PushOutcome.cases.Attempted.make({
    accepted: receipts.filter(PushReceipt.guards.Sent).length,
    failed: receipts.filter(
      (receipt) => PushReceipt.guards.Failed(receipt) && receipt.reason !== 'Uncertain',
    ).length,
    uncertain: receipts.filter(
      (receipt) =>
        PushReceipt.guards.Queued(receipt) ||
        (PushReceipt.guards.Failed(receipt) && receipt.reason === 'Uncertain'),
    ).length,
  })

/** Existing Notifications supply bodies on demand; push persistence stores only their evidence. */
const makePush = Effect.fn('Push.make')(function* () {
  const database = yield* Database
  const adapter = yield* PushAdapter
  const targets = yield* PushTargets
  const presence = yield* Presence
  const send = makeSend({ database, adapter, targets, presence })
  const reconcile = makeReconcile({ database, adapter, targets, presence })
  const deliver = Effect.fn('Push.deliver')(function* (
    personId: PersonId,
    notificationId: NotificationId,
  ) {
    const rows = yield* database.run(
      database
        .select()
        .from(notifications)
        .where(and(eq(notifications.id, notificationId), eq(notifications.personId, personId))),
    )
    const row = rows[0]
    if (row === undefined) return yield* new NotFound({ message: 'Notification not found.' })
    const notice = yield* decodeNotice(row)
    if (yield* presence.present(personId)) return PushOutcome.cases.Present.make({})
    if (!(yield* readable(notice).pipe(Effect.provideService(Database, database))))
      return PushOutcome.cases.NoTargets.make({})
    const active = yield* targets.active(personId)
    if (active.length === 0) return PushOutcome.cases.NoTargets.make({})
    const payload = PushPayload.make({
      notificationId,
      title: notice.title.slice(0, 180),
      body: notice.body.replace(/\s+/gu, ' ').trim().slice(0, 280),
      threadId: notice.conversationId,
    })
    return summarize(yield* Effect.forEach(active, (target) => send(notice, payload, target)))
  })
  return Push.of({ deliver, reconcile })
})

export interface PushService {
  readonly deliver: (
    personId: PersonId,
    notificationId: NotificationId,
  ) => Effect.Effect<
    PushOutcome,
    import('../database/client.ts').DatabaseInfrastructureError | NotFound
  >
  readonly reconcile: Effect.Effect<
    void,
    import('../database/client.ts').DatabaseInfrastructureError
  >
}
export class Push extends Context.Service<Push, PushService>()('vivid/Push') {}
export const pushLayer = Layer.effect(Push, makePush())

/** Expo recommends reading tickets after 15 minutes; this pass never repeats a send. */
const makeReconcile = Effect.fn('Push.reconcile')(function* (services: DeliveryServices) {
  const database = services.database
  const now = yield* Clock.currentTimeMillis
  const rows = yield* database.run(
    database
      .select({ delivery: pushDeliveries, personId: notifications.personId })
      .from(pushDeliveries)
      .innerJoin(notifications, eq(notifications.id, pushDeliveries.notificationId))
      .where(
        and(
          lte(pushDeliveries.updatedAt, now - 15 * 60_000),
          sql`${pushDeliveries.receipt}->>'_tag' = 'Sent'`,
          sql`${pushDeliveries.receipt}->'acceptance'->>'_tag' = 'Phone'`,
          sql`${pushDeliveries.receipt}->'acceptance'->>'confirmed' = 'false'`,
        ),
      )
      .orderBy(asc(pushDeliveries.updatedAt))
      .limit(100),
  )
  yield* Effect.forEach(rows, (row) => settleReceipt(services, row), { discard: true })
})

/** A missing receipt remains pending; a gone token loses its authority and its ticket is terminal. */
const settleReceipt = Effect.fn('Push.settleReceipt')(function* (
  services: DeliveryServices,
  row: { readonly delivery: typeof pushDeliveries.$inferSelect; readonly personId: PersonId },
) {
  const receipt = yield* decodeReceipt(row.delivery.receipt)
  if (!PushReceipt.guards.Sent(receipt) || !PushAcceptance.guards.Phone(receipt.acceptance)) return
  const acceptance = receipt.acceptance
  const result = yield* services.adapter.receipt(acceptance.ticket).pipe(
    Effect.catchTags({
      PushUncertain: () => Effect.succeed(Option.none<'Confirmed' | 'Gone' | 'Rejected'>()),
      PushRejected: () => Effect.succeed(Option.none<'Confirmed' | 'Gone' | 'Rejected'>()),
    }),
  )
  const now = yield* Clock.currentTimeMillis
  if (Option.isNone(result)) {
    // Expo drops tickets after 24 hours; stop inspecting an irrecoverable receipt, never resend it.
    if (now - row.delivery.createdAt < 24 * 60 * 60_000) {
      // Rotate pending tickets to avoid starving newer receipts when a provider stays silent.
      yield* saveReceipt(services.database, row.delivery, receipt)
      return
    }
    yield* saveReceipt(
      services.database,
      row.delivery,
      PushReceipt.cases.Failed.make({ reason: 'Uncertain' }),
    )
    return
  }
  if (result.value === 'Gone') yield* services.targets.remove(row.personId, row.delivery.targetId)
  const settled =
    result.value === 'Confirmed'
      ? PushReceipt.cases.Sent.make({
          acceptance: PushAcceptance.cases.Phone.make({
            ticket: acceptance.ticket,
            confirmed: true,
          }),
        })
      : PushReceipt.cases.Failed.make({ reason: result.value })
  yield* saveReceipt(services.database, row.delivery, settled)
})

/** Receipt reconciliation changes evidence only; it never stores bodies or creates Notifications. */
const saveReceipt = Effect.fn('Push.saveReceipt')(function* (
  database: Database['Service'],
  key: Pick<typeof pushDeliveries.$inferSelect, 'notificationId' | 'targetId'>,
  receipt: PushReceipt,
) {
  yield* database.run(
    database
      .update(pushDeliveries)
      .set({ receipt: encodeReceipt(receipt), updatedAt: yield* Clock.currentTimeMillis })
      .where(
        and(
          eq(pushDeliveries.notificationId, key.notificationId),
          eq(pushDeliveries.targetId, key.targetId),
        ),
      ),
  )
})

/** Background lifecycle only reads Expo receipts; Routine scheduling stays with the existing worker. */
export const pushReceiptsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const push = yield* Push
    yield* push.reconcile.pipe(
      // Recorded before `ignore` discards the failure; the next minute's check is unchanged.
      observeFailures('schedule'),
      Effect.tapError((error) =>
        Effect.logWarning('Push receipts could not be checked', error._tag),
      ),
      Effect.ignore,
      untraced,
      Effect.repeat(Schedule.spaced('1 minute')),
      Effect.forkScoped,
    )
  }),
)
