import * as NodeCrypto from 'node:crypto'
import * as Schema from 'effect/Schema'
import { Occurrence, OccurrenceId, RoutineId, ThreadId } from '@vivid/contracts'

/** A supplied delivery key names one attempt; absence deliberately means new work on every call. */
export const RoutineDeliveryKey = Schema.String.pipe(Schema.brand('RoutineDeliveryKey'))
export type RoutineDeliveryKey = typeof RoutineDeliveryKey.Type
export const RoutineInvocation = Schema.TaggedUnion({
  Fresh: {},
  Keyed: { key: RoutineDeliveryKey },
})
export type RoutineInvocation = typeof RoutineInvocation.Type

/** These are insertion snapshots, never a second mutable lifecycle beside the Run. */
export const OccurrenceOpening = Schema.TaggedUnion({
  Ready: {},
  Failed: { reason: Schema.String },
})
export type OccurrenceOpening = typeof OccurrenceOpening.Type

/** Insertion arbitrates receipts and failure notices; Conversation deduplicates actual admissions. */
export const OccurrenceClaim = Schema.TaggedUnion({
  Created: { occurrence: Occurrence },
  Existing: { occurrence: Occurrence },
})
export type OccurrenceClaim = typeof OccurrenceClaim.Type

export class RoutineThreadUnavailable extends Schema.TaggedError<RoutineThreadUnavailable>()(
  'RoutineThreadUnavailable',
  { routineId: RoutineId, threadId: ThreadId },
  { title: 'Routine Thread could not be opened' },
) {}

export const THREAD_OPENING_FAILURE = 'Its thread could not be opened'

const RoutineAttempt = Schema.Struct({ id: OccurrenceId, deliveryKey: Schema.String })
export type RoutineAttempt = typeof RoutineAttempt.Type

/** The receipt id is scoped to the Routine; the original header is passed unchanged to delivery. */
export const identifyAttempt = (routineId: RoutineId, invocation: RoutineInvocation) =>
  RoutineInvocation.match(invocation, {
    Fresh: () => {
      const id = OccurrenceId.make(NodeCrypto.randomUUID())
      return RoutineAttempt.make({ id, deliveryKey: id })
    },
    Keyed: ({ key }) =>
      RoutineAttempt.make({
        id: OccurrenceId.make(
          `webhook-${NodeCrypto.createHash('sha256')
            .update(JSON.stringify([routineId, key]))
            .digest('hex')}`,
        ),
        deliveryKey: key,
      }),
  })
