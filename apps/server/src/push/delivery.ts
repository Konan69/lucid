import * as NodeCrypto from 'node:crypto'
import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import { Clock, Context, Effect, Layer, Option, Schedule, Schema } from 'effect'
import {
  CompanyId,
  NotFound,
  NotificationId,
  NotificationApproval,
  NotificationKind,
  NotificationOpens,
  PersonId,
  PushOutcome,
  PushPayload,
  type PushSound,
  ThreadId,
  type PushTarget,
} from '@vivid/contracts'
import { Database, decodeStored, encodeStored, returned } from '../database/client.ts'
import { notifications } from '../notifications/tables.ts'
import { observeFailures } from '../observability/failure.ts'
import { canSee, findThread } from '../threads/access.ts'
import { opensAt } from '../threads/place.ts'
import { Presence } from '../threads/presence.ts'
import { PushAdapter } from './adapter.ts'
import { PushAcceptance, PushReceipt } from './receipts.ts'
import { pushDeliveries } from './tables.ts'
import { PushTargets } from './targets.ts'
import { untraced } from '../observability/quiet.ts'

const NoticeRow = createSelectSchema(notifications, {
  approval: Schema.NullOr(NotificationApproval),
  id: NotificationId,
  kind: NotificationKind,
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
  conversationId: Schema.NullOr(ThreadId),
})
const decodeNotice = decodeStored(NoticeRow, 'push Notification')
const decodeReceipt = decodeStored(PushReceipt, 'push receipt')
const encodeReceipt = encodeStored(PushReceipt, 'push receipt')
/** The body as it is sent: the claim row stores its hash and length, so one that will not encode cannot be claimed. */
const encodePayload = encodeStored(Schema.fromJsonString(PushPayload), 'push payload')

/**
 * Which notices sound. Only what the Person is waiting on and what is urgent: Vivid finishing
 * work they asked for, a question or Approval it is stopped on, and an urgent Feed finding (told
 * as `needs-you`, `notifications/attention.ts`); a Thread shared with them and an invitation are
 * people waiting on them too. A Feed post Vivid made on its own is quiet (Konan, 27 October 2026:
 * "Feed posts appear silently"). A new kind fails to compile here until it is decided.
 */
const SOUND = {
  finished: 'Audible',
  'needs-you': 'Audible',
  shared: 'Audible',
  invited: 'Audible',
  posted: 'Quiet',
} as const satisfies Record<typeof NotificationKind.Type, PushSound>

/** Expo recommends waiting 15 minutes before reading asynchronous delivery receipts.
 * Source: https://docs.expo.dev/push-notifications/sending-notifications/ . */
const RECEIPT_READY_AFTER_MS = 15 * 60_000
/** Expo removes receipts after 24 hours. Expiry stops inspection and never resends a claim.
 * Source: https://docs.expo.dev/push-notifications/sending-notifications/ . */
const RECEIPT_RETENTION_MS = 24 * 60 * 60_000
/** Paces pull-only Expo receipt reconciliation. Source: unmeasured. Each pass leaves unresolved
 * tickets owed; the cadence adds up to one minute to provider confirmation visibility. */
const RECEIPT_CADENCE = '1 minute'

/**
 * Push quotes only an existing Notification, with the recipient's current Thread access checked:
 * where the notice opens (`opensAt`), or none while its Thread is gone or out of their reach.
 */
const opensOf = Effect.fn('Push.opensOf')(function* (notice: typeof NoticeRow.Type) {
  if (notice.conversationId === null)
    return Option.some(NotificationOpens.cases.Notifications.make({}))
  const thread = yield* findThread(notice.conversationId)
  if (Option.isNone(thread) || !(yield* canSee(thread.value.id, notice.personId)))
    return Option.none<NotificationOpens>()
  return Option.some(opensAt(thread.value))
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
  const body = yield* encodePayload(payload)
  const claimed = yield* database.run(
    database
      .insert(pushDeliveries)
      .values({
        notificationId: payload.notificationId,
        targetId: target.id,
        bodyHash: NodeCrypto.createHash('sha256').update(body).digest('hex'),
        bodyLength: Buffer.byteLength(body),
        receipt: yield* encodeReceipt(PushReceipt.cases.Queued.make({})),
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
    const opens = yield* opensOf(notice).pipe(Effect.provideService(Database, services.database))
    if (Option.isNone(opens)) return PushReceipt.cases.Failed.make({ reason: 'AccessLost' })
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
        .set({ receipt: yield* encodeReceipt(receipt), updatedAt: now })
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
    const opens = yield* opensOf(notice).pipe(Effect.provideService(Database, database))
    if (Option.isNone(opens)) return PushOutcome.cases.NoTargets.make({})
    const active = yield* targets.active(personId)
    if (active.length === 0) return PushOutcome.cases.NoTargets.make({})
    const payload = PushPayload.make({
      notificationId,
      previewUrl: notice.previewUrl,
      approval: notice.approval,
      title: notice.title.slice(0, 180),
      body: notice.body.replace(/\s+/gu, ' ').trim().slice(0, 280),
      opens: opens.value,
      sound: SOUND[notice.kind],
    })
    return summarize(yield* Effect.forEach(active, (target) => send(notice, payload, target)))
  })
  return Push.of({ deliver, reconcile })
})

/** A durable device obligation can settle independently of every other target. */
export const deliverTarget = Effect.fn('Push.deliverTarget')(function* (input: {
  readonly personId: PersonId
  readonly notificationId: NotificationId
  readonly targetId: PushTarget['id']
}) {
  const database = yield* Database
  const adapter = yield* PushAdapter
  const targets = yield* PushTargets
  const presence = yield* Presence
  const rows = yield* database.run(
    database
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.id, input.notificationId), eq(notifications.personId, input.personId)),
      ),
  )
  const row = rows[0]
  // Deletion cancels delivery. Revalidation below preserves current access and session policy.
  if (row === undefined) return
  const notice = yield* decodeNotice(row)
  const opens = yield* opensOf(notice)
  if (Option.isNone(opens)) return
  const target = (yield* targets.active(input.personId)).find(({ id }) => id === input.targetId)
  if (target === undefined) return
  const payload = PushPayload.make({
    notificationId: input.notificationId,
    previewUrl: notice.previewUrl,
    approval: notice.approval,
    title: notice.title.slice(0, 180),
    body: notice.body.replace(/\s+/gu, ' ').trim().slice(0, 280),
    opens: opens.value,
    // The owed job sounds exactly as a direct delivery would: by the notice's kind.
    sound: SOUND[notice.kind],
  })
  yield* makeSend({ database, adapter, targets, presence })(notice, payload, target)
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
          lte(pushDeliveries.updatedAt, now - RECEIPT_READY_AFTER_MS),
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
    if (now - row.delivery.createdAt < RECEIPT_RETENTION_MS) {
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
      .set({ receipt: yield* encodeReceipt(receipt), updatedAt: yield* Clock.currentTimeMillis })
      .where(
        and(
          eq(pushDeliveries.notificationId, key.notificationId),
          eq(pushDeliveries.targetId, key.targetId),
        ),
      ),
  )
})

/** Background lifecycle reads Expo receipts. */
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
      Effect.repeat(Schedule.spaced(RECEIPT_CADENCE)),
      Effect.forkScoped,
    )
  }),
)
